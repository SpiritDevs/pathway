// Path containment here is synchronous validation around terminal metadata, not filesystem I/O.
// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  OrchestrationV2WorkspaceMovePreviewError,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WorkspaceMove,
  type OrchestrationV2WorkspaceMoveBlocker,
  type OrchestrationV2WorkspaceMovePreview,
  type TerminalSummary,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { ProjectionStoreV2, threadShellFromProjection } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export class ThreadWorkspaceMoveExecutionError extends Schema.TaggedErrorClass<ThreadWorkspaceMoveExecutionError>()(
  "ThreadWorkspaceMoveExecutionError",
  {
    threadId: ThreadId,
    moveId: CommandId,
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace move ${this.moveId} failed during ${this.operation}.`;
  }
}

export class ThreadWorkspaceMoveService extends Context.Service<
  ThreadWorkspaceMoveService,
  {
    readonly preview: (
      threadId: ThreadId,
    ) => Effect.Effect<
      OrchestrationV2WorkspaceMovePreview,
      OrchestrationV2WorkspaceMovePreviewError
    >;
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly moveId: CommandId;
      readonly stopTerminals: boolean;
    }) => Effect.Effect<void, ThreadWorkspaceMoveExecutionError>;
  }
>()("@spiritdevs/pathway/orchestration-v2/ThreadWorkspaceMoveService") {}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function containsPath(root: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

function isBusyThread(thread: OrchestrationV2ThreadShell): boolean {
  return (
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0
  );
}

function activeTerminalsInCheckout(
  terminals: ReadonlyArray<TerminalSummary>,
  sourceCwd: string,
): ReadonlyArray<TerminalSummary> {
  return terminals.filter(
    (terminal) =>
      (terminal.status === "starting" || terminal.status === "running") &&
      containsPath(sourceCwd, terminal.cwd),
  );
}

function temporaryBranch(moveId: CommandId): string {
  const suffix = NodeCrypto.createHash("sha256").update(String(moveId)).digest("hex").slice(0, 16);
  return `pathway/${suffix}`;
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectionProjects.ProjectionProjectRepository;
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;

  const preview: ThreadWorkspaceMoveService["Service"]["preview"] = Effect.fn(
    "ThreadWorkspaceMoveService.preview",
  )(function* (threadId) {
    const gitOption = yield* Effect.serviceOption(GitWorkflow.GitWorkflowService);
    const terminalsOption = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const dependencies = Option.all({
      git: gitOption,
      terminals: terminalsOption,
    });
    if (Option.isNone(dependencies)) {
      return yield* new OrchestrationV2WorkspaceMovePreviewError({
        threadId,
        message: "Workspace moves are unavailable in this server runtime.",
      });
    }
    const { git, terminals } = dependencies.value;
    const projection = yield* projections.getThreadProjection(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2WorkspaceMovePreviewError({
            threadId,
            message: "Unable to read the thread workspace.",
            cause,
          }),
      ),
    );
    const project = yield* projects.getById({ projectId: projection.thread.projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2WorkspaceMovePreviewError({
            threadId,
            message: "Unable to read the thread project.",
            cause,
          }),
      ),
      Effect.map(Option.getOrNull),
    );
    const blockers: OrchestrationV2WorkspaceMoveBlocker[] = [];
    if (projection.thread.worktreePath !== null) {
      blockers.push({
        kind: "already_in_worktree",
        message: "This thread is already attached to a worktree.",
      });
    }
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
      blockers.push({
        kind: "thread_archived",
        message: "Archived or deleted threads cannot change workspace.",
      });
    }
    if (projection.thread.workspaceMove?.status === "running") {
      blockers.push({
        kind: "move_in_progress",
        message: "A workspace move is already in progress.",
      });
    }
    const currentShell = threadShellFromProjection(projection);
    if (isBusyThread(currentShell)) {
      blockers.push({
        kind: "thread_active",
        message: "Wait for this thread's active or queued work to finish.",
      });
    }
    const sourceCwd = project?.workspaceRoot ?? null;
    if (sourceCwd === null) {
      blockers.push({
        kind: "workspace_unavailable",
        message: "This project has no workspace folder.",
      });
      return { fileCount: 0, terminalCount: 0, blockers };
    }

    const [shell, localStatus, terminalMetadata] = yield* Effect.all([
      projections.getShellSnapshot(),
      git.localStatus({ cwd: sourceCwd }),
      terminals.listMetadata,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2WorkspaceMovePreviewError({
            threadId,
            message: "Unable to inspect the project checkout.",
            cause,
          }),
      ),
    );
    if (!localStatus.isRepo) {
      blockers.push({
        kind: "not_git_repository",
        message: "The project workspace is not a Git repository.",
      });
    }
    const sharedBusyThread = [...shell.threads, ...shell.archivedThreads].find(
      (candidate) =>
        candidate.id !== threadId &&
        candidate.projectId === projection.thread.projectId &&
        candidate.worktreePath === null &&
        (candidate.workspaceMove?.status === "running" || isBusyThread(candidate)),
    );
    if (sharedBusyThread) {
      blockers.push({
        kind: "shared_thread_active",
        message: `Wait for “${sharedBusyThread.title}” to finish its active or queued work.`,
      });
    }
    return {
      fileCount: localStatus.workingTree.files.length,
      terminalCount: activeTerminalsInCheckout(terminalMetadata, sourceCwd).length,
      blockers,
    };
  });

  const loadMove = Effect.fn("ThreadWorkspaceMoveService.loadMove")(function* (
    threadId: ThreadId,
    moveId: CommandId,
  ) {
    const projection = yield* threads.getThreadProjection(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadWorkspaceMoveExecutionError({
            threadId,
            moveId,
            operation: "read-thread",
            cause,
          }),
      ),
    );
    const move = projection.thread.workspaceMove;
    if (!move || move.id !== moveId) {
      return yield* new ThreadWorkspaceMoveExecutionError({
        threadId,
        moveId,
        operation: "read-move",
        cause: "The durable workspace move marker is missing or was superseded.",
      });
    }
    return { projection, move };
  });

  const writeMove = Effect.fn("ThreadWorkspaceMoveService.writeMove")(function* (input: {
    readonly threadId: ThreadId;
    readonly moveId: CommandId;
    readonly step: string;
    readonly update: (
      move: OrchestrationV2WorkspaceMove,
      now: DateTime.Utc,
    ) => OrchestrationV2WorkspaceMove;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly expectedWorktreePath?: string | null;
  }) {
    const { move } = yield* loadMove(input.threadId, input.moveId);
    const now = yield* DateTime.now;
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.moveId}:workspace-move:${input.step}`),
        threadId: input.threadId,
        workspaceMove: input.update(move, now),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
        ...(input.expectedWorktreePath === undefined
          ? {}
          : { expectedWorktreePath: input.expectedWorktreePath }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadWorkspaceMoveExecutionError({
              threadId: input.threadId,
              moveId: input.moveId,
              operation: input.step,
              cause,
            }),
        ),
      );
  });

  const execute: ThreadWorkspaceMoveService["Service"]["execute"] = Effect.fn(
    "ThreadWorkspaceMoveService.execute",
  )(function* (input) {
    const gitOption = yield* Effect.serviceOption(GitWorkflow.GitWorkflowService);
    const terminalsOption = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const vcsStatusOption = yield* Effect.serviceOption(VcsStatusBroadcaster.VcsStatusBroadcaster);
    const dependencies = Option.all({
      git: gitOption,
      terminals: terminalsOption,
      vcsStatus: vcsStatusOption,
    });
    if (Option.isNone(dependencies)) {
      return yield* new ThreadWorkspaceMoveExecutionError({
        threadId: input.threadId,
        moveId: input.moveId,
        operation: "resolve-services",
        cause: "Workspace move dependencies are unavailable.",
      });
    }
    const { git, terminals, vcsStatus } = dependencies.value;
    const initial = yield* loadMove(input.threadId, input.moveId);
    if (initial.move.status !== "running") return;
    if (
      initial.projection.thread.worktreePath !== null &&
      initial.projection.thread.worktreePath === initial.move.targetWorktreePath
    ) {
      const targetWorktreePath = initial.projection.thread.worktreePath;
      const project = yield* projects
        .getById({
          projectId: initial.projection.thread.projectId,
        })
        .pipe(
          Effect.map(Option.getOrNull),
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceMoveExecutionError({
                threadId: input.threadId,
                moveId: input.moveId,
                operation: "reconcile-project",
                cause,
              }),
          ),
        );
      const sourceCwd = initial.move.sourceCwd ?? project?.workspaceRoot ?? null;
      let detail: string | null = null;
      if (initial.move.transferStashOid !== null && sourceCwd !== null) {
        const dropExit = yield* Effect.exit(
          git.dropTransferStash({ cwd: sourceCwd, oid: initial.move.transferStashOid }),
        );
        if (Exit.isFailure(dropExit)) {
          detail = `The thread moved, but its transfer stash could not be removed: ${errorText(Cause.squash(dropExit.cause))}`;
        }
      }
      let setup = initial.move.setup;
      if (setup === "pending" && project?.workspaceRoot) {
        const setupExit = yield* Effect.exit(
          ProjectSetupScriptRunner.runResolvedProjectSetupScript({
            threadId: input.threadId,
            projectId: initial.projection.thread.projectId,
            projectCwd: project.workspaceRoot,
            worktreePath: targetWorktreePath,
            project: {
              workspaceRoot: project.workspaceRoot,
              scripts: project.scripts,
            },
            terminalManager: terminals,
          }),
        );
        setup = Exit.isSuccess(setupExit)
          ? setupExit.value.status === "started"
            ? "started"
            : "no_script"
          : "failed";
        if (Exit.isFailure(setupExit)) {
          detail = `The thread moved, but its setup action could not start: ${errorText(Cause.squash(setupExit.cause))}`;
        }
      }
      yield* writeMove({
        ...input,
        step: "reconcile-complete",
        update: (move, now) => ({
          ...move,
          status: "completed",
          phase: "starting_setup",
          setup,
          detail,
          updatedAt: now,
          completedAt: now,
        }),
      });
      if (sourceCwd !== null) {
        yield* Effect.all([
          vcsStatus.refreshStatus(sourceCwd),
          vcsStatus.refreshStatus(targetWorktreePath),
        ]).pipe(Effect.ignoreCause({ log: true }));
      }
      return;
    }

    let attemptedSourceCwd = initial.move.sourceCwd;
    let attemptedTransferStashOid = initial.move.transferStashOid;
    let attemptedTargetBranch = initial.move.targetBranch;
    let attemptedTargetWorktreePath = initial.move.targetWorktreePath;
    const operation = Effect.gen(function* () {
      let move = (yield* loadMove(input.threadId, input.moveId)).move;
      const movePreview = yield* preview(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadWorkspaceMoveExecutionError({
              threadId: input.threadId,
              moveId: input.moveId,
              operation: "validate",
              cause,
            }),
        ),
      );
      const blockers = movePreview.blockers.filter(
        (blocker) => blocker.kind !== "move_in_progress",
      );
      if (blockers.length > 0) {
        return yield* new ThreadWorkspaceMoveExecutionError({
          threadId: input.threadId,
          moveId: input.moveId,
          operation: "validate",
          cause: blockers.map((blocker) => blocker.message).join(" "),
        });
      }
      const project = yield* projects
        .getById({
          projectId: initial.projection.thread.projectId,
        })
        .pipe(
          Effect.map(Option.getOrNull),
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceMoveExecutionError({
                threadId: input.threadId,
                moveId: input.moveId,
                operation: "resolve-project",
                cause,
              }),
          ),
        );
      if (project === null || project.workspaceRoot === null) {
        return yield* new ThreadWorkspaceMoveExecutionError({
          threadId: input.threadId,
          moveId: input.moveId,
          operation: "resolve-project",
          cause: "Project workspace is unavailable.",
        });
      }
      const sourceCwd = project.workspaceRoot;
      attemptedSourceCwd = sourceCwd;

      let affectedTerminals = activeTerminalsInCheckout(yield* terminals.listMetadata, sourceCwd);
      if (affectedTerminals.length > 0) {
        if (!input.stopTerminals) {
          return yield* new ThreadWorkspaceMoveExecutionError({
            threadId: input.threadId,
            moveId: input.moveId,
            operation: "stop-terminals",
            cause: `${affectedTerminals.length} terminal session(s) must stop before the move.`,
          });
        }
        yield* writeMove({
          ...input,
          step: "stopping-terminals",
          update: (current, now) => ({
            ...current,
            phase: "stopping_terminals",
            terminalCount: affectedTerminals.length,
            updatedAt: now,
          }),
        });
        yield* Effect.forEach(
          affectedTerminals,
          (terminal) =>
            terminals.close({ threadId: terminal.threadId, terminalId: terminal.terminalId }),
          { concurrency: 4, discard: true },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceMoveExecutionError({
                threadId: input.threadId,
                moveId: input.moveId,
                operation: "stop-terminals",
                cause,
              }),
          ),
        );
        affectedTerminals = activeTerminalsInCheckout(yield* terminals.listMetadata, sourceCwd);
        if (affectedTerminals.length > 0) {
          return yield* new ThreadWorkspaceMoveExecutionError({
            threadId: input.threadId,
            moveId: input.moveId,
            operation: "stop-terminals",
            cause: "Some terminal sessions did not stop.",
          });
        }
      }

      const sourceHead = move.sourceHead
        ? { commitSha: move.sourceHead }
        : yield* git.resolveCommit({ cwd: sourceCwd, revision: "HEAD" }).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadWorkspaceMoveExecutionError({
                  threadId: input.threadId,
                  moveId: input.moveId,
                  operation: "resolve-head",
                  cause,
                }),
            ),
          );
      yield* writeMove({
        ...input,
        step: "saving-changes",
        update: (current, now) => ({
          ...current,
          phase: "saving_changes",
          sourceCwd,
          sourceHead: sourceHead.commitSha,
          fileCount: movePreview.fileCount,
          terminalCount: movePreview.terminalCount,
          updatedAt: now,
        }),
      });
      move = (yield* loadMove(input.threadId, input.moveId)).move;
      const stash =
        move.transferStashOid !== null
          ? { oid: move.transferStashOid }
          : yield* git
              .createTransferStash({
                cwd: sourceCwd,
                marker: `pathway-workspace-move:${input.moveId}`,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ThreadWorkspaceMoveExecutionError({
                      threadId: input.threadId,
                      moveId: input.moveId,
                      operation: "save-changes",
                      cause,
                    }),
                ),
              );
      attemptedTransferStashOid = stash.oid;
      yield* writeMove({
        ...input,
        step: "saved-changes",
        update: (current, now) => ({
          ...current,
          transferStashOid: stash.oid,
          updatedAt: now,
        }),
      });

      move = (yield* loadMove(input.threadId, input.moveId)).move;
      const branch = move.targetBranch ?? temporaryBranch(input.moveId);
      attemptedTargetBranch = branch;
      yield* writeMove({
        ...input,
        step: "creating-worktree",
        update: (current, now) => ({
          ...current,
          phase: "creating_worktree",
          targetBranch: branch,
          updatedAt: now,
        }),
      });
      let worktreePath = move.targetWorktreePath;
      if (worktreePath === null) {
        const refs = yield* git.listRefs({
          cwd: sourceCwd,
          query: branch,
          refKind: "local",
          refresh: true,
        });
        const existing = refs.refs.find((ref) => ref.name === branch && !ref.isRemote);
        if (existing?.worktreePath) {
          worktreePath = existing.worktreePath;
        } else if (existing) {
          return yield* new ThreadWorkspaceMoveExecutionError({
            threadId: input.threadId,
            moveId: input.moveId,
            operation: "create-worktree",
            cause: `Temporary branch '${branch}' exists without its worktree.`,
          });
        } else {
          const created = yield* git
            .createWorktree({
              cwd: sourceCwd,
              refName: sourceHead.commitSha,
              newRefName: branch,
              baseRefName: initial.projection.thread.branch ?? "HEAD",
              path: null,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadWorkspaceMoveExecutionError({
                    threadId: input.threadId,
                    moveId: input.moveId,
                    operation: "create-worktree",
                    cause,
                  }),
              ),
            );
          worktreePath = created.worktree.path;
          attemptedTargetWorktreePath = worktreePath;
        }
      }
      attemptedTargetWorktreePath = worktreePath;
      yield* writeMove({
        ...input,
        step: "created-worktree",
        update: (current, now) => ({
          ...current,
          targetWorktreePath: worktreePath,
          targetBranch: branch,
          updatedAt: now,
        }),
      });

      if (stash.oid !== null) {
        yield* writeMove({
          ...input,
          step: "applying-changes",
          update: (current, now) => ({
            ...current,
            phase: "applying_changes",
            updatedAt: now,
          }),
        });
        yield* git.applyTransferStash({ cwd: worktreePath, oid: stash.oid }).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceMoveExecutionError({
                threadId: input.threadId,
                moveId: input.moveId,
                operation: "apply-changes",
                cause,
              }),
          ),
        );
      }

      yield* writeMove({
        ...input,
        step: "moving-thread",
        update: (current, now) => ({
          ...current,
          phase: "moving_thread",
          updatedAt: now,
        }),
      });
      yield* writeMove({
        ...input,
        step: "bind-worktree",
        branch,
        worktreePath,
        expectedWorktreePath: null,
        update: (current, now) => ({
          ...current,
          phase: "starting_setup",
          targetWorktreePath: worktreePath,
          targetBranch: branch,
          updatedAt: now,
        }),
      });
      let completionDetail: string | null = null;
      if (stash.oid !== null) {
        const dropExit = yield* Effect.exit(
          git.dropTransferStash({ cwd: sourceCwd, oid: stash.oid }),
        );
        if (Exit.isFailure(dropExit)) {
          completionDetail = `The thread moved, but its transfer stash could not be removed: ${errorText(Cause.squash(dropExit.cause))}`;
        }
      }

      const setupExit = yield* Effect.exit(
        ProjectSetupScriptRunner.runResolvedProjectSetupScript({
          threadId: input.threadId,
          projectId: initial.projection.thread.projectId,
          projectCwd: sourceCwd,
          worktreePath,
          project: {
            workspaceRoot: sourceCwd,
            scripts: project.scripts,
          },
          terminalManager: terminals,
        }),
      );
      const setup = Exit.isSuccess(setupExit)
        ? setupExit.value.status === "started"
          ? ("started" as const)
          : ("no_script" as const)
        : ("failed" as const);
      const detail = Exit.isFailure(setupExit)
        ? `The thread moved, but its setup action could not start: ${errorText(Cause.squash(setupExit.cause))}`
        : completionDetail;
      yield* writeMove({
        ...input,
        step: "complete",
        expectedWorktreePath: worktreePath,
        update: (current, now) => ({
          ...current,
          status: "completed",
          setup,
          detail,
          updatedAt: now,
          completedAt: now,
        }),
      });
      yield* Effect.all([
        vcsStatus.refreshStatus(sourceCwd),
        vcsStatus.refreshStatus(worktreePath),
      ]).pipe(Effect.ignoreCause({ log: true }));

      const naming = Option.all({
        providerRegistry: yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry),
        providerInstances: yield* Effect.serviceOption(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
        ),
        serverSettings: yield* Effect.serviceOption(ServerSettings.ServerSettingsService),
      });
      if (Option.isSome(naming)) {
        const oldBranch = branch;
        yield* Effect.gen(function* () {
          const settings = yield* naming.value.serverSettings.getSettings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* naming.value.providerRegistry.getProviders,
                );
          const generated = yield* TextGeneration.makeTextGenerationFromRegistry(
            naming.value.providerInstances,
          ).generateBranchName({
            cwd: worktreePath,
            message: initial.projection.thread.title,
            attachments: [],
            modelSelection,
          });
          const renamed = yield* git.renameBranch({
            cwd: worktreePath,
            oldBranch,
            newBranch: generated.branch,
          });
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.moveId}:workspace-move:branch-rename`),
            threadId: input.threadId,
            branch: renamed.branch,
            worktreePath,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Moved thread worktree branch rename failed", {
              moveId: input.moveId,
              threadId: input.threadId,
              oldBranch,
              cause,
            }),
          ),
        );
      }
    });

    const result = yield* Effect.exit(operation);
    if (Exit.isSuccess(result)) return;

    const failure = Cause.squash(result.cause);
    const latest = yield* loadMove(input.threadId, input.moveId);
    const move = latest.move;
    if (
      latest.projection.thread.worktreePath === move.targetWorktreePath &&
      move.targetWorktreePath
    ) {
      yield* writeMove({
        ...input,
        step: "completed-with-warning",
        expectedWorktreePath: move.targetWorktreePath,
        update: (current, now) => ({
          ...current,
          status: "completed",
          setup: current.setup === "pending" ? "failed" : current.setup,
          detail: errorText(failure),
          updatedAt: now,
          completedAt: now,
        }),
      });
      return;
    }

    let rollbackFailure: unknown = null;
    const rollbackSourceCwd = move.sourceCwd ?? attemptedSourceCwd;
    const rollbackTargetPath = move.targetWorktreePath ?? attemptedTargetWorktreePath;
    const rollbackTargetBranch = move.targetBranch ?? attemptedTargetBranch;
    const rollbackTransferStashOid = move.transferStashOid ?? attemptedTransferStashOid;
    if (rollbackTargetPath !== null && rollbackSourceCwd !== null) {
      const cleanup = yield* Effect.exit(
        git.removeWorktree({ cwd: rollbackSourceCwd, path: rollbackTargetPath, force: true }).pipe(
          Effect.andThen(
            rollbackTargetBranch === null
              ? Effect.void
              : git.deleteLocalBranch({
                  cwd: rollbackSourceCwd,
                  refName: rollbackTargetBranch,
                  force: true,
                }),
          ),
        ),
      );
      if (Exit.isFailure(cleanup)) rollbackFailure = Cause.squash(cleanup.cause);
    }
    if (rollbackTransferStashOid !== null && rollbackSourceCwd !== null) {
      const restore = yield* Effect.exit(
        git.applyTransferStash({ cwd: rollbackSourceCwd, oid: rollbackTransferStashOid }),
      );
      if (Exit.isFailure(restore)) {
        rollbackFailure = Cause.squash(restore.cause);
      } else if (rollbackFailure === null) {
        yield* git
          .dropTransferStash({ cwd: rollbackSourceCwd, oid: rollbackTransferStashOid })
          .pipe(Effect.ignoreCause({ log: true }));
      }
    }
    const manualRecovery = rollbackFailure !== null;
    const manualRecoveryArtifact =
      rollbackTransferStashOid === null
        ? "The incomplete worktree may require manual cleanup."
        : `Transfer stash ${rollbackTransferStashOid} was preserved.`;
    yield* writeMove({
      ...input,
      step: manualRecovery ? "manual-recovery" : "failed",
      expectedWorktreePath: null,
      update: (current, now) => ({
        ...current,
        status: manualRecovery ? "manual_recovery" : "failed",
        transferStashOid: manualRecovery ? rollbackTransferStashOid : null,
        detail: manualRecovery
          ? `The move failed and automatic restoration also failed. ${manualRecoveryArtifact} ${errorText(rollbackFailure)}`
          : errorText(failure),
        updatedAt: now,
        completedAt: now,
      }),
    });
  });

  return ThreadWorkspaceMoveService.of({ preview, execute });
});

export const layer = Layer.effect(ThreadWorkspaceMoveService, make);
