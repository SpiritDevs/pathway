import {
  IssueCycleId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueStatusId,
  ProjectId,
  type Issue,
  type IssueMilestone,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_CONTEXT_MENU_REMOVE_FIELDS,
  ISSUE_MENU_MIXED_VALUE,
  issueContextMenuCopyValue,
  issueContextMenuIssues,
  issueContextMenuLabel,
  issueContextMenuMilestones,
  issueContextMenuProjectId,
  issueContextMenuRemovable,
  issueContextMenuRemovePatch,
  issueDueDateQuickOptions,
  sharedIssueMenuValue,
} from "./issueContextMenu.logic";

const NOW = "2026-08-13T00:00:00.000Z";

function issue(id: string, overrides: Partial<Omit<Issue, "id">> = {}): Issue {
  return {
    id: IssueId.make(id),
    key: `PAT-${id}`,
    title: `Issue ${id}`,
    description: "",
    statusId: IssueStatusId.make("todo"),
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
    ...overrides,
  };
}

function milestone(id: string, projectId: string): IssueMilestone {
  return {
    id: IssueMilestoneId.make(id),
    projectId: ProjectId.make(projectId),
    name: `Milestone ${id}`,
    description: "",
    startDate: null,
    targetDate: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("issueContextMenuIssues", () => {
  it("targets the row under the pointer when it is outside the selection", () => {
    const clicked = issue("1");
    const targets = issueContextMenuIssues(clicked, [issue("2"), issue("3")]);
    expect(targets).toEqual([clicked]);
  });

  it("targets the whole selection when the row is part of it", () => {
    const clicked = issue("1");
    const selected = [clicked, issue("2")];
    expect(issueContextMenuIssues(clicked, selected)).toBe(selected);
  });

  it("targets the one row when it is the only thing selected", () => {
    const clicked = issue("1");
    expect(issueContextMenuIssues(clicked, [clicked])).toEqual([clicked]);
  });
});

describe("issueContextMenuLabel", () => {
  it("names the issue, or counts them", () => {
    expect(issueContextMenuLabel([issue("1")])).toBe("PAT-1");
    expect(issueContextMenuLabel([issue("1"), issue("2")])).toBe("2 issues");
    expect(issueContextMenuLabel([])).toBe("No issue");
  });
});

describe("sharedIssueMenuValue", () => {
  it("returns the shared value, and the mixed sentinel otherwise", () => {
    expect(sharedIssueMenuValue(["a", "a"])).toBe("a");
    expect(sharedIssueMenuValue(["a", "b"])).toBe(ISSUE_MENU_MIXED_VALUE);
    expect(sharedIssueMenuValue([])).toBe(ISSUE_MENU_MIXED_VALUE);
  });

  it("treats the empty string as a real shared value, not as mixed", () => {
    expect(sharedIssueMenuValue(["", ""])).toBe("");
  });
});

describe("issueContextMenuProjectId", () => {
  const alpha = ProjectId.make("alpha");

  it("returns the project every target shares", () => {
    expect(
      issueContextMenuProjectId([
        issue("1", { projectId: alpha }),
        issue("2", { projectId: alpha }),
      ]),
    ).toBe(alpha);
  });

  it("returns null when the targets disagree or have none", () => {
    expect(
      issueContextMenuProjectId([
        issue("1", { projectId: alpha }),
        issue("2", { projectId: ProjectId.make("beta") }),
      ]),
    ).toBe(null);
    expect(issueContextMenuProjectId([issue("1")])).toBe(null);
  });
});

describe("issueContextMenuMilestones", () => {
  it("offers only the milestones of the shared project", () => {
    const milestones = [milestone("m1", "alpha"), milestone("m2", "beta")];
    expect(issueContextMenuMilestones(milestones, ProjectId.make("alpha"))).toEqual([
      milestones[0],
    ]);
  });

  it("offers nothing without a shared project", () => {
    expect(issueContextMenuMilestones([milestone("m1", "alpha")], null)).toEqual([]);
  });
});

describe("issueDueDateQuickOptions", () => {
  it("counts forward from the day the view calls today", () => {
    expect(issueDueDateQuickOptions("2026-08-13").map((option) => option.value)).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-20",
      "2026-09-12",
    ]);
  });
});

describe("issueContextMenuCopyValue", () => {
  const issues = [issue("1"), issue("2", { title: "Second" })];

  it("copies one field per issue, one per line", () => {
    expect(issueContextMenuCopyValue(issues, "key", "https://pathway.test")).toBe("PAT-1\nPAT-2");
    expect(issueContextMenuCopyValue(issues, "title", "https://pathway.test")).toBe(
      "Issue 1\nSecond",
    );
  });

  it("builds absolute links, and markdown around them", () => {
    expect(issueContextMenuCopyValue([issues[0] as Issue], "url", "https://pathway.test/")).toBe(
      "https://pathway.test/issues?issue=PAT-1",
    );
    expect(
      issueContextMenuCopyValue([issues[0] as Issue], "markdown", "https://pathway.test"),
    ).toBe("[PAT-1 Issue 1](https://pathway.test/issues?issue=PAT-1)");
  });
});

describe("issueContextMenuRemovable", () => {
  it("offers a field while any target still carries it", () => {
    const carrying = issue("1", { cycleId: IssueCycleId.make("c1") });
    expect(issueContextMenuRemovable([carrying, issue("2")], "cycle")).toBe(true);
    expect(issueContextMenuRemovable([issue("2")], "cycle")).toBe(false);
  });

  it("offers nothing for a bare issue", () => {
    const bare = [issue("1")];
    for (const field of ISSUE_CONTEXT_MENU_REMOVE_FIELDS) {
      expect(issueContextMenuRemovable(bare, field)).toBe(false);
    }
  });

  it("reads labels as carried only while there is one", () => {
    expect(
      issueContextMenuRemovable([issue("1", { labelIds: [IssueLabelId.make("l1")] })], "labels"),
    ).toBe(true);
  });
});

describe("issueContextMenuRemovePatch", () => {
  it("clears the field it names, and nothing else", () => {
    expect(issueContextMenuRemovePatch("assignee")).toEqual({ assignee: null });
    expect(issueContextMenuRemovePatch("labels")).toEqual({ labelIds: [] });
    expect(issueContextMenuRemovePatch("dueDate")).toEqual({ dueDate: null });
  });

  it("covers every field the menu can offer", () => {
    for (const field of ISSUE_CONTEXT_MENU_REMOVE_FIELDS) {
      expect(Object.keys(issueContextMenuRemovePatch(field))).toHaveLength(1);
    }
  });
});
