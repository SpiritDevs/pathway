import type { ProjectId, ThreadId, VcsStatusResult } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { conversationDirectoryForThread } from "../conversationWorkspace.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

export interface ThreadWorkspaceCleanupInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly conversationDirectory?: string;
  readonly worktreePath?: string;
  readonly discardChanges?: boolean;
  readonly expectedPullRequest?: { readonly number: number; readonly url: string };
  readonly ownedBranch?: { readonly name: string; readonly commitSha: string };
}

export function isMatchingMergedPullRequest(
  expected: { readonly number: number; readonly url: string } | null | undefined,
  actual: VcsStatusResult["pr"],
): boolean {
  return (
    expected != null &&
    actual !== null &&
    actual.state === "merged" &&
    actual.number === expected.number &&
    actual.url === expected.url
  );
}

export function temporaryWorkspaceIssues(status: VcsStatusResult) {
  return {
    hasUncommittedChanges: status.isRepo && status.hasWorkingTreeChanges,
    hasUnpushedCommits: status.isRepo && status.aheadCount > 0,
  };
}

export class ResourceCleanupError extends Schema.TaggedErrorClass<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "attachment", "workspace", "workspace-check"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupWorkspace?: (
    input: ThreadWorkspaceCleanupInput,
  ) => Effect.Effect<void, ResourceCleanupError>;
  readonly captureWorktreeBranch?: (
    input: ThreadWorkspaceCleanupInput,
  ) => Effect.Effect<
    { readonly name: string; readonly commitSha: string } | undefined,
    ResourceCleanupError
  >;
  readonly checkTemporaryWorkspace?: (input: ThreadWorkspaceCleanupInput) => Effect.Effect<
    {
      readonly hasUncommittedChanges: boolean;
      readonly hasUnpushedCommits: boolean;
      readonly mergedPullRequest?: boolean;
    },
    ResourceCleanupError
  >;
}>("@spiritdevs/pathway/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const live = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const git = yield* GitWorkflowService;
    const projects = yield* ProjectionProjectRepository;

    const workspaceFailure = (input: ThreadWorkspaceCleanupInput, cause: unknown) =>
      new ResourceCleanupError({ operation: "workspace", threadId: input.threadId, cause });

    const validateConversationDirectory = (input: ThreadWorkspaceCleanupInput) =>
      input.conversationDirectory === undefined ||
      path.resolve(input.conversationDirectory) ===
        path.resolve(conversationDirectoryForThread(config.stateDir, input.threadId));

    const captureWorktreeBranch = Effect.fn("ResourceCleanupService.captureWorktreeBranch")(
      function* (input: ThreadWorkspaceCleanupInput) {
        if (input.worktreePath === undefined || input.projectId === null) return undefined;
        if (
          !(yield* fileSystem
            .exists(input.worktreePath)
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause))))
        )
          return undefined;
        yield* git.invalidateLocalStatus(input.worktreePath);
        const status = yield* git
          .localStatus({ cwd: input.worktreePath })
          .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
        if (!status.isRepo || status.refName === null) return undefined;
        const head = yield* git
          .resolveCommit({ cwd: input.worktreePath, revision: "HEAD" })
          .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
        return { name: status.refName, commitSha: head.commitSha };
      },
    );

    const checkTemporaryWorkspace = Effect.fn("ResourceCleanupService.checkTemporaryWorkspace")(
      function* (input: ThreadWorkspaceCleanupInput) {
        if (!validateConversationDirectory(input)) {
          return yield* workspaceFailure(
            input,
            "Conversation directory is outside this thread's storage.",
          );
        }
        if (input.projectId !== null && input.worktreePath === undefined) {
          return yield* workspaceFailure(
            input,
            "Temporary project threads require their own worktree.",
          );
        }
        const directories = [
          ...new Set(
            [input.worktreePath, input.conversationDirectory].filter(
              (directory): directory is string => directory !== undefined,
            ),
          ),
        ];
        let hasUncommittedChanges = false;
        let hasUnpushedCommits = false;
        let mergedPullRequest = false;
        for (const cwd of directories) {
          if (
            !(yield* fileSystem
              .exists(cwd)
              .pipe(Effect.mapError((cause) => workspaceFailure(input, cause))))
          )
            continue;
          yield* git.invalidateStatus(cwd);
          const status = yield* git.status({ cwd }).pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({
                  operation: "workspace-check",
                  threadId: input.threadId,
                  cause,
                }),
            ),
          );
          const issues = temporaryWorkspaceIssues(status);
          if (cwd === (input.worktreePath ?? input.conversationDirectory)) {
            mergedPullRequest = isMatchingMergedPullRequest(input.expectedPullRequest, status.pr);
          }
          hasUncommittedChanges ||= issues.hasUncommittedChanges;
          hasUnpushedCommits ||= issues.hasUnpushedCommits;
          if (status.isRepo && !status.hasPrimaryRemote && !hasUnpushedCommits) {
            const head = yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(Effect.option);
            hasUnpushedCommits ||= Option.isSome(head);
          }
        }
        return { hasUncommittedChanges, hasUnpushedCommits, mergedPullRequest };
      },
    );

    const cleanupWorkspace = Effect.fn("ResourceCleanupService.cleanupWorkspace")(function* (
      input: ThreadWorkspaceCleanupInput,
    ) {
      if (!validateConversationDirectory(input)) {
        return yield* workspaceFailure(
          input,
          "Conversation directory is outside this thread's storage.",
        );
      }
      if (input.discardChanges !== true) {
        const issues = yield* checkTemporaryWorkspace(input);
        if (issues.hasUncommittedChanges || issues.hasUnpushedCommits) {
          return yield* workspaceFailure(
            input,
            "TEMPORARY_UNFINISHED_WORK: Workspace changed before cleanup.",
          );
        }
      }
      if (input.worktreePath !== undefined) {
        if (input.projectId === null) {
          return yield* workspaceFailure(
            input,
            "A worktree cannot be removed without its project.",
          );
        }
        const project = yield* projects
          .getById({ projectId: input.projectId })
          .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
        if (Option.isNone(project) || project.value.workspaceRoot === null) {
          return yield* workspaceFailure(input, "The worktree's project workspace is unavailable.");
        }
        const projectCwd = project.value.workspaceRoot;
        if (path.resolve(projectCwd) === path.resolve(input.worktreePath)) {
          return yield* workspaceFailure(
            input,
            "The project checkout cannot be removed as a thread worktree.",
          );
        }
        if (input.ownedBranch !== undefined) {
          yield* git.invalidateLocalStatus(projectCwd);
          const root = yield* git
            .localStatus({ cwd: projectCwd })
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
          if (root.refName === input.ownedBranch.name) {
            return yield* workspaceFailure(
              input,
              "The project checkout's branch cannot be removed.",
            );
          }
          const refs = yield* git
            .listRefs({
              cwd: projectCwd,
              query: input.ownedBranch.name,
              refKind: "local",
              refresh: true,
            })
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
          const branch = refs.refs.find(
            (ref) => ref.name === input.ownedBranch?.name && !ref.isRemote,
          );
          if (
            branch?.worktreePath &&
            path.resolve(branch.worktreePath) !== path.resolve(input.worktreePath)
          ) {
            return yield* workspaceFailure(
              input,
              "Another worktree is using the temporary branch.",
            );
          }
          if (branch !== undefined) {
            const head = yield* git
              .resolveCommit({ cwd: projectCwd, revision: input.ownedBranch.name })
              .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
            if (head.commitSha !== input.ownedBranch.commitSha) {
              return yield* workspaceFailure(
                input,
                "The temporary branch changed after deletion was requested; its files were kept.",
              );
            }
          }
        }
        if (
          yield* fileSystem
            .exists(input.worktreePath)
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)))
        ) {
          const [realProject, realWorktree] = yield* Effect.all([
            fileSystem.realPath(projectCwd),
            fileSystem.realPath(input.worktreePath),
          ]).pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
          if (realProject === realWorktree) {
            return yield* workspaceFailure(
              input,
              "The project checkout cannot be removed as a thread worktree.",
            );
          }
          yield* git
            .removeWorktree({ cwd: projectCwd, path: input.worktreePath, force: true })
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
        }
        if (input.ownedBranch !== undefined) {
          const refs = yield* git
            .listRefs({
              cwd: projectCwd,
              query: input.ownedBranch.name,
              refKind: "local",
              refresh: true,
            })
            .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
          if (refs.refs.some((ref) => ref.name === input.ownedBranch?.name && !ref.isRemote)) {
            yield* git
              .deleteLocalBranch({ cwd: projectCwd, refName: input.ownedBranch.name, force: true })
              .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
          }
        }
      }
      if (input.conversationDirectory !== undefined) {
        yield* fileSystem
          .remove(input.conversationDirectory, { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => workspaceFailure(input, cause)));
      }
    });
    return {
      captureWorktreeBranch,
      checkTemporaryWorkspace,
      cleanupWorkspace,
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
