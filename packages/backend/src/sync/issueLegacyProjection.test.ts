import {
  issueEntityCodec,
  syncedIssueDomainFromEntities,
  type IssueStatusEntity,
} from "@spiritdevs/client-runtime/sync";
import { IssueStatusId } from "@spiritdevs/contracts";
import { TeamId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveIssueStatusesForOwnerFromReplica,
  issueFromReplica,
} from "./issueLegacyProjection.ts";

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
    expect(projected.deletedAt).toBeNull();
  });

  it("projects a soft-deleted replica issue into the legacy bin", () => {
    const codec = issueEntityCodec("issue");
    if (codec === null) throw new Error("Missing issue entity codec.");
    const entity = Option.getOrThrow(
      codec.decode({
        id: "issue-deleted",
        key: "PAT-9",
        keyNumber: 9,
        title: "Deleted issue",
        description: "Still readable",
        statusId: "status-1",
        priority: "none",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "m",
        labelIds: [],
        dueDate: null,
        triage: false,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        pullRequest: null,
        createdAt: Date.UTC(2026, 0, 1),
        updatedAt: Date.UTC(2026, 0, 3),
        deletedAt: Date.UTC(2026, 0, 3),
      }),
    );
    if (entity.entityKind !== "issue") throw new Error("Decoded the wrong entity kind.");

    expect(issueFromReplica(entity).deletedAt).toBe("2026-01-03T00:00:00.000Z");
  });
});

describe("deleted issue compatibility", () => {
  it("rebuilds the new bin from an audit snapshot without requiring a live issue upsert", () => {
    const deletedIssue = {
      id: "issue-deleted-audit",
      key: "PAT-10",
      keyNumber: 10,
      title: "Recoverable delete",
      description: "Stored outside the live issue key",
      statusId: "status-1",
      priority: "none",
      assignee: null,
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: null,
      sortOrder: "m",
      labelIds: [],
      dueDate: null,
      triage: false,
      slackSource: null,
      teamIds: [],
      workflowOwner: { kind: "company" as const },
      workModelSelection: null,
      automationAssignment: null,
      pullRequest: null,
      createdAt: Date.UTC(2026, 0, 1),
      updatedAt: Date.UTC(2026, 0, 4),
      deletedAt: Date.UTC(2026, 0, 4),
    };
    const readModel = syncedIssueDomainFromEntities([
      {
        entityKind: "issueAuditEvent",
        id: "audit-bin-1",
        issueId: deletedIssue.id,
        kind: "deleted_snapshot",
        actor: { kind: "system", source: "import" },
        payload: { deletedIssue },
        operationId: null,
        createdAt: Date.UTC(2026, 0, 4),
      },
    ]);

    expect(readModel.issues).toHaveLength(1);
    expect(issueFromReplica(readModel.issues[0]!).deletedAt).toBe("2026-01-04T00:00:00.000Z");
  });
});

describe("workflow status projection", () => {
  it("returns only the target issue workflow when different teams reuse a status name", () => {
    const status = (
      id: string,
      name: string,
      teamId: string | null,
      position: number,
    ): IssueStatusEntity => ({
      entityKind: "issueStatus",
      id: IssueStatusId.make(id),
      scope: teamId === null ? "company" : "team",
      teamId: teamId === null ? null : TeamId.make(teamId),
      baseStatusId: null,
      name,
      color: "#3b82f6",
      category: name === "Todo" ? "unstarted" : "review",
      position,
      hidden: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const statuses = [
      status("status-todo", "Todo", null, 0),
      status("status-team-a-qa", "QA", "team-a", 1),
      status("status-team-b-qa", "QA", "team-b", 1),
    ];

    expect(
      effectiveIssueStatusesForOwnerFromReplica(statuses, {
        kind: "team",
        teamId: TeamId.make("team-b"),
      }).map(({ id }) => id),
    ).toEqual(["status-todo", "status-team-b-qa"]);
  });
});
