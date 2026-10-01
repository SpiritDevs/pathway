import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";

type ParentCandidate = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "environmentId" | "id" | "lineage"
>;

const threadKey = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

/**
 * Threads that `target` can be listed under: not archived, not itself, and not anything already
 * listed beneath it, which would make a loop.
 */
export function threadParentCandidates<T extends ParentCandidate>(
  threads: ReadonlyArray<T>,
  target: { readonly environmentId: string; readonly threadId: string },
): T[] {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    const { parentThreadId, parentEnvironmentId } = thread.lineage;
    if (parentThreadId === null) continue;
    const parentKey = threadKey(parentEnvironmentId ?? thread.environmentId, parentThreadId);
    const siblings = children.get(parentKey) ?? [];
    siblings.push(threadKey(thread.environmentId, thread.id));
    children.set(parentKey, siblings);
  }
  const excluded = new Set([threadKey(target.environmentId, target.threadId)]);
  const pending = [...excluded];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      pending.push(child);
    }
  }
  return threads.filter(
    (thread) =>
      thread.archivedAt === null && !excluded.has(threadKey(thread.environmentId, thread.id)),
  );
}
