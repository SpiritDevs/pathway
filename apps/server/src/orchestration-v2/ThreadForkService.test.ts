import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { layer, ThreadForkServiceV2 } from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    settleAfterCompletion: true,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    titleRegeneration: {
      requestId: CommandId.make("command:fork-source-title"),
      startedAt: snoozedAt,
    },
    workspaceMove: {
      id: CommandId.make("command:fork-source-move"),
      status: "running",
      phase: "creating_worktree",
      sourceCwd: "/tmp/project",
      sourceHead: null,
      fileCount: 0,
      terminalCount: 0,
      transferStashOid: null,
      targetWorktreePath: null,
      targetBranch: null,
      setup: "pending",
      detail: null,
      startedAt: snoozedAt,
      updatedAt: snoozedAt,
      completedAt: null,
    },
    browserTakeover: {
      id: CommandId.make("command:fork-source-takeover"),
      status: "active",
      runId: sourceRunId,
      providerSessionId: "provider-session:fork-source",
      tabId: "tab:fork-source",
      hostClientId: "client:fork-source",
      hostConnectionId: "connection:fork-source",
      failure: null,
      requestedAt: snoozedAt,
      updatedAt: snoozedAt,
    },
    previewActivity: {
      runId: sourceRunId,
      providerSessionId: "provider-session:fork-source",
      tabId: "tab:fork-source",
      hostClientId: "client:fork-source",
      lastActivityAt: snoozedAt,
    },
    deletedAt: null,
  };
}

function makeCompletedSourceRun(): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeCompletedSourceRun();
    const sourceProjection: OrchestrationV2ThreadProjection = {
      thread: sourceThread,
      runs: [sourceRun],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: snoozedAt,
    };
    const service = yield* ThreadForkServiceV2;
    const result = yield* service.plan({
      sourceProjection,
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      forkKind: "side_chat",
      compactContext: true,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isTrue(result.transfer.compactContext);
    assert.isNull(result.targetThread.snoozedAt);
    // The source's in-flight operations settle only on the source.
    assert.isNull(result.targetThread.titleRegeneration);
    assert.isNull(result.targetThread.workspaceMove);
    assert.isNull(result.targetThread.browserTakeover);
    assert.isNull(result.targetThread.previewActivity);
    assert.isFalse(result.targetThread.settleAfterCompletion);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.equal(result.targetThread.forkKind, "side_chat");
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }).pipe(Effect.provide(layer)),
);
