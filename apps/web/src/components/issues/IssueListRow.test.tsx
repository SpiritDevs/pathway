import { IssueId, IssueStatusId, type Issue } from "@t3tools/contracts";
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

function renderRow(investigating: boolean) {
  return renderToStaticMarkup(
    <IssueListRow
      active={false}
      childRollup={null}
      investigating={investigating}
      issue={issue}
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
});
