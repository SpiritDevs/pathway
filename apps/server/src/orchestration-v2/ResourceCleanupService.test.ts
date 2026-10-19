import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type VcsStatusResult } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { conversationDirectoryForThread } from "../conversationWorkspace.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import {
  live,
  ResourceCleanupService,
  ResourceCleanupError,
  isMatchingMergedPullRequest,
  temporaryWorkspaceIssues,
} from "./ResourceCleanupService.ts";

const plainStatus: VcsStatusResult = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function testLayer(
  status: VcsStatusResult = plainStatus,
  overrides: Partial<GitWorkflowService["Service"]> = {},
) {
  const git = {
    invalidateStatus: () => Effect.void,
    status: () => Effect.succeed(status),
    resolveCommit: () => Effect.succeed({ commitSha: "local-only-commit" }),
    removeWorktree: () => Effect.void,
    invalidateLocalStatus: () => Effect.void,
    localStatus: () => Effect.succeed({ ...plainStatus, refName: "main" }),
    ...overrides,
  } as GitWorkflowService["Service"];
  const projects = {
    getById: () =>
      Effect.succeed(Option.some({ workspaceRoot: "/tmp/conversation-cleanup-project" })),
  } as ProjectionProjectRepository["Service"];
  return live.pipe(
    Layer.provide(Layer.succeed(GitWorkflowService, git)),
    Layer.provide(Layer.succeed(ProjectionProjectRepository, projects)),
    Layer.provide(
      Layer.succeed(TerminalManager, { close: () => Effect.void } as TerminalManager["Service"]),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "pathway-conversation-cleanup-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.layer(testLayer())("Conversation directory cleanup", (it) => {
  it.effect("removes non-Git scratch files and safely retries a completed removal", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("conversation-files");
      const conversationDirectory = conversationDirectoryForThread(config.stateDir, threadId);
      yield* fs.makeDirectory(conversationDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(conversationDirectory, "notes.txt"), "One-off notes");
      assert.isDefined(cleanup.cleanupWorkspace);
      yield* cleanup.cleanupWorkspace({ threadId, projectId: null, conversationDirectory });
      assert.isFalse(yield* fs.exists(conversationDirectory));
      yield* cleanup.cleanupWorkspace({ threadId, projectId: null, conversationDirectory });
    }),
  );

  it.effect("rejects deleting any directory outside the thread's canonical scratch path", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = ThreadId.make("conversation-escape");
      assert.isDefined(cleanup.cleanupWorkspace);
      const error = yield* cleanup
        .cleanupWorkspace({
          threadId,
          projectId: null,
          conversationDirectory: config.stateDir,
          discardChanges: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ResourceCleanupError);
      assert.isTrue(yield* fs.exists(config.stateDir));
    }),
  );

  it.effect("never removes the project's root checkout as a worktree", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService;
      assert.isDefined(cleanup.cleanupWorkspace);
      const error = yield* cleanup
        .cleanupWorkspace({
          threadId: ThreadId.make("conversation-project-root"),
          projectId: ProjectId.make("project"),
          worktreePath: "/tmp/conversation-cleanup-project",
          discardChanges: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ResourceCleanupError);
      assert.include(String(error.cause), "project checkout");
    }),
  );
});

it.layer(testLayer({ ...plainStatus, isRepo: true }))("Conversation Git cleanup", (it) => {
  it.effect("retains a scratch Git repository containing commits with no remote", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = ThreadId.make("conversation-local-commit");
      const conversationDirectory = conversationDirectoryForThread(config.stateDir, threadId);
      yield* fs.makeDirectory(conversationDirectory, { recursive: true });
      assert.isDefined(cleanup.checkTemporaryWorkspace);
      const issues = yield* cleanup.checkTemporaryWorkspace({
        threadId,
        projectId: null,
        conversationDirectory,
      });
      assert.isTrue(issues.hasUnpushedCommits);
      assert.isDefined(cleanup.cleanupWorkspace);
      yield* cleanup
        .cleanupWorkspace({ threadId, projectId: null, conversationDirectory })
        .pipe(Effect.flip);
      assert.isTrue(yield* fs.exists(conversationDirectory));
      yield* cleanup.cleanupWorkspace({
        threadId,
        projectId: null,
        conversationDirectory,
        discardChanges: true,
      });
      assert.isFalse(yield* fs.exists(conversationDirectory));
    }),
  );
});

it("only recognizes the exact attached, merged pull request", () => {
  const expected = { number: 42, url: "https://github.com/example/repo/pull/42" };
  const merged = {
    ...expected,
    title: "Work",
    baseRef: "main",
    headRef: "work",
    state: "merged" as const,
  };
  assert.isTrue(isMatchingMergedPullRequest(expected, merged));
  assert.isFalse(isMatchingMergedPullRequest(expected, { ...merged, number: 43 }));
  assert.isFalse(
    isMatchingMergedPullRequest(expected, {
      ...merged,
      url: "https://github.com/other/repo/pull/42",
    }),
  );
  assert.isFalse(isMatchingMergedPullRequest(expected, { ...merged, state: "closed" }));
  assert.isFalse(isMatchingMergedPullRequest(expected, { ...merged, state: "open" }));
  assert.isFalse(isMatchingMergedPullRequest(undefined, merged));
  assert.deepEqual(
    temporaryWorkspaceIssues({
      ...plainStatus,
      isRepo: true,
      hasWorkingTreeChanges: true,
      aheadCount: 2,
    }),
    { hasUncommittedChanges: true, hasUnpushedCommits: true },
  );
});

for (const ownership of ["owned", "moved", "changed"] as const) {
  it.effect(
    `temporary branch cleanup ${ownership === "owned" ? "removes only its recorded branch" : `refuses a branch that ${ownership}`}`,
    () => {
      const removed: string[] = [];
      const branch = {
        name: "pathway/temp",
        isRemote: false,
        worktreePath: ownership === "moved" ? "/another-worktree" : null,
      };
      const layer = testLayer(plainStatus, {
        listRefs: () =>
          Effect.succeed({
            refs: removed.length === 0 ? [branch] : [],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
          } as never),
        resolveCommit: () =>
          Effect.succeed({ commitSha: ownership === "changed" ? "new-head" : "recorded-head" }),
        deleteLocalBranch: ({ refName }) =>
          Effect.sync(() => {
            removed.push(refName);
          }),
      });
      return Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService;
        assert.isDefined(cleanup.cleanupWorkspace);
        const input = {
          threadId: ThreadId.make("conversation-owned-branch"),
          projectId: ProjectId.make("project"),
          worktreePath: "/tmp/conversation-owned-worktree",
          discardChanges: true,
          ownedBranch: { name: "pathway/temp", commitSha: "recorded-head" },
        };
        if (ownership === "owned") {
          yield* cleanup.cleanupWorkspace(input);
          yield* cleanup.cleanupWorkspace(input);
          assert.deepEqual(removed, ["pathway/temp"]);
        } else {
          yield* cleanup.cleanupWorkspace(input).pipe(Effect.flip);
          assert.deepEqual(removed, []);
        }
      }).pipe(Effect.provide(layer));
    },
  );
}
