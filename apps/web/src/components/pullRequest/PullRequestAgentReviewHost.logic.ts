import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentId, PullRequestRef, RunId, ThreadId } from "@spiritdevs/contracts";
import { parsePullRequestReviewThreadTitle } from "@spiritdevs/shared/pullRequestReview";

export interface PullRequestReviewPublisherTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: PullRequestRef;
}

export const pullRequestReviewPublisherTargetKey = (
  target: Pick<PullRequestReviewPublisherTarget, "environmentId" | "threadId">,
) => `${target.environmentId}\u0000${target.threadId}`;

export const pullRequestReviewCompletionKey = (
  target: Pick<PullRequestReviewPublisherTarget, "environmentId" | "threadId">,
  runId: RunId,
) => `${pullRequestReviewPublisherTargetKey(target)}\u0000${runId}`;

const COMPLETED_REVIEW_STORAGE_KEY = "pathway:completed-agent-pull-request-reviews:v1";
const MAX_PERSISTED_COMPLETED_REVIEWS = 10_000;
const MAX_CONCURRENT_SETTLED_RECOVERIES = 1;

interface CompletionStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function readCompletedPullRequestReviewKeys(
  storage: CompletionStorage | undefined,
): ReadonlySet<string> {
  if (storage === undefined) return new Set();
  try {
    const parsed = JSON.parse(storage.getItem(COMPLETED_REVIEW_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((value): value is string => typeof value === "string")
        .slice(-MAX_PERSISTED_COMPLETED_REVIEWS),
    );
  } catch {
    return new Set();
  }
}

export function writeCompletedPullRequestReviewKeys(
  storage: CompletionStorage | undefined,
  keys: ReadonlySet<string>,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      COMPLETED_REVIEW_STORAGE_KEY,
      JSON.stringify([...keys].slice(-MAX_PERSISTED_COMPLETED_REVIEWS)),
    );
  } catch {
    // Persistence is an optimization. Server-side marker deduplication keeps a later rescan safe.
  }
}

export function addCompletedPullRequestReviewKey(
  keys: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  if (keys.has(key)) return keys;
  return new Set([...keys, key].slice(-MAX_PERSISTED_COMPLETED_REVIEWS));
}

export function pullRequestReviewCanFinish(input: {
  readonly active: boolean;
  readonly processedMessageIds: ReadonlySet<string>;
  readonly latestRun: { readonly assistantMessageId: string | null } | null;
}): boolean {
  if (input.active || input.latestRun === null) return false;
  return (
    input.latestRun.assistantMessageId === null ||
    input.processedMessageIds.has(input.latestRun.assistantMessageId)
  );
}

/**
 * Keeps responsibility for an observed review after its runtime settles so its final projection
 * update cannot outrun publishing. On startup, settled reviews recover newest-first through a
 * bounded slot; durable run completion keys advance that queue without mounting historical
 * threads or hiding a later run completed by another client.
 */
export function reconcilePullRequestReviewPublisherTargets(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  retained: ReadonlyArray<PullRequestReviewPublisherTarget>,
  completedThreadKeys: ReadonlySet<string> = new Set(),
): ReadonlyArray<PullRequestReviewPublisherTarget> {
  const targets = new Map(
    retained.map((target) => [pullRequestReviewPublisherTargetKey(target), target] as const),
  );
  const threadKeys = new Set(threads.map((thread) => `${thread.environmentId}\u0000${thread.id}`));
  for (const key of targets.keys()) {
    if (!threadKeys.has(key)) targets.delete(key);
  }
  const reviews = threads.flatMap((thread) => {
    const review = parsePullRequestReviewThreadTitle(thread.title);
    return thread.deletedAt === null && review?.publishComments === true
      ? [{ thread, review }]
      : [];
  });

  for (const thread of threads) {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    const review = parsePullRequestReviewThreadTitle(thread.title);
    if (thread.deletedAt !== null || review?.publishComments !== true) {
      targets.delete(key);
      continue;
    }
    if (!threadRuntimeIsActive(thread.runtime) && thread.latestRun === null) {
      targets.delete(key);
      continue;
    }
    const runId = thread.latestRun?.runId;
    if (
      runId !== undefined &&
      completedThreadKeys.has(
        pullRequestReviewCompletionKey(
          { environmentId: thread.environmentId, threadId: thread.id },
          runId,
        ),
      ) &&
      !threadRuntimeIsActive(thread.runtime)
    ) {
      targets.delete(key);
    }
  }

  const retainedSettledCount = reviews.filter(({ thread }) => {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    return !threadRuntimeIsActive(thread.runtime) && targets.has(key);
  }).length;
  const recoverySlots = Math.max(0, MAX_CONCURRENT_SETTLED_RECOVERIES - retainedSettledCount);
  const recoveryKeys = new Set(
    reviews
      .filter(({ thread }) => {
        const key = `${thread.environmentId}\u0000${thread.id}`;
        return (
          !threadRuntimeIsActive(thread.runtime) &&
          thread.latestRun !== null &&
          !completedThreadKeys.has(
            pullRequestReviewCompletionKey(
              { environmentId: thread.environmentId, threadId: thread.id },
              thread.latestRun.runId,
            ),
          ) &&
          !targets.has(key)
        );
      })
      .toSorted(
        (left, right) =>
          right.thread.createdAt.localeCompare(left.thread.createdAt) ||
          right.thread.id.localeCompare(left.thread.id),
      )
      .slice(0, recoverySlots)
      .map(({ thread }) => `${thread.environmentId}\u0000${thread.id}`),
  );

  for (const { thread, review } of reviews) {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    const active = threadRuntimeIsActive(thread.runtime);
    if (!active && !targets.has(key) && !recoveryKeys.has(key)) continue;
    const existing = targets.get(key);
    if (
      existing !== undefined &&
      existing.reference.projectId === thread.projectId &&
      existing.reference.repository === review.repository &&
      existing.reference.number === review.number
    ) {
      continue;
    }
    const target = {
      environmentId: thread.environmentId,
      threadId: thread.id,
      reference: {
        projectId: thread.projectId,
        repository: review.repository,
        number: review.number,
      },
    };
    targets.set(key, target);
  }

  const next = [...targets.values()];
  return next.length === retained.length &&
    next.every((target, index) => target === retained[index])
    ? retained
    : next;
}
