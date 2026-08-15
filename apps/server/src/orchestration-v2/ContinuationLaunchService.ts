import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2ContinuationLaunchResult,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export interface ContinuationLaunchInput {
  readonly commandId: CommandId;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly targetThreadId: ThreadId;
  readonly title?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceTarget: "current" | "new-worktree";
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export class ContinuationLaunchError extends Schema.TaggedErrorClass<ContinuationLaunchError>()(
  "ContinuationLaunchError",
  {
    operation: Schema.Literals([
      "read-receipt",
      "read-source",
      "resolve-project",
      "provision-worktree",
      "fork-thread",
      "configure-thread",
      "run-setup-script",
      "complete-launch",
    ]),
    commandId: CommandId,
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Continuation launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ContinuationLaunchService extends Context.Service<
  ContinuationLaunchService,
  {
    readonly launch: (
      input: ContinuationLaunchInput,
    ) => Effect.Effect<OrchestrationV2ContinuationLaunchResult, ContinuationLaunchError>;
  }
>()("@spiritdevs/pathway/orchestration-v2/ContinuationLaunchService") {}

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

function continuationBranchName(threadId: ThreadId): string {
  const suffix = threadId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 72)
    .replace(/[-_]+$/gu, "");
  return `pathway/continue-${suffix || "thread"}`;
}

export const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const mapError =
    (input: ContinuationLaunchInput, operation: ContinuationLaunchError["operation"]) =>
    (cause: unknown) =>
      new ContinuationLaunchError({
        operation,
        commandId: input.commandId,
        sourceThreadId: input.sourceThreadId,
        targetThreadId: input.targetThreadId,
        cause,
      });

  const readTarget = (input: ContinuationLaunchInput) =>
    threads.getThreadProjection(input.targetThreadId).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isThreadNotFound, () => Effect.succeed(Option.none())),
      Effect.mapError(mapError(input, "read-source")),
    );

  const validateTarget = (
    input: ContinuationLaunchInput,
    target: OrchestrationV2ThreadProjection,
  ) => {
    const forkedFrom = target.thread.forkedFrom;
    if (
      forkedFrom?.type !== "run" ||
      forkedFrom.threadId !== input.sourceThreadId ||
      forkedFrom.runId !== input.sourceRunId
    ) {
      return Effect.fail(
        mapError(
          input,
          "fork-thread",
        )(`Target thread ${input.targetThreadId} already exists with different lineage.`),
      );
    }
    return Effect.void;
  };

  const cleanupWorktree = (input: {
    readonly sourceCwd: string;
    readonly branch: string;
    readonly worktreePath: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.worktreePath !== null) {
        yield* git
          .removeWorktree({ cwd: input.sourceCwd, path: input.worktreePath, force: true })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* git
        .deleteLocalBranch({ cwd: input.sourceCwd, refName: input.branch, force: true })
        .pipe(Effect.ignoreCause({ log: true }));
    });

  const provisionWorktree = Effect.fn("ContinuationLaunchService.provisionWorktree")(
    function* (input: {
      readonly launch: ContinuationLaunchInput;
      readonly sourceCwd: string;
      readonly sourceBranch: string | null;
      readonly existingTarget: Option.Option<OrchestrationV2ThreadProjection>;
    }) {
      const branch = continuationBranchName(input.launch.targetThreadId);
      if (Option.isSome(input.existingTarget)) {
        const target = input.existingTarget.value.thread;
        if (target.branch === branch && target.worktreePath !== null) {
          return { branch, worktreePath: target.worktreePath, created: false } as const;
        }
      }

      const refs = yield* git.listRefs({
        cwd: input.sourceCwd,
        query: branch,
        refKind: "local",
        refresh: true,
      });
      const orphan = refs.refs.find((ref) => ref.name === branch);
      if (orphan !== undefined) {
        yield* cleanupWorktree({
          sourceCwd: input.sourceCwd,
          branch,
          worktreePath: orphan.worktreePath,
        });
      }

      // Resolve first, then pass the immutable commit id to worktree creation.
      // Dirty source changes are intentionally excluded.
      const { commitSha } = yield* git.resolveCommit({
        cwd: input.sourceCwd,
        revision: "HEAD",
      });
      const created = yield* git.createWorktree({
        cwd: input.sourceCwd,
        refName: commitSha,
        newRefName: branch,
        baseRefName: input.sourceBranch ?? "HEAD",
        path: null,
      });
      return { branch, worktreePath: created.worktree.path, created: true } as const;
    },
  );

  const launch: ContinuationLaunchService["Service"]["launch"] = Effect.fn(
    "ContinuationLaunchService.launch",
  )(function* (input) {
    if (input.sourceThreadId === input.targetThreadId) {
      return yield* mapError(input, "fork-thread")("A continuation requires a new thread id.");
    }

    const completedReceipt = yield* receipts
      .getByCommandId(input.commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt")));
    if (Option.isSome(completedReceipt)) {
      const target = yield* threads
        .getThreadProjection(input.targetThreadId)
        .pipe(Effect.mapError(mapError(input, "read-source")));
      yield* validateTarget(input, target);
      return { threadId: target.thread.id, projection: target, resumed: true };
    }

    const source = yield* threads
      .getThreadProjection(input.sourceThreadId)
      .pipe(Effect.mapError(mapError(input, "read-source")));
    const sourceRun = source.runs.find((run) => run.id === input.sourceRunId);
    if (sourceRun?.status !== "completed") {
      return yield* mapError(
        input,
        "read-source",
      )(`Source run ${input.sourceRunId} is not completed.`);
    }

    const project = yield* projects.getById(source.thread.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project")("Source project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const sourceCwd = source.thread.worktreePath ?? project.workspaceRoot;
    if (sourceCwd === null) {
      return yield* mapError(input, "resolve-project")("Source project has no workspace.");
    }

    const existingTarget = yield* readTarget(input);
    if (Option.isSome(existingTarget)) {
      yield* validateTarget(input, existingTarget.value);
    }

    let materialized: {
      readonly branch: string;
      readonly worktreePath: string;
      readonly created: boolean;
    } | null = null;
    if (input.workspaceTarget === "new-worktree") {
      materialized = yield* provisionWorktree({
        launch: input,
        sourceCwd,
        sourceBranch: source.thread.branch,
        existingTarget,
      }).pipe(Effect.mapError(mapError(input, "provision-worktree")));
    }

    if (materialized?.created === true) {
      const setupExit = yield* Effect.exit(
        setupScripts.runForThread({
          threadId: input.targetThreadId,
          projectId: source.thread.projectId,
          projectCwd: project.workspaceRoot ?? sourceCwd,
          worktreePath: materialized.worktreePath,
          project: {
            workspaceRoot: project.workspaceRoot ?? sourceCwd,
            scripts: project.scripts,
          },
        }),
      );
      if (setupExit._tag === "Failure") {
        yield* cleanupWorktree({
          sourceCwd,
          branch: materialized.branch,
          worktreePath: materialized.worktreePath,
        });
        return yield* mapError(input, "run-setup-script")(setupExit.cause);
      }
    }

    if (Option.isNone(existingTarget)) {
      const forkExit = yield* Effect.exit(
        threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`${input.commandId}:fork`),
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          sourcePoint: { type: "run", runId: input.sourceRunId },
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      );
      if (forkExit._tag === "Failure") {
        if (materialized?.created === true) {
          yield* cleanupWorktree({
            sourceCwd,
            branch: materialized.branch,
            worktreePath: materialized.worktreePath,
          });
        }
        return yield* mapError(input, "fork-thread")(forkExit.cause);
      }
    }

    const configure = (command: Parameters<typeof threads.dispatch>[0]) =>
      threads.dispatch(command).pipe(Effect.mapError(mapError(input, "configure-thread")));
    if (materialized !== null) {
      yield* configure({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace`),
        threadId: input.targetThreadId,
        branch: materialized.branch,
        worktreePath: materialized.worktreePath,
      });
    }
    yield* configure(
      source.thread.modelSelection.instanceId === input.modelSelection.instanceId
        ? {
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${input.commandId}:model`),
            threadId: input.targetThreadId,
            modelSelection: input.modelSelection,
          }
        : {
            type: "provider.switch",
            commandId: CommandId.make(`${input.commandId}:model`),
            threadId: input.targetThreadId,
            modelSelection: input.modelSelection,
          },
    );
    yield* configure({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`${input.commandId}:runtime`),
      threadId: input.targetThreadId,
      runtimeMode: input.runtimeMode,
    });
    yield* configure({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make(`${input.commandId}:interaction`),
      threadId: input.targetThreadId,
      interactionMode: input.interactionMode,
    });
    // This final idempotent command is the composite workflow's durable
    // completion marker. Retries before this point reconcile each sub-command.
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.targetThreadId,
      })
      .pipe(Effect.mapError(mapError(input, "complete-launch")));
    const projection = yield* threads
      .getThreadProjection(input.targetThreadId)
      .pipe(Effect.mapError(mapError(input, "complete-launch")));
    return { threadId: input.targetThreadId, projection, resumed: false };
  });

  return ContinuationLaunchService.of({ launch });
});

export const layer = Layer.effect(ContinuationLaunchService, make);
