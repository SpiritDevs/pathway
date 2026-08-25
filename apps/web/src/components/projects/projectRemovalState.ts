import { useSyncExternalStore } from "react";

const REMOVAL_SUPPRESSION_TIMEOUT_MS = 30_000;
const listeners = new Set<() => void>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pendingProjectKeys: ReadonlySet<string> = new Set();

function publish(next: ReadonlySet<string>): void {
  pendingProjectKeys = next;
  for (const listener of listeners) listener();
}

function clearExpiry(projectKey: string): void {
  const timer = expiryTimers.get(projectKey);
  if (timer !== undefined) clearTimeout(timer);
  expiryTimers.delete(projectKey);
}

export function markWorkspaceProjectRemovalPending(projectKey: string): void {
  clearExpiry(projectKey);
  if (!pendingProjectKeys.has(projectKey)) {
    publish(new Set([...pendingProjectKeys, projectKey]));
  }
  expiryTimers.set(
    projectKey,
    setTimeout(
      () => clearWorkspaceProjectRemovalPending(projectKey),
      REMOVAL_SUPPRESSION_TIMEOUT_MS,
    ),
  );
}

export function clearWorkspaceProjectRemovalPending(projectKey: string): void {
  clearExpiry(projectKey);
  if (!pendingProjectKeys.has(projectKey)) return;
  const next = new Set(pendingProjectKeys);
  next.delete(projectKey);
  publish(next);
}

export function settleMissingWorkspaceProjectRemovals(
  currentProjectKeys: ReadonlySet<string>,
): void {
  for (const projectKey of pendingProjectKeys) {
    if (!currentProjectKeys.has(projectKey)) {
      clearWorkspaceProjectRemovalPending(projectKey);
    }
  }
}

export function pendingWorkspaceProjectRemovalKeys(): ReadonlySet<string> {
  return pendingProjectKeys;
}

export function subscribeToPendingWorkspaceProjectRemovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingWorkspaceProjectRemovals(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeToPendingWorkspaceProjectRemovals,
    pendingWorkspaceProjectRemovalKeys,
    pendingWorkspaceProjectRemovalKeys,
  );
}
