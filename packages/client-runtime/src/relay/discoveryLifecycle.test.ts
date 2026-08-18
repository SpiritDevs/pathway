import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { ApplicationActivityState } from "../platform/capabilities.ts";
import * as RelayEnvironmentDiscoveryLifecycle from "./discoveryLifecycle.ts";

describe("RelayEnvironmentDiscoveryLifecycle", () => {
  it.effect("refreshes globally while active and pauses while backgrounded", () =>
    Effect.gen(function* () {
      const activity = yield* SubscriptionRef.make<ApplicationActivityState>("inactive");
      const refreshes = yield* Ref.make(0);
      const lifecycle = yield* RelayEnvironmentDiscoveryLifecycle.run({
        activity: {
          status: SubscriptionRef.get(activity),
          changes: SubscriptionRef.changes(activity),
        },
        refresh: Ref.update(refreshes, (count) => count + 1),
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(refreshes)).toBe(0);

      yield* SubscriptionRef.set(activity, "active");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(refreshes)).toBe(1);

      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(refreshes)).toBe(2);

      yield* SubscriptionRef.set(activity, "inactive");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(refreshes)).toBe(2);

      yield* Fiber.interrupt(lifecycle);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("refreshes immediately when the runtime starts active", () =>
    Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const lifecycle = yield* RelayEnvironmentDiscoveryLifecycle.run({
        activity: {
          status: Effect.succeed("active"),
          changes: Stream.never,
        },
        refresh: Ref.update(refreshes, (count) => count + 1),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(yield* Ref.get(refreshes)).toBe(1);
      yield* Fiber.interrupt(lifecycle);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
