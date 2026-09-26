import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { make } from "./ComputerRunCalls.ts";

it.effect("refuses a call that arrives after its run was stopped", () =>
  Effect.gen(function* () {
    const calls = yield* make;
    yield* calls.stop("thread", "run");
    let ran = false;
    const exit = yield* Effect.exit(
      calls.run(
        "thread",
        "run",
        Effect.sync(() => {
          ran = true;
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(ran);
    // Another run on the thread is untouched.
    assert.isTrue(
      Exit.isSuccess(yield* Effect.exit(calls.run("thread", "other-run", Effect.void))),
    );
  }),
);

it.effect("ends a waiting call and returns once it has unwound", () =>
  Effect.gen(function* () {
    const calls = yield* make;
    const waiting = yield* Deferred.make<void>();
    const unwound = yield* Deferred.make<void>();
    const call = yield* Effect.forkChild(
      calls.run(
        "thread",
        "run",
        Deferred.succeed(waiting, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(unwound, undefined)),
        ),
      ),
    );
    yield* Deferred.await(waiting);
    yield* calls.stop("thread", "run");
    assert.isTrue(yield* Deferred.isDone(unwound));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(call)));
    assert.isTrue(calls.stopped("thread", "run"));
  }),
);
