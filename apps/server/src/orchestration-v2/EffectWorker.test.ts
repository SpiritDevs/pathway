import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { QuestionAnswerDelivery, QuestionAnswerDeliveryError } from "./QuestionAnswerDelivery.ts";

import { BrowserTakeoverService } from "./BrowserTakeoverService.ts";
import { CheckpointRollbackServiceV2 } from "./CheckpointRollbackService.ts";
import {
  EffectOutboxError,
  EffectOutboxV2,
  layer as effectOutboxLayer,
  type OrchestrationEffectV2,
} from "./EffectOutbox.ts";
import {
  executorLayer,
  isNonRetryableProviderTurnControlFailure,
  layerWithOptions as effectWorkerLayerWithOptions,
  OrchestrationEffectExecutionError,
  OrchestrationEffectExecutorV2,
  OrchestrationEffectWorkerError,
  OrchestrationEffectWorkerV2,
  runDaemonWithOptions,
} from "./EffectWorker.ts";
import { RunFinalizationService } from "./RunFinalizationService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import { ProviderTurnStartError, ProviderTurnStartServiceV2 } from "./ProviderTurnStartService.ts";
import { RuntimeRequestServiceV2 } from "./RuntimeRequestService.ts";
import { ThreadTitleRegenerationService } from "./ThreadTitleRegenerationService.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const replacementSessionId = ProviderSessionId.make(
  "provider-session:effect-worker-restart:replacement",
);
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function makeExecutorLayer(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlServiceV2,
      ProviderTurnControlServiceV2.of({
        interrupt: () => Effect.void,
        steer: () => Effect.void,
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManagerV2,
      ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeed(Option.none()),
        close: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartServiceV2,
      ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService,
      RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackServiceV2,
      CheckpointRollbackServiceV2.of({ execute: () => record("rollback") }),
    ),
    Layer.succeed(
      RuntimeRequestServiceV2,
      RuntimeRequestServiceV2.of({ respond: () => Effect.void }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.of({
        execute: ({ requestId, kind }) => record(`title:${kind.type}:${requestId}`),
      }),
    ),
    Layer.succeed(
      BrowserTakeoverService,
      BrowserTakeoverService.of({
        establish: ({ takeoverId }) => record(`takeover:establish:${takeoverId}`),
        proceed: ({ takeoverId }) => record(`takeover:proceed:${takeoverId}`),
        release: ({ takeoverId }) => record(`takeover:release:${takeoverId}`),
        recover: Effect.succeed({ failed: 0, rearmed: 0, completed: 0 }),
      }),
    ),
  );
  return executorLayer.pipe(Layer.provide(dependencies));
}

it("does not retry pure interrupt races where the turn is already gone", () => {
  assert.isTrue(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ProviderAdapterInterruptError: ... ACP provider turn provider-turn:x is not active",
    ),
  );
  assert.isTrue(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "Provider session provider-session:x is not active.",
    ),
  );
  // Restart is compound (interrupt + detach + start). Do not swallow start failures.
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.restart",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.start",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ACP hard teardown failed unexpectedly; the session is poisoned",
    ),
  );
});

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string | null;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () =>
        Effect.fail(
          new EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          // Model a cancellation commit immediately after this durable read
          // took its snapshot. Its process-local signal is only delivered when
          // the worker registered the waiter before starting the read.
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("requeues a replay-safe claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-settlement-failure";
    const workerId = "worker-replay-safe-settlement-failure";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated replay-safe settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retries), 1);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a process-bound executor failure retryable when retry settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-retry-settlement-failure";
    const workerId = "worker-process-bound-retry-settlement-failure";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-retry-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-retry-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-retry-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retryAttempts = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      retry: () =>
        Ref.updateAndGet(retryAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutboxError({
                    operation: "retry",
                    effectId,
                    cause: "simulated retry settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated provider execution failure",
            }),
          ),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retryAttempts), 2);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a max-attempt replay-safe failure terminal when fail settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-terminal-settlement-failure";
    const workerId = "worker-replay-safe-terminal-settlement-failure";
    const claimedEffect: OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-terminal-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-terminal-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 5,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const failAttempts = yield* Ref.make(0);
    const retries = yield* Ref.make(0);
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () =>
        Ref.updateAndGet(failAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutboxError({
                    operation: "fail",
                    effectId,
                    cause: "simulated terminal settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated terminal cleanup failure",
            }),
          ),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({ workerId, maxAttempts: 5 }).pipe(
      Layer.provide(Layer.merge(outboxLayer, executorLayer)),
    );

    const exit = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(failAttempts), 2);
    assert.equal(yield* Ref.get(retries), 0);
  }),
);

it.effect("uses durable deadlines, notifications, and a slow liveness poll", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const available = yield* Queue.unbounded<void>();
    const now = yield* DateTime.now;
    const nextClaimableAt = yield* Ref.make<Option.Option<DateTime.Utc>>(
      Option.some(DateTime.add(now, { milliseconds: 100 })),
    );
    const worker = OrchestrationEffectWorkerV2.of({
      awaitWork: Queue.take(available),
      runOnce: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(attempts, (current) => current + 1);
        if (count === 2) {
          yield* Ref.set(nextClaimableAt, Option.some(DateTime.add(now, { milliseconds: 5_000 })));
        }
        if (count === 3) yield* Ref.set(nextClaimableAt, Option.none());
        return false;
      }),
      nextClaimableAt: Ref.get(nextClaimableAt),
      drain: () => Effect.succeed(0),
    });
    const awaitAttempts = Effect.fnUntraced(function* (expected: number) {
      while ((yield* Ref.get(attempts)) < expected) {
        yield* Effect.yieldNow;
      }
    });

    yield* runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(Effect.provideService(OrchestrationEffectWorkerV2, worker), Effect.forkScoped);

    yield* awaitAttempts(1);
    yield* TestClock.adjust("99 millis");
    assert.equal(yield* Ref.get(attempts), 1);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(2);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 2);

    yield* Queue.offer(available, undefined);
    yield* awaitAttempts(3);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 3);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(4);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not hot-loop when a claim fails", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(
          new OrchestrationEffectWorkerError({
            operation: "claim",
            cause: "simulated database failure",
          }),
        ),
      ),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(Effect.provideService(OrchestrationEffectWorkerV2, worker), Effect.forkScoped);

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("backs off briefly when a due deadline loses a claim race", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(Effect.as(false)),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(Effect.provideService(OrchestrationEffectWorkerV2, worker), Effect.forkScoped);

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("24 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("detaches a handed-off session only after the old turn terminalizes", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(restartEffect(now, { type: "detach" }));
    }).pipe(Effect.provide(makeExecutorLayer({ events })));

    assert.deepEqual(yield* Ref.get(events), ["interrupt", "detach", "start"]);
  }),
);

it.effect("restores the checkpoint before starting an edited replacement run", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const effect: OrchestrationEffectV2 = {
      id: "effect:edit-and-restart",
      commandId: CommandId.make("command:edit-and-restart"),
      threadId,
      request: {
        type: "provider-thread.rollback-and-start",
        providerThreadId,
        checkpointId: CheckpointId.make("checkpoint:before-edited-run"),
        scopeId: CheckpointScopeId.make("scope:before-edited-run"),
        runId,
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: "test-worker",
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(makeExecutorLayer({ events })));

    assert.deepEqual(yield* Ref.get(events), ["rollback", "start"]);
  }),
);

it.effect("executes durable thread title generation effects", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const commandId = CommandId.make("command:title-generation");
    const effect: OrchestrationEffectV2 = {
      id: "effect:title-generation",
      commandId,
      threadId,
      request: {
        type: "thread-title.generate",
        kind: { type: "initial", messageId: MessageId.make("message:title-generation") },
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: "test-worker",
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(makeExecutorLayer({ events })));

    assert.deepEqual(yield* Ref.get(events), [`title:initial:${commandId}`]);
  }),
);

it.effect("safely retries after replacement cleanup succeeds and start fails", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const failFirstStart = yield* Ref.make(true);
    const effect = restartEffect(now, {
      type: "replace",
      replacementProviderSessionId: replacementSessionId,
    });
    const layer = makeExecutorLayer({ events, failFirstStart });

    const first = yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      return yield* Effect.exit(executor.execute(effect));
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.isFailure(first));

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(events), [
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
    ]);
  }),
);

for (const failurePhase of ["before-event-commit", "after-event-commit"] as const) {
  it.effect(`retries question recovery ${failurePhase} without another provider delivery`, () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const deliveries = yield* Ref.make(0);
      const recoveries = yield* Ref.make(0);
      const requestStatus = yield* Ref.make<"resolved" | "pending">("resolved");
      const recoveryCommits = yield* Ref.make(0);
      const commandId = CommandId.make(`command:question-recovery:${failurePhase}`);
      const effectId = `effect:question-recovery:${failurePhase}`;
      const deliveryLayer = Layer.mock(QuestionAnswerDelivery)({
        failed: (input) =>
          Effect.gen(function* () {
            assert.equal(input.commandId, commandId);
            const attempt = yield* Ref.updateAndGet(recoveries, (count) => count + 1);
            // The real handler re-reads under the thread lock and only writes a
            // resolved request. Model both a failed write and a lost commit ack.
            if (failurePhase === "before-event-commit" && attempt <= 2) {
              return yield* new QuestionAnswerDeliveryError({ cause: "EventSink.write failed" });
            }
            if ((yield* Ref.get(requestStatus)) === "resolved") {
              yield* Ref.set(requestStatus, "pending");
              yield* Ref.update(recoveryCommits, (count) => count + 1);
            }
            if (failurePhase === "after-event-commit" && attempt === 1) {
              return yield* new QuestionAnswerDeliveryError({
                cause: "Event commit acknowledgement failed",
              });
            }
          }),
      });
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "question-recovery-worker",
        maxAttempts: 1,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(EffectOutboxV2, outbox),
            deliveryLayer,
            Layer.succeed(OrchestrationEffectExecutorV2, {
              execute: (effect) =>
                Ref.update(deliveries, (count) => count + 1).pipe(
                  Effect.andThen(() =>
                    Effect.fail(
                      new OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: effect.request.type,
                        cause: "Provider rejected answer",
                      }),
                    ),
                  ),
                ),
            }),
          ),
        ),
      );
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.steer",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            messageId: MessageId.make("answer-message"),
          },
        },
      ]);
      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        const failedRecoveryCount = failurePhase === "before-event-commit" ? 2 : 1;
        for (let attempt = 0; attempt < failedRecoveryCount; attempt += 1) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(worker.runOnce)));
          const pending = yield* outbox.get(effectId);
          assert.isTrue(Option.isSome(pending));
          if (Option.isSome(pending)) {
            assert.equal(pending.value.status, "pending");
            assert.equal(pending.value.attemptCount, attempt + 1);
          }
          assert.equal(yield* Ref.get(deliveries), 1);
          assert.isFalse(yield* worker.runOnce);
          yield* TestClock.adjust("1 second");
        }
        assert.isTrue(yield* worker.runOnce);
        assert.isFalse(yield* worker.runOnce);
      }).pipe(Effect.provide(workerLayer));
      const settled = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(settled));
      if (Option.isSome(settled)) assert.equal(settled.value.status, "failed");
      assert.equal(yield* Ref.get(requestStatus), "pending");
      assert.equal(yield* Ref.get(deliveries), 1);
      assert.equal(yield* Ref.get(recoveryCommits), 1);
    }).pipe(Effect.provide(effectOutboxLayer.pipe(Layer.provide(SqlitePersistenceMemory)))),
  );
}

it.effect(
  "keeps workspace cleanup pending until deletion writers stop and retries beyond the ordinary attempt limit",
  () =>
    Effect.gen(function* () {
      const failDetach = yield* Ref.make(true);
      const failCleanup = yield* Ref.make(true);
      const removed = yield* Ref.make(0);
      const commandId = CommandId.make("cleanup-dependencies-command");
      const cleanupThreadId = ThreadId.make("cleanup-dependencies-thread");
      const detachId = "cleanup-dependencies-detach";
      const cleanupId = "cleanup-dependencies-workspace";
      const executor = OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          Effect.gen(function* () {
            if (effect.request.type === "provider-session.detach" && (yield* Ref.get(failDetach)))
              return yield* new OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause: "provider is still writing",
              });
            if (effect.request.type === "thread-workspace.cleanup" && (yield* Ref.get(failCleanup)))
              return yield* new OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause: "workspace temporarily locked",
              });
            if (effect.request.type === "thread-workspace.cleanup")
              yield* Ref.update(removed, (count) => count + 1);
          }),
      });
      const testLayer = effectWorkerLayerWithOptions({
        workerId: "cleanup-dependency-worker",
        maxAttempts: 1,
      }).pipe(
        Layer.provide(Layer.succeed(OrchestrationEffectExecutorV2, executor)),
        Layer.provideMerge(effectOutboxLayer),
        Layer.provide(SqlitePersistenceMemory),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutboxV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([
          {
            id: detachId,
            commandId,
            threadId: cleanupThreadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: oldSessionId,
              revokeMcpCredential: true,
              durableRetry: true,
            },
          },
          {
            id: cleanupId,
            commandId,
            threadId: cleanupThreadId,
            request: { type: "thread-workspace.cleanup", afterEffectIds: [detachId] },
          },
        ]);
        yield* worker.runOnce;
        yield* worker.runOnce;
        assert.equal(yield* Ref.get(removed), 0);
        assert.equal((yield* outbox.listWorkspaceCleanupFailures())[0]?.id, cleanupId);
        yield* TestClock.adjust("100 millis");
        yield* worker.runOnce;
        const retryingDetach = yield* outbox.get(detachId);
        assert.isTrue(Option.isSome(retryingDetach));
        if (Option.isSome(retryingDetach)) {
          assert.equal(retryingDetach.value.status, "pending");
          assert.equal(retryingDetach.value.attemptCount, 2);
        }
        const unrelatedRetry = yield* outbox.retryWorkspaceCleanup(detachId).pipe(Effect.flip);
        assert.instanceOf(unrelatedRetry, EffectOutboxError);
        yield* Ref.set(failDetach, false);
        yield* outbox.retryWorkspaceCleanup(cleanupId);
        yield* worker.drain();
        assert.equal(yield* Ref.get(removed), 0);
        assert.include(
          (yield* outbox.listWorkspaceCleanupFailures())[0]?.lastError ?? "",
          "workspace temporarily locked",
        );
        yield* Ref.set(failCleanup, false);
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
        assert.equal(yield* Ref.get(removed), 1);
        assert.deepEqual(yield* outbox.listWorkspaceCleanupFailures(), []);
      }).pipe(Effect.provide(testLayer));
    }),
);

it.effect(
  "recovers a previous deleted owner's failed shutdown before cleaning a shared workspace",
  () =>
    Effect.gen(function* () {
      const removed = yield* Ref.make(0);
      const oldOwnerId = ThreadId.make("cleanup-previous-owner");
      const finalOwnerId = ThreadId.make("cleanup-final-owner");
      const activeOwnerId = ThreadId.make("cleanup-active-owner");
      const detachId = "previous-owner-failed-detach";
      const cleanupId = "final-owner-cleanup";
      const workerId = "shared-cleanup-worker";
      const testLayer = effectWorkerLayerWithOptions({ workerId, maxAttempts: 1 }).pipe(
        Layer.provide(
          Layer.succeed(OrchestrationEffectExecutorV2, {
            execute: (effect) =>
              effect.request.type === "thread-workspace.cleanup"
                ? Ref.update(removed, (count) => count + 1)
                : Effect.void,
          }),
        ),
        Layer.provideMerge(effectOutboxLayer),
        Layer.provideMerge(SqlitePersistenceMemory),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* OrchestrationEffectWorkerV2;
        const now = DateTime.formatIso(yield* DateTime.now);
        // Only ownership columns are consumed by the outbox dependency query.
        for (const ownerId of [oldOwnerId, finalOwnerId, activeOwnerId]) {
          const payload = '{"ownedWorktreePath":"/owned/shared-worktree"}';
          const deletedAt = ownerId === activeOwnerId ? null : now;
          yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json) VALUES (${ownerId}, 'shared-project', 'Shared workspace owner', 'codex', 'codex', 'full-access', 'default', ${now}, ${now}, ${deletedAt}, ${payload})`;
        }
        const activeCleanupId = "active-owner-old-terminal-cleanup";
        yield* outbox.enqueue([
          {
            id: activeCleanupId,
            commandId: CommandId.make("active-owner:past-settle"),
            threadId: activeOwnerId,
            request: { type: "terminal.cleanup" },
          },
        ]);
        yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 });
        yield* outbox.fail({
          effectId: activeCleanupId,
          workerId,
          error: "an unrelated retained thread's old cleanup",
        });
        yield* outbox.enqueue([
          {
            id: detachId,
            commandId: CommandId.make("previous-owner:settle"),
            threadId: oldOwnerId,
            request: { type: "provider-session.detach", providerSessionId: oldSessionId },
          },
        ]);
        const oldClaim = yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 });
        assert.isTrue(Option.isSome(oldClaim));
        yield* outbox.enqueue([
          {
            id: cleanupId,
            commandId: CommandId.make("final-owner:delete"),
            threadId: finalOwnerId,
            request: { type: "thread-workspace.cleanup" },
          },
        ]);
        yield* worker.runOnce;
        assert.equal(yield* Ref.get(removed), 0);
        assert.deepEqual(yield* outbox.listWorkspaceCleanupFailures(), []);
        yield* outbox.fail({
          effectId: detachId,
          workerId,
          error: "previous shutdown exhausted retries",
        });
        yield* TestClock.adjust("1 second");
        yield* worker.runOnce;
        const recovered = yield* outbox.get(detachId);
        if (Option.isNone(recovered)) return assert.fail("Missing shutdown dependency");
        assert.equal(recovered.value.status, "pending");
        assert.equal(recovered.value.attemptCount, 0);
        assert.isTrue(
          recovered.value.request.type === "provider-session.detach" &&
            recovered.value.request.durableRetry === true,
        );
        yield* worker.runOnce;
        assert.equal(yield* Ref.get(removed), 0);
        yield* TestClock.adjust("2 seconds");
        yield* worker.drain();
        assert.equal(yield* Ref.get(removed), 1);
        assert.deepEqual(yield* outbox.listWorkspaceCleanupFailures(), []);
        const activeCleanup = yield* outbox.get(activeCleanupId);
        assert.isTrue(Option.isSome(activeCleanup) && activeCleanup.value.status === "failed");
      }).pipe(Effect.provide(testLayer));
    }),
);
