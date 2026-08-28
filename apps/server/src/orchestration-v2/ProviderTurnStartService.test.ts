import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  ContextHandoffId,
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
} from "@spiritdevs/contracts";
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
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const unusedTextGenerationLayer = Layer.mock(TextGeneration)({});
const serverSettingsLayer = ServerSettingsService.layerTest();

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
        unusedTextGenerationLayer,
        serverSettingsLayer,
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
        unusedTextGenerationLayer,
        serverSettingsLayer,
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
        unusedTextGenerationLayer,
        serverSettingsLayer,
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

it("seeds related child routing only from routable subagents", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_related_seed");
  const runId = RunId.make("run_provider_turn_start_related_seed");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_related_seed");
  const rootNodeId = NodeId.make("node_provider_turn_start_related_seed");
  const providerThreadId = ProviderThreadId.make("provider_thread_related_seed");
  const providerSessionId = ProviderSessionId.make("provider_session_related_seed");
  const messageId = MessageId.make("message_provider_turn_start_related_seed");
  const checkpointScopeId = CheckpointScopeId.make("checkpoint_scope_related_seed");
  const providerInstanceId = ProviderInstanceId.make("provider_related_seed");
  const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
  const makeSubagent = (key: string, status: string, withChild = true) => ({
    id: NodeId.make(`node_related_seed_${key}`),
    threadId,
    status,
    childThreadId: withChild ? ThreadId.make(`thread_related_seed_${key}_child`) : null,
    providerThreadId: withChild
      ? ProviderThreadId.make(`provider_thread_related_seed_${key}_child`)
      : null,
  });
  const projection = {
    thread: { id: threadId, modelSelection },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        ordinal: 2,
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
        providerInstanceId,
        nativeThreadRef: null,
        handoffIds: [],
        forkedFrom: null,
      },
    ],
    providerTurns: [],
    messages: [
      { id: messageId, text: "Resume", attachments: [], createdBy: "user", creationSource: "web" },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    subagents: [
      makeSubagent("running", "running"),
      makeSubagent("completed", "completed"),
      makeSubagent("interrupted", "interrupted"),
      makeSubagent("failed", "failed"),
      makeSubagent("cancelled", "cancelled"),
      makeSubagent("unlinked", "running", false),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  let related:
    | {
        readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
        readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
      }
    | undefined;
  const startRootRun = vi.fn((input: NonNullable<typeof related>) => {
    related = input;
    return Effect.void;
  });
  const ensureThread = vi.fn(() => Effect.succeed({ ...projection.providerThreads[0] } as never));
  const testLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: ProviderDriverKind.make("codex"),
              providerSession: { id: providerSessionId, capabilities: CodexProviderCapabilitiesV2 },
              ensureThread,
            } as never),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/workspace" } as never),
        }),
        unusedTextGenerationLayer,
        serverSettingsLayer,
      ),
    ),
  );

  await Effect.gen(function* () {
    yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });

    expect(startRootRun).toHaveBeenCalledOnce();
    // canRouteRelatedSubagent: terminal-at-start (interrupted/failed/cancelled)
    // subagents must not seed child routing; unlinked rows contribute nothing.
    expect(related?.relatedThreadIds).toEqual([
      ThreadId.make("thread_related_seed_running_child"),
      ThreadId.make("thread_related_seed_completed_child"),
    ]);
    expect(related?.relatedProviderThreadIds).toEqual([
      ProviderThreadId.make("provider_thread_related_seed_running_child"),
      ProviderThreadId.make("provider_thread_related_seed_completed_child"),
    ]);
  }).pipe(Effect.provide(testLayer), Effect.runPromise);
});

it("generates and persists a pending model-switch summary before starting the provider", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_compaction");
  const sourceRunId = RunId.make("run_provider_turn_start_compaction_source");
  const runId = RunId.make("run_provider_turn_start_compaction_target");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_compaction");
  const rootNodeId = NodeId.make("node_provider_turn_start_compaction");
  const checkpointScopeId = CheckpointScopeId.make("checkpoint_scope_compaction");
  const providerThreadId = ProviderThreadId.make("provider_thread_compaction_target");
  const sourceProviderThreadId = ProviderThreadId.make("provider_thread_compaction_source");
  const providerSessionId = ProviderSessionId.make("provider_session_compaction");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const messageId = MessageId.make("message_provider_turn_start_compaction");
  const handoffId = ContextHandoffId.make("handoff_provider_turn_start_compaction");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.6-sol" };
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId,
    nativeThreadRef: { driver: "codex", nativeId: "native-target", strength: "strong" },
  };
  const projection = {
    thread: { id: threadId, modelSelection, worktreePath: "/workspace" },
    runs: [
      {
        id: sourceRunId,
        status: "completed",
        ordinal: 1,
        providerThreadId: sourceProviderThreadId,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.5" },
      },
      {
        id: runId,
        status: "starting",
        ordinal: 2,
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        providerSessionId,
        userMessageId: messageId,
        modelSelection,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerSessions: [
      { id: providerSessionId, providerInstanceId, status: "ready", cwd: "/workspace" },
    ],
    providerThreads: [providerThread],
    providerTurns: [],
    messages: [
      {
        id: messageId,
        text: "Continue after compaction",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextTransfers: [],
    contextHandoffs: [
      {
        id: handoffId,
        targetRunId: runId,
        status: "pending",
        strategy: "full_thread_summary",
        summaryText: "deterministic fallback",
        coveredRunOrdinals: { from: 1, to: 1 },
        compaction: {
          sourceChars: 20_000,
          thresholdChars: 16_000,
          maxSummaryChars: 8_000,
          generation: "pending",
        },
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("turn-item-compaction-source"),
        runId: sourceRunId,
        status: "completed",
        type: "user_message",
        text: "Important source context",
        attachments: [],
      },
      {
        id: TurnItemId.make("turn-item-compaction-row"),
        runId,
        nodeId: rootNodeId,
        status: "running",
        type: "compaction",
        contextHandoffId: handoffId,
      },
    ],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;

  const writes: Array<ReadonlyArray<{ readonly type: string; readonly payload: unknown }>> = [];
  const writeIfRunCurrent = vi.fn((input: { readonly events: (typeof writes)[number] }) => {
    writes.push(input.events);
    return Effect.succeed({ committed: true, storedEvents: [] } as never);
  });
  let startedMessage = "";
  const startRootRun = vi.fn((input: { readonly message: { readonly text: string } }) => {
    startedMessage = input.message.text;
    return Effect.void;
  });
  const investigate = vi.fn(() =>
    Effect.succeed({ text: "## Current goal and latest user intent\n- Generated summary" }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          write: () => Effect.succeed({ storedEvents: [] } as never),
          writeIfRunCurrent,
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              providerSession: {
                id: providerSessionId,
                capabilities: CodexProviderCapabilitiesV2,
              },
              resumeThread: () => Effect.succeed(providerThread as never),
            } as never),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/workspace" } as never),
        }),
        Layer.succeed(TextGeneration, { investigate } as never),
        serverSettingsLayer,
      ),
    ),
  );

  await ProviderTurnStart.ProviderTurnStartServiceV2.pipe(
    Effect.flatMap((service) => service.start({ threadId, runId })),
    Effect.provide(layer),
    Effect.runPromise,
  );

  expect(investigate).toHaveBeenCalledOnce();
  expect(startedMessage).toContain("Generated summary");
  const events = writes.flat();
  expect(
    events.some(
      (event) =>
        event.type === "context-handoff.updated" &&
        (event.payload as { compaction?: { generation?: string } }).compaction?.generation ===
          "model",
    ),
  ).toBe(true);
});
