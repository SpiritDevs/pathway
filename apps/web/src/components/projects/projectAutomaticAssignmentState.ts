import { useSyncExternalStore } from "react";

const AUTOMATIC_ASSIGNMENT_TIMEOUT_MS = 30_000;
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

/** Suppress the manual owner dialog while this exact checkout is being assigned automatically. */
export function markProjectAutomaticAssignmentPending(projectKey: string): void {
  clearExpiry(projectKey);
  if (!pendingProjectKeys.has(projectKey)) {
    publish(new Set([...pendingProjectKeys, projectKey]));
  }
  expiryTimers.set(
    projectKey,
    setTimeout(
      () => clearProjectAutomaticAssignmentPending(projectKey),
      AUTOMATIC_ASSIGNMENT_TIMEOUT_MS,
    ),
  );
}

export function clearProjectAutomaticAssignmentPending(projectKey: string): void {
  clearExpiry(projectKey);
  if (!pendingProjectKeys.has(projectKey)) return;
  const next = new Set(pendingProjectKeys);
  next.delete(projectKey);
  publish(next);
}

export function pendingProjectAutomaticAssignmentKeys(): ReadonlySet<string> {
  return pendingProjectKeys;
}

export function subscribeToProjectAutomaticAssignments(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingProjectAutomaticAssignments(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeToProjectAutomaticAssignments,
    pendingProjectAutomaticAssignmentKeys,
    pendingProjectAutomaticAssignmentKeys,
  );
}
