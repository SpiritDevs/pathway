import { issueEntityCodec } from "@spiritdevs/client-runtime/sync";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { issueFromReplica } from "./issueLegacyProjection.ts";

describe("issueFromReplica", () => {
  it("retains triage state and Slack provenance for the legacy UI seam", () => {
    const codec = issueEntityCodec("issue");
    if (codec === null) throw new Error("Missing issue entity codec.");
    const entity = Option.getOrThrow(
      codec.decode({
        id: "issue-slack",
        key: "PAT-8",
        keyNumber: 8,
        title: "Slack report",
        description: "Filed from Slack",
        statusId: "",
        priority: "none",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "m",
        labelIds: [],
        dueDate: null,
        triage: true,
        slackSource: {
          issueId: "issue-slack",
          channelId: "C123",
          messageTs: "1723459200.001900",
          permalink: "https://example.slack.com/archives/C123/p1723459200001900",
          authorName: "Corey",
        },
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        pullRequest: null,
        createdAt: Date.UTC(2026, 0, 1),
        updatedAt: Date.UTC(2026, 0, 2),
      }),
    );
    if (entity.entityKind !== "issue") throw new Error("Decoded the wrong entity kind.");

    const projected = issueFromReplica(entity);
    expect(projected.triage).toBe(true);
    expect(projected.statusId).toBe("");
    expect(projected.slackSource).toEqual({
      issueId: "issue-slack",
      channelId: "C123",
      messageTs: "1723459200.001900",
      permalink: "https://example.slack.com/archives/C123/p1723459200001900",
      authorName: "Corey",
    });
  });
});
