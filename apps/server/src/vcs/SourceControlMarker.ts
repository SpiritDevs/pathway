import type { GitRunStackedActionResult } from "@spiritdevs/contracts";

export interface SourceControlMarkerResult {
  readonly committed: boolean;
  /** SHA of the commit this action created, when it created one. */
  readonly commitSha?: string;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

export function sourceControlMarkerFromGitResult(
  result: GitRunStackedActionResult,
): SourceControlMarkerResult | null {
  const pullRequest =
    result.pr.status === "created" && result.pr.number !== undefined && result.pr.url !== undefined
      ? { number: result.pr.number, url: result.pr.url }
      : null;
  if (result.push.status !== "pushed" && pullRequest === null) {
    return null;
  }

  const committed = result.commit.status === "created";
  const commitSha = committed ? result.commit.commitSha : undefined;

  return {
    committed,
    ...(commitSha === undefined ? {} : { commitSha }),
    pullRequest,
  };
}
