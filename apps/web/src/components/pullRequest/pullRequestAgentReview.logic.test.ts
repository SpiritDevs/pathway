import { describe, expect, it } from "vite-plus/test";

import {
  agentReviewSummary,
  buildPullRequestAgentReviewPrompt,
  parseAgentReviewFindings,
} from "./pullRequestAgentReview.logic";

describe("agent pull request review markers", () => {
  it("turns valid line markers into review comments and leaves malformed markers alone", () => {
    const response = [
      "Two findings.",
      '<pathway-review-comment>{"path":"src/a.ts","line":12,"side":"right","body":"This can throw."}</pathway-review-comment>',
      '<pathway-review-comment>{"path":"src/b.ts","line":0,"side":"middle","body":"bad"}</pathway-review-comment>',
    ].join("\n");

    expect(parseAgentReviewFindings(response)).toEqual([
      {
        index: 0,
        path: "src/a.ts",
        line: 12,
        side: "right",
        body: "This can throw.",
      },
    ]);
    expect(agentReviewSummary(response)).toContain("Two findings.");
    expect(agentReviewSummary(response)).not.toContain("pathway-review-comment");
  });

  it("asks for review-only work and exact diff anchors", () => {
    const prompt = buildPullRequestAgentReviewPrompt({
      number: 42,
      title: "A title",
      url: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      headBranch: "feature",
      baseBranch: "main",
      instructions: "Pay special attention to migrations.",
    });

    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("pathway-review-comment");
    expect(prompt).toContain("Pay special attention to migrations");
  });
});
