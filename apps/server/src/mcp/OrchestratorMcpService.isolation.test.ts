import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpDelegateTaskOutcome,
  type OrchestratorMcpDelegateTaskResult,
  type ServerProvider,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  type DelegatedRunPreparationInput,
  ThreadLaunchError,
  ThreadLaunchService,
} from "../orchestration-v2/ThreadLaunchService.ts";
import {
  ThreadManagementService,
  layer as threadManagementLayer,
} from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { OrchestratorMcpService, layer as mcpServiceLayer } from "./OrchestratorMcpService.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");
const projectId = ProjectId.make("project:mcp-isolation");
const parentThreadId = ThreadId.make("thread:mcp-isolation-parent");
const parentCheckout = "/repo-worktrees/parent";
const provider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [
    { slug: modelSelection.model, name: modelSelection.model, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "mcp-delegate-isolation" },
  makeProviderAdapterRegistryLayer([
    {
      instanceId: modelSelection.instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Isolation tests never start providers"),
    },
  ]),
  { runEffectWorker: false },
);

const resolvedBases: Array<{ readonly projectId: ProjectId; readonly worktreePath: unknown }> = [];
const preparedRuns: Array<DelegatedRunPreparationInput> = [];
let checkoutIsGit = true;
const threadLaunchLayer = Layer.mock(ThreadLaunchService)({
  resolveWorktreeBase: (input) => {
    resolvedBases.push({ projectId: input.projectId, worktreePath: input.worktreePath });
    return checkoutIsGit
      ? Effect.succeed("parent-head-sha")
      : Effect.fail(
          new ThreadLaunchError({
            operation: "resolve-base",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: `${input.worktreePath} is not a git repository with a commit, so a separate worktree cannot be created.`,
          }),
        );
  },
  prepareDelegatedRun: (input) => Effect.sync(() => void preparedRuns.push(input)),
});
const testLayer = mcpServiceLayer.pipe(
  Layer.provideMerge(threadManagementLayer.pipe(Layer.provideMerge(orchestratorLayer))),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      threadLaunchLayer,
      Layer.mock(ScheduledTaskService)({}),
    ),
  ),
);

const localTask = (
  outcome: OrchestratorMcpDelegateTaskOutcome,
): OrchestratorMcpDelegateTaskResult =>
  "taskId" in outcome ? outcome : assert.fail("Expected a local delegated task.");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-isolation"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:mcp-isolation",
  providerInstanceId: modelSelection.instanceId,
  providerDriverKind: driver,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect("delegates into a separate worktree only when isolation asks for one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threads = yield* ThreadManagementService;
    const service = yield* OrchestratorMcpService;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:mcp-isolation:parent"),
      threadId: parentThreadId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: parentCheckout,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:mcp-isolation:parent-message"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:mcp-isolation:parent"),
      text: "Coordinate the fixes",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const subagentCount = threads
      .getThreadProjection(parentThreadId)
      .pipe(Effect.map((projection) => projection.subagents.length));

    // Default: the child shares the parent's checkout and starts straight away.
    const shared = localTask(
      yield* service.delegateTask(scope, { task: "Fix the shared bug", clientRequestId: "shared" }),
    );
    const sharedChild = yield* threads.getThreadProjection(shared.childThreadId);
    assert.equal(sharedChild.thread.worktreePath, parentCheckout);
    assert.equal(sharedChild.runs[0]?.status, "starting");
    assert.isEmpty(resolvedBases);
    assert.isEmpty(preparedRuns);

    // Isolation: the child waits in preparing, without the parent's checkout, for its worktree.
    const isolated = localTask(
      yield* service.delegateTask(scope, {
        task: "Fix the isolated bug",
        isolation: "worktree",
        clientRequestId: "isolated",
      }),
    );
    assert.equal(isolated.status, "running");
    assert.deepEqual(resolvedBases, [{ projectId, worktreePath: parentCheckout }]);
    const isolatedChild = yield* threads.getThreadProjection(isolated.childThreadId);
    assert.equal(isolatedChild.thread.worktreePath, null);
    assert.equal(isolatedChild.thread.branch, null);
    assert.equal(isolatedChild.runs[0]?.status, "preparing");
    assert.equal(preparedRuns.length, 1);
    assert.deepInclude(preparedRuns[0], {
      threadId: isolated.childThreadId,
      runId: isolated.childRunId!,
      baseRef: "parent-head-sha",
    });

    // A retry replays the same task; ThreadLaunchService ignores the repeated preparation.
    const countBeforeRetry = yield* subagentCount;
    const retried = localTask(
      yield* service.delegateTask(scope, {
        task: "Fix the isolated bug",
        isolation: "worktree",
        clientRequestId: "isolated",
      }),
    );
    assert.equal(retried.taskId, isolated.taskId);
    assert.equal(yield* subagentCount, countBeforeRetry);
    assert.deepEqual(preparedRuns[1], preparedRuns[0]);

    // A checkout that is not a git repository is refused before any child exists.
    checkoutIsGit = false;
    const refused = yield* service
      .delegateTask(scope, {
        task: "Fix it somewhere else",
        isolation: "worktree",
        clientRequestId: "non-git",
      })
      .pipe(Effect.flip);
    assert.equal(refused.code, "invalid_request");
    assert.include(refused.message, "is not a git repository");
    assert.include(refused.message, "Omit isolation");
    assert.equal(yield* subagentCount, countBeforeRetry);
    assert.equal(preparedRuns.length, 2);
  }).pipe(Effect.provide(testLayer)),
);
