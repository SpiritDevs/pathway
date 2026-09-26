import type { ComputerEvent } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ComputerEventInterests } from "./computerEventInterests.ts";

const stateEvent = (threadId: string) =>
  ({ type: "computer.thread-state", state: { threadId } }) as ComputerEvent;
const actionEvent = (threadId?: string) => ({ type: "computer.action", threadId }) as ComputerEvent;

/**
 * A socket registry with the close-hook contract the server's WebSocket layer
 * provides: cleanups registered on a live connection run when it closes, and a
 * closed connection refuses new registrations.
 */
function makeFixture() {
  const connections = new Map<string, Set<() => void>>();
  let nextKey = 0;
  const onClose = (key: string, cleanup: () => void) => {
    const cleanups = connections.get(key);
    if (!cleanups) return false;
    cleanups.add(cleanup);
    return true;
  };
  const cleanupRegistrations = { count: 0 };
  const interests = new ComputerEventInterests((key, cleanup) => {
    cleanupRegistrations.count += 1;
    return onClose(key, cleanup);
  });
  return {
    interests,
    onClose,
    cleanupRegistrations,
    open: () => {
      const key = `connection-${(nextKey += 1)}`;
      connections.set(key, new Set());
      return {
        key,
        close: () => {
          const cleanups = connections.get(key);
          connections.delete(key);
          for (const cleanup of cleanups ?? []) cleanup();
        },
      };
    },
  };
}

const deliver = (
  interests: ComputerEventInterests,
  connectionKey: string | undefined,
  events: readonly ComputerEvent[],
) => Stream.runCollect(interests.subscribe(connectionKey, Stream.fromIterable(events)));

describe("ComputerEventInterests", () => {
  it("filters thread state and actions while preserving global and human events", () => {
    const f = makeFixture();
    const first = f.open();
    const second = f.open();
    f.interests.watch(first.key, "thread-a");
    f.interests.watch(second.key, "thread-b");
    expect(f.interests.accepts(first.key, stateEvent("thread-a"))).toBe(true);
    expect(f.interests.accepts(first.key, actionEvent("thread-a"))).toBe(true);
    expect(f.interests.accepts(first.key, stateEvent("thread-b"))).toBe(false);
    expect(f.interests.accepts(second.key, actionEvent("thread-a"))).toBe(false);
    expect(f.interests.accepts(first.key, actionEvent())).toBe(true);
    expect(f.interests.accepts(first.key, { type: "computer.windows-changed", windows: [] })).toBe(
      true,
    );
  });

  it("retains live views beyond 256 connections and across disconnected-client churn", () => {
    const f = makeFixture();
    const first = f.open();
    f.interests.watch(first.key, "first-view");
    const liveKeys: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const live = f.open();
      liveKeys.push(live.key);
      f.interests.watch(live.key, `view-${index}`);
      const transient = f.open();
      f.interests.watch(transient.key, "transient-view");
      transient.close();
      expect(f.interests.accepts(transient.key, stateEvent("transient-view"))).toBe(false);
    }
    expect(f.interests.accepts(first.key, stateEvent("first-view"))).toBe(true);
    for (const [index, key] of liveKeys.entries()) {
      expect(f.interests.accepts(key, stateEvent(`view-${index}`))).toBe(true);
      expect(f.interests.accepts(key, stateEvent("first-view"))).toBe(false);
    }
  });

  it("falls back to broadcast beyond 64 distinct views without silently dropping any", () => {
    const f = makeFixture();
    const connection = f.open();
    for (let index = 0; index < 100; index += 1) {
      f.interests.watch(connection.key, `view-${index}`);
    }
    for (let index = 0; index < 100; index += 1) {
      expect(f.interests.accepts(connection.key, stateEvent(`view-${index}`))).toBe(true);
    }
    expect(f.interests.accepts(connection.key, stateEvent("another-view"))).toBe(true);
    connection.close();
    expect(f.interests.accepts(connection.key, stateEvent("view-0"))).toBe(false);
  });

  it("does not consume the distinct-view budget on repeated state reads", () => {
    const f = makeFixture();
    const connection = f.open();
    for (let index = 0; index < 100; index += 1) f.interests.watch(connection.key, "same-view");
    expect(f.interests.accepts(connection.key, stateEvent("same-view"))).toBe(true);
    expect(f.interests.accepts(connection.key, stateEvent("another-view"))).toBe(false);
  });

  it("cleans state-only connections and rejects late reads after socket close", () => {
    const f = makeFixture();
    const connection = f.open();
    f.interests.watch(connection.key, "view");
    connection.close();
    f.interests.watch(connection.key, "view");
    expect(f.interests.accepts(connection.key, stateEvent("view"))).toBe(false);
    expect(f.onClose(connection.key, () => {})).toBe(false);
  });

  it.effect("keeps interests across stream retries without registering the socket twice", () =>
    Effect.gen(function* () {
      const f = makeFixture();
      const connection = f.open();
      f.interests.watch(connection.key, "view");
      expect(yield* deliver(f.interests, connection.key, [stateEvent("view")])).toEqual([
        stateEvent("view"),
      ]);
      // A retried stream is a fresh subscription on the same socket.
      expect(
        yield* deliver(f.interests, connection.key, [stateEvent("other"), stateEvent("view")]),
      ).toEqual([stateEvent("view")]);
      expect(f.cleanupRegistrations.count).toBe(1);
      connection.close();
      expect(yield* deliver(f.interests, connection.key, [stateEvent("view")])).toEqual([]);
    }),
  );

  it.effect("preserves broadcast for callers without a connection context", () =>
    Effect.gen(function* () {
      const f = makeFixture();
      f.interests.watch(undefined, "view");
      expect(yield* deliver(f.interests, undefined, [stateEvent("other")])).toEqual([
        stateEvent("other"),
      ]);
    }),
  );
});
