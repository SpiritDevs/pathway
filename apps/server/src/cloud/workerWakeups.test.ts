import type { ConvexClient } from "convex/browser";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeWorkerWakeupGate, makeWorkerWakeups } from "./workerWakeups.ts";

describe("worker queue wakeups", () => {
  it.effect("checks an empty queue once a minute and wakes immediately when work arrives", () =>
    Effect.gen(function* () {
      const gate = yield* makeWorkerWakeupGate();
      gate.notify(false);
      let checks = 0;
      const started = yield* Deferred.make<void>();
      const workArrived = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        checks++;
        if (checks === 1) yield* Deferred.succeed(started, undefined);
        if (checks === 7) yield* Deferred.succeed(workArrived, undefined);
        yield* gate.wait;
      }).pipe(Effect.forever, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 minutes");
      expect(checks).toBe(6);
      gate.notify(true);
      yield* Deferred.await(workArrived);
      expect(checks).toBe(7);
    }),
  );

  it.effect(
    "retains ten-second recovery when work may be waiting on a lease or the subscription is unavailable",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeWorkerWakeupGate();
        const waiting = yield* Deferred.make<void>();
        let woken = false;
        const fiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(waiting, undefined);
          yield* gate.wait;
          woken = true;
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("9 seconds");
        expect(woken).toBe(false);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect(woken).toBe(true);
      }),
  );

  it.effect("coalesces notifications received during work and cancels scoped waiters", () =>
    Effect.gen(function* () {
      const gate = yield* makeWorkerWakeupGate();
      gate.notify(true);
      gate.notify(true);
      gate.notify(true);
      yield* gate.wait;
      gate.notify(false);
      let woken = false;
      const waiting = yield* Deferred.make<void>();
      const fiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(waiting, undefined);
        yield* gate.wait;
        woken = true;
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("59 seconds");
      expect(woken).toBe(false);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("1 second");
      expect(woken).toBe(false);
    }),
  );
});

it.effect(
  "re-subscribes after errors, refreshes auth, and closes subscriptions with the company scope",
  () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let subscriptions = 0;
      let unsubscribed = 0;
      let closed = 0;
      let invalidations = 0;
      let onError: ((error: Error) => unknown) | undefined;
      let fetchToken: Parameters<ConvexClient["setAuth"]>[0] | undefined;
      const client: Pick<ConvexClient, "onUpdate" | "setAuth" | "close"> = {
        setAuth: (fetcher) => {
          fetchToken = fetcher;
        },
        onUpdate: (_ref, _args, _callback, fail) => {
          onError = fail;
          subscriptions++;
          Deferred.doneUnsafe(subscriptions === 1 ? first : second, Effect.void);
          const unsubscribe = () => {
            unsubscribed++;
          };
          return Object.assign(unsubscribe, {
            unsubscribe,
            getCurrentValue: () => undefined,
            getQueryLogs: () => undefined,
          });
        },
        close: async () => {
          closed++;
        },
      };
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeWorkerWakeups({
            companyId: CompanyId.make("workspace"),
            convexUrl: "https://test.convex.cloud",
            kinds: ["mail"],
            client,
            tokens: {
              token: Effect.succeed("test-token"),
              invalidate: () =>
                Effect.sync(() => {
                  invalidations++;
                }),
            },
          });
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(first);
      const auth = fetchToken!;
      expect(yield* Effect.promise(() => auth({ forceRefreshToken: true }))).toBe("test-token");
      expect(invalidations).toBe(1);
      onError!(new Error("subscription interrupted"));
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(second);
      expect(subscriptions).toBe(2);
      expect(unsubscribed).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(unsubscribed).toBe(2);
      expect(closed).toBe(1);
    }),
);
