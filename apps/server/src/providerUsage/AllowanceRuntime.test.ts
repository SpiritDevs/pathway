import { ConvexError } from "convex/values";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  awaitAllowanceAdmission,
  makeAllowanceAdmissionCheck,
  type AllowanceAdmission,
} from "./AllowanceRuntime.ts";
const ready: AllowanceAdmission = {
  canStart: true,
  shouldInterrupt: false,
  budgets: [],
  detail: "Ready",
};
const held: AllowanceAdmission = {
  ...ready,
  canStart: false,
  shouldInterrupt: true,
  detail: "Allowance reached",
};
it.effect("retains a queued start until an explicit allowance change permits admission", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let current = held;
    let checks = 0;
    const fiber = yield* awaitAllowanceAdmission(
      Effect.sync(() => {
        checks++;
        return current;
      }),
      Effect.succeed(true),
      () => Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
      Deferred.await(resume),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(waiting);
    expect(checks).toBe(1);
    expect(fiber.pollUnsafe()).toBeUndefined();
    current = ready;
    yield* Deferred.succeed(resume, undefined);
    expect(yield* Fiber.join(fiber)).toBe(true);
    expect(checks).toBe(2);
  }),
);
it.effect("does not start a cancelled or superseded run after a budget hold", () =>
  Effect.gen(function* () {
    let current = true;
    let checks = 0;
    const admitted = yield* awaitAllowanceAdmission(
      Effect.sync(() => {
        checks++;
        return held;
      }),
      Effect.sync(() => current),
      () => Effect.void,
      Effect.sync(() => {
        current = false;
      }),
    );
    expect(admitted).toBe(false);
    expect(checks).toBe(1);
  }),
);

it.effect("does not interrupt an unbudgeted assignment when a later cloud check fails", () =>
  Effect.gen(function* () {
    const check = makeAllowanceAdmissionCheck();
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    const state = yield* check("thread-a", () => Effect.fail("Cloud unavailable"));
    expect(state.canStart).toBe(true);
    expect(state.shouldInterrupt).toBe(false);
    expect(state.budgets).toEqual([]);
  }),
);

it.effect("holds an unknown assignment instead of assuming it has no budget", () =>
  Effect.gen(function* () {
    const state = yield* makeAllowanceAdmissionCheck()("thread-a", () =>
      Effect.fail("Cloud unavailable"),
    );
    expect(state.canStart).toBe(false);
    expect(state.shouldInterrupt).toBe(true);
  }),
);

it.effect("keeps a newly discovered guard enforced even if its usage observation fails", () =>
  Effect.gen(function* () {
    const check = makeAllowanceAdmissionCheck();
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    const state = yield* check("thread-a", (observe) => {
      observe(true);
      return Effect.fail("Observation unavailable");
    });
    expect(state.canStart).toBe(false);
    expect(state.shouldInterrupt).toBe(true);
    expect((yield* check("thread-a", () => Effect.fail("Cloud unavailable"))).canStart).toBe(false);
  }),
);

it.effect("does not reuse another thread or chat's unbudgeted state", () =>
  Effect.gen(function* () {
    const check = makeAllowanceAdmissionCheck();
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    expect((yield* check("thread-b", () => Effect.fail("Cloud unavailable"))).canStart).toBe(false);
    expect((yield* check("chat-a", () => Effect.fail("Cloud unavailable"))).canStart).toBe(false);
  }),
);

it.effect("accepts a confirmed budget removal before a later connection failure", () =>
  Effect.gen(function* () {
    const check = makeAllowanceAdmissionCheck();
    yield* check("thread-a", (observe) => {
      observe(true);
      return Effect.succeed(held);
    });
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    expect((yield* check("thread-a", () => Effect.fail("Cloud unavailable"))).canStart).toBe(true);
  }),
);

it.effect("invalidates unbudgeted evidence when an allocation may have committed", () =>
  Effect.gen(function* () {
    const guards = new Map<string, boolean>();
    const check = makeAllowanceAdmissionCheck(guards);
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    guards.set("thread-a", true);
    expect((yield* check("thread-a", () => Effect.fail("Allocation response lost"))).canStart).toBe(
      false,
    );
  }),
);

it.effect("does not treat an explicit authorization rejection as a connectivity failure", () =>
  Effect.gen(function* () {
    const check = makeAllowanceAdmissionCheck();
    yield* check("thread-a", (observe) => {
      observe(false);
      return Effect.succeed(ready);
    });
    const state = yield* check("thread-a", () =>
      Effect.tryPromise(() => Promise.reject(new ConvexError("Assignment permission changed"))),
    );
    expect(state.canStart).toBe(false);
    expect((yield* check("thread-a", () => Effect.fail("Cloud unavailable"))).canStart).toBe(false);
  }),
);
