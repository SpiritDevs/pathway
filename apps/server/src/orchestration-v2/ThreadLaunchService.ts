import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2WorkspacePreparation,
  type OrchestrationV2WorkspacePreparationControlInput,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type ThreadLocation,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
} from "@spiritdevs/shared/git";

import * as TerminalManager from "../terminal/Manager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly locations?: ReadonlyArray<ThreadLocation>;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedErrorClass<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
      "control-preparation",
      "cleanup-worktree",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.operation === "cleanup-worktree")
      return "Could not clean up the worktree. The task was kept and has not been started locally.";
    if (this.operation === "control-preparation" && typeof this.cause === "string")
      return this.cause;
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<ThreadLaunchResult, ThreadLaunchError>;
    readonly controlPreparation: (
      input: OrchestrationV2WorkspacePreparationControlInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, ThreadLaunchError>;
  }
>()("@spiritdevs/pathway/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

interface ActivePreparation {
  readonly input: ThreadLaunchInput;
  readonly done: Deferred.Deferred<void, ThreadLaunchError>;
  accepting: boolean;
  control: OrchestrationV2WorkspacePreparationControlInput | null;
  projectCwd: string | null;
  worktree: { readonly path: string } | null;
  terminalId: string | null;
}

export const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager.TerminalManager;
  const activePreparations = new Map<RunId, ActivePreparation>();
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: ThreadLaunchInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.messages.length > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const applyPreparationControl = Effect.fn("ThreadLaunchService.applyPreparationControl")(
    function* (entry: ActivePreparation, threadId: ThreadId, runId: RunId) {
      const control = entry.control;
      if (control === null) return false;
      entry.accepting = false;
      if (entry.terminalId !== null) {
        yield* terminals
          .close({ threadId, terminalId: entry.terminalId })
          .pipe(Effect.mapError(mapError(entry.input, "cleanup-worktree", threadId)));
        entry.terminalId = null;
      }
      if (entry.worktree !== null && entry.projectCwd !== null) {
        yield* git
          .removeWorktree({ cwd: entry.projectCwd, path: entry.worktree.path, force: true })
          .pipe(Effect.mapError(mapError(entry.input, "cleanup-worktree", threadId)));
        // Only the worktree allocated by this launch is owned by the preparation.
        entry.worktree = null;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${control.commandId}:workspace`),
          threadId,
          worktreePath: null,
          branch: null,
        })
        .pipe(Effect.mapError(mapError(entry.input, "update-thread", threadId)));
      if (control.action === "cancel") {
        yield* threads
          .dispatch({
            type: "thread.delete",
            commandId: control.commandId,
            threadId,
            preparingRunId: runId,
          })
          .pipe(Effect.mapError(mapError(entry.input, "control-preparation", threadId)));
      } else {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${control.commandId}:local`),
            threadId,
            runId,
            phase: "setup",
            workspacePreparation: {
              phase: "setup",
              workspaceKind: "root",
              ...(entry.projectCwd === null ? {} : { cwd: entry.projectCwd }),
            },
          })
          .pipe(Effect.mapError(mapError(entry.input, "update-thread", threadId)));
        yield* threads
          .dispatch({ type: "prepared-run.release", commandId: control.commandId, threadId, runId })
          .pipe(Effect.mapError(mapError(entry.input, "release-run", threadId)));
      }
      return true;
    },
  );

  const controlPreparation: ThreadLaunchService["Service"]["controlPreparation"] = Effect.fn(
    "ThreadLaunchService.controlPreparation",
  )(function* (control) {
    const receipt = yield* receipts.getByCommandId(control.commandId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadLaunchError({
            operation: "control-preparation",
            commandId: control.commandId,
            projectId: ProjectId.make("unknown"),
            threadId: control.threadId,
            cause,
          }),
      ),
    );
    if (
      Option.isSome(receipt) &&
      receipt.value.status === "accepted" &&
      receipt.value.threadId === control.threadId &&
      receipt.value.commandType ===
        (control.action === "cancel" ? "thread.delete" : "prepared-run.release")
    )
      return { threadId: control.threadId };
    const entry = activePreparations.get(control.runId);
    const rejected = (cause: string) =>
      new ThreadLaunchError({
        operation: "control-preparation",
        commandId: control.commandId,
        projectId: entry?.input.projectId ?? ProjectId.make("unknown"),
        threadId: control.threadId,
        cause,
      });
    if (Option.isSome(receipt))
      return yield* rejected("This request identifier has already been used.");
    if (!entry || entry.input.workspaceStrategy.type !== "worktree")
      return yield* rejected("Worktree preparation is no longer active.");
    const projection = yield* threads
      .getThreadProjection(control.threadId)
      .pipe(Effect.mapError(() => rejected("Could not read this thread.")));
    if (
      projection.thread.id !== control.threadId ||
      projection.thread.projectId !== entry.input.projectId ||
      !projection.runs.some((run) => run.id === control.runId && run.status === "preparing")
    )
      return yield* rejected(
        "The agent has already started. Workspace preparation can no longer be changed.",
      );
    if (
      control.action === "cancel" &&
      (projection.messages.length !== 1 || projection.runs.length !== 1)
    )
      return yield* rejected(
        "Remove queued follow-up messages before cancelling this preparation.",
      );
    if (entry.control?.commandId === control.commandId && entry.control.action === control.action) {
      yield* Deferred.await(entry.done);
      return { threadId: control.threadId };
    }
    // Claim before yielding again: release and competing actions use this same fence.
    if (!entry.accepting || entry.control !== null)
      return yield* rejected("Workspace preparation is already finishing or changing.");
    entry.control = control;
    const item = projection.turnItems.find(
      (item) =>
        item.type === "command_execution" &&
        item.runId === control.runId &&
        item.workspacePreparation,
    );
    if (item?.type === "command_execution" && item.workspacePreparation) {
      yield* threads
        .dispatch({
          type: "prepared-run.progress",
          commandId: CommandId.make(`${control.commandId}:requested`),
          threadId: control.threadId,
          runId: control.runId,
          phase: item.workspacePreparation.phase,
          workspacePreparation: { ...item.workspacePreparation, controlAction: control.action },
        })
        .pipe(Effect.ignore);
    }
    yield* Deferred.await(entry.done);
    return { threadId: control.threadId };
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
    entry: ActivePreparation,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const reportProgress = (
      phase: OrchestrationV2WorkspacePreparation["phase"],
      details: Partial<OrchestrationV2WorkspacePreparation> = {},
      suffix: string = phase,
    ) =>
      runId === null
        ? Effect.void
        : threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:${suffix}`),
              threadId,
              runId,
              phase,
              workspacePreparation: {
                ...details,
                phase,
                workspaceKind: input.workspaceStrategy.type,
                ...(input.workspaceStrategy.type === "worktree"
                  ? {
                      baseRef: input.workspaceStrategy.baseRef,
                      startFromOrigin: input.workspaceStrategy.startFromOrigin ?? false,
                    }
                  : {}),
              },
            })
            .pipe(Effect.asVoid, Effect.mapError(mapError(input, "update-thread", threadId)));
    yield* reportProgress("preparing");

    const initialMessage = input.initialMessage;
    if (project.workspaceRoot === null) {
      return yield* mapError(
        input,
        "resolve-project",
        threadId,
      )("Project has no workspace directory. Attach a directory before launching a thread.");
    }
    const projectWorkspaceRoot = project.workspaceRoot;
    entry.projectCwd = projectWorkspaceRoot;
    const applyControl = () =>
      runId === null ? Effect.succeed(false) : applyPreparationControl(entry, threadId, runId);
    if (yield* applyControl()) return;
    const generateBranchNameFor = (cwd: string, message: ThreadLaunchInitialMessage) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const modelSelection =
          settings.sourceControlWriterModelSelection === null
            ? settings.textGenerationModelSelection
            : ServerSettings.resolveSourceControlWriterModelSelection(
                settings,
                yield* providerRegistry.getProviders,
              );
        return yield* textGeneration
          .generateBranchName({
            cwd,
            message: message.text,
            attachments: message.attachments,
            modelSelection,
          })
          .pipe(Effect.map((result) => result.branch));
      });

    // The server owns worktree naming: without an explicit branch, provision
    // under a temporary `pathway/<hash>` name so the worktree never waits on
    // name generation, then rename in the background below.
    const requestedBranch = input.workspaceStrategy.branch;
    let branch: string | null;
    if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
      const uuid = yield* randomUuidV4;
      branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
    } else {
      branch = requestedBranch ?? null;
    }
    let worktreePath =
      input.workspaceStrategy.type === "existing_worktree"
        ? input.workspaceStrategy.worktreePath
        : null;
    if (input.workspaceStrategy.type === "worktree") {
      let startRef = input.workspaceStrategy.baseRef;
      if (input.workspaceStrategy.startFromOrigin === true) {
        const primaryRemoteName = yield* git
          .resolvePrimaryRemoteName(projectWorkspaceRoot)
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        const remoteName = yield* git
          .resolveRemoteNameForRef({
            cwd: projectWorkspaceRoot,
            refName: input.workspaceStrategy.baseRef,
            fallbackRemoteName: primaryRemoteName,
          })
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        yield* git
          .fetchRemote({ cwd: projectWorkspaceRoot, remoteName })
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        startRef = yield* git
          .resolveRemoteTrackingCommit({
            cwd: projectWorkspaceRoot,
            refName: input.workspaceStrategy.baseRef,
            fallbackRemoteName: remoteName,
          })
          .pipe(
            Effect.map((resolved) => resolved.commitSha),
            Effect.mapError(mapError(input, "provision-worktree", threadId)),
          );
      }
      if (yield* applyControl()) return;
      yield* reportProgress("worktree", { branch: branch!, cwd: projectWorkspaceRoot });
      const worktree = yield* git
        .createWorktree(
          {
            cwd: projectWorkspaceRoot,
            refName: startRef,
            newRefName: branch!,
            baseRefName: input.workspaceStrategy.baseRef,
            path: null,
          },
          (checkoutPercent) =>
            entry.control
              ? Effect.void
              : reportProgress(
                  "worktree",
                  { branch: branch!, cwd: projectWorkspaceRoot, checkoutPercent },
                  `checkout:${checkoutPercent}`,
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not report checkout progress", cause),
                  ),
                ),
        )
        .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
      worktreePath = worktree.worktree.path;
      branch = worktree.worktree.refName;
      entry.worktree = { path: worktreePath };
      if (yield* applyControl()) return;
    }

    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace`),
        threadId,
        branch,
        worktreePath,
      })
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));

    if (yield* applyControl()) return;
    const cwd = worktreePath ?? projectWorkspaceRoot;
    yield* reportProgress("setup", { cwd, ...(branch === null ? {} : { branch }) });
    const setup = yield* setupScripts
      .runForThread({
        threadId,
        projectId: input.projectId,
        projectCwd: projectWorkspaceRoot,
        worktreePath: cwd,
        project: {
          workspaceRoot: projectWorkspaceRoot,
          scripts: project.scripts,
        },
      })
      .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

    if (setup.status === "started") {
      entry.terminalId = setup.terminalId;
      if (yield* applyControl()) return;
      yield* reportProgress(
        "setup",
        {
          cwd,
          ...(branch === null ? {} : { branch }),
          terminalId: setup.terminalId,
          scriptName: setup.scriptName,
        },
        "setup-started",
      );
    }

    const controlled = yield* Effect.sync(() => {
      entry.accepting = false;
      return entry.control !== null;
    });
    if (controlled) {
      yield* applyControl();
      return;
    }
    if (runId !== null) {
      yield* threads
        .dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${input.commandId}:release`),
          threadId,
          runId,
        })
        .pipe(Effect.mapError(mapError(input, "release-run", threadId)));
    }
    // Rename temporary branches (server-invented above, or sent by clients
    // that name worktrees themselves) in the background so generation latency
    // never delays provisioning or the provider turn. The temporary name
    // simply sticks if generation or the rename fails.
    if (
      worktreePath !== null &&
      branch !== null &&
      initialMessage !== undefined &&
      isTemporaryWorktreeBranch(branch)
    ) {
      const oldBranch = branch;
      const worktreeCwd = worktreePath;
      yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
        Effect.flatMap((newBranch) => git.renameBranch({ cwd: worktreeCwd, oldBranch, newBranch })),
        Effect.flatMap((renamed) =>
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:branch-rename`),
            threadId,
            branch: renamed.branch,
            worktreePath: worktreeCwd,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread worktree branch rename failed", {
            commandId: input.commandId,
            threadId,
            oldBranch,
            cause,
          }),
        ),
        Effect.forkIn(preparationScope),
      );
    }
  });

  const failPreparedRun = (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.mapError(mapError(input, "fail-run", threadId)),
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const entry: ActivePreparation = {
      input,
      done: yield* Deferred.make<void, ThreadLaunchError>(),
      accepting: true,
      control: null,
      projectCwd: null,
      worktree: null,
      terminalId: null,
    };
    if (runId !== null) activePreparations.set(runId, entry);
    yield* prepareInBackground(input, threadId, runId, entry).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          entry.accepting = false;
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            yield* failPreparedRun(input, threadId, runId, Cause.squash(exit.cause));
          }
          yield* Deferred.done(entry.done, exit);
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          if (runId !== null) activePreparations.delete(runId);
          yield* releasePreparation(input.commandId);
        }),
      ),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (input) {
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      return yield* Effect.gen(function* () {
        const candidateThreadId =
          input.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        const initialBranch = input.workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          input.workspaceStrategy.type === "existing_worktree"
            ? input.workspaceStrategy.worktreePath
            : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                ...(input.locations === undefined ? {} : { locations: input.locations }),
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              attachments: input.initialMessage.attachments,
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadProjection(threadId).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(input, threadId, runId);
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  return ThreadLaunchService.of({ launch, controlPreparation });
});

export const layer = Layer.effect(ThreadLaunchService, make);
