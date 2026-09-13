import type { ProjectBindingTarget } from "./projectRepositoryChoice.logic";
import { useSyncExternalStore } from "react";

const AUTOMATIC_ASSIGNMENT_TIMEOUT_MS = 30_000;
// Retain creation intent after a request settles so a delayed replica or retry cannot
// fall back to personal while the chosen company's binding is still arriving.
const creationTargets = new Map<
  string,
  ProjectBindingTarget & { readonly matchRepository?: boolean }
>();
export function projectAutomaticAssignmentTarget(projectKey: string) {
  return creationTargets.get(projectKey);
}

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

/** Reserve the checkout before creating it so background assignment cannot race its owner. */
export function markProjectAutomaticAssignmentPending(
  projectKey: string,
  target?: ProjectBindingTarget & { readonly matchRepository?: boolean },
): void {
  if (target !== undefined) creationTargets.set(projectKey, target);
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
