import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  MessageId,
  ProviderInstanceId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: { id: threadId },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return projectionReadCount === 1
              ? Effect.succeed(projection)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "simulated inherited-background projection failure",
                  }),
                );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("does not create a native fork after the starting attempt was cancelled", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_cancelled_fork");
  const runId = RunId.make("run_provider_turn_start_cancelled_fork");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_cancelled_fork");
  const rootNodeId = NodeId.make("node_provider_turn_start_cancelled_fork");
  const providerThreadId = ProviderThreadId.make("provider_thread_cancelled_fork");
  const providerSessionId = ProviderSessionId.make("provider_session_cancelled_fork");
  const messageId = MessageId.make("message_provider_turn_start_cancelled_fork");
  const checkpointScopeId = CheckpointScopeId.make("checkpoint_scope_cancelled_fork");
  const providerInstanceId = ProviderInstanceId.make("provider_cancelled_fork");
  const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
  const runningProjection = {
    thread: { id: threadId, modelSelection },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 1,
        modelSelection,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerSessions: [],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [
      {
        type: "fork",
        targetThreadId: threadId,
        targetRunId: runId,
        status: "pending",
        resolution: null,
      },
    ],
    turnItems: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const cancelledProjection = {
    ...runningProjection,
    runs: runningProjection.runs.map((run) => ({ ...run, status: "cancelled" as const })),
  } as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const forkThread = vi.fn(() => Effect.die("native fork must not run"));
  const open = vi.fn(() => Effect.succeed({ forkThread } as never));
  const testLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return Effect.succeed(
              projectionReadCount < 3 ? runningProjection : cancelledProjection,
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({}),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/workspace" } as never),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
    yield* service.start({ threadId, runId });
    expect(open).toHaveBeenCalledOnce();
    expect(forkThread).not.toHaveBeenCalled();
  }).pipe(Effect.provide(testLayer), Effect.runPromise);
});
