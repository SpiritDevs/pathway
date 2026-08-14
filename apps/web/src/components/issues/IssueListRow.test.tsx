import { IssueId, IssueStatusId, ThreadId, type Issue } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssueListRow } from "./IssueListRow";

const NOW = "2026-08-13T00:00:00.000Z";

const issue: Issue = {
  id: IssueId.make("issue-1"),
  key: "PAT-1",
  title: "Investigate the missing stages",
  description: "",
  statusId: IssueStatusId.make("status-todo"),
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
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

function renderRow(investigating: boolean, rowIssue: Issue = issue) {
  return renderToStaticMarkup(
    <IssueListRow
      active={false}
      childRollup={null}
      investigating={investigating}
      issue={rowIssue}
      labels={[]}
      labelsById={new Map()}
      onOpen={() => {}}
      onPriority={() => {}}
      onRowClick={() => {}}
      onStatus={() => {}}
      onToggleLabel={() => {}}
      parentTitle={null}
      projectTitle="Pathway"
      selected={false}
      status={null}
      statuses={[]}
      today="2026-08-13"
    />,
  );
}

describe("IssueListRow investigation badge", () => {
  it("shows the labelled badge in the trailing metadata when investigation is active", () => {
    const html = renderRow(true);

    expect(html).toContain("Investigating");
    expect(html.indexOf("Investigating")).toBeGreaterThan(html.indexOf(issue.title));
    expect(html.indexOf("Investigating")).toBeLessThan(html.indexOf("Pathway"));
  });

  it("omits the badge when there is no active investigation", () => {
    expect(renderRow(false)).not.toContain("Investigating");
  });

  it("links the pull request from the trailing row metadata", () => {
    const html = renderRow(false, {
      ...issue,
      pullRequest: {
        threadId: ThreadId.make("thread-1"),
        provider: "github",
        number: 42,
        title: "Show PRs on issues",
        url: "https://github.com/t3dotgg/pathway/pull/42",
        state: "open",
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    expect(html).toContain("PR #42");
    expect(html).toContain('href="https://github.com/t3dotgg/pathway/pull/42"');
    expect(html.indexOf("PR #42")).toBeGreaterThan(html.indexOf(issue.title));
  });
});
