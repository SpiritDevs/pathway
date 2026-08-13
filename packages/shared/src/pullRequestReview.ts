/**
 * Durable identity for agent conversations that belong to a pull request rather than the
 * ordinary thread inbox. The title travels in every existing thread contract and shell snapshot,
 * so old servers can retain and route review conversations without a second persistence model.
 */
const PULL_REQUEST_REVIEW_TITLE_PREFIX = "PR review · ";
const PUBLISH_SUFFIX = " · publish";

export interface PullRequestReviewThreadIdentity {
  readonly repository: string;
  readonly number: number;
  readonly publishComments: boolean;
}

export function pullRequestReviewThreadTitle(input: PullRequestReviewThreadIdentity): string {
  return `${PULL_REQUEST_REVIEW_TITLE_PREFIX}${input.repository}#${input.number}${input.publishComments ? PUBLISH_SUFFIX : ""}`;
}

export function parsePullRequestReviewThreadTitle(
  title: string,
): PullRequestReviewThreadIdentity | null {
  if (!title.startsWith(PULL_REQUEST_REVIEW_TITLE_PREFIX)) return null;
  const publishComments = title.endsWith(PUBLISH_SUFFIX);
  const value = title.slice(
    PULL_REQUEST_REVIEW_TITLE_PREFIX.length,
    publishComments ? -PUBLISH_SUFFIX.length : undefined,
  );
  const separator = value.lastIndexOf("#");
  if (separator <= 0) return null;
  const repository = value.slice(0, separator).trim();
  const number = Number(value.slice(separator + 1));
  if (repository.length === 0 || !Number.isSafeInteger(number) || number <= 0) return null;
  return { repository, number, publishComments };
}

export function isPullRequestReviewThreadTitle(title: string): boolean {
  return parsePullRequestReviewThreadTitle(title) !== null;
}
