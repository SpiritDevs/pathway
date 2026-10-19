import type { OrchestrationV2ThreadDetailSnapshot } from "@spiritdevs/contracts";

// Offscreen threads keep their last projection and resume cursor, not their
// live stream. Reopening one paints the snapshot synchronously and resumes the
// stream from its sequence, so the bound only limits memory, not live work.
export const RETAINED_THREAD_SNAPSHOT_LIMIT = 20;

/**
 * Least-recently-used thread snapshots keyed by thread key. Each snapshot pairs
 * a projection with the sequence it was built from; storing `undefined` drops
 * the entry so the next open falls back to the persistent cache.
 */
export interface RetainedThreadSnapshots {
  readonly get: (key: string) => OrchestrationV2ThreadDetailSnapshot | undefined;
  readonly set: (key: string, snapshot: OrchestrationV2ThreadDetailSnapshot | undefined) => void;
}

export function makeRetainedThreadSnapshots(
  limit = RETAINED_THREAD_SNAPSHOT_LIMIT,
): RetainedThreadSnapshots {
  const entries = new Map<string, OrchestrationV2ThreadDetailSnapshot>();
  return {
    get: (key) => entries.get(key),
    set: (key, snapshot) => {
      entries.delete(key);
      if (snapshot === undefined) return;
      entries.set(key, snapshot);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}
