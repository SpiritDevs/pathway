import type {
  ThreadQueueSubmission,
  ThreadQueueThread,
  ThreadQueueDestination,
} from "@spiritdevs/contracts/threadQueue";
import { Atom } from "effect/unstable/reactivity";
import type { ThreadQueueOutboxRecord } from "@spiritdevs/client-runtime/sync/thread-queue-outbox";
export const threadQueueRowsAtom = Atom.make<ReadonlyArray<ThreadQueueThread>>([]).pipe(
  Atom.keepAlive,
);
export const localThreadQueueAtom = Atom.make<
  ReadonlyArray<ThreadQueueOutboxRecord<ThreadQueueSubmission>>
>([]).pipe(Atom.keepAlive);
export const threadQueueHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);

/** A mutation receipt stays visible until the list subscription observes that revision. */
export function reconcileQueuedThreadReceipts(
  rows: ReadonlyArray<ThreadQueueThread>,
  receipts: ReadonlyMap<string, ThreadQueueThread>,
) {
  const merged = new Map(rows.map((row) => [row.threadId, row]));
  const pending = new Map<string, ThreadQueueThread>();
  for (const [threadId, receipt] of receipts) {
    if ((merged.get(threadId)?.revision ?? -1) >= receipt.revision) continue;
    merged.set(threadId, receipt);
    pending.set(threadId, receipt);
  }
  return { rows: [...merged.values()], pending };
}

export function mergeThreadQueueEntries(
  cloud: ReadonlyArray<ThreadQueueThread>,
  local: ReadonlyArray<ThreadQueueOutboxRecord<ThreadQueueSubmission>>,
) {
  const rows = new Map(
    cloud.map((thread) => [thread.threadId, { ...thread, waitingToSync: false, cloudSaved: true }]),
  );
  for (const row of local) {
    const existing = rows.get(row.threadId);
    if (existing) {
      rows.set(row.threadId, {
        ...existing,
        waitingToSync: existing.waitingToSync || !row.canceled,
        queuedCount: existing.queuedCount + (row.canceled ? 0 : 1),
        error: row.error || existing.error,
        updatedAt: Math.max(existing.updatedAt, row.createdAt),
      });
      continue;
    }
    const launch = row.submission.kind === "launch" ? row.submission.input : null;
    const localProjectId = launch ? launch.projectId : (row.localProjectId ?? null);
    rows.set(row.threadId, {
      threadId: row.threadId,
      environmentId: row.environmentId,
      localProjectId: localProjectId === `conversations:${row.companyId}` ? null : localProjectId,
      cloudProjectId: null,
      title: launch?.title ?? row.threadTitle ?? "Queued message",
      launch,
      state: row.canceled ? "canceled" : "queued",
      error: row.error ?? null,
      revision: 0,
      acceptedAt: null,
      queuedCount: 1,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      waitingToSync: !row.canceled,
      cloudSaved: false,
    });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const threadQueueEntriesAtom = Atom.make((get) =>
  mergeThreadQueueEntries(get(threadQueueRowsAtom), get(localThreadQueueAtom)),
);

export const threadQueueAccountAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

export const threadQueueDestinationsAtom = Atom.make<ReadonlyArray<ThreadQueueDestination>>(
  [],
).pipe(Atom.keepAlive);
