// @effect-diagnostics nodeBuiltinImport:off - Canonical filesystem lease keys are an adapter concern.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

function keyFor(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    const parent = NodePath.dirname(path);
    if (parent === path) return NodePath.resolve(path);
    try {
      return NodePath.join(NodeFS.realpathSync(parent), NodePath.basename(path));
    } catch {
      return NodePath.resolve(path);
    }
  }
}

const busy = new Set<string>();
const removed = new Set<string>();
const uses = new Map<string, number>();
const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(right + NodePath.sep) || right.startsWith(left + NodePath.sep);
export function workspaceStorageBlocker(path: string, allowRemoved = false): string | null {
  const key = keyFor(path);
  if ([...busy].some((path) => overlaps(path, key)))
    return "This worktree is being cleaned up. Wait for cleanup to finish.";
  if (!allowRemoved && [...removed].some((path) => overlaps(path, key)))
    return "This worktree was removed to free space. Recreate the worktree before continuing.";
  return null;
}
export function leaseStorageWorkspace(path: string): () => void {
  const key = keyFor(path);
  if ([...uses].some(([path, count]) => count > 0 && overlaps(path, key)))
    throw new Error("This worktree is starting new activity.");
  if ([...busy].some((path) => overlaps(path, key)))
    throw new Error("This worktree is already being changed.");
  busy.add(key);
  return () => {
    busy.delete(key);
  };
}
export function markStorageWorkspaceRemoved(path: string, value: boolean): void {
  const key = keyFor(path);
  if (value) removed.add(key);
  else removed.delete(key);
}

export function useStorageWorkspace(path: string, allowRemoved = false): () => void {
  const key = keyFor(path);
  const blocker = workspaceStorageBlocker(path, allowRemoved);
  if (blocker) throw new Error(blocker);
  uses.set(key, (uses.get(key) ?? 0) + 1);
  return () => {
    const count = (uses.get(key) ?? 1) - 1;
    if (count === 0) uses.delete(key);
    else uses.set(key, count);
  };
}
