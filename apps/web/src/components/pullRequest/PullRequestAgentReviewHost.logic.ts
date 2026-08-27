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

const targetKey = (target: Pick<PullRequestReviewPublisherTarget, "environmentId" | "threadId">) =>
  `${target.environmentId}\u0000${target.threadId}`;

/**
 * Keeps responsibility for a publishing review after its runtime settles. A completed review no
 * longer counts as active, but its final assistant message can arrive in the same projection
 * update that settles it, so dropping the observer at that boundary would lose the host write.
 */
export function reconcilePullRequestReviewPublisherTargets(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  retained: ReadonlyArray<PullRequestReviewPublisherTarget>,
): ReadonlyArray<PullRequestReviewPublisherTarget> {
  const targets = new Map(retained.map((target) => [targetKey(target), target] as const));

  for (const thread of threads) {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    const review = parsePullRequestReviewThreadTitle(thread.title);
    if (thread.deletedAt !== null || review === null || !review.publishComments) {
      targets.delete(key);
      continue;
    }
    if (!threadRuntimeIsActive(thread.runtime)) continue;
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
