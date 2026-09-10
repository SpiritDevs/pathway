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

export function queuedThreadKey(row: {
  queueId?: string;
  environmentId: string;
  threadId: string;
}) {
  return row.queueId ?? `${row.environmentId}:${row.threadId}`;
}

export function parseQueuedThreadSearch(raw: Record<string, unknown>): { queueId?: string } {
  return typeof raw.queueId === "string" && raw.queueId.length > 0 && raw.queueId.length <= 256
    ? { queueId: raw.queueId }
    : {};
}

export function queuedThreadEnvironmentKeys(
  rows: readonly { environmentId: string; originEnvironmentId?: string; threadId: string }[],
) {
  return new Set(
    rows.flatMap((row) => [
      `${row.environmentId}:${row.threadId}`,
      `${row.originEnvironmentId ?? row.environmentId}:${row.threadId}`,
    ]),
  );
}

export function findQueuedThread<
  T extends { environmentId: string; originEnvironmentId?: string; threadId: string },
>(
  rows: readonly T[],
  environmentId: string | undefined,
  threadId: string | undefined,
): T | undefined {
  const scoped = rows.find(
    (row) => row.environmentId === environmentId && row.threadId === threadId,
  );
  if (scoped) return scoped;
  return rows.find((row) => row.originEnvironmentId === environmentId && row.threadId === threadId);
}

/** A mutation receipt stays visible until the list subscription observes that revision. */
export function reconcileQueuedThreadReceipts(
  rows: ReadonlyArray<ThreadQueueThread>,
  receipts: ReadonlyMap<string, ThreadQueueThread>,
) {
  const merged = new Map(rows.map((row) => [queuedThreadKey(row), row]));
  const pending = new Map<string, ThreadQueueThread>();
  for (const receipt of receipts.values()) {
    const threadId = queuedThreadKey(receipt);
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
    cloud.map((thread) => [
      queuedThreadKey(thread),
      { ...thread, waitingToSync: false, cloudSaved: true },
    ]),
  );
  for (const row of local) {
    const cloudMatch = findQueuedThread(
      cloud.filter((thread) => !thread.companyId || thread.companyId === row.companyId),
      row.environmentId,
      row.threadId,
    );
    const key = row.queueId ?? (cloudMatch ? queuedThreadKey(cloudMatch) : queuedThreadKey(row));
    const existing = rows.get(key);
    if (existing) {
      rows.set(key, {
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
    rows.set(key, {
      threadId: row.threadId,
      companyId: row.companyId,
      ...(row.queueId ? { queueId: row.queueId } : {}),
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

/** The same environment can publish project bindings to several companies. */
export function mergeQueueDestinations(destinations: readonly ThreadQueueDestination[]) {
  const result = new Map<string, ThreadQueueDestination>();
  for (const destination of destinations) {
    const previous = result.get(destination.environmentId);
    result.set(
      destination.environmentId,
      previous
        ? {
            ...destination,
            projects: [
              ...new Map(
                [...previous.projects, ...destination.projects].map((project) => [
                  project.localProjectId,
                  project,
                ]),
              ).values(),
            ],
            providers: [
              ...new Map(
                [...previous.providers, ...destination.providers].map((provider) => [
                  provider.instanceId,
                  provider,
                ]),
              ).values(),
            ],
          }
        : destination,
    );
  }
  return [...result.values()];
}
