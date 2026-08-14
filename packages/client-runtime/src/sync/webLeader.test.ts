import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  makeInProcessWebLockManager,
  makeWebLeaderElection,
  webLeaderLockName,
  whileLeader,
  type WebLeaderElection,
} from "./webLeader.ts";

/** Waits until the election reports leadership; `changes` replays the current value first. */
const awaitLeadership = (election: WebLeaderElection) =>
  Stream.runHead(Stream.filter(election.changes, (leading) => leading));

/** Two elections over one lock manager stand in for two tabs of the same origin. */
const makeTabs = Effect.fn("makeTabs")(function* (scope: string) {
  const locks = makeInProcessWebLockManager();
  const tabA = yield* makeWebLeaderElection({ scope, locks });
  const tabB = yield* makeWebLeaderElection({ scope, locks });
  return { tabA, tabB };
});

describe("WebLeaderElection", () => {
  it.effect("grants the first context and hands off to the waiting one on release", () =>
    Effect.gen(function* () {
      const { tabA, tabB } = yield* makeTabs("user-a");

      yield* tabA.acquire;
      expect(yield* tabA.isLeader).toBe(true);
      expect(tabA.lockName).toBe(webLeaderLockName("user-a"));

      const waiting = yield* Effect.forkChild(tabB.acquire, { startImmediately: true });
      expect(yield* tabB.isLeader).toBe(false);

      yield* tabA.release;
      yield* Fiber.join(waiting);
      expect(yield* tabA.isLeader).toBe(false);
      expect(yield* tabB.isLeader).toBe(true);
    }),
  );

  it.effect("reports leadership changes on the subscription", () =>
    Effect.gen(function* () {
      const { tabA } = yield* makeTabs("user-a");

      const observed = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabA.changes, 3)), {
        startImmediately: true,
      });
      yield* tabA.acquire;
      yield* tabA.release;
      expect(yield* Fiber.join(observed)).toEqual([false, true, false]);
    }),
  );

  it.effect("acquire is idempotent while leading and release is idempotent while not", () =>
    Effect.gen(function* () {
      const { tabA } = yield* makeTabs("user-a");
      yield* tabA.release; // Releasing without the lock does nothing.
      yield* tabA.acquire;
      yield* tabA.acquire; // Re-acquiring does not queue a second request.
      expect(yield* tabA.isLeader).toBe(true);
      yield* tabA.release;
      expect(yield* tabA.isLeader).toBe(false);
    }),
  );

  it.effect("withLeadership releases the lock when the effect completes", () =>
    Effect.gen(function* () {
      const { tabA, tabB } = yield* makeTabs("user-a");

      expect(yield* whileLeader(tabA, Effect.succeed("worked"))).toBe("worked");
      expect(yield* tabA.isLeader).toBe(false);

      // The lock is free again, so the second tab is granted without waiting.
      yield* tabB.acquire;
      expect(yield* tabB.isLeader).toBe(true);
    }),
  );

  it.effect("withLeadership interrupts the effect and fails when leadership is lost", () =>
    Effect.gen(function* () {
      const { tabA, tabB } = yield* makeTabs("user-a");

      // The engine seam: `run` never completes on its own; only leadership loss ends it.
      const running = yield* Effect.forkChild(tabA.withLeadership(Effect.never), {
        startImmediately: true,
      });
      yield* awaitLeadership(tabA);
      expect(yield* tabA.isLeader).toBe(true);

      yield* tabA.release;
      const error = yield* Effect.flip(Fiber.join(running));
      expect(error._tag).toBe("WebLeaderError");
      expect(error.reason).toBe("lost");
      expect(yield* tabA.isLeader).toBe(false);

      // The handoff completes: the other tab can lead now.
      yield* tabB.acquire;
      expect(yield* tabB.isLeader).toBe(true);
    }),
  );

  it.effect("an interrupted waiter leaves the queue instead of becoming leader later", () =>
    Effect.gen(function* () {
      const { tabA, tabB } = yield* makeTabs("user-a");

      yield* tabA.acquire;
      const waiting = yield* Effect.forkChild(tabB.acquire, { startImmediately: true });
      yield* Fiber.interrupt(waiting);
      yield* tabA.release;
      expect(yield* tabB.isLeader).toBe(false);

      // The abandoned request is gone, so a fresh acquire is granted immediately.
      yield* tabB.acquire;
      expect(yield* tabB.isLeader).toBe(true);
    }),
  );

  it.effect("falls back to in-process arbitration when Web Locks is unavailable", () =>
    Effect.gen(function* () {
      // `locks: null` is what a platform passes when Web Locks is absent: the election still
      // works, but only within this JavaScript context — the documented single-tab assumption.
      const tabA = yield* makeWebLeaderElection({ scope: "fallback-scope", locks: null });
      const tabB = yield* makeWebLeaderElection({ scope: "fallback-scope", locks: null });
      expect(tabA.crossContext).toBe(false);

      yield* tabA.acquire;
      const waiting = yield* Effect.forkChild(tabB.acquire, { startImmediately: true });
      expect(yield* tabB.isLeader).toBe(false);
      yield* tabA.release;
      yield* Fiber.join(waiting);
      expect(yield* tabB.isLeader).toBe(true);
      yield* tabB.release;
    }),
  );
});
