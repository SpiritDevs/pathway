import * as NodeCrypto from "node:crypto";
import { ProjectId, ThreadId, type OrchestrationV2AppThread } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class ThreadWorkspaceError extends Schema.TaggedErrorClass<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isThreadWorkspaceError = Schema.is(ThreadWorkspaceError);

const WorkspaceOwnership = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  cwd: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.String,
  baseCommit: Schema.String,
  phase: Schema.Literals(["creating", "ready"]),
});
const decodeWorkspaceOwnership = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkspaceOwnership),
);
const encodeWorkspaceOwnership = Schema.encodeEffect(Schema.fromJsonString(WorkspaceOwnership));

const unavailable = () =>
  Effect.fail(new ThreadWorkspaceError({ message: "Thread workspace service unavailable." }));

export class ThreadWorkspaceService extends Context.Reference<{
  readonly createConversation: (threadId: ThreadId) => Effect.Effect<string, ThreadWorkspaceError>;
  readonly attachProject: (input: {
    threadId: ThreadId;
    projectId: ProjectId;
    temporary: boolean;
    baseRef?: string | undefined;
    branch?: string | undefined;
    startFromOrigin?: boolean | undefined;
  }) => Effect.Effect<{ worktreePath: string | null; branch: string | null }, ThreadWorkspaceError>;
  readonly hasMergedPullRequest: (
    thread: OrchestrationV2AppThread,
  ) => Effect.Effect<boolean, ThreadWorkspaceError>;
  readonly hasUnfinishedGitWork: (
    thread: OrchestrationV2AppThread,
  ) => Effect.Effect<boolean, ThreadWorkspaceError>;
  readonly cleanup: (threadId: ThreadId) => Effect.Effect<void, ThreadWorkspaceError>;
}>("@spiritdevs/pathway/orchestration-v2/ThreadWorkspaceService", {
  defaultValue: () => ({
    createConversation: unavailable,
    attachProject: unavailable,
    hasUnfinishedGitWork: unavailable,
    hasMergedPullRequest: unavailable,
    cleanup: unavailable,
  }),
}) {}

export function conversationDirectory(
  path: Pick<Path.Path, "join">,
  stateDir: string,
  threadId: ThreadId,
): string {
  return path.join(
    stateDir,
    "conversations",
    NodeCrypto.createHash("sha256").update(threadId).digest("hex"),
  );
}

export const live = Layer.effect(
  ThreadWorkspaceService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const git = yield* GitVcsDriver;
    const gitWorkflow = yield* GitWorkflowService;
    const projects = yield* ProjectionProjectRepository;
    const projections = yield* ProjectionStoreV2;
    const mapError = (message: string) => (cause: unknown) =>
      new ThreadWorkspaceError({ message, cause });
    const ownershipPath = (threadId: ThreadId) =>
      path.join(
        config.stateDir,
        "thread-workspaces",
        `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
      );
    const writeOwnership = Effect.fn("ThreadWorkspaceService.writeOwnership")(function* (
      record: typeof WorkspaceOwnership.Type,
    ) {
      const target = ownershipPath(record.threadId);
      const encoded = yield* encodeWorkspaceOwnership(record).pipe(
        Effect.mapError(mapError("Could not encode workspace ownership.")),
      );
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(Effect.mapError(mapError("Could not persist workspace ownership.")));
      yield* fs
        .writeFileString(`${target}.tmp`, encoded)
        .pipe(Effect.mapError(mapError("Could not persist workspace ownership.")));
      yield* fs
        .rename(`${target}.tmp`, target)
        .pipe(Effect.mapError(mapError("Could not persist workspace ownership.")));
    });

    const projectRoot = Effect.fn("ThreadWorkspaceService.projectRoot")(function* (
      projectId: ProjectId,
      allowDeleted = false,
    ) {
      const result = yield* projects
        .getById({ projectId })
        .pipe(Effect.mapError(mapError("Could not load project.")));
      if (
        Option.isNone(result) ||
        (!allowDeleted && result.value.deletedAt !== null) ||
        result.value.workspaceRoot === null
      ) {
        return yield* new ThreadWorkspaceError({
          message: "Attach a project with a workspace on this environment.",
        });
      }
      return result.value.workspaceRoot;
    });

    return {
      createConversation: Effect.fn("ThreadWorkspaceService.createConversation")(function* (
        threadId: ThreadId,
      ) {
        const directory = conversationDirectory(path, config.stateDir, threadId);
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError(mapError("Could not create conversation folder.")));
        return directory;
      }),
      attachProject: Effect.fn("ThreadWorkspaceService.attachProject")(function* (input: {
        threadId: ThreadId;
        projectId: ProjectId;
        temporary: boolean;
        baseRef?: string | undefined;
        branch?: string | undefined;
        startFromOrigin?: boolean | undefined;
      }) {
        const cwd = yield* projectRoot(input.projectId);
        if (!input.temporary) return { worktreePath: null, branch: null };
        const branch =
          input.branch ??
          `pathway/temporary-${NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 20)}`;
        const worktreePath = path.join(
          config.worktreesDir,
          "temporary",
          NodeCrypto.createHash("sha256").update(input.threadId).digest("hex"),
        );
        const manifestPath = ownershipPath(input.threadId);
        let previous: typeof WorkspaceOwnership.Type | null = null;
        if (
          yield* fs
            .exists(manifestPath)
            .pipe(Effect.mapError(mapError("Could not inspect workspace ownership.")))
        ) {
          previous = yield* fs
            .readFileString(manifestPath)
            .pipe(
              Effect.flatMap(decodeWorkspaceOwnership),
              Effect.mapError(mapError("Could not read workspace ownership.")),
            );
          if (
            previous.threadId !== input.threadId ||
            previous.projectId !== input.projectId ||
            previous.cwd !== cwd ||
            previous.worktreePath !== worktreePath ||
            previous.branch !== branch
          )
            return yield* new ThreadWorkspaceError({
              message:
                "A workspace preparation for this thread already exists with different settings. Retry the original preparation.",
            });
        }
        if (
          yield* fs
            .exists(worktreePath)
            .pipe(Effect.mapError(mapError("Could not inspect workspace folder.")))
        ) {
          if (previous === null)
            return yield* new ThreadWorkspaceError({
              message:
                "The requested workspace already exists without this thread's ownership record.",
            });
          const shell = yield* projections
            .getShellSnapshot()
            .pipe(Effect.mapError(mapError("Could not verify provisional workspace ownership.")));
          if (
            [...shell.threads, ...shell.archivedThreads].some(
              (thread) =>
                thread.id !== input.threadId &&
                thread.deletedAt === null &&
                thread.worktreePath === worktreePath,
            )
          )
            return yield* new ThreadWorkspaceError({
              message: "The prepared workspace is referenced by another thread.",
            });
          const expectedGit = yield* git
            .execute({
              operation: "temporary-thread.project-identity",
              cwd,
              args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            })
            .pipe(Effect.mapError(mapError("Could not verify project Git identity.")));
          const actualGit = yield* git
            .execute({
              operation: "temporary-thread.workspace-identity",
              cwd: worktreePath,
              args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            })
            .pipe(Effect.mapError(mapError("Could not verify prepared Git worktree.")));
          const actualBranch = yield* git
            .execute({
              operation: "temporary-thread.workspace-branch",
              cwd: worktreePath,
              args: ["symbolic-ref", "--short", "HEAD"],
            })
            .pipe(Effect.mapError(mapError("Could not verify prepared branch.")));
          if (
            expectedGit.stdout.trim() !== actualGit.stdout.trim() ||
            actualBranch.stdout.trim() !== branch
          )
            return yield* new ThreadWorkspaceError({
              message: "Prepared workspace identity changed. Its files have been kept.",
            });
          if (previous.phase === "creating") {
            const status = yield* git
              .statusDetailsLocal(worktreePath)
              .pipe(Effect.mapError(mapError("Could not inspect interrupted preparation.")));
            if (status.hasWorkingTreeChanges)
              return yield* new ThreadWorkspaceError({
                message:
                  "Workspace preparation was interrupted with unfinished files. Its files have been kept.",
              });
            yield* writeOwnership({ ...previous, phase: "ready" });
          }
          return { worktreePath, branch };
        }
        let refName = input.baseRef ?? "HEAD";
        if (input.startFromOrigin === true) {
          const primaryRemoteName = yield* git
            .resolvePrimaryRemoteName(cwd)
            .pipe(Effect.mapError(mapError("Could not resolve project remote.")));
          const remoteName = yield* git
            .resolveRemoteNameForRef({ cwd, refName, fallbackRemoteName: primaryRemoteName })
            .pipe(Effect.mapError(mapError("Could not resolve selected branch remote.")));
          yield* git
            .fetchRemote({ cwd, remoteName })
            .pipe(Effect.mapError(mapError("Could not fetch selected base branch.")));
          const resolved = yield* git
            .resolveRemoteTrackingCommit({ cwd, refName, fallbackRemoteName: remoteName })
            .pipe(Effect.mapError(mapError("Could not resolve selected remote branch.")));
          refName = resolved.commitSha;
        }
        const base = yield* git
          .execute({
            operation: "temporary-thread.resolve-base",
            cwd,
            args: ["rev-parse", "--verify", `${refName}^{commit}`],
          })
          .pipe(Effect.mapError(mapError("Could not resolve the selected base branch.")));
        const existingBranch = yield* git
          .execute({
            operation: "temporary-thread.provisional-branch",
            cwd,
            args: ["show-ref", "--verify", "--hash", `refs/heads/${branch}`],
            allowNonZeroExit: true,
          })
          .pipe(Effect.mapError(mapError("Could not inspect the requested branch.")));
        if (existingBranch.exitCode === 0 && previous === null)
          return yield* new ThreadWorkspaceError({
            message:
              "The requested branch already exists. Choose a new branch for this temporary thread.",
          });
        if (
          existingBranch.exitCode === 0 &&
          previous !== null &&
          existingBranch.stdout.trim() !== previous.baseCommit
        )
          return yield* new ThreadWorkspaceError({
            message:
              "The provisional branch changed before workspace preparation finished. Its commits have been kept.",
          });
        const record: typeof WorkspaceOwnership.Type = previous ?? {
          threadId: input.threadId,
          projectId: input.projectId,
          cwd,
          worktreePath,
          branch,
          baseCommit: base.stdout.trim(),
          phase: "creating",
        };
        yield* writeOwnership(record);
        yield* fs
          .makeDirectory(path.dirname(worktreePath), { recursive: true })
          .pipe(Effect.mapError(mapError("Could not create worktree parent directory.")));
        const result = yield* git
          .createWorktree({
            cwd,
            refName: existingBranch.exitCode === 0 ? branch : record.baseCommit,
            ...(existingBranch.exitCode === 0 ? {} : { newRefName: branch }),
            baseRefName: input.baseRef,
            path: worktreePath,
          })
          .pipe(
            Effect.mapError(
              mapError(
                "Temporary project threads require a new dedicated Git worktree. Choose a Git project that supports worktrees.",
              ),
            ),
          );
        yield* writeOwnership({ ...record, phase: "ready" });
        return { worktreePath: result.worktree.path, branch: result.worktree.refName };
      }),
      hasMergedPullRequest: Effect.fn("ThreadWorkspaceService.hasMergedPullRequest")(function* (
        thread: OrchestrationV2AppThread,
      ) {
        if (!thread.temporary || thread.projectId === null || thread.worktreePath === null)
          return false;
        yield* gitWorkflow.invalidateStatus(thread.worktreePath);
        const status = yield* gitWorkflow
          .status({ cwd: thread.worktreePath })
          .pipe(Effect.mapError(mapError("Could not verify merged pull request.")));
        return status.pr?.state === "merged";
      }),
      hasUnfinishedGitWork: Effect.fn("ThreadWorkspaceService.hasUnfinishedGitWork")(function* (
        thread: OrchestrationV2AppThread,
      ) {
        const directories = new Set<string>();
        const conversationRepositories = new Set<string>();
        const bareRepositories = new Set<string>();
        if (thread.conversationPath != null) {
          const conversationPath = thread.conversationPath;
          yield* Effect.gen(function* () {
            const root = yield* fs.realPath(conversationPath);
            const pending = [root];
            const visited = new Set<string>();
            let examinedEntries = 0;
            while (pending.length > 0) {
              const directory = pending.pop()!;
              if (visited.has(directory)) continue;
              visited.add(directory);
              const entries = yield* fs.readDirectory(directory);
              examinedEntries += entries.length;
              if (examinedEntries > 20_000)
                return yield* new ThreadWorkspaceError({
                  message:
                    "The conversation folder is too large to verify all Git work automatically. Keep conversation to preserve it and review its repositories before deleting.",
                });
              // Only repositories owned by this folder count. In particular, development
              // userdata may itself live in an unrelated, ignored parent checkout.
              const hasGitMetadata = entries.includes(".git");
              const mayBeBareRepository =
                entries.includes("HEAD") && entries.includes("objects") && entries.includes("refs");
              const isBareRepository =
                mayBeBareRepository &&
                (yield* git
                  .execute({
                    operation: "temporary-thread.inspect-bare-repository",
                    cwd: directory,
                    args: ["rev-parse", "--is-bare-repository"],
                    allowNonZeroExit: true,
                  })
                  .pipe(
                    Effect.mapError(mapError("Could not inspect conversation repository.")),
                  )).stdout.trim() === "true";
              if (hasGitMetadata || isBareRepository) {
                directories.add(directory);
                conversationRepositories.add(directory);
              }
              if (isBareRepository) {
                bareRepositories.add(directory);
                continue;
              }
              for (const entry of entries) {
                if (entry === ".git") continue;
                const child = path.join(directory, entry);
                const info = yield* fs
                  .stat(child)
                  .pipe(
                    Effect.catch((error) =>
                      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
                    ),
                  );
                if (info?.type !== "Directory") continue;
                const resolved = yield* fs.realPath(child);
                const relative = path.relative(root, resolved);
                if (
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative)
                )
                  pending.push(resolved);
              }
            }
          }).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.fail(
                  new ThreadWorkspaceError({
                    message:
                      "Git verification of the conversation folder timed out. Keep conversation to preserve it and review its repositories before deleting.",
                  }),
                ),
            }),
            Effect.mapError((cause) =>
              isThreadWorkspaceError(cause)
                ? cause
                : mapError("Could not verify Git work in the conversation folder.")(cause),
            ),
          );
        }
        if (thread.projectId !== null)
          directories.add(thread.worktreePath ?? (yield* projectRoot(thread.projectId)));
        for (const cwd of directories) {
          const local = bareRepositories.has(cwd)
            ? null
            : yield* git
                .statusDetailsLocal(cwd)
                .pipe(Effect.mapError(mapError("Could not check unfinished Git work.")));
          if (local !== null && !local.isRepo) {
            if (conversationRepositories.has(cwd))
              return yield* new ThreadWorkspaceError({
                message:
                  "A repository in the conversation folder could not be verified. Its files have been kept.",
              });
            continue;
          }
          if (local?.hasWorkingTreeChanges) return true;
          // Commits are safe only when reachable from a remote ref. This also
          // protects new branches without an upstream and commits on default.
          const unpublished = yield* git
            .execute({
              operation: "temporary-thread.unpushed",
              cwd,
              args: [
                "rev-list",
                "--max-count=1",
                "HEAD",
                ...(conversationRepositories.has(cwd) ? ["--branches", "--tags"] : []),
                "--not",
                "--remotes",
              ],
              allowNonZeroExit: true,
            })
            .pipe(Effect.mapError(mapError("Could not check unpushed commits.")));
          if (unpublished.exitCode !== 0 || unpublished.stdout.trim() !== "") return true;
          if (
            cwd === thread.worktreePath &&
            thread.ownedBranch != null &&
            thread.ownedBranch !== local?.branch
          ) {
            const owned = yield* git
              .execute({
                operation: "temporary-thread.owned-branch",
                cwd,
                args: ["rev-list", "--max-count=1", thread.ownedBranch, "--not", "--remotes"],
                allowNonZeroExit: true,
              })
              .pipe(Effect.mapError(mapError("Could not check the owned branch.")));
            if (owned.exitCode === 0 && owned.stdout.trim() !== "") return true;
          }
        }
        return false;
      }),
      cleanup: Effect.fn("ThreadWorkspaceService.cleanup")(function* (threadId: ThreadId) {
        const projection = yield* projections
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError("Could not read deleted thread.")));
        const thread = projection.thread;
        if (thread.deletedAt === null) return;
        const shell = yield* projections
          .getShellSnapshot()
          .pipe(Effect.mapError(mapError("Could not verify workspace ownership.")));
        const others = [...shell.threads, ...shell.archivedThreads].filter(
          (candidate) => candidate.id !== threadId && candidate.deletedAt === null,
        );
        if (
          thread.ownedWorktreePath != null &&
          thread.projectId !== null &&
          !others.some(
            (candidate) =>
              candidate.worktreePath === thread.ownedWorktreePath ||
              candidate.ownedWorktreePath === thread.ownedWorktreePath,
          )
        ) {
          const cwd = yield* projectRoot(thread.projectId, true);
          if (
            yield* fs
              .exists(thread.ownedWorktreePath)
              .pipe(Effect.mapError(mapError("Could not inspect owned worktree.")))
          ) {
            yield* git
              .removeWorktree({ cwd, path: thread.ownedWorktreePath, force: true })
              .pipe(Effect.mapError(mapError("Could not remove owned worktree.")));
          }
          if (
            thread.ownedBranch != null &&
            !others.some(
              (candidate) =>
                candidate.projectId === thread.projectId &&
                (candidate.branch === thread.ownedBranch ||
                  candidate.ownedBranch === thread.ownedBranch),
            )
          ) {
            const branch = yield* git
              .execute({
                operation: "temporary-thread.branch-exists",
                cwd,
                args: ["show-ref", "--verify", "--quiet", `refs/heads/${thread.ownedBranch}`],
                allowNonZeroExit: true,
              })
              .pipe(Effect.mapError(mapError("Could not inspect the owned branch.")));
            if (branch.exitCode === 0)
              yield* git
                .deleteLocalBranch({ cwd, refName: thread.ownedBranch, force: true })
                .pipe(Effect.mapError(mapError("Could not remove the owned local branch.")));
          }
          yield* fs
            .remove(
              path.join(
                config.stateDir,
                "thread-workspaces",
                `${path.basename(thread.ownedWorktreePath)}.json`,
              ),
              { force: true },
            )
            .pipe(Effect.mapError(mapError("Could not remove workspace ownership record.")));
        }
        if (
          thread.conversationPath != null &&
          !others.some((candidate) => candidate.conversationPath === thread.conversationPath)
        ) {
          // Never trust a mutable path or a client's directory hint for deletion.
          if (
            thread.conversationPath !==
              conversationDirectory(path, config.stateDir, thread.lineage.rootThreadId) &&
            thread.conversationPath !== conversationDirectory(path, config.stateDir, thread.id)
          ) {
            return yield* new ThreadWorkspaceError({
              message: "Conversation folder ownership could not be verified.",
            });
          }
          yield* fs
            .remove(thread.conversationPath, { recursive: true, force: true })
            .pipe(Effect.mapError(mapError("Could not remove conversation folder.")));
        }
      }),
    };
  }),
);
