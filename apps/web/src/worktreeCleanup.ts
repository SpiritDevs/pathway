import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

/** Kept threads may move to another worktree while retaining older server-owned folders. */
export function getClientWorktreeCleanupPathForThread(
  threads: ReadonlyArray<
    Pick<ThreadShell, "id" | "worktreePath" | "ownedWorktreePath" | "temporary">
  >,
  threadId: ThreadShell["id"],
): string | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const worktreePath = thread ? normalizeWorktreePath(thread.worktreePath) : null;
  if (
    !thread ||
    thread.temporary ||
    worktreePath === null ||
    worktreePath === normalizeWorktreePath(thread.ownedWorktreePath ?? null)
  ) {
    return null;
  }
  return getOrphanedWorktreePathForThread(threads, threadId);
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
