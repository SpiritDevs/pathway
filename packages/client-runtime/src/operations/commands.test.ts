import { CompanyId } from "@spiritdevs/contracts/company";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ContinuationLaunchInput,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
  type ChatAttachment,
  type PersistChatAttachmentsInput,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  attachThreadProject,
  setThreadTemporary,
  archiveThread,
  attachPullRequest,
  createProject,
  deleteThread,
  detachPullRequest,
  forkThreadFromRun,
  launchThreadContinuation,
  mergeThreadBack,
  cancelQueuedRun,
  editQueuedRun,
  editAndRestartMessage,
  promoteQueuedRun,
  reorderQueuedRun,
  revertThreadCheckpoint,
  setSettleAfterCompletion,
  settleThread,
  startThreadTurn,
  unsettleThread,
  updateProject,
  updateThreadMetadata,
  respondToThreadUserInput,
} from "./commands.ts";

class LaunchTestError extends Schema.TaggedErrorClass<LaunchTestError>()("LaunchTestError", {
  phase: Schema.Literals(["attachments", "launch", "settings"]),
}) {}

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly failCommandType?: OrchestrationV2Command["type"];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly launchCalls?: string[];
  readonly launchFailure?: "attachments" | "launch";
  readonly savedAttachments?: readonly ChatAttachment[];
  readonly attachmentRequests?: PersistChatAttachmentsInput[];
  readonly continuationLaunches?: OrchestrationV2ContinuationLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly resolvedPullRequest?: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly state: "open" | "closed" | "merged";
  };
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.gen(function* () {
        input.commands.push(command);
        if (command.type === input.failCommandType) {
          return yield* new LaunchTestError({ phase: "settings" });
        }
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
      Effect.succeed(input.projection ?? v2Projection),
    [WS_METHODS.assetsPersistChatAttachments]: (request: PersistChatAttachmentsInput) =>
      Effect.gen(function* () {
        input.attachmentRequests?.push(request);
        input.launchCalls?.push("attachments");
        if (input.launchFailure === "attachments")
          return yield* new LaunchTestError({ phase: "attachments" });
        return { attachments: input.savedAttachments ?? [] };
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.gen(function* () {
        input.launchCalls?.push("launch");
        input.launches?.push(launchInput);
        if (input.launchFailure === "launch")
          return yield* new LaunchTestError({ phase: "launch" });
        return {
          threadId: launchInput.threadId ?? v2ThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchContinuation]: (
      launchInput: OrchestrationV2ContinuationLaunchInput,
    ) =>
      Effect.sync(() => {
        input.continuationLaunches?.push(launchInput);
        return {
          threadId: launchInput.targetThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
    [WS_METHODS.gitResolvePullRequest]: () =>
      Effect.succeed({
        pullRequest: input.resolvedPullRequest ?? {
          number: 47,
          title: "Attach published PR",
          url: "https://github.com/SpiritDevs/pathway/pull/47",
          baseBranch: "main",
          headBranch: "feature/attach-pr",
          state: "open",
        },
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("saves question uploads before responding and preserves their question ownership", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const attachmentRequests: PersistChatAttachmentsInput[] = [];
      const first = {
        type: "image" as const,
        id: "pending-00000000-0000-4000-8000-000000000001-png",
        name: "layout.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const second = {
        ...first,
        id: "pending-00000000-0000-4000-8000-000000000002-png",
        name: "color.png",
      };
      const savedAttachments = [first, second].map((attachment) => ({
        ...attachment,
        id: attachment.id.replace("pending", "thread"),
      }));
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        attachmentRequests,
        savedAttachments,
      });
      yield* respondToThreadUserInput({
        threadId: v2ThreadId,
        requestId: RuntimeRequestId.make("question"),
        answers: { layout: "", color: "Blue" },
        attachmentsByQuestionId: { layout: [first], color: [second] },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(attachmentRequests).toEqual([
        {
          threadId: v2ThreadId,
          messageId: "question:00000000-0000-4000-8000-000000000000",
          attachments: [first, second],
        },
      ]);
      expect(commands).toEqual([
        expect.objectContaining({
          type: "runtime-request.respond",
          answers: { layout: "", color: "Blue" },
          attachmentsByQuestionId: { layout: [savedAttachments[0]], color: [savedAttachments[1]] },
        }),
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps the question pending when saving an upload fails", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        launchFailure: "attachments",
      });
      const result = yield* respondToThreadUserInput({
        threadId: v2ThreadId,
        requestId: RuntimeRequestId.make("question"),
        answers: { layout: "" },
        attachmentsByQuestionId: {
          layout: [
            {
              type: "image",
              id: "pending-00000000-0000-4000-8000-000000000001-png",
              name: "layout.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          ],
        },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(commands).toEqual([]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("routes projects through the event-sourced project transport", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });

      yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createWorkspaceRootIfMissing: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projects).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createWorkspaceRootIfMissing: true,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("forwards project favicon overrides and resets without changing the path", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });
      const environment = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );

      yield* updateProject({
        projectId: ProjectId.make("project-1"),
        faviconPath: "brand assets/nested/project icon.svg",
      }).pipe(environment);
      yield* updateProject({
        projectId: ProjectId.make("project-1"),
        faviconPath: null,
      }).pipe(environment);

      expect(projects).toEqual([
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          faviconPath: "brand assets/nested/project icon.svg",
        },
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          faviconPath: null,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("forwards project new-thread workspace overrides and resets", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });
      const environment = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );

      yield* updateProject({
        projectId: ProjectId.make("project-1"),
        defaultThreadEnvMode: "worktree",
      }).pipe(environment);
      yield* updateProject({
        projectId: ProjectId.make("project-1"),
        defaultThreadEnvMode: null,
      }).pipe(environment);

      expect(projects).toEqual([
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          defaultThreadEnvMode: "worktree",
        },
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          defaultThreadEnvMode: null,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("marks an explicit project rename as custom", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });

      yield* updateProject({
        projectId: ProjectId.make("project-1"),
        title: "pathway",
        titleIsCustom: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projects).toEqual([
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "pathway",
          titleIsCustom: true,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves caller command ids for idempotent V2 commands", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* archiveThread({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "thread.archive", commandId: "queued-command", threadId: "thread-1" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("passes a projection precondition through guarded thread deletion", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* deleteThread({
        commandId: CommandId.make("guarded-delete"),
        threadId: ThreadId.make("thread-1"),
        replaceableInitialThread: {
          messageId: MessageId.make("message-1"),
          runId: RunId.make("run-1"),
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "thread.delete",
          commandId: "guarded-delete",
          threadId: "thread-1",
          replaceableInitialThread: { messageId: "message-1", runId: "run-1" },
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("resolves and attaches a pull request through the source-control marker command", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      const pullRequest = yield* attachPullRequest({
        commandId: CommandId.make("attach-pr-command"),
        threadId: ThreadId.make("thread-1"),
        cwd: "/workspace/pathway",
        reference: "https://github.com/SpiritDevs/pathway/pull/47",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(pullRequest.number).toBe(47);
      expect(commands).toEqual([
        {
          type: "thread.source-control.record",
          commandId: "attach-pr-command",
          threadId: "thread-1",
          committed: false,
          pullRequestAction: "attached",
          pullRequest: {
            number: 47,
            url: "https://github.com/SpiritDevs/pathway/pull/47",
          },
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("records a detached pull request without claiming a push or commit", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* detachPullRequest({
        commandId: CommandId.make("detach-pr-command"),
        threadId: ThreadId.make("thread-1"),
        pullRequest: {
          number: 47,
          url: "https://github.com/SpiritDevs/pathway/pull/47",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "thread.source-control.record",
          commandId: "detach-pr-command",
          threadId: "thread-1",
          committed: false,
          pullRequestAction: "detached",
          pullRequest: {
            number: 47,
            url: "https://github.com/SpiritDevs/pathway/pull/47",
          },
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("launches continuation through the composite V2 request", () =>
    Effect.gen(function* () {
      const continuationLaunches: OrchestrationV2ContinuationLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        continuationLaunches,
      });

      const result = yield* launchThreadContinuation({
        commandId: CommandId.make("continue-command"),
        creationSource: "mobile",
        sourceThreadId: v2ThreadId,
        sourceRunId: RunId.make("run-source"),
        targetThreadId: ThreadId.make("thread-continuation"),
        title: "Continue here",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus-4-1",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceTarget: "new-worktree",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(continuationLaunches).toEqual([
        {
          commandId: "continue-command",
          creationSource: "mobile",
          sourceThreadId: v2ThreadId,
          sourceRunId: "run-source",
          targetThreadId: "thread-continuation",
          title: "Continue here",
          modelSelection: { instanceId: "claude", model: "claude-opus-4-1" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceTarget: "new-worktree",
        },
      ]);
      expect(result.threadId).toBe("thread-continuation");
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches one V2 edit-and-restart command with a replacement message id", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* editAndRestartMessage({
        commandId: CommandId.make("edit-message"),
        threadId: v2ThreadId,
        messageId: MessageId.make("message-original"),
        replacementMessageId: MessageId.make("message-replacement"),
        text: "Corrected text",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "message.edit-and-restart",
          commandId: "edit-message",
          createdBy: "user",
          creationSource: "web",
          threadId: v2ThreadId,
          messageId: "message-original",
          replacementMessageId: "message-replacement",
          text: "Corrected text",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("resolves run ordinal zero to the first run's root-scope baseline", () =>
    Effect.gen(function* () {
      const firstRunId = RunId.make("run-1");
      const secondRunId = RunId.make("run-2");
      const firstRootNodeId = NodeId.make("node-run-1");
      const secondRootNodeId = NodeId.make("node-run-2");
      const firstScopeId = CheckpointScopeId.make("checkpoint-scope-run-1");
      const secondScopeId = CheckpointScopeId.make("checkpoint-scope-run-2");
      const firstBaselineId = CheckpointId.make("checkpoint-run-1-baseline");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: firstRunId,
            threadId: v2ThreadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            providerThreadId: null,
            userMessageId: MessageId.make("message-run-1"),
            rootNodeId: firstRootNodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: v2Now,
            checkpointId: null,
            contextHandoffId: null,
          },
          {
            id: secondRunId,
            threadId: v2ThreadId,
            ordinal: 2,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            providerThreadId: null,
            userMessageId: MessageId.make("message-run-2"),
            rootNodeId: secondRootNodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: v2Now,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        checkpointScopes: [
          {
            id: firstScopeId,
            threadId: v2ThreadId,
            runId: firstRunId,
            nodeId: firstRootNodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/workspace/run-1",
            createdAt: v2Now,
          },
          {
            id: secondScopeId,
            threadId: v2ThreadId,
            runId: secondRunId,
            nodeId: secondRootNodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/workspace/run-2",
            createdAt: v2Now,
          },
        ],
        checkpoints: [
          {
            id: firstBaselineId,
            threadId: v2ThreadId,
            scopeId: firstScopeId,
            runId: null,
            nodeId: firstRootNodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/pathway/run-1-baseline"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
          {
            id: CheckpointId.make("checkpoint-run-2-baseline"),
            threadId: v2ThreadId,
            scopeId: secondScopeId,
            runId: null,
            nodeId: secondRootNodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/pathway/run-2-baseline"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* revertThreadCheckpoint({
        commandId: CommandId.make("rollback-thread-start"),
        threadId: v2ThreadId,
        turnCount: 0,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "checkpoint.rollback",
          commandId: "rollback-thread-start",
          threadId: v2ThreadId,
          scopeId: firstScopeId,
          checkpointId: firstBaselineId,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("persists changed send settings before dispatching an existing thread message", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* startThreadTurn({
        commandId: CommandId.make("send-settings"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-settings"),
          role: "user",
          text: "Review the next step",
          attachments: [],
        },
        branch: "feature/review",
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toMatchObject([
        {
          type: "thread.metadata.update",
          commandId: "send-settings:branch",
          threadId: v2ThreadId,
          branch: "feature/review",
        },
        {
          type: "thread.runtime-mode.set",
          commandId: "send-settings:runtime-mode",
          threadId: v2ThreadId,
          runtimeMode: "approval-required",
        },
        {
          type: "thread.interaction-mode.set",
          commandId: "send-settings:interaction-mode",
          threadId: v2ThreadId,
          interactionMode: "plan",
        },
        { type: "message.dispatch", commandId: "send-settings" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("clears explicit branch metadata without rewriting unchanged send settings", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projection: {
          ...v2Projection,
          thread: { ...v2Projection.thread, branch: "feature/old" },
        },
      });

      yield* startThreadTurn({
        commandId: CommandId.make("clear-branch"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-clear-branch"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        branch: null,
        runtimeMode: v2Projection.thread.runtimeMode,
        interactionMode: v2Projection.thread.interactionMode,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toMatchObject([
        { type: "thread.metadata.update", branch: null },
        { type: "message.dispatch" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not dispatch a message when its permission update fails", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        failCommandType: "thread.runtime-mode.set",
      });

      const result = yield* startThreadTurn({
        commandId: CommandId.make("failed-settings"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-failed-settings"),
          role: "user",
          text: "Continue with approvals",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(commands).toMatchObject([
        { type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves plan implementation provenance on V2 runs", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* startThreadTurn({
        commandId: CommandId.make("implement-plan"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-implementation"),
          role: "user",
          text: "Implement the plan",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Implement the plan",
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-plan"),
          planId: PlanId.make("plan-1"),
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "implement-plan",
        threadId: v2ThreadId,
        titleSeed: "Implement the plan",
        sourcePlanRef: { threadId: "thread-plan", planId: "plan-1" },
        dispatchMode: { type: "start_immediately" },
      });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  for (const failure of ["attachments", "launch", undefined] as const) {
    it.effect(`notifies dispatch only after preparation (${failure ?? "success"})`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const launches: OrchestrationV2ThreadLaunchInput[] = [];
        let pinned = false;
        const supervisor = yield* makeSupervisor({
          commands: [],
          projects: [],
          launches,
          launchCalls: calls,
          ...(failure === undefined ? {} : { launchFailure: failure }),
        });
        const result = yield* startThreadTurn({
          commandId: CommandId.make("launch-boundary"),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make("launch-boundary-message"),
            role: "user",
            text: "Start here",
            attachments: [
              {
                type: "image",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 1,
                dataUrl: "data:image/png;base64,AQ==",
              },
            ],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: ProjectId.make("project-1"),
              title: "Thread",
              modelSelection: v2Projection.thread.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-06-20T00:00:00.000Z",
            },
          },
          onLaunchDispatch: () => {
            pinned = true;
            calls.push("pin");
          },
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(result)).toBe(failure !== undefined);
        expect(calls).toEqual(
          failure === "attachments" ? ["attachments"] : ["attachments", "pin", "launch"],
        );
        expect(pinned).toBe(failure !== "attachments");
        expect(launches).toHaveLength(failure === "attachments" ? 0 : 1);
        if (launches[0]) expect(launches[0]).not.toHaveProperty("onLaunchDispatch");
      }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
    );
  }

  it.effect("does not notify launch dispatch for an existing thread message", () =>
    Effect.gen(function* () {
      let notified = false;
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      yield* startThreadTurn({
        commandId: CommandId.make("existing-message"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("existing-message"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        onLaunchDispatch: () => {
          notified = true;
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(notified).toBe(false);
      expect(commands[0]).toMatchObject({ type: "message.dispatch" });
      expect(commands[0]).not.toHaveProperty("onLaunchDispatch");
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves an existing worktree and branch during first-message launch", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-worktree"),
          role: "user",
          text: "Continue here",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Continue here",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/workspace/project-worktrees/feature",
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        title: "Continue here",
        generateTitle: true,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/workspace/project-worktrees/feature",
          branch: "feature",
        },
      });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("provisions an origin-based worktree for an existing empty thread", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-thread-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-thread-worktree"),
          role: "user",
          text: "Move to a worktree",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/workspace/project",
            baseBranch: "main",
            branch: "feature",
            startFromOrigin: true,
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        reuseExistingThread: true,
        projectId: v2Projection.thread.projectId,
        workspaceStrategy: {
          type: "worktree",
          baseRef: "main",
          branch: "feature",
          startFromOrigin: true,
        },
      });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("maps explicit active-run delivery modes to V2 dispatch semantics", () =>
    Effect.gen(function* () {
      const activeRunId = RunId.make("run-active");
      const now = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: activeRunId,
            threadId: v2ThreadId,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message-active"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      for (const [mode, expectedType] of [
        ["queue", "queue_after_active"],
        ["steer", "steer_active"],
        ["restart", "restart_active"],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`message-${mode}`),
            role: "user",
            text: mode,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: mode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(commands.at(-1)).toMatchObject({
          type: "message.dispatch",
          dispatchMode: {
            type: expectedType,
            ...(mode === "queue" ? {} : { targetRunId: activeRunId }),
          },
        });
      }
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect(
    "dispatches V2-native relationship and queue commands without compatibility shaping",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [] });
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisor,
        );

        yield* forkThreadFromRun({
          commandId: CommandId.make("fork"),
          sourceThreadId: v2ThreadId,
          targetThreadId: ThreadId.make("thread-fork"),
          runId: RunId.make("run-1"),
          forkKind: "side_chat",
        }).pipe(provide);
        yield* mergeThreadBack({
          commandId: CommandId.make("merge"),
          sourceThreadId: ThreadId.make("thread-fork"),
          targetThreadId: v2ThreadId,
          runId: RunId.make("run-2"),
        }).pipe(provide);
        yield* reorderQueuedRun({
          commandId: CommandId.make("reorder"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
          beforeRunId: RunId.make("run-4"),
        }).pipe(provide);
        yield* promoteQueuedRun({
          commandId: CommandId.make("promote"),
          threadId: v2ThreadId,
          queuedRunId: RunId.make("run-3"),
          targetRunId: RunId.make("run-active"),
        }).pipe(provide);
        yield* cancelQueuedRun({
          commandId: CommandId.make("cancel"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
        }).pipe(provide);
        yield* editQueuedRun({
          commandId: CommandId.make("edit"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
          text: "updated queued text",
        }).pipe(provide);

        expect(commands).toMatchObject([
          {
            type: "thread.fork",
            forkKind: "side_chat",
            sourcePoint: { type: "run", runId: "run-1" },
          },
          { type: "thread.merge_back", sourcePoint: { type: "run", runId: "run-2" } },
          { type: "queued-run.reorder", runId: "run-3", beforeRunId: "run-4" },
          {
            type: "queued-message.promote-to-steer",
            queuedRunId: "run-3",
            targetRunId: "run-active",
          },
          { type: "queued-run.cancel", runId: "run-3" },
          { type: "queued-run.edit", runId: "run-3", text: "updated queued text" },
        ]);
      }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("uses provider.switch when model selection changes provider instance", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* updateThreadMetadata({
        commandId: CommandId.make("switch-provider"),
        threadId: v2ThreadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-4-6",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "provider.switch",
          commandId: "switch-provider",
          threadId: v2ThreadId,
          modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6" },
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches settle lifecycle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands: dispatched, projects: [] });

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* settleThread({
        commandId: CommandId.make("force-settle-command"),
        threadId: ThreadId.make("thread-1"),
        force: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* setSettleAfterCompletion({
        commandId: CommandId.make("settle-after-completion-command"),
        threadId: ThreadId.make("thread-1"),
        enabled: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.settle",
          commandId: "force-settle-command",
          threadId: "thread-1",
          force: true,
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
        {
          type: "thread.settle-after-completion.set",
          commandId: "settle-after-completion-command",
          threadId: "thread-1",
          enabled: true,
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});

describe("conversation environment commands", () => {
  it.effect("preserves a projectless temporary launch and its selected company", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });
      yield* startThreadTurn({
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("conversation-message"),
          role: "user",
          text: "Make a file",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: null,
            temporary: true,
            conversationCompanyId: CompanyId.make("company-1"),
            title: "Conversation",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-09-08T00:00:00Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(launches[0]).toMatchObject({
        projectId: null,
        temporary: true,
        conversationCompanyId: "company-1",
        workspaceStrategy: { type: "root" },
      });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps attachment, retention and explicit discard addressed to the same thread", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const environment = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
      yield* attachThreadProject({
        threadId: v2ThreadId,
        projectId: ProjectId.make("project-1"),
      }).pipe(environment);
      yield* setThreadTemporary({ threadId: v2ThreadId, temporary: false, keep: true }).pipe(
        environment,
      );
      yield* settleThread({ threadId: v2ThreadId, discardChanges: true }).pipe(environment);
      expect(commands).toMatchObject([
        { type: "thread.project.attach", threadId: v2ThreadId, projectId: "project-1" },
        { type: "thread.temporary.set", threadId: v2ThreadId, temporary: false, keep: true },
        { type: "thread.settle", threadId: v2ThreadId, discardChanges: true },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
