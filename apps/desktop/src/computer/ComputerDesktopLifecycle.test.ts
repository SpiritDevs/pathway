import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import {
  type ComputerDesktopLifecycleEvent,
  type ComputerDesktopPowerMonitor,
  make,
} from "./ComputerDesktopLifecycle.ts";

/** An in-memory power monitor whose listeners the test fires by hand. */
const makeMonitor = (idleState: string) => {
  const listeners = new Map<ComputerDesktopLifecycleEvent, Set<() => void>>();
  const monitor: ComputerDesktopPowerMonitor = {
    getSystemIdleState: () => Effect.succeed(idleState),
    onSimpleEvent: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const set = listeners.get(eventName) ?? new Set();
          set.add(listener);
          listeners.set(eventName, set);
        }),
        () => Effect.sync(() => listeners.get(eventName)?.delete(listener)),
      ),
  };
  const emit = (eventName: ComputerDesktopLifecycleEvent) => {
    for (const listener of listeners.get(eventName) ?? []) listener();
  };
  const listenerCount = () => [...listeners.values()].reduce((count, set) => count + set.size, 0);
  return { monitor, emit, listenerCount };
};

it.effect("keeps lock, sleep and user-session gates independent and removes handlers", () =>
  Effect.gen(function* () {
    const { monitor, emit, listenerCount } = makeMonitor("active");
    const reasons = new Set<string>();
    const calls = yield* Queue.unbounded<string>();
    const scope = yield* Scope.make();
    yield* make({
      monitor,
      host: {
        pauseDesktop: (reason) =>
          Effect.sync(() => reasons.add(reason)).pipe(Effect.andThen(Queue.offer(calls, reason))),
        resumeDesktop: (reason) =>
          Effect.sync(() => reasons.delete(reason)).pipe(
            Effect.andThen(Queue.offer(calls, reason)),
            Effect.asVoid,
          ),
      },
      onError: (error) => Effect.die(error),
    }).pipe(Scope.provide(scope));
    const settle = (count: number) => Queue.takeN(calls, count);
    emit("lock-screen");
    emit("suspend");
    emit("user-did-resign-active");
    emit("resume");
    emit("unlock-screen");
    yield* settle(5);
    assert.deepStrictEqual([...reasons], ["user-session"]);
    emit("user-did-become-active");
    yield* settle(1);
    assert.strictEqual(reasons.size, 0);
    assert.strictEqual(listenerCount(), 6);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(listenerCount(), 0);
    emit("lock-screen");
    assert.strictEqual(reasons.size, 0);
  }),
);

describe("desktop startup", () => {
  it.effect("blocks an already locked desktop and reports failed native cleanup", () =>
    Effect.gen(function* () {
      const { monitor } = makeMonitor("locked");
      const reasons: Array<string> = [];
      const errors = yield* Queue.unbounded<unknown>();
      const failure = new Error("Native cleanup not acknowledged");
      yield* make({
        monitor,
        host: {
          pauseDesktop: (reason) =>
            Effect.sync(() => reasons.push(reason)).pipe(Effect.andThen(Effect.fail(failure))),
          resumeDesktop: () => Effect.void,
        },
        onError: (error) => Queue.offer(errors, error).pipe(Effect.asVoid),
      });
      assert.strictEqual(yield* Queue.take(errors), failure);
      assert.deepStrictEqual(reasons, ["screen-lock"]);
    }).pipe(Effect.scoped),
  );
});
