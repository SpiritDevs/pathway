import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { awaitAllowanceAdmission, type AllowanceAdmission } from "./AllowanceRuntime.ts";
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
