import type { EnvironmentId, StorageSnapshot, StorageJob } from "@spiritdevs/contracts";

export type StorageThreadRow = StorageSnapshot["threads"][number];
export type StorageWorktreeRow = StorageSnapshot["worktrees"][number];
export type StorageThreadFilter = "inactive" | "all" | StorageThreadRow["status"];

export function storageSelectionKey(environmentId: EnvironmentId, worktreeId: string): string {
  return JSON.stringify([environmentId, worktreeId]);
}

export function storageThreadMatches(
  thread: StorageThreadRow,
  worktree: StorageWorktreeRow | undefined,
  filter: StorageThreadFilter,
  query: string,
): boolean {
  if (filter === "inactive" && thread.status === "active") return false;
  if (filter !== "inactive" && filter !== "all" && thread.status !== filter) return false;
  const search = query.trim().toLowerCase();
  return (
    !search ||
    [thread.title, worktree?.path, worktree?.branch].some((value) =>
      value?.toLowerCase().includes(search),
    )
  );
}

export function storageJobReclaimedBytes(job: StorageJob): number | null {
  const measured = job.items.filter(
    (item) => item.status === "removed" && item.actualFreeDeltaBytes !== null,
  );
  return measured.length > 0
    ? measured.reduce((sum, item) => sum + (item.actualFreeDeltaBytes ?? 0), 0)
    : null;
}

export function storageJobRetryIds(job: StorageJob): string[] {
  return job.items.filter((item) => item.status === "failed").map((item) => item.worktreeId);
}
