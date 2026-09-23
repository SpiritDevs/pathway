/**
 * The orchestration graph Computer approvals run on, as server.ts composes it,
 * plus a thread with one running turn to ask approvals for.
 *
 * @module computer/computerApprovals.testkit
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { layer as projectionStoreLayer } from "../orchestration-v2/ProjectionStore.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ComputerApprovalGate from "./ComputerApprovalGate.ts";
import {
  computerApprovalRequesterLayer,
  computerServerOwnedRuntimeRequestsLayer,
} from "./computerApprovalRequester.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-computer-approvals-",
});
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfigLayer),
      Layer.provide(NodeServices.layer),
    ),
  ),
);
const NoProviderInstances = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const OrchestrationStores = Layer.mergeAll(
  OrchestrationV2EventSinkLayerLive,
  projectionStoreLayer,
  idAllocatorLayer,
);
// The composition server.ts uses: one gate, shared by the orchestrator's
// answer routing and the requester that posts through the same event sink.
const GateLive = ComputerApprovalGate.layer.pipe(
  Layer.provide(computerApprovalRequesterLayer.pipe(Layer.provide(OrchestrationStores))),
);

/** The orchestrator, its stores and the Computer approval gate, in memory. */
export const ComputerApprovalsTestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive.pipe(
    Layer.provide(computerServerOwnedRuntimeRequestsLayer.pipe(Layer.provide(GateLive))),
  ),
  OrchestrationStores,
  GateLive,
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provide(NoProviderInstances),
  Layer.provideMerge(NodeServices.layer),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

/** A thread with one running turn on a live provider session. */
export const seedRunningTurn = Effect.fn("seedRunningTurn")(function* (
  name: string,
  runtimeMode: RuntimeMode = "approval-required",
) {
  const orchestrator = yield* OrchestratorV2;
  const eventSink = yield* EventSinkV2;
  const threadId = ThreadId.make(`${name}-thread`);
  const runId = RunId.make(`${name}-run`);
  const attemptId = RunAttemptId.make(`${name}-attempt`);
  const rootNodeId = NodeId.make(`${name}-root`);
  const providerThreadId = ProviderThreadId.make(`${name}-provider-thread`);
  const driver = ProviderDriverKind.make("codex");
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`${name}-create`),
    threadId,
    projectId: ProjectId.make(`${name}-project`),
    title: "Computer approvals",
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: `/tmp/${name}`,
  });
  const now = yield* DateTime.now;
  const event = (suffix: string) => EventId.make(`${name}-${suffix}`);
  yield* eventSink.write({
    events: [
      {
        id: event("provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: ProviderSessionId.make(`${name}-session`),
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: event("run"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`${name}-message`),
          rootNodeId,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: event("attempt"),
        type: "run-attempt.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
    ],
  });
  return { threadId, runId };
});

/** The Computer card the gate posted for the thread, once it lands. */
export const pendingComputerRequest = Effect.fn("pendingComputerRequest")(function* (threadId: ThreadId) {
  const orchestrator = yield* OrchestratorV2;
  // The card is posted from the gate's publisher fiber; let it land.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const request = projection.runtimeRequests.find(
      (candidate) => candidate.kind === "computer" && candidate.status === "pending",
    );
    if (request !== undefined) return { request, projection };
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("the Computer approval card was never posted");
});
