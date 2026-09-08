import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  emptyProjection,
  ProjectionStoreV2,
  threadShellFromProjection,
} from "./ProjectionStore.ts";
import { conversationDirectory, live, ThreadWorkspaceService } from "./ThreadWorkspaceService.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-conversation-workspaces-",
});
const baseLayer = Git.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("owns isolated conversation folders and protects uncommitted and unpushed Git work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const git = yield* Git.GitVcsDriver;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread/../../not-a-path");
    const companyFolder = conversationDirectory(path, config.stateDir, threadId);
    assert.equal(path.dirname(companyFolder), path.join(config.stateDir, "conversations"));
    const projectId = ProjectId.make("workspace-test-project");
    const cwd = path.join(config.stateDir, "repository");
    yield* fs.makeDirectory(cwd, { recursive: true });
    const runGit = (directory: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "conversation-workspace-test", cwd: directory, args });
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "conversation-test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Conversation test"]);
    yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "base\n");
    yield* runGit(cwd, ["add", "tracked.txt"]);
    yield* runGit(cwd, ["commit", "-m", "base"]);
    yield* runGit(cwd, ["tag", "selected-base"]);
    yield* fs.writeFileString(path.join(cwd, "newer-main.txt"), "main only\n");
    yield* runGit(cwd, ["add", "newer-main.txt"]);
    yield* runGit(cwd, ["commit", "-m", "newer main"]);
    yield* runGit(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    let thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: null,
      title: "Conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      createdBy: "user",
      creationSource: "web",
      temporary: true,
    };
    const projection = (value: OrchestrationV2AppThread) =>
      emptyProjection({
        type: "thread.created",
        id: EventId.make(`event:${value.id}`),
        threadId: value.id,
        occurredAt: now,
        payload: value,
      });
    let sharingThread: OrchestrationV2AppThread | null = null;
    const workspaceLayer = live.pipe(
      Layer.provide(
        Layer.mock(ProjectionProjectRepository)({
          getById: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Test",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                scripts: [],
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
                deletedAt: null,
              }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.sync(() => projection(thread)),
          getShellSnapshot: () =>
            Effect.sync(() => ({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [],
              archivedThreads:
                sharingThread === null
                  ? []
                  : [threadShellFromProjection(projection(sharingThread))],
            })),
        }),
      ),
      Layer.provide(Layer.mock(GitWorkflowService)({})),
    );

    yield* Effect.gen(function* () {
      const workspaces = yield* ThreadWorkspaceService;
      thread = { ...thread, conversationPath: yield* workspaces.createConversation(threadId) };
      assert.equal(thread.conversationPath, companyFolder);
      yield* fs.writeFileString(path.join(companyFolder, "notes.txt"), "conversation notes");
      assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
      const workspace = yield* workspaces.attachProject({
        threadId,
        projectId,
        temporary: true,
        baseRef: "selected-base",
      });
      assert.isNotNull(workspace.worktreePath);
      assert.notEqual(workspace.worktreePath, cwd);
      thread = {
        ...thread,
        projectId,
        ...workspace,
        ownedWorktreePath: workspace.worktreePath,
        ownedBranch: workspace.branch,
      };
      const worktree = workspace.worktreePath!;
      // Provisioning may finish before the orchestration event commits. A
      // replay must find its own workspace and preserve files created there.
      yield* fs.writeFileString(path.join(worktree, "recover.txt"), "keep this provisional file");
      const recovered = yield* workspaces.attachProject({
        threadId,
        projectId,
        temporary: true,
        baseRef: "selected-base",
      });
      assert.deepEqual(recovered, workspace);
      assert.equal(
        yield* fs.readFileString(path.join(worktree, "recover.txt")),
        "keep this provisional file",
      );
      yield* fs.remove(path.join(worktree, "recover.txt"));
      const collisionId = ThreadId.make("unowned-workspace-collision");
      const unownedDirectory = path.join(
        config.worktreesDir,
        "temporary",
        path.basename(conversationDirectory(path, config.stateDir, collisionId)),
      );
      yield* fs.makeDirectory(unownedDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(unownedDirectory, "keep.txt"), "unowned");
      const collision = yield* workspaces
        .attachProject({ threadId: collisionId, projectId, temporary: true })
        .pipe(Effect.flip);
      assert.include(collision.message, "without this thread's ownership record");
      assert.equal(yield* fs.readFileString(path.join(unownedDirectory, "keep.txt")), "unowned");
      assert.isFalse(yield* fs.exists(path.join(worktree, "newer-main.txt")));
      assert.isTrue(yield* fs.exists(path.join(companyFolder, "notes.txt")));
      assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
      yield* fs.writeFileString(path.join(worktree, "new.txt"), "uncommitted\n");
      assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
      yield* runGit(worktree, ["add", "new.txt"]);
      yield* runGit(worktree, ["commit", "-m", "unpublished work"]);
      assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
      yield* runGit(worktree, ["update-ref", "refs/remotes/origin/temporary", "HEAD"]);
      assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));

      // Archived threads still own their shared resources.
      sharingThread = { ...thread, id: ThreadId.make("archived-sharing-thread"), archivedAt: now };
      thread = { ...thread, deletedAt: now };
      yield* workspaces.cleanup(threadId);
      assert.isTrue(yield* fs.exists(worktree));
      assert.isTrue(yield* fs.exists(companyFolder));
      thread = { ...sharingThread, deletedAt: now };
      sharingThread = null;
      yield* workspaces.cleanup(thread.id);
      assert.isFalse(yield* fs.exists(worktree));
      assert.isFalse(yield* fs.exists(companyFolder));
      assert.isFalse(
        yield* fs.exists(
          path.join(config.stateDir, "thread-workspaces", `${path.basename(worktree)}.json`),
        ),
      );
      const remainingBranches = yield* runGit(cwd, ["branch", "--list", workspace.branch!]);
      assert.equal(remainingBranches.stdout.trim(), "");
      const remote = yield* runGit(cwd, ["rev-parse", "refs/remotes/origin/temporary"]);
      assert.isNotEmpty(remote.stdout.trim());
      yield* workspaces.cleanup(thread.id);
    }).pipe(Effect.provide(workspaceLayer));
  }).pipe(Effect.provide(baseLayer)),
);

it.effect(
  "checks owned nested repositories without inheriting an ancestor checkout or outside symlinks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const git = yield* Git.GitVcsDriver;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("nested-git-conversation");
      const runGit = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({ operation: "conversation-nested-git-test", cwd, args });
      const initializeRepository = Effect.fn(function* (cwd: string) {
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* runGit(cwd, ["init", "--initial-branch=main"]);
        yield* runGit(cwd, ["config", "user.email", "conversation-test@example.com"]);
        yield* runGit(cwd, ["config", "user.name", "Conversation test"]);
        yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "base\n");
        yield* runGit(cwd, ["add", "tracked.txt"]);
        yield* runGit(cwd, ["commit", "-m", "base"]);
        yield* runGit(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      });
      // Match isolated development homes: userdata is nested inside an unrelated checkout.
      yield* initializeRepository(config.stateDir);
      yield* fs.writeFileString(path.join(config.stateDir, ".gitignore"), "conversations/\n");
      yield* fs.writeFileString(
        path.join(config.stateDir, "tracked.txt"),
        "unrelated dirty work\n",
      );
      const workspaceLayer = live.pipe(
        Layer.provide(Layer.mock(ProjectionProjectRepository)({})),
        Layer.provide(Layer.mock(ProjectionStoreV2)({})),
        Layer.provide(Layer.mock(GitWorkflowService)({})),
      );
      const conversationPath = conversationDirectory(path, config.stateDir, threadId);
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: null,
        conversationPath,
        temporary: true,
        title: "Conversation",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      };
      yield* Effect.gen(function* () {
        const workspaces = yield* ThreadWorkspaceService;
        yield* workspaces.createConversation(threadId);
        yield* fs.writeFileString(path.join(conversationPath, "notes.txt"), "outside Git\n");
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        const nested = path.join(conversationPath, "projects", "nested");
        yield* initializeRepository(nested);
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* fs.writeFileString(path.join(nested, "tracked.txt"), "unfinished nested work\n");
        assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* runGit(nested, ["add", "tracked.txt"]);
        yield* runGit(nested, ["commit", "-m", "unpublished nested work"]);
        assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* runGit(nested, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* runGit(nested, ["switch", "-c", "unpublished-other-branch"]);
        yield* fs.writeFileString(
          path.join(nested, "tracked.txt"),
          "work on another local branch\n",
        );
        yield* runGit(nested, ["add", "tracked.txt"]);
        yield* runGit(nested, ["commit", "-m", "other branch work"]);
        yield* runGit(nested, ["switch", "main"]);
        assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* runGit(nested, [
          "update-ref",
          "refs/remotes/origin/other",
          "unpublished-other-branch",
        ]);
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        const bare = path.join(conversationPath, "saved-repository.git");
        yield* runGit(conversationPath, ["clone", "--bare", nested, bare]);
        assert.isTrue(yield* workspaces.hasUnfinishedGitWork(thread));
        yield* runGit(bare, ["update-ref", "refs/remotes/origin/main", "unpublished-other-branch"]);
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        const outside = path.join(config.stateDir, "outside-repository");
        yield* initializeRepository(outside);
        yield* fs.writeFileString(path.join(outside, "tracked.txt"), "keep outside work\n");
        yield* fs.symlink(outside, path.join(conversationPath, "outside-link"));
        yield* fs.symlink(conversationPath, path.join(conversationPath, "cycle-link"));
        yield* fs.symlink(
          path.join(config.stateDir, "missing"),
          path.join(conversationPath, "broken-link"),
        );
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(thread));
        const rootId = ThreadId.make("root-git-conversation");
        const root = yield* workspaces.createConversation(rootId);
        yield* initializeRepository(root);
        const rootThread = { ...thread, id: rootId, conversationPath: root };
        assert.isFalse(yield* workspaces.hasUnfinishedGitWork(rootThread));
        yield* fs.writeFileString(path.join(root, "tracked.txt"), "root unfinished work\n");
        assert.isTrue(yield* workspaces.hasUnfinishedGitWork(rootThread));
      }).pipe(Effect.provide(workspaceLayer));

      const oversized = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: () => Effect.succeed(Array.from({ length: 20_001 }, (_, i) => `file-${i}`)),
      });
      const bounded = yield* Effect.gen(function* () {
        const workspaces = yield* ThreadWorkspaceService;
        return yield* workspaces.hasUnfinishedGitWork(thread).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          workspaceLayer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, oversized))),
        ),
      );
      assert.include(bounded.message, "too large to verify");
      assert.isTrue(yield* fs.exists(conversationPath));
    }).pipe(Effect.provide(baseLayer)),
);
