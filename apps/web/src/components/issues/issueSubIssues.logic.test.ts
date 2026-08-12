import type { Issue, IssueId, IssueLabelId, IssueStatusId, ProjectId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { subIssueCreateInput } from "./issueSubIssues.logic";

function parent(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-parent" as IssueId,
    key: "ISS-1",
    title: "Parent",
    description: "",
    statusId: "status-backlog" as IssueStatusId,
    priority: "none",
    assignee: null,
    labelIds: [],
    projectId: "project-1" as ProjectId,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    dueDate: null,
    triage: false,
    sortOrder: "m",
    slackSource: null,
    deletedAt: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("subIssueCreateInput", () => {
  it("creates a child in the parent's project with the selected properties", () => {
    const assignee = { kind: "agent" as const, provider: ProviderDriverKind.make("codex") };
    const labelId = "label-1" as IssueLabelId;

    expect(
      subIssueCreateInput(parent(), {
        title: "  Verify editor behavior  ",
        description: "Keep **Markdown**",
        statusId: "status-started" as IssueStatusId,
        priority: "high",
        assignee,
        labelIds: [labelId],
      }),
    ).toEqual({
      title: "Verify editor behavior",
      description: "Keep **Markdown**",
      statusId: "status-started",
      priority: "high",
      assignee,
      projectId: "project-1",
      parentId: "issue-parent",
      labelIds: [labelId],
    });
  });

  it("omits empty optional fields and rejects a blank title", () => {
    expect(
      subIssueCreateInput(parent({ projectId: null }), {
        title: "Child",
        description: "",
        statusId: null,
        priority: "none",
        assignee: null,
        labelIds: [],
      }),
    ).toEqual({ title: "Child", parentId: "issue-parent" });

    expect(
      subIssueCreateInput(parent(), {
        title: "   ",
        description: "",
        statusId: null,
        priority: "none",
        assignee: null,
        labelIds: [],
      }),
    ).toBeNull();
  });
});
