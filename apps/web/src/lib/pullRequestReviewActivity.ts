import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { parsePullRequestReviewThreadTitle } from "@t3tools/shared/pullRequestReview";

type PullRequestReviewActivityThread = Pick<
  EnvironmentThreadShell,
  "deletedAt" | "environmentId" | "projectId" | "runtime" | "title"
>;

export function pullRequestReviewActivityKey(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}): string {
  return JSON.stringify([input.projectId, input.repository.toLowerCase(), input.number]);
}

export function deriveActivePullRequestReviewKeys(
  threads: ReadonlyArray<PullRequestReviewActivityThread>,
  environmentId: EnvironmentId,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.deletedAt !== null ||
      !threadRuntimeIsActive(thread.runtime)
    ) {
      continue;
    }
    const review = parsePullRequestReviewThreadTitle(thread.title);
    if (review === null) continue;
    keys.add(
      pullRequestReviewActivityKey({
        projectId: thread.projectId,
        repository: review.repository,
        number: review.number,
      }),
    );
  }
  return keys;
}
