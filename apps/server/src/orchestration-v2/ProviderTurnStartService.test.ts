import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  ContextTransferId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ProviderAdapterForkThreadError } from "./ProviderAdapter.ts";

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

it("atomically resolves a failed native fork as portable context when startup commits", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_native_fallback");
  const sourceThreadId = ThreadId.make("thread_provider_turn_start_native_fallback_source");
  const runId = RunId.make("run_provider_turn_start_native_fallback");
  const sourceRunId = RunId.make("run_provider_turn_start_native_fallback_source");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_native_fallback");
  const sourceAttemptId = RunAttemptId.make("attempt_provider_turn_start_native_fallback_source");
  const rootNodeId = NodeId.make("node_provider_turn_start_native_fallback");
  const providerThreadId = ProviderThreadId.make("provider_thread_native_fallback");
  const sourceProviderThreadId = ProviderThreadId.make("provider_thread_native_fallback_source");
  const providerSessionId = ProviderSessionId.make("provider_session_native_fallback");
  const messageId = MessageId.make("message_provider_turn_start_native_fallback");
  const checkpointScopeId = CheckpointScopeId.make("checkpoint_scope_native_fallback");
  const providerInstanceId = ProviderInstanceId.make("provider_native_fallback");
  const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
  const now = DateTime.makeUnsafe("2026-08-12T00:00:00.000Z");
  const transferId = ContextTransferId.make("transfer_native_fallback");
  const targetProjection = {
    thread: { id: threadId, modelSelection, worktreePath: "/workspace" },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        ordinal: 1,
        modelSelection,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        nativeThreadRef: null,
        handoffIds: [],
        forkedFrom: { providerThreadId: sourceProviderThreadId },
      },
    ],
    providerTurns: [],
    messages: [
      {
        id: messageId,
        text: "Continue here",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [
      {
        id: transferId,
        type: "fork",
        sourceThreadId,
        targetThreadId: threadId,
        sourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
        targetRunId: runId,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        status: "pending",
        resolution: null,
      },
    ],
    turnItems: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const sourceProjection = {
    ...targetProjection,
    thread: { ...targetProjection.thread, id: sourceThreadId },
    runs: [
      {
        ...targetProjection.runs[0],
        id: sourceRunId,
        status: "completed",
        ordinal: 2,
        activeAttemptId: sourceAttemptId,
        providerThreadId: sourceProviderThreadId,
      },
    ],
    attempts: [{ id: sourceAttemptId, providerTurnId: null }],
    providerThreads: [
      {
        ...targetProjection.providerThreads[0],
        id: sourceProviderThreadId,
        nativeThreadRef: { driver: "codex", nativeId: "native-source", strength: "strong" },
        forkedFrom: null,
      },
    ],
    turnItems: [
      {
        createdBy: "user",
        creationSource: "web",
        id: TurnItemId.make("turn-item-native-fallback-source"),
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId: sourceProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("message-native-fallback-source"),
        inputIntent: "turn_start",
        text: "Remember the portable source fact.",
        attachments: [],
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;

  const durableWrites: Array<{
    readonly events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>;
  }> = [];
  const write = vi.fn((input: (typeof durableWrites)[number]) => {
    durableWrites.push(input);
    return Effect.succeed({ storedEvents: [] } as never);
  });
  const currentWrites: typeof durableWrites = [];
  const writeIfRunCurrent = vi.fn((input: (typeof currentWrites)[number]) => {
    currentWrites.push(input);
    return Effect.succeed({ committed: true, storedEvents: [] } as never);
  });
  const forkThread = vi.fn(() =>
    Effect.fail(
      new ProviderAdapterForkThreadError({
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: sourceProviderThreadId,
        cause: "native fork failed after dispatch",
      }),
    ),
  );
  const ensureThread = vi.fn(() =>
    Effect.succeed({
      ...targetProjection.providerThreads[0],
      nativeThreadRef: { driver: "codex", nativeId: "portable-target", strength: "strong" },
    } as never),
  );
  let startedMessage: string | undefined;
  const startRootRun = vi.fn((input: { readonly message: { readonly text: string } }) => {
    startedMessage = input.message.text;
    return Effect.void;
  });
  const open = vi.fn(() =>
    Effect.succeed({
      driver: "codex",
      providerSession: {
        id: providerSessionId,
        capabilities: CodexProviderCapabilitiesV2,
      },
      forkThread,
      ensureThread,
    } as never),
  );
  const testLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        Layer.mock(EventSink.EventSinkV2)({ write, writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: (requestedThreadId: ThreadId) =>
            Effect.succeed(
              requestedThreadId === sourceThreadId ? sourceProjection : targetProjection,
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/workspace" } as never),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });

    expect(forkThread).toHaveBeenCalledOnce();
    expect(ensureThread).toHaveBeenCalledOnce();
    expect(startRootRun).toHaveBeenCalledOnce();
    expect(durableWrites).toEqual([]);
    const fallbackEvents = currentWrites.flatMap((entry) => entry.events);
    expect(fallbackEvents.some((event) => event.type === "context-handoff.updated")).toBe(true);
    const transfers = fallbackEvents
      .filter((event) => event.type === "context-transfer.updated")
      .map((event) => event.payload) as ReadonlyArray<{
      status?: string;
      resolution?: { strategy?: string };
    }>;
    const transfer = transfers[0];
    expect(transfer?.status).toBe("resolved_portable");
    expect(transfer?.resolution?.strategy).toBe("portable_context");
    const consumedTransfer = transfers[1];
    expect(consumedTransfer?.status).toBe("consumed");
    expect(consumedTransfer?.resolution?.strategy).toBe("portable_context");
    expect(startedMessage).toContain("Context handoff (full_thread_summary):");
    expect(startedMessage).toContain("Remember the portable source fact.");
  }).pipe(Effect.provide(testLayer), Effect.runPromise);
});
