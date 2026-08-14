import { IssueId, IssueStatusId, type Issue } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssuesBulkBar } from "./IssuesBulkBar";

const issue: Issue = {
  id: IssueId.make("issue-1"),
  key: "ISS-32",
  title: "Show bulk issue actions",
  description: "",
  statusId: IssueStatusId.make("todo"),
  priority: "medium",
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
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  deletedAt: null,
};

describe("IssuesBulkBar", () => {
  it("keeps bulk investigation and exposes the selected issues to an icon-only AI action", () => {
    const html = renderToStaticMarkup(
      <IssuesBulkBar
        askDisabledReason="Connect a project"
        investigateDisabledReason="Connect a project"
        issues={[issue]}
        labels={[]}
        onAsk={() => {}}
        onClear={() => {}}
        onDelete={() => {}}
        onInvestigate={() => {}}
        onPriority={() => {}}
        onStatus={() => {}}
        onToggleLabel={() => {}}
        projects={[]}
        statuses={[]}
      />,
    );

    expect(html).toContain("Investigate");
    expect(html).toContain('aria-label="Ask AI about 1 selected issue"');
    expect(html).not.toContain("Discuss in project");
  });
});
