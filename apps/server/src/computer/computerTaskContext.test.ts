import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { currentComputerTask, withComputerTask } from "./computerTaskContext.ts";

describe("computer task attribution", () => {
  it.effect("is absent in ordinary work and expires in detached continuations", () =>
    Effect.gen(function* () {
      expect(yield* currentComputerTask).toBeUndefined();
      const gate = yield* Deferred.make<void>();
      const task = { threadId: "thread", turnId: "turn" };
      const detached = yield* withComputerTask(
        task,
        Effect.gen(function* () {
          expect(yield* currentComputerTask).toEqual(task);
          return yield* Effect.forkDetach(
            Effect.andThen(Deferred.await(gate), currentComputerTask),
          );
        }),
      );
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(detached)).toBeUndefined();
    }),
  );
});
