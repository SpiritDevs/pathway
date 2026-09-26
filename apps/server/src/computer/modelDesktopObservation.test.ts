import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  isModelDesktopObservationActive,
  withModelDesktopObservation,
} from "./modelDesktopObservation.ts";

/** A continuation that outlives the scope it was started in, like a dangling promise. */
const detachedCheck = (release: Deferred.Deferred<void>) =>
  Effect.forkDetach(Effect.andThen(Deferred.await(release), isModelDesktopObservationActive));

describe("model desktop observation scope", () => {
  it.effect("isolates concurrent scopes and leaves outside work inactive", () =>
    Effect.gen(function* () {
      expect(yield* isModelDesktopObservationActive).toBe(false);
      const firstRelease = yield* Deferred.make<void>();
      const secondRelease = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        withModelDesktopObservation(
          Effect.gen(function* () {
            expect(yield* isModelDesktopObservationActive).toBe(true);
            yield* Deferred.await(firstRelease);
            expect(yield* isModelDesktopObservationActive).toBe(true);
            return "first observation";
          }),
        ),
      );
      const second = yield* Effect.forkChild(
        withModelDesktopObservation(
          Effect.gen(function* () {
            expect(yield* isModelDesktopObservationActive).toBe(true);
            yield* Deferred.await(secondRelease);
            expect(yield* isModelDesktopObservationActive).toBe(true);
          }),
        ),
      );
      expect(yield* isModelDesktopObservationActive).toBe(false);
      yield* Deferred.succeed(firstRelease, undefined);
      expect(yield* Fiber.join(first)).toBe("first observation");
      expect(yield* isModelDesktopObservationActive).toBe(false);
      yield* Deferred.succeed(secondRelease, undefined);
      yield* Fiber.join(second);
      expect(yield* isModelDesktopObservationActive).toBe(false);
    }),
  );

  it.effect("expires authority in an inherited continuation after completion", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const delayed = yield* withModelDesktopObservation(
        Effect.gen(function* () {
          const continuation = yield* detachedCheck(release);
          expect(yield* isModelDesktopObservationActive).toBe(true);
          return continuation;
        }),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(delayed)).toBe(false);
    }),
  );

  it.effect.each(["defect", "failure"] as const)(
    "expires inherited authority after a %s",
    (failureMode) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const failure = new Error("observation failed");
        let delayed: Fiber.Fiber<boolean> | undefined;
        const result = yield* Effect.exit(
          withModelDesktopObservation(
            Effect.gen(function* () {
              delayed = yield* detachedCheck(release);
              expect(yield* isModelDesktopObservationActive).toBe(true);
              return yield* failureMode === "defect" ? Effect.die(failure) : Effect.fail(failure);
            }),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* isModelDesktopObservationActive).toBe(false);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(delayed!)).toBe(false);
      }),
  );

  it.effect("restores the outer scope while expiring a completed nested scope", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      yield* withModelDesktopObservation(
        Effect.gen(function* () {
          const delayed = yield* withModelDesktopObservation(
            Effect.gen(function* () {
              const continuation = yield* detachedCheck(release);
              expect(yield* isModelDesktopObservationActive).toBe(true);
              return continuation;
            }),
          );
          expect(yield* isModelDesktopObservationActive).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(delayed)).toBe(false);
          expect(yield* isModelDesktopObservationActive).toBe(true);
        }),
      );
      expect(yield* isModelDesktopObservationActive).toBe(false);
    }),
  );
});
