import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContinuationLaunch from "./ContinuationLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const projectId = ProjectId.make("project:continuation-launch");
const sourceThreadId = ThreadId.make("thread:continuation-launch:source");
const targetThreadId = ThreadId.make("thread:continuation-launch:target");
const sourceRunId = RunId.make("run:continuation-launch:source");
const sourceModel = {
  instanceId: ProviderInstanceId.make("codex-source"),
  model: "gpt-source",
} as const;
const targetModel = {
  instanceId: ProviderInstanceId.make("claude-target"),
  model: "claude-target",
} as const;

function makeHarness(options: { readonly failFirstSetup?: boolean } = {}) {
  const commands: Array<OrchestrationV2Command> = [];
  const receipts = new Set<string>();
  let target: OrchestrationV2ThreadProjection | null = null;
  const source = {
    thread: {
      id: sourceThreadId,
      projectId,
      title: "Source",
      modelSelection: sourceModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/source",
      worktreePath: "/repo/source-worktree",
      forkedFrom: null,
    },
    runs: [{ id: sourceRunId, status: "completed" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const createWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0]) =>
      Effect.succeed({
        worktree: {
          path: "/repo/worktrees/continuation",
          refName: "pathway/continue-thread-continuation-launch-target",
        },
      } as never),
  );
  const resolveCommit = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["resolveCommit"]>[0]) =>
      Effect.succeed({ commitSha: "exact-source-head" }),
  );
  let setupAttempts = 0;
  const runSetup = vi.fn(() => {
    setupAttempts += 1;
    return options.failFirstSetup === true && setupAttempts === 1
      ? Effect.fail(new Error("setup failed") as never)
      : Effect.succeed({ status: "no-script" as const });
  });
  const removeWorktree = vi.fn(() => Effect.void);
  const deleteLocalBranch = vi.fn(() => Effect.void);

  const threadManagement = Layer.succeed(
    ThreadManagement.ThreadManagementService,
    ThreadManagement.ThreadManagementService.of({
      dispatch: (command: OrchestrationV2Command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.fork") {
            target = {
              ...source,
              thread: {
                ...source.thread,
                id: targetThreadId,
                forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRunId },
              },
              runs: [],
            } as OrchestrationV2ThreadProjection;
          } else if (target !== null && command.type === "provider.switch") {
            target = {
              ...target,
              thread: { ...target.thread, modelSelection: command.modelSelection },
            };
          } else if (target !== null && command.type === "thread.metadata.update") {
            target = {
              ...target,
              thread: {
                ...target.thread,
                ...(command.branch === undefined ? {} : { branch: command.branch }),
                ...(command.worktreePath === undefined
                  ? {}
                  : { worktreePath: command.worktreePath }),
              },
            };
            if (command.commandId === CommandId.make("command:continuation-launch")) {
              receipts.add(command.commandId);
            }
          }
          return { sequence: commands.length, storedEvents: [], domainEvents: [] } as never;
        }),
      getThreadProjection: (threadId: ThreadId) =>
        threadId === sourceThreadId
          ? Effect.succeed(source)
          : target !== null
            ? Effect.succeed(target)
            : Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                }),
              ),
    } as never),
  );
  const services = Layer.mergeAll(
    threadManagement,
    Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, {
      getByCommandId: (commandId: CommandId) =>
        Effect.succeed(
          receipts.has(commandId)
            ? Option.some({ commandId, threadId: targetThreadId } as never)
            : Option.none(),
        ),
    } as never),
    Layer.succeed(ProjectService.ProjectService, {
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            workspaceRoot: "/repo",
            scripts: [],
          } as never),
        ),
    } as never),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.succeed(GitWorkflow.GitWorkflowService, {
      listRefs: () =>
        Effect.succeed({
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        }),
      resolveCommit,
      createWorktree,
      removeWorktree,
      deleteLocalBranch,
    } as never),
  );
  const layer = ContinuationLaunch.layer.pipe(Layer.provide(services));
  return {
    layer,
    commands,
    createWorktree,
    resolveCommit,
    runSetup,
    removeWorktree,
    deleteLocalBranch,
  };
}

const launchInput = (workspaceTarget: "current" | "new-worktree") => ({
  commandId: CommandId.make("command:continuation-launch"),
  sourceThreadId,
  sourceRunId,
  targetThreadId,
  modelSelection: targetModel,
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
  workspaceTarget,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

it.effect(
  "keeps V2 fork lineage and uses provider.switch for a cross-provider continuation",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ContinuationLaunch.ContinuationLaunchService;
      const result = yield* service.launch(launchInput("current"));
      assert.equal(result.threadId, targetThreadId);
      assert.deepEqual(result.projection.thread.forkedFrom, {
        type: "run",
        threadId: sourceThreadId,
        runId: sourceRunId,
      });
      const commandTypes = harness.commands.map((command) => command.type);
      assert.includeMembers(commandTypes, [
        "thread.fork",
        "provider.switch",
        "thread.runtime-mode.set",
        "thread.interaction-mode.set",
      ]);
      assert.equal(harness.createWorktree.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("creates a retry-safe worktree from the exact source HEAD and runs setup once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* ContinuationLaunch.ContinuationLaunchService;
    yield* service.launch(launchInput("new-worktree"));
    const retry = yield* service.launch(launchInput("new-worktree"));
    assert.isTrue(retry.resumed);
    assert.deepEqual(harness.resolveCommit.mock.calls[0]?.[0], {
      cwd: "/repo/source-worktree",
      revision: "HEAD",
    });
    assert.deepInclude(harness.createWorktree.mock.calls[0]?.[0], {
      cwd: "/repo/source-worktree",
      refName: "exact-source-head",
      baseRefName: "feature/source",
    });
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.equal(harness.runSetup.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("cleans up before forking when setup fails and recreates safely on retry", () => {
  const harness = makeHarness({ failFirstSetup: true });
  return Effect.gen(function* () {
    const service = yield* ContinuationLaunch.ContinuationLaunchService;
    const first = yield* Effect.exit(service.launch(launchInput("new-worktree")));
    assert.equal(first._tag, "Failure");
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.removeWorktree.mock.calls.length, 1);
    assert.equal(harness.deleteLocalBranch.mock.calls.length, 1);
    const retry = yield* service.launch(launchInput("new-worktree"));
    assert.isFalse(retry.resumed);
    assert.equal(harness.createWorktree.mock.calls.length, 2);
    assert.equal(harness.runSetup.mock.calls.length, 2);
    assert.equal(harness.commands.filter((command) => command.type === "thread.fork").length, 1);
  }).pipe(Effect.provide(harness.layer));
});
