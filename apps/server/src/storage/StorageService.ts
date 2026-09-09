// @effect-diagnostics nodeBuiltinImport:off globalDate:off - OS filesystem accounting and Git inventory are the native storage adapter boundary.
import { recordStoragePressure, storageInventoryRevision } from "./pressureState.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_STORAGE_POLICY,
  StorageError,
  StoragePolicy,
  StorageJob,
  type StorageCleanupInput,
  type StorageSnapshot,
  type StoragePreview,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import { eligibilityBlockers, storagePressure, validateStoragePolicy } from "./policy.ts";
import { leaseStorageWorkspace, markStorageWorkspaceRemoved } from "./workspaceLease.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const iso = () => new Date().toISOString();
const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Storage operation failed.";
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => new StorageError({ message: errorMessage(cause) }),
  });
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + NodePath.sep);
async function canonical(path: string) {
  return NodeFSP.realpath(path).catch(() => NodePath.resolve(path));
}
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (
      await execute("git", ["-C", cwd, ...args], {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout;
  } catch {
    throw new Error(
      "Git could not verify or update this worktree. Its files were kept where possible.",
    );
  }
}

export async function inspectStorageGitWorktree(
  path: string,
  root: string,
  branch: string,
): Promise<string[]> {
  const blockers: string[] = [];
  if ((await NodeFSP.stat(path)).dev !== (await NodeFSP.stat(NodePath.dirname(path))).dev)
    blockers.push("Worktree is a volume mount point");
  const real = await NodeFSP.realpath(path);
  if ((await NodeFSP.lstat(path)).isSymbolicLink())
    blockers.push("Symlinked worktree requires manual review");
  const listing = await git(root, ["worktree", "list", "--porcelain"]);
  const blocks = listing.split("\n\n");
  const registered = blocks.find((block) => block.split("\n")[0] === `worktree ${real}`);
  if (
    !registered ||
    registered.includes("\nlocked") ||
    blocks[0]?.split("\n")[0] === `worktree ${real}`
  )
    blockers.push("Not an unlocked linked worktree");
  if (
    registered &&
    !registered.includes(`\nbranch refs/heads/${branch}\n`) &&
    !registered.endsWith(`\nbranch refs/heads/${branch}`)
  )
    blockers.push("Worktree branch changed");
  if ((await git(path, ["status", "--porcelain", "--untracked-files=all"])).trim())
    blockers.push("Uncommitted or untracked files");
  if ((await git(path, ["rev-list", "--max-count=1", "HEAD", "--not", "--remotes"])).trim())
    blockers.push("Unpublished commits");
  return blockers;
}

export async function removeStorageGitWorktree(
  path: string,
  root: string,
  branch: string,
): Promise<void> {
  const blockers = await inspectStorageGitWorktree(path, root, branch);
  if (blockers.length) throw new Error(blockers.join("; "));
  await git(root, ["worktree", "remove", "--force", "--", path]);
}

/** Bounded, low-priority inventory; no symlink traversal or descent into other volumes. */
export async function measureStorageDirectory(
  root: string,
  limit = 100_000,
): Promise<number | null> {
  const start = Date.now();
  const rootInfo = await NodeFSP.lstat(root).catch(() => null);
  if (!rootInfo || rootInfo.isSymbolicLink()) return null;
  const pending = [root];
  const inodes = new Set<string>();
  let count = 0;
  let bytes = 0;
  while (pending.length > 0) {
    if (++count > limit || Date.now() - start > 2_000) return null;
    const path = pending.pop()!;
    const stat = await NodeFSP.lstat(path).catch(() => null);
    if (!stat) return null;
    if (stat.dev !== rootInfo.dev) return null;
    const key = `${stat.dev}:${stat.ino}`;
    if (inodes.has(key)) continue;
    inodes.add(key);
    bytes += stat.blocks * 512;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const entries = await NodeFSP.readdir(path).catch(() => null);
      if (!entries) return null;
      for (const name of entries) pending.push(NodePath.join(path, name));
    }
  }
  return Number.isSafeInteger(bytes) ? bytes : null;
}

const Removal = Schema.Struct({
  phase: Schema.optional(Schema.Literals(["pending", "removed"])),
  path: Schema.String,
  root: Schema.String,
  branch: Schema.String,
  threadIds: Schema.Array(Schema.String),
  reclaimedAt: Schema.String,
});
const Persisted = Schema.Struct({
  policy: StoragePolicy,
  keep: Schema.Array(Schema.String),
  since: Schema.Record(Schema.String, Schema.String),
  resetAt: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  removals: Schema.Array(Removal),
  jobs: Schema.Array(StorageJob),
});
type Persisted = typeof Persisted.Type;
const decodePersisted = Schema.decodeUnknownSync(Persisted);
export async function readStorageState(
  file: string,
): Promise<{ state: Persisted; error: string | null }> {
  const empty: Persisted = {
    policy: DEFAULT_STORAGE_POLICY,
    keep: [],
    since: {},
    removals: [],
    jobs: [],
  };
  try {
    const contents = await NodeFSP.readFile(file, "utf8");
    return { state: decodePersisted(JSON.parse(contents)), error: null };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return { state: empty, error: null };
    return {
      state: empty,
      error:
        "Stored cleanup policy could not be read. Automatic cleanup is disabled; the original file has been kept.",
    };
  }
}

interface Shape {
  snapshot: Effect.Effect<StorageSnapshot, StorageError>;
  monitor: Effect.Effect<void, StorageError>;
  waitForJob: (jobId: string) => Effect.Effect<StorageJob, StorageError>;
  setPolicy: (
    policy: typeof StoragePolicy.Type,
  ) => Effect.Effect<typeof StoragePolicy.Type, StorageError>;
  setKeep: (threadId: ThreadId, keep: boolean) => Effect.Effect<void, StorageError>;
  preview: (input: StorageCleanupInput) => Effect.Effect<StoragePreview, StorageError>;
  start: (input: StorageCleanupInput) => Effect.Effect<typeof StorageJob.Type, StorageError>;
  cancel: (jobId: string) => Effect.Effect<typeof StorageJob.Type, StorageError>;
  recreate: (threadId: ThreadId) => Effect.Effect<{ path: string }, StorageError>;
}
export class StorageService extends Context.Service<StorageService, Shape>()(
  "@spiritdevs/pathway/storage/StorageService",
) {}

export class StorageServiceInputs extends Context.Service<
  StorageServiceInputs,
  {
    config: Pick<ServerConfig["Service"], "stateDir">;
    threadDataBytes?: (threadId: ThreadId) => Effect.Effect<number, StorageError>;
    threads: Pick<ThreadManagementService["Service"], "getShellSnapshot" | "getThreadProjection">;
    terminals: Pick<TerminalManager["Service"], "listMetadata">;
    workflow: Pick<GitWorkflowService["Service"], "status">;
    projects: Pick<ProjectionProjectRepository["Service"], "listAll">;
  }
>()("@spiritdevs/pathway/storage/StorageService/StorageServiceInputs") {}

export const makeStorageService = Effect.gen(function* () {
  const { config, threads, terminals, workflow, projects, threadDataBytes } =
    yield* StorageServiceInputs;
  const scope = yield* Scope.Scope;
  const runtime = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(runtime);
  const file = NodePath.join(config.stateDir, "storage-management.json");
  let state: Persisted = {
    policy: DEFAULT_STORAGE_POLICY,
    keep: [],
    since: {},
    removals: [],
    jobs: [],
  };
  let persistenceError: string | null = null;
  let persistenceBlocked = false;
  const loaded = yield* Effect.promise(() => readStorageState(file));
  state = loaded.state;
  persistenceError = loaded.error;
  persistenceBlocked = loaded.error !== null;
  state = {
    ...state,
    jobs: state.jobs.map((job) =>
      job.status === "running"
        ? {
            ...job,
            status: "failed",
            finishedAt: iso(),
            items: job.items.map((item) =>
              item.status === "pending"
                ? {
                    ...item,
                    status: "failed",
                    message: "Environment restarted; review and retry this item.",
                  }
                : item,
            ),
          }
        : job,
    ),
  };
  const confirmedRemovals = [];
  for (const removal of state.removals) {
    const exists = yield* io(() =>
      NodeFSP.lstat(removal.path).then(
        () => true,
        () => false,
      ),
    );
    if (!exists) {
      confirmedRemovals.push({ ...removal, phase: "removed" as const });
      markStorageWorkspaceRemoved(removal.path, true);
    }
  }
  state = { ...state, removals: confirmedRemovals };
  let saveTail = Promise.resolve();
  const save = () => {
    const encoded = JSON.stringify(state);
    const task = saveTail.then(async () => {
      if (persistenceBlocked)
        throw new Error(
          "Storage policy could not be read. Repair storage-management.json before changing cleanup settings.",
        );
      await NodeFSP.mkdir(config.stateDir, { recursive: true });
      const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(temp, encoded, { mode: 0o600 });
      await NodeFSP.rename(temp, file);
    });
    const reported = task.then(
      () => {
        persistenceError = null;
      },
      (cause: unknown) => {
        persistenceError =
          "Storage state could not be saved. Automatic cleanup is paused; capacity measurements remain available.";
        throw cause;
      },
    );
    saveTail = reported.catch(() => {});
    return reported;
  };
  let cached: StorageSnapshot | null = null;
  let cachedRevision = -1;
  let capacityPaths = new Map<string, string>();
  let capacityPathsRevision = -1;
  let capacityPathsDiscoveredAt = 0;
  let refreshing: Promise<StorageSnapshot> | null = null;
  let activeJob: string | null = null;
  const completions = new Map<
    string,
    { promise: Promise<StorageJob>; resolve: (job: StorageJob) => void }
  >();
  const changeRequests = new Map<string, { state: string | null; at: number }>();
  const threadSizes = new Map<string, { bytes: number | null; at: number }>();
  const sizes = new Map<string, { bytes: number | null; at: string }>();

  async function refresh(force = false): Promise<StorageSnapshot> {
    if (refreshing) return refreshing;
    if (
      !force &&
      cached &&
      cachedRevision === storageInventoryRevision() &&
      Date.now() - Date.parse(cached.sampledAt) < 30_000
    )
      return { ...cached, policy: state.policy, jobs: state.jobs };
    refreshing = (async () => {
      const revision = storageInventoryRevision();
      const shell = await run(threads.getShellSnapshot());
      const projectRows = await run(projects.listAll());
      const all = [...shell.threads, ...shell.archivedThreads].filter(
        (thread) => thread.deletedAt === null,
      );
      const terminalRows = await run(terminals.listMetadata);
      const terminalPaths = await Promise.all(
        terminalRows.map((terminal) => canonical(terminal.cwd)),
      );
      const roots = await Promise.all(
        projectRows.flatMap((project) =>
          project.workspaceRoot ? [canonical(project.workspaceRoot)] : [],
        ),
      );
      const rootByProject = new Map(
        projectRows.map((project) => [project.projectId, project.workspaceRoot]),
      );
      const now = iso();
      const since: Record<string, string> = {};
      const rows: StorageSnapshot["threads"][number][] = [];
      const worktrees = new Map<string, StorageSnapshot["worktrees"][number]>();
      const volumes = new Map<string, StorageSnapshot["volumes"][number]>();
      async function volume(path: string) {
        try {
          const [stat, capacity] = await Promise.all([NodeFSP.stat(path), NodeFSP.statfs(path)]);
          const id = String(stat.dev);
          if (!volumes.has(id))
            volumes.set(id, {
              id,
              path,
              totalBytes: capacity.blocks * capacity.bsize,
              availableBytes: capacity.bavail * capacity.bsize,
              sampledAt: now,
              pressure: storagePressure(
                capacity.bavail * capacity.bsize,
                capacity.blocks * capacity.bsize,
                state.policy,
              ),
            });
          return id;
        } catch {
          return null;
        }
      }
      await volume(NodePath.parse(config.stateDir).root);
      await volume(config.stateDir);
      for (const root of roots) await volume(root);
      const prTargets = new Set(
        [
          ...new Set(
            all.flatMap((thread) => {
              const path =
                thread.worktreePath ??
                (thread.projectId ? rootByProject.get(thread.projectId) : null);
              return path ? [path] : [];
            }),
          ),
        ]
          .filter(
            (path) =>
              !changeRequests.has(path) || Date.now() - changeRequests.get(path)!.at > 15 * 60_000,
          )
          .sort(
            (left, right) =>
              (changeRequests.get(left)?.at ?? 0) - (changeRequests.get(right)?.at ?? 0),
          )
          .slice(0, 4),
      );
      for (const thread of all) {
        const snoozed =
          thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > Date.now();
        const busy =
          ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status) ||
          thread.pendingRuntimeRequest !== null ||
          (thread.pendingBackgroundTasks?.length ?? 0) > 0;
        const activityAt = Math.max(
          ...[
            thread.latestUserMessageAt,
            thread.latestRunRequestedAt,
            thread.latestRunStartedAt,
            thread.latestRunCompletedAt,
          ].map((at) => (at ? DateTime.toEpochMillis(at) : 0)),
        );
        const workspace =
          thread.worktreePath ?? (thread.projectId ? rootByProject.get(thread.projectId) : null);
        if (
          !busy &&
          workspace &&
          (!changeRequests.has(workspace) ||
            Date.now() - changeRequests.get(workspace)!.at > 15 * 60_000) &&
          prTargets.has(workspace)
        ) {
          try {
            const status = await run(
              workflow.status({ cwd: workspace }).pipe(Effect.timeout("2 seconds")),
            );
            changeRequests.set(workspace, { state: status.pr?.state ?? null, at: Date.now() });
          } catch {
            changeRequests.set(workspace, { state: "unknown", at: Date.now() });
          }
        }
        const pr = workspace ? changeRequests.get(workspace) : undefined;
        const inactiveDays =
          state.policy.autoSettleAfterDays === undefined ? 3 : state.policy.autoSettleAfterDays;
        const autoSettled =
          !thread.temporary &&
          thread.settledOverride !== "active" &&
          (pr?.state === "merged" ||
            (inactiveDays !== null &&
              activityAt > 0 &&
              Date.now() - activityAt > inactiveDays * 86_400_000 &&
              !thread.attachedPullRequest &&
              ((thread.projectId === null && !workspace) ||
                (pr !== undefined && pr.state === null))));
        const status = snoozed
          ? "snoozed"
          : thread.archivedAt !== null
            ? "archived"
            : !busy && (thread.settledOverride === "settled" || autoSettled)
              ? "settled"
              : "active";
        const eligible =
          !busy &&
          (status === "archived" || status === "settled") &&
          !thread.temporary &&
          !thread.pinnedAt &&
          !state.keep.includes(thread.id);
        if (eligible) {
          const lifecycleAt = thread.archivedAt ?? thread.settledAt;
          const previousSince = state.since[thread.id];
          const initialAt = lifecycleAt
            ? DateTime.toEpochMillis(lifecycleAt)
            : pr?.state === "merged"
              ? previousSince
                ? Date.parse(previousSince)
                : Date.now()
              : activityAt + (inactiveDays ?? 0) * 86_400_000;
          since[thread.id] = new Date(
            Math.max(
              initialAt,
              activityAt,
              Date.parse(state.since[thread.id] ?? "1970-01-01"),
              Date.parse(state.resetAt?.[thread.id] ?? "1970-01-01"),
            ),
          ).toISOString();
        }
        const originalPath = thread.worktreePath ?? thread.conversationPath ?? null;
        const path = originalPath ? await canonical(originalPath) : null;
        const removal = state.removals.find(
          (entry) => entry.phase !== "pending" && entry.threadIds.includes(thread.id),
        );
        rows.push({
          threadId: thread.id,
          title: thread.title,
          conversationCompanyId: thread.conversationCompanyId ?? null,
          projectId: thread.projectId,
          worktreeId: path,
          status,
          keepWorktree: state.keep.includes(thread.id),
          threadDataBytes: null,
          temporary: thread.temporary === true,
          eligibleSince: since[thread.id] ?? null,
          reclaimedAt: removal?.reclaimedAt ?? null,
        });
        if (!path) continue;
        const existing = worktrees.get(path);
        const blockers = eligibilityBlockers({
          active: busy || status === "active",
          snoozed,
          temporary: thread.temporary === true,
          pinned: thread.pinnedAt != null,
          keep: state.keep.includes(thread.id),
          terminal: terminalRows.some(
            (terminal, index) =>
              terminal.status !== "exited" &&
              (terminal.threadId === thread.id || inside(path, terminalPaths[index]!)),
          ),
          projectRoot: roots.some(
            (root) => inside(NodePath.resolve(path), root) || root === NodePath.resolve(path),
          ),
          sharedActive: false,
          dirty: false,
          unpublished: false,
          mode: "manual",
          eligibleSince: since[thread.id] ?? null,
          afterDays: state.policy.afterDays,
          now: Date.now(),
        });
        if (existing) {
          worktrees.set(path, {
            ...existing,
            threadIds: [...existing.threadIds, thread.id],
            blockers: [...new Set([...existing.blockers, ...blockers])],
          });
        } else {
          const measured = sizes.get(path);
          const root = thread.projectId ? (rootByProject.get(thread.projectId) ?? null) : null;
          worktrees.set(path, {
            id: path,
            path,
            projectRoot: root,
            branch: thread.branch,
            volumeId: await volume(path),
            threadIds: [thread.id],
            estimatedBytes: measured?.bytes ?? null,
            measuredAt: measured?.at ?? null,
            kind: thread.conversationPath === path ? "conversation" : "worktree",
            blockers,
            removed: removal !== undefined,
          });
        }
      }
      // Discover linked worktrees that have outlived their thread, without scanning arbitrary folders.
      for (const root of new Set(roots)) {
        try {
          const listing = await git(root, ["worktree", "list", "--porcelain"]);
          for (const block of listing.split("\n\n")) {
            const path = /^worktree (.+)$/m.exec(block)?.[1];
            if (!path || worktrees.has(path) || roots.some((root) => inside(path, root))) continue;
            const measured = sizes.get(path);
            worktrees.set(path, {
              id: path,
              path,
              projectRoot: root,
              branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null,
              volumeId: await volume(path),
              threadIds: [],
              estimatedBytes: measured?.bytes ?? null,
              measuredAt: measured?.at ?? null,
              kind: "orphan",
              blockers: terminalRows.some(
                (terminal, index) =>
                  terminal.status !== "exited" && inside(path, terminalPaths[index]!),
              )
                ? ["Open terminal in this workspace"]
                : [],
              removed: false,
            });
          }
        } catch {
          /* A repository that cannot be inspected supplies no orphan candidates. */
        }
      }
      const pendingThreadSizes = [...rows].sort(
        (left, right) =>
          (threadSizes.get(left.threadId)?.at ?? 0) - (threadSizes.get(right.threadId)?.at ?? 0),
      );
      let measuredThreads = 0;
      for (const row of pendingThreadSizes) {
        const previous = threadSizes.get(row.threadId);
        if (previous && Date.now() - previous.at <= 15 * 60_000) continue;
        if (measuredThreads++ >= 4) break;
        let bytes: number | null = null;
        if (threadDataBytes) {
          try {
            bytes = await run(threadDataBytes(row.threadId).pipe(Effect.timeout("2 seconds")));
          } catch {
            /* Unknown measurements back off without starving later threads. */
          }
        }
        threadSizes.set(row.threadId, { bytes, at: Date.now() });
      }
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const measured = threadSizes.get(row.threadId);
        rows[index] = {
          ...row,
          threadDataBytes: measured?.bytes ?? null,
          threadDataMeasuredAt: measured ? new Date(measured.at).toISOString() : null,
        };
      }
      let measuredCount = 0;
      for (const [key, worktree] of [...worktrees].sort(
        ([left], [right]) =>
          Date.parse(sizes.get(left)?.at ?? "1970-01-01") -
          Date.parse(sizes.get(right)?.at ?? "1970-01-01"),
      )) {
        if (worktree.removed) continue;
        const previous = sizes.get(key);
        if (
          (!previous || Date.now() - Date.parse(previous.at) > 15 * 60_000) &&
          measuredCount++ < 4
        ) {
          const measurement = { bytes: await measureStorageDirectory(key), at: iso() };
          sizes.set(key, measurement);
          worktrees.set(key, {
            ...worktree,
            estimatedBytes: measurement.bytes,
            measuredAt: measurement.at,
          });
        }
      }
      const changed = JSON.stringify(state.since) !== JSON.stringify(since);
      state = { ...state, since };
      if ((changed || persistenceError !== null) && !persistenceBlocked)
        await save().catch(() => {});
      cached = {
        sampledAt: now,
        volumes: [...volumes.values()],
        threads: rows,
        worktrees: [...worktrees.values()],
        policy: state.policy,
        jobs: state.jobs,
        scanError: persistenceError,
      };
      cachedRevision = revision;
      capacityPaths = new Map(cached.volumes.map((volume) => [volume.id, volume.path]));
      capacityPathsRevision = revision;
      capacityPathsDiscoveredAt = Date.now();
      recordStoragePressure(cached);
      return cached;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  async function preview(input: StorageCleanupInput): Promise<StoragePreview> {
    const snapshot = await refresh(true);
    const items: StoragePreview["items"][number][] = [];
    for (const id of [...new Set(input.worktreeIds)].slice(0, 500)) {
      const worktree = snapshot.worktrees.find((item) => item.id === id);
      if (!worktree) {
        items.push({
          worktreeId: id,
          path: id,
          threadIds: [],
          estimatedBytes: null,
          eligible: false,
          blockers: ["Worktree no longer exists in this environment inventory"],
        });
        continue;
      }
      const blockers = [...worktree.blockers];
      if (persistenceBlocked) blockers.push("Stored cleanup protections could not be read");
      if (worktree.removed) blockers.push("Already reclaimed");
      if (worktree.kind !== "worktree" && input.mode !== "manual")
        blockers.push("Manual review required");
      if (worktree.kind === "conversation")
        blockers.push("Use Delete thread to remove its conversation folder");
      if (
        input.mode === "scheduled" &&
        worktree.threadIds.some(
          (threadId) =>
            !state.since[threadId] ||
            Date.now() - Date.parse(state.since[threadId]!) < state.policy.afterDays * 86_400_000,
        )
      )
        blockers.push("Retention period has not elapsed");
      if (!worktree.projectRoot) blockers.push("Repository root unavailable");
      if (!worktree.branch) blockers.push("No preserved branch");
      if (blockers.length === 0) {
        try {
          blockers.push(
            ...(await inspectStorageGitWorktree(
              worktree.path,
              worktree.projectRoot!,
              worktree.branch!,
            )),
          );
        } catch {
          blockers.push("Could not verify worktree safety");
        }
      }
      items.push({
        worktreeId: id,
        path: worktree.path,
        threadIds: worktree.threadIds,
        estimatedBytes: worktree.estimatedBytes,
        eligible: blockers.length === 0,
        blockers,
      });
    }
    return {
      items,
      estimatedBytes: items.reduce(
        (sum, item) => sum + (item.eligible ? (item.estimatedBytes ?? 0) : 0),
        0,
      ),
    };
  }

  function replaceJob(job: typeof StorageJob.Type) {
    state = { ...state, jobs: state.jobs.map((entry) => (entry.id === job.id ? job : entry)) };
  }
  async function executeJob(id: string) {
    try {
      let job = state.jobs.find((entry) => entry.id === id)!;
      const ordered = [...job.items].sort((a, b) => {
        const age = (key: string) =>
          Math.max(
            ...(cached?.worktrees
              .find((row) => row.id === key)
              ?.threadIds.map((threadId) => Date.parse(state.since[threadId] ?? iso())) ?? [
              Date.now(),
            ]),
          );
        return age(a.worktreeId) - age(b.worktreeId);
      });
      for (const item of ordered.filter((item) => item.status === "pending")) {
        job = state.jobs.find((entry) => entry.id === id)!;
        if (job.status === "cancelled") break;
        let release: (() => void) | undefined;
        let result: (typeof StorageJob.Type)["items"][number] = item;
        try {
          release = leaseStorageWorkspace(item.worktreeId);
          const checked = await preview({ mode: job.mode, worktreeIds: [item.worktreeId] });
          const candidate = checked.items[0];
          const worktree = cached?.worktrees.find((entry) => entry.id === item.worktreeId);
          if (!candidate?.eligible || !worktree?.projectRoot || !worktree.branch) {
            result = {
              ...item,
              status: "skipped",
              message: candidate?.blockers.join("; ") ?? "Worktree unavailable",
            };
          } else {
            const before = await NodeFSP.statfs(worktree.path);
            const free = before.bavail * before.bsize;
            if (
              job.mode === "emergency" &&
              storagePressure(free, before.blocks * before.bsize, state.policy) === "healthy"
            ) {
              result = {
                ...item,
                status: "skipped",
                message: "This volume has recovered above warning limits",
              };
            } else {
              const currentJob = state.jobs.find((entry) => entry.id === id);
              if (
                currentJob?.status === "cancelled" ||
                (job.mode === "scheduled" && !state.policy.enabled)
              )
                break;
              // Persist intent before removal so a crash cannot hide a reclaimed workspace.
              const removal = {
                phase: "pending" as const,
                path: worktree.path,
                root: worktree.projectRoot,
                branch: worktree.branch,
                threadIds: worktree.threadIds,
                reclaimedAt: iso(),
              };
              state = {
                ...state,
                removals: [
                  ...state.removals.filter((entry) => entry.path !== worktree.path),
                  removal,
                ],
              };
              await save();
              if (
                state.jobs.find((entry) => entry.id === id)?.status === "cancelled" ||
                (job.mode === "scheduled" && !state.policy.enabled)
              ) {
                state = {
                  ...state,
                  removals: state.removals.filter((entry) => entry.path !== worktree.path),
                };
                await save();
                break;
              }
              await removeStorageGitWorktree(worktree.path, worktree.projectRoot, worktree.branch);
              markStorageWorkspaceRemoved(worktree.path, true);
              state = {
                ...state,
                removals: state.removals.map((entry) =>
                  entry.path === worktree.path ? { ...entry, phase: "removed" } : entry,
                ),
              };
              const after = await NodeFSP.statfs(NodePath.dirname(worktree.path)).catch(() => null);
              result = {
                ...item,
                status: "removed",
                message: null,
                actualFreeDeltaBytes: after ? after.bavail * after.bsize - free : null,
              };
              sizes.delete(worktree.path);
            }
          }
        } catch {
          result = {
            ...item,
            status: "failed",
            message: "Worktree cleanup failed. Review the workspace and retry.",
          };
          if (
            await NodeFSP.stat(item.worktreeId).then(
              () => true,
              () => false,
            )
          )
            state = {
              ...state,
              removals: state.removals.filter((entry) => entry.path !== item.worktreeId),
            };
        } finally {
          release?.();
        }
        job = state.jobs.find((entry) => entry.id === id)!;
        replaceJob({
          ...job,
          items: job.items.map((entry) => (entry.worktreeId === item.worktreeId ? result : entry)),
        });
        await save();
      }
      job = state.jobs.find((entry) => entry.id === id)!;
      replaceJob({
        ...job,
        status:
          job.status === "cancelled"
            ? "cancelled"
            : job.items.some((item) => item.status === "failed")
              ? "failed"
              : "completed",
        finishedAt: iso(),
      });
      await save();
    } catch {
      const job = state.jobs.find((entry) => entry.id === id);
      if (job)
        replaceJob({
          ...job,
          status: "failed",
          finishedAt: iso(),
          items: job.items.map((item) =>
            item.status === "pending"
              ? {
                  ...item,
                  status: "failed",
                  message: "Cleanup stopped unexpectedly. Review and retry.",
                }
              : item,
          ),
        });
      await save().catch(() => {});
    } finally {
      activeJob = null;
      cached = null;
      const final = state.jobs.find((entry) => entry.id === id);
      if (final) completions.get(id)?.resolve(final);
      completions.delete(id);
    }
  }
  const start = Effect.fn("Storage.start")(function* (input: StorageCleanupInput) {
    if (activeJob !== null)
      return yield* new StorageError({
        message: "Cleanup is already running in this environment.",
      });
    const id = NodeCrypto.randomUUID();
    let resolveCompletion!: (job: StorageJob) => void;
    const promise = new Promise<StorageJob>((resolve) => {
      resolveCompletion = resolve;
    });
    completions.set(id, { promise, resolve: resolveCompletion });
    activeJob = id;
    const result = yield* io(async () => {
      try {
        const checked = await preview(input);
        const job: typeof StorageJob.Type = {
          id,
          mode: input.mode,
          status: "running",
          startedAt: iso(),
          finishedAt: null,
          items: checked.items.map((item) => ({
            worktreeId: item.worktreeId,
            projectRoot:
              cached?.worktrees.find((entry) => entry.id === item.worktreeId)?.projectRoot ?? null,
            status: item.eligible ? "pending" : "skipped",
            message: item.eligible ? null : item.blockers.join("; "),
            estimatedBytes: item.estimatedBytes ?? 0,
            actualFreeDeltaBytes: null,
          })),
        };
        state = { ...state, jobs: [...state.jobs.slice(-99), job] };
        await save();
        return job;
      } catch (cause) {
        activeJob = null;
        completions.delete(id);
        throw cause;
      }
    });
    yield* forkParked(io(() => executeJob(id)).pipe(Effect.catch(() => Effect.void))).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    return result;
  });
  const service: Shape = {
    snapshot: io(() => refresh()),
    monitor: Effect.gen(function* () {
      if (!state.policy.enabled || activeJob !== null || persistenceError !== null) {
        yield* io(async () => {
          const revision = storageInventoryRevision();
          if (
            capacityPathsRevision !== revision ||
            Date.now() - capacityPathsDiscoveredAt >= 15 * 60_000
          ) {
            const shell = await run(threads.getShellSnapshot());
            const projectRows = await run(projects.listAll());
            const paths = new Set([
              NodePath.parse(config.stateDir).root,
              config.stateDir,
              ...projectRows.flatMap((project) =>
                project.workspaceRoot ? [project.workspaceRoot] : [],
              ),
              ...[...shell.threads, ...shell.archivedThreads].flatMap((thread) =>
                thread.deletedAt === null
                  ? [thread.worktreePath, thread.conversationPath].filter((path): path is string =>
                      Boolean(path),
                    )
                  : [],
              ),
            ]);
            const discovered = new Map<string, string>();
            for (const path of paths) {
              try {
                const stat = await NodeFSP.stat(path);
                const id = String(stat.dev);
                if (!discovered.has(id)) discovered.set(id, path);
              } catch {
                // Recheck absent paths on inventory changes and periodic volume rediscovery.
              }
            }
            capacityPaths = discovered;
            capacityPathsRevision = revision;
            capacityPathsDiscoveredAt = Date.now();
          }
          const volumes = new Map<string, StorageSnapshot["volumes"][number]>();
          const sampledAt = iso();
          for (const [id, path] of capacityPaths) {
            try {
              const capacity = await NodeFSP.statfs(path);
              const availableBytes = capacity.bavail * capacity.bsize;
              const totalBytes = capacity.blocks * capacity.bsize;
              volumes.set(id, {
                id,
                path,
                availableBytes,
                totalBytes,
                sampledAt,
                pressure: storagePressure(availableBytes, totalBytes, state.policy),
              });
            } catch {
              // Rediscover a removed or disconnected representative on the next monitoring tick.
              capacityPathsRevision = -1;
            }
          }
          recordStoragePressure({ sampledAt, volumes: [...volumes.values()] });
        });
        return;
      }
      const snapshot = yield* service.snapshot;
      const ids = snapshot.worktrees
        .filter(
          (entry) =>
            entry.kind === "worktree" &&
            !entry.removed &&
            entry.blockers.length === 0 &&
            entry.threadIds.every(
              (id) =>
                state.since[id] &&
                Date.now() - Date.parse(state.since[id]!) >= state.policy.afterDays * 86_400_000,
            ),
        )
        .map((entry) => entry.id);
      if (ids.length) yield* service.start({ mode: "scheduled", worktreeIds: ids });
    }),
    waitForJob: (jobId) =>
      io(async () => {
        const completion = completions.get(jobId);
        if (completion) return completion.promise;
        const job = state.jobs.find((entry) => entry.id === jobId);
        if (!job) throw new Error("Cleanup job unavailable.");
        return job;
      }),
    setPolicy: (policy) =>
      io(async () => {
        validateStoragePolicy(policy);
        state = {
          ...state,
          policy,
          jobs: state.jobs.map((job) =>
            !policy.enabled && job.mode === "scheduled" && job.status === "running"
              ? { ...job, status: "cancelled" }
              : job,
          ),
        };
        await save();
        cached = null;
        return policy;
      }),
    setKeep: (threadId, keep) =>
      io(async () => {
        const snapshot = await refresh();
        const thread = snapshot.threads.find((thread) => thread.threadId === threadId);
        if (!thread) throw new Error("Thread unavailable.");
        const release = thread.worktreeId ? leaseStorageWorkspace(thread.worktreeId) : () => {};
        try {
          const since = { ...state.since };
          delete since[threadId];
          state = {
            ...state,
            keep: [...state.keep.filter((id) => id !== threadId), ...(keep ? [threadId] : [])],
            since,
            resetAt: { ...state.resetAt, [threadId]: iso() },
          };
          await save();
          cached = null;
        } finally {
          release();
        }
      }),
    preview: (input) => io(() => preview(input)),
    start,
    cancel: (jobId) =>
      io(async () => {
        const job = state.jobs.find((entry) => entry.id === jobId);
        if (!job) throw new Error("Cleanup job unavailable.");
        if (job.status !== "running") return job;
        const cancelled = { ...job, status: "cancelled" as const };
        replaceJob(cancelled);
        await save();
        return cancelled;
      }),
    recreate: (threadId) =>
      io(async () => {
        const removal = state.removals.find((entry) => entry.threadIds.includes(threadId));
        if (!removal || removal.phase === "pending")
          throw new Error("No reclaimed worktree is recorded for this thread.");
        const current = await run(threads.getShellSnapshot());
        const target = [...current.threads, ...current.archivedThreads].find(
          (thread) => thread.id === threadId && thread.deletedAt === null,
        );
        if (!target?.worktreePath || (await canonical(target.worktreePath)) !== removal.path)
          throw new Error("This thread no longer owns the reclaimed worktree.");
        const release = leaseStorageWorkspace(removal.path);
        try {
          if (
            await NodeFSP.lstat(removal.path).then(
              () => true,
              () => false,
            )
          )
            throw new Error("The old worktree path is occupied. Its files were kept.");
          await git(removal.root, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${removal.branch}`,
          ]);
          await git(removal.root, ["worktree", "add", "--", removal.path, removal.branch]);
          state = {
            ...state,
            removals: state.removals.filter((entry) => entry.path !== removal.path),
          };
          markStorageWorkspaceRemoved(removal.path, false);
          await save();
          cached = null;
          return { path: removal.path };
        } finally {
          release();
        }
      }),
  };
  yield* forkParked(
    service.monitor.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Storage monitoring deferred", { message: cause.message }),
      ),
      Effect.repeat(Schedule.spaced("1 minute")),
    ),
  );
  return service;
});

/** Logical conversation payload bytes; SQLite page overhead, attachment blobs and provider logs are separate. */
export function measureThreadStorageBytes(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql<{ bytes: number }>`
            SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
              SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
              UNION ALL SELECT length(CAST(payload_json AS BLOB)) FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}
              UNION ALL SELECT length(CAST(payload_json AS BLOB)) FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
              UNION ALL SELECT length(CAST(payload_json AS BLOB)) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
              UNION ALL SELECT length(CAST(payload_json AS BLOB)) FROM orchestration_v2_projection_checkpoints WHERE thread_id = ${threadId}
            )
          `.pipe(
    Effect.map((rows) => rows[0]?.bytes ?? 0),
    Effect.mapError(() => new StorageError({ message: "Conversation size is unavailable." })),
  );
}

export const layer = Layer.effect(StorageService, makeStorageService).pipe(
  Layer.provide(
    Layer.effect(
      StorageServiceInputs,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          threadDataBytes: (threadId: ThreadId) => measureThreadStorageBytes(sql, threadId),
          config: yield* ServerConfig,
          threads: yield* ThreadManagementService,
          terminals: yield* TerminalManager,
          workflow: yield* GitWorkflowService,
          projects: yield* ProjectionProjectRepository,
        };
      }),
    ),
  ),
);
