import {
  DEFAULT_STORAGE_POLICY,
  EnvironmentId,
  ThreadId,
  type StorageJob,
  type StorageSnapshot,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  storageJobReclaimedBytes,
  storageJobRetryIds,
  storageSelectionKey,
  storageThreadMatches,
} from "./storageDashboard.logic";

const thread: StorageSnapshot["threads"][number] = {
  threadId: ThreadId.make("thread-1"),
  title: "Fix editor selection",
  projectId: null,
  worktreeId: "/work/fix",
  status: "snoozed",
  keepWorktree: false,
  threadDataBytes: 250,
  eligibleSince: null,
  reclaimedAt: null,
};
const worktree: StorageSnapshot["worktrees"][number] = {
  id: "/work/fix",
  path: "/work/fix",
  projectRoot: "/work",
  branch: "fix/editor",
  volumeId: "disk",
  threadIds: [thread.threadId],
  estimatedBytes: 400,
  measuredAt: null,
  kind: "worktree",
  blockers: [],
  removed: false,
};
const job: StorageJob = {
  id: "cleanup-1",
  mode: "manual",
  status: "completed",
  startedAt: "2026-09-09T00:00:00Z",
  finishedAt: "2026-09-09T00:01:00Z",
  items: [
    {
      worktreeId: "/one",
      status: "removed",
      message: null,
      estimatedBytes: 500,
      actualFreeDeltaBytes: 200,
    },
    {
      worktreeId: "/two",
      status: "failed",
      message: "Permission denied",
      estimatedBytes: 800,
      actualFreeDeltaBytes: null,
    },
    {
      worktreeId: "/three",
      status: "removed",
      message: null,
      estimatedBytes: 600,
      actualFreeDeltaBytes: -50,
    },
    {
      worktreeId: "/four",
      status: "skipped",
      message: "Busy",
      estimatedBytes: 900,
      actualFreeDeltaBytes: null,
    },
  ],
};

describe("storage dashboard selection and reporting", () => {
  it("keeps identical worktree paths on different environments separate", () => {
    expect(storageSelectionKey(EnvironmentId.make("one"), "/work/fix")).not.toBe(
      storageSelectionKey(EnvironmentId.make("two"), "/work/fix"),
    );
  });
  it("includes snoozed projectless conversations by default and exposes active ones only when requested", () => {
    expect(storageThreadMatches(thread, worktree, "inactive", "")).toBe(true);
    expect(storageThreadMatches({ ...thread, status: "active" }, worktree, "inactive", "")).toBe(
      false,
    );
    expect(storageThreadMatches({ ...thread, status: "active" }, worktree, "all", "")).toBe(true);
  });
  it("combines case-insensitive branch and path searching with status filters", () => {
    expect(storageThreadMatches(thread, worktree, "snoozed", " FIX/EDITOR ")).toBe(true);
    expect(storageThreadMatches(thread, worktree, "archived", "/work/fix")).toBe(false);
  });
  it("retries only failed worktrees after partial completion", () => {
    expect(storageJobRetryIds(job)).toEqual(["/two"]);
  });
  it("reports actual free-space change, including concurrent disk usage, instead of summed estimates", () => {
    expect(storageJobReclaimedBytes(job)).toBe(150);
    expect(
      storageJobReclaimedBytes({
        ...job,
        items: job.items.filter((item) => item.status !== "removed"),
      }),
    ).toBeNull();
  });
  it("ships scheduling disabled with the requested age choices and thresholds", () => {
    expect(DEFAULT_STORAGE_POLICY).toMatchObject({
      enabled: false,
      afterDays: 30,
      warningBytes: 20e9,
      warningPercent: 10,
      criticalBytes: 10e9,
      criticalPercent: 5,
    });
  });
});
