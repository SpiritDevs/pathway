import { describe, expect, it } from "vite-plus/test";

import {
  isPullRequestReviewThreadTitle,
  parsePullRequestReviewThreadTitle,
  pullRequestReviewThreadTitle,
} from "./pullRequestReview.ts";

describe("pull request review thread identity", () => {
  it("round trips repository names, numbers, and publishing intent", () => {
    const title = pullRequestReviewThreadTitle({
      repository: "coreybaines/pathway",
      number: 4843,
      publishComments: true,
    });

    expect(title).toBe("PR review · coreybaines/pathway#4843 · publish");
    expect(parsePullRequestReviewThreadTitle(title)).toEqual({
      repository: "coreybaines/pathway",
      number: 4843,
      publishComments: true,
    });
  });

  it("does not classify ordinary or malformed titles as review conversations", () => {
    expect(isPullRequestReviewThreadTitle("Review the pull request page")).toBe(false);
    expect(isPullRequestReviewThreadTitle("PR review · pathway#nope")).toBe(false);
    expect(parsePullRequestReviewThreadTitle("PR review · pathway#42")).toEqual({
      repository: "pathway",
      number: 42,
      publishComments: false,
    });
  });
});
