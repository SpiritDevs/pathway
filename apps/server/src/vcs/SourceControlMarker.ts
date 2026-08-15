import type { GitRunStackedActionResult } from "@spiritdevs/contracts";

export interface SourceControlMarkerResult {
  readonly committed: boolean;
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

  return {
    committed: result.commit.status === "created",
    pullRequest,
  };
}
