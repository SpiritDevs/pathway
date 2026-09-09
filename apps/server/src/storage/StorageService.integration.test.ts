// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Isolated filesystem and Git fixtures exercise the storage adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationV2ThreadShell,
  StorageJob,
  type OrchestrationV2ThreadShellSnapshot,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import { ServerActivation } from "../serverActivation.ts";
import { makeStorageService, StorageServiceInputs } from "./StorageService.ts";
import { workspaceStorageBlocker } from "./workspaceLease.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (root: string, args: string[]) => execute("git", ["-C", root, ...args]);
const decodeThread = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeProject = Schema.decodeUnknownSync(ProjectionProject);
const decodePersistedJobs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ jobs: Schema.Array(StorageJob) })),
);

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-storage-service-")),
    );
    const root = NodePath.join(dir, "main");
    const worktree = NodePath.join(dir, "worktree");
    const stateDir = NodePath.join(dir, "state");
    await NodeFSP.mkdir(root);
    await NodeFSP.mkdir(stateDir);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Storage fixture"]);
    await git(root, ["config", "user.email", "storage@example.invalid"]);
    await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "ignored/\n");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["commit", "-m", "Fixture"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["worktree", "add", "-b", "topic", worktree]);
    await NodeFSP.mkdir(NodePath.join(worktree, "ignored"));
    await NodeFSP.writeFile(
      NodePath.join(worktree, "ignored", "local-data"),
      "Discardable ignored data",
    );
    const now = DateTime.nowUnsafe();
    const thread = decodeThread({
      id: "saved-thread",
      projectId: "project",
      createdBy: "user",
      creationSource: "web",
      title: "Saved conversation",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "topic",
      worktreePath: worktree,
      lineage: { rootThreadId: "saved-thread", parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
      settledOverride: "settled",
      settledAt: now,
      deletedAt: null,
    });
    const project = decodeProject({
      projectId: "project",
      title: "Project",
      workspaceRoot: root,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
      deletedAt: null,
    });
    return { dir, root, worktree, stateDir, thread, project };
  }),
  (value) => Effect.promise(() => NodeFSP.rm(value.dir, { recursive: true, force: true })),
);

function inputsFor(
  value: Effect.Success<typeof fixture>,
  overrides: Partial<StorageServiceInputs["Service"]> = {},
): StorageServiceInputs["Service"] {
  return {
    config: { stateDir: value.stateDir },
    threads: {
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [value.thread],
        }),
      getThreadProjection: () =>
        Effect.die("Thread-data measurement is unavailable in this fixture"),
    },
    terminals: { listMetadata: Effect.succeed([]) },
    workflow: { status: () => Effect.die("PR status is unavailable in this fixture") },
    projects: { listAll: () => Effect.succeed([value.project]) },
    ...overrides,
  };
}

describe("storage service lifecycle", () => {
  it.effect(
    "removes a worktree, persists the receipt, and recreates it without deleting its thread or branch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const value = yield* fixture;
          const service = yield* makeStorageService.pipe(
            Effect.provideService(StorageServiceInputs, inputsFor(value)),
            Effect.provideService(ServerActivation, Effect.never),
          );
          const started = yield* service.start({ worktreeIds: [value.worktree], mode: "manual" });
          const finished = yield* service.waitForJob(started.id);
          expect(finished.status).toBe("completed");
          expect(finished.items[0]?.status).toBe("removed");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.stat(value.worktree).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          expect(workspaceStorageBlocker(value.worktree)).toMatch(/Recreate/);
          const saved = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(value.stateDir, "storage-management.json"), "utf8"),
          );
          const persisted = yield* decodePersistedJobs(saved);
          expect(persisted.jobs[0]?.items[0]?.status).toBe("removed");
          const snapshot = yield* service.snapshot;
          expect(
            snapshot.threads.find((thread) => thread.threadId === value.thread.id)?.reclaimedAt,
          ).not.toBeNull();
          expect(snapshot.worktrees.find((thread) => thread.id === value.worktree)?.removed).toBe(
            true,
          );
          yield* service.recreate(value.thread.id);
          expect(workspaceStorageBlocker(value.worktree)).toBeNull();
          expect(
            yield* Effect.promise(() =>
              NodeFSP.stat(value.worktree).then((stat) => stat.isDirectory()),
            ),
          ).toBe(true);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(value.worktree, "ignored")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          expect((yield* service.snapshot).threads[0]?.reclaimedAt).toBeNull();
        }),
      ),
  );

  it.effect("rechecks a shared worktree when another thread becomes active before deletion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* fixture;
        let reads = 0;
        const service = yield* makeStorageService.pipe(
          Effect.provideService(
            StorageServiceInputs,
            inputsFor(value, {
              threads: {
                getThreadProjection: () => Effect.die("Unavailable"),
                getShellSnapshot: () =>
                  Effect.sync(() => {
                    reads++;
                    return {
                      schemaVersion: 1,
                      snapshotSequence: reads,
                      archivedThreads: [value.thread],
                      threads:
                        reads > 1
                          ? [
                              {
                                ...value.thread,
                                id: decodeThread({ ...value.thread, id: "active-thread" }).id,
                                archivedAt: null,
                                status: "running" as const,
                                settledOverride: null,
                              },
                            ]
                          : [],
                    };
                  }),
              },
            }),
          ),
          Effect.provideService(ServerActivation, Effect.never),
        );
        const started = yield* service.start({ worktreeIds: [value.worktree], mode: "manual" });
        const finished = yield* service.waitForJob(started.id);
        expect(finished.items[0]?.status).toBe("skipped");
        expect(finished.items[0]?.message).toMatch(/active|running/i);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(value.worktree).then((stat) => stat.isDirectory()),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("honors cancellation that arrives during the final eligibility check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* fixture;
        const checking = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        const shell: OrchestrationV2ThreadShellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [value.thread],
        };
        const service = yield* makeStorageService.pipe(
          Effect.provideService(
            StorageServiceInputs,
            inputsFor(value, {
              threads: {
                getThreadProjection: () => Effect.die("Unavailable"),
                getShellSnapshot: () =>
                  Effect.gen(function* () {
                    reads++;
                    if (reads === 2) {
                      yield* Deferred.succeed(checking, undefined);
                      yield* Deferred.await(release);
                    }
                    return shell;
                  }),
              },
            }),
          ),
          Effect.provideService(ServerActivation, Effect.never),
        );
        const started = yield* service.start({ worktreeIds: [value.worktree], mode: "manual" });
        yield* Deferred.await(checking);
        yield* service.cancel(started.id);
        yield* Deferred.succeed(release, undefined);
        const finished = yield* service.waitForJob(started.id);
        expect(finished.status).toBe("cancelled");
        expect(finished.items.some((item) => item.status === "removed")).toBe(false);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(value.worktree).then((stat) => stat.isDirectory()),
          ),
        ).toBe(true);
        expect(workspaceStorageBlocker(value.worktree)).toBeNull();
      }),
    ),
  );

  it.effect("protects a nested project root within a linked worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* fixture;
        const nestedRoot = NodePath.join(value.worktree, "ignored", "nested-project");
        yield* Effect.promise(() => NodeFSP.mkdir(nestedRoot));
        const service = yield* makeStorageService.pipe(
          Effect.provideService(
            StorageServiceInputs,
            inputsFor(value, {
              projects: {
                listAll: () =>
                  Effect.succeed([
                    value.project,
                    decodeProject({
                      ...value.project,
                      projectId: "nested",
                      workspaceRoot: nestedRoot,
                    }),
                  ]),
              },
            }),
          ),
          Effect.provideService(ServerActivation, Effect.never),
        );
        const preview = yield* service.preview({ worktreeIds: [value.worktree], mode: "manual" });
        expect(preview.items[0]?.eligible).toBe(false);
        expect(preview.items[0]?.blockers.join(" ")).toMatch(/project/i);
      }),
    ),
  );

  it.effect(
    "protects nested project roots when the thread reaches its worktree through a symlinked parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const value = yield* fixture;
          const aliasParent = NodePath.join(value.dir, "alias");
          const nestedRoot = NodePath.join(value.worktree, "ignored", "nested-project");
          yield* Effect.promise(() => NodeFSP.mkdir(nestedRoot));
          yield* Effect.promise(() => NodeFSP.symlink(value.dir, aliasParent));
          const aliasPath = NodePath.join(aliasParent, "worktree");
          const service = yield* makeStorageService.pipe(
            Effect.provideService(
              StorageServiceInputs,
              inputsFor(
                { ...value, thread: { ...value.thread, worktreePath: aliasPath } },
                {
                  projects: {
                    listAll: () =>
                      Effect.succeed([
                        value.project,
                        decodeProject({
                          ...value.project,
                          projectId: "nested",
                          workspaceRoot: nestedRoot,
                        }),
                      ]),
                  },
                },
              ),
            ),
            Effect.provideService(ServerActivation, Effect.never),
          );
          const inventory = yield* service.snapshot;
          const worktreeId = inventory.threads.find(
            (thread) => thread.threadId === value.thread.id,
          )?.worktreeId;
          expect(worktreeId).toBe(value.worktree);
          const preview = yield* service.preview({ worktreeIds: [worktreeId!], mode: "manual" });
          expect(preview.items[0]?.eligible).toBe(false);
          expect(preview.items[0]?.blockers.join(" ")).toMatch(/project/i);
        }),
      ),
  );

  it.effect("keeps files when a cleanup intent cannot be persisted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* fixture;
        const service = yield* makeStorageService.pipe(
          Effect.provideService(StorageServiceInputs, inputsFor(value)),
          Effect.provideService(ServerActivation, Effect.never),
        );
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(value.stateDir, "storage-management.json")),
        );
        const result = yield* Effect.exit(
          service.start({ worktreeIds: [value.worktree], mode: "manual" }),
        );
        expect(result._tag).toBe("Failure");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(value.worktree, "ignored", "local-data"), "utf8"),
          ),
        ).toBe("Discardable ignored data");
        expect(workspaceStorageBlocker(value.worktree)).toBeNull();
      }),
    ),
  );
});
