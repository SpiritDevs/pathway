import { ProjectId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  pendingReviewCommentsForSubmission,
  type PendingReviewComment,
  stageAgentReviewFindings,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", line: 1, side: "right" };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  });

  it("removes only the line comments included in a submitted snapshot", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const submittedIds =
      usePullRequestReviewStore.getState().drafts["review-a"]?.map((entry) => entry.id) ?? [];

    usePullRequestReviewStore.getState().addComment("review-a", comment("added-in-flight"));
    usePullRequestReviewStore.getState().removeComments("review-a", submittedIds);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("does not duplicate a deterministic agent finding after remounting", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("agent-finding"));
    usePullRequestReviewStore.getState().addComment("review-a", comment("agent-finding"));

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("agent-finding"),
    ]);
  });

  it("stages an agent finding and its summary together", () => {
    stageAgentReviewFindings({
      reference: {
        projectId: ProjectId.make("project-1"),
        repository: "acme/app",
        number: 42,
      },
      messageText: [
        "Review summary",
        '<pathway-review-comment>{"path":"src/app.ts","line":2,"side":"right","body":"Finding"}</pathway-review-comment>',
      ].join("\n"),
      findings: [
        {
          markerId: "pathway-agent-review:thread-1:message-1:0",
          finding: {
            index: 0,
            path: "src/app.ts",
            line: 2,
            side: "right",
            body: "Finding",
          },
        },
      ],
    });

    expect(usePullRequestReviewStore.getState()).toMatchObject({
      drafts: {
        "project-1/acme/app#42": [
          {
            id: "pathway-agent-review:thread-1:message-1:0",
            markerId: "pathway-agent-review:thread-1:message-1:0",
            path: "src/app.ts",
            line: 2,
            side: "right",
            body: "Finding",
          },
        ],
      },
      summaries: { "project-1/acme/app#42": "Review summary" },
    });
  });

  it("attaches an agent marker only to the submitted comment body", () => {
    const pending = comment("pathway-agent-review:thread-1:message-1:0", "Finding");

    expect(
      pendingReviewCommentsForSubmission([
        { ...pending, markerId: "pathway-agent-review:thread-1:message-1:0" },
      ]),
    ).toEqual([
      {
        path: "src/app.ts",
        line: 1,
        side: "right",
        body: "Finding\n\n<!-- pathway-agent-review:thread-1:message-1:0 -->",
      },
    ]);
    expect(pending.body).toBe("Finding");
  });

  it("keeps summary bodies isolated by review key", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Summary A");
    store.setSummary("review-b", "Summary B");
    store.clearSummary("review-a", "Summary A");

    expect(usePullRequestReviewStore.getState().summaries).toEqual({
      "review-b": "Summary B",
    });
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });
});
