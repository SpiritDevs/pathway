import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId } from "@spiritdevs/contracts";
import * as Layer from "effect/Layer";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { ComputerService } from "./Services/ComputerService.ts";
import { RunStopFence } from "../orchestration-v2/RunStopFence.ts";
import { ComputerRunCalls, computerRunStopFenceLayer } from "./ComputerRunCalls.ts";
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

it.effect(
  "run terminalization clears active-turn state while preserving the human controller",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
        const calls = yield* make;
        const threadId = ThreadId.make("thread");
        const runId = RunId.make("run");
        manager.surfaceControl.startTurn(threadId, runId);
        yield* manager.surfaceControl.take("human");
        const waiting = yield* Effect.forkChild(
          calls.run(
            threadId,
            runId,
            manager.withAgentActivity(threadId, Effect.die("stopped turn dispatched")),
          ),
          { startImmediately: true },
        );
        yield* Effect.gen(function* () {
          const fence = yield* RunStopFence;
          yield* fence.stopRun({ threadId, runId });
        }).pipe(
          Effect.provide(
            computerRunStopFenceLayer.pipe(
              Layer.provide(Layer.succeed(ComputerRunCalls, calls)),
              Layer.provide(
                Layer.succeed(ComputerService, {
                  manager,
                  supported: true,
                  availability: { kind: "available", backend: "fake" },
                }),
              ),
            ),
          ),
        );
        assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)));
        assert.deepEqual(manager.surfaceControl.snapshot.activeTurns, []);
        assert.deepEqual(manager.surfaceControl.snapshot.controller, {
          kind: "client",
          clientId: "human",
        });
        yield* manager.surfaceControl.release("human");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
