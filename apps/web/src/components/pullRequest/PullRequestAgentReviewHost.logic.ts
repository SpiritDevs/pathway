import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentId, PullRequestRef, ThreadId } from "@spiritdevs/contracts";
import { parsePullRequestReviewThreadTitle } from "@spiritdevs/shared/pullRequestReview";

export interface PullRequestReviewPublisherTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: PullRequestRef;
}

export const pullRequestReviewPublisherTargetKey = (
  target: Pick<PullRequestReviewPublisherTarget, "environmentId" | "threadId">,
) => `${target.environmentId}\u0000${target.threadId}`;

export function pullRequestReviewProcessingDisposition(input: {
  readonly activityAvailable: boolean;
  readonly activityError: string | null;
}): "wait" | "stage" | "publish" {
  if (input.activityAvailable) return "publish";
  return input.activityError === null ? "wait" : "stage";
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

function reviewIntentKey(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: PullRequestRef["projectId"];
  readonly repository: string;
  readonly number: number;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.repository.toLowerCase(),
    input.number,
  ]);
}

/**
 * Keeps responsibility for a publishing review after its runtime settles. A completed review no
 * longer counts as active, but its final assistant message can arrive in the same projection
 * update that settles it, so dropping the observer at that boundary would lose the host write.
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
  const latestByIntent = new Map<string, (typeof reviews)[number]>();
  for (const candidate of reviews) {
    const key = reviewIntentKey({
      environmentId: candidate.thread.environmentId,
      projectId: candidate.thread.projectId,
      repository: candidate.review.repository,
      number: candidate.review.number,
    });
    const current = latestByIntent.get(key);
    if (current === undefined || candidate.thread.updatedAt > current.thread.updatedAt) {
      latestByIntent.set(key, candidate);
    }
  }

  for (const thread of threads) {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    const review = parsePullRequestReviewThreadTitle(thread.title);
    if (thread.deletedAt !== null || review?.publishComments !== true) {
      targets.delete(key);
      continue;
    }
    if (completedThreadKeys.has(key) && !threadRuntimeIsActive(thread.runtime)) {
      targets.delete(key);
    }
  }

  for (const { thread, review } of reviews) {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    const active = threadRuntimeIsActive(thread.runtime);
    const latest = latestByIntent.get(
      reviewIntentKey({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        repository: review.repository,
        number: review.number,
      }),
    );
    if (!active && (completedThreadKeys.has(key) || latest?.thread.id !== thread.id)) continue;
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
