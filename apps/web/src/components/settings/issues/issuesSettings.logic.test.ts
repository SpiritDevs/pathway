import {
  IssueId,
  IssueLabelId,
  IssueStatusId,
  type Issue,
  type IssueStatus,
  type IssueStatusCategory,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_ISSUES_STORE, type IssuesStore } from "../../../state/issues";
import {
  countIssuesByLabel,
  countIssuesByStatus,
  duplicateNameError,
  issueKeyPrefixError,
  issueStatusDeletability,
  issueStatusReassignmentOptions,
  normalizeIssueKeyPrefix,
  reorderedIssueStatusIds,
} from "./issuesSettings.logic";

const NOW = "2026-08-12T00:00:00.000Z";

function status(id: string, category: IssueStatusCategory, position: number): IssueStatus {
  return {
    id: IssueStatusId.make(id),
    name: id,
    color: "#abcdef",
    category,
    position,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const BACKLOG = status("backlog", "backlog", 0);
const TODO = status("todo", "unstarted", 1);
const NEXT_UP = status("next-up", "unstarted", 2);
const DOING = status("doing", "started", 3);
const ALL_STATUSES = [BACKLOG, TODO, NEXT_UP, DOING];

function issue(id: string, overrides: Partial<Omit<Issue, "id">> = {}): Issue {
  return {
    id: IssueId.make(id),
    key: `PAT-${id}`,
    title: `Issue ${id}`,
    description: "",
    statusId: TODO.id,
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

function storeOf(issues: ReadonlyArray<Issue>): IssuesStore {
  return {
    ...EMPTY_ISSUES_STORE,
    issuesById: new Map(issues.map((value) => [value.id, value])),
    statuses: ALL_STATUSES,
  };
}

const BUG = IssueLabelId.make("bug");
const CHORE = IssueLabelId.make("chore");

describe("issueKeyPrefixError", () => {
  it("accepts what the contract's pattern accepts", () => {
    expect(issueKeyPrefixError("PAT")).toBe(null);
    expect(issueKeyPrefixError("  pat  ")).toBe(null);
    expect(issueKeyPrefixError("A")).toBe(null);
    expect(issueKeyPrefixError("T3X9")).toBe(null);
    expect(issueKeyPrefixError("ABCDEFGHIJ")).toBe(null);
  });

  it("rejects an empty prefix, an over-long one, and one that does not start with a letter", () => {
    expect(issueKeyPrefixError("")).toBe("Enter a prefix.");
    expect(issueKeyPrefixError("   ")).toBe("Enter a prefix.");
    expect(issueKeyPrefixError("ABCDEFGHIJK")).toBe("Use at most 10 characters.");
    expect(issueKeyPrefixError("1AB")).toBe("Start with a letter, then letters or digits only.");
    expect(issueKeyPrefixError("PA-T")).toBe("Start with a letter, then letters or digits only.");
    // A space inside survives the trim and is not a letter or a digit.
    expect(issueKeyPrefixError("PA T")).toBe("Start with a letter, then letters or digits only.");
  });

  it("normalizes to the stored form", () => {
    expect(normalizeIssueKeyPrefix(" pat ")).toBe("PAT");
  });
});

describe("issueStatusDeletability", () => {
  it("allows deleting a status with a sibling in its category", () => {
    expect(issueStatusDeletability(ALL_STATUSES, TODO.id)).toEqual({ canDelete: true });
    expect(issueStatusDeletability(ALL_STATUSES, DOING.id)).toEqual({ canDelete: true });
  });

  it("refuses the last unstarted status, since new issues land in one", () => {
    const withOneUnstarted = [BACKLOG, TODO, DOING];
    expect(issueStatusDeletability(withOneUnstarted, TODO.id)).toEqual({
      canDelete: false,
      reason: "This is the only Unstarted status, and new issues need one to land in.",
    });
    // The rule is about the category, not about being alone: the others still go.
    expect(issueStatusDeletability(withOneUnstarted, BACKLOG.id)).toEqual({ canDelete: true });
  });

  it("refuses the only status, which has nowhere to reassign to", () => {
    expect(issueStatusDeletability([DOING], DOING.id)).toEqual({
      canDelete: false,
      reason: "A tracker needs at least one status.",
    });
  });

  it("offers every status but the one going away", () => {
    expect(issueStatusReassignmentOptions(ALL_STATUSES, TODO.id).map((s) => s.id)).toEqual([
      "backlog",
      "next-up",
      "doing",
    ]);
  });
});

describe("reorderedIssueStatusIds", () => {
  it("moves the dragged status to the slot it was dropped on", () => {
    expect(
      reorderedIssueStatusIds({ statuses: ALL_STATUSES, activeId: "doing", overId: "backlog" }),
    ).toEqual(["doing", "backlog", "todo", "next-up"]);
    expect(
      reorderedIssueStatusIds({ statuses: ALL_STATUSES, activeId: "backlog", overId: "doing" }),
    ).toEqual(["todo", "next-up", "doing", "backlog"]);
  });

  it("returns null when the drop changed nothing", () => {
    expect(
      reorderedIssueStatusIds({ statuses: ALL_STATUSES, activeId: "todo", overId: "todo" }),
    ).toBe(null);
    expect(
      reorderedIssueStatusIds({ statuses: ALL_STATUSES, activeId: "todo", overId: "gone" }),
    ).toBe(null);
  });
});

describe("counts", () => {
  it("counts live issues per status and per label", () => {
    const store = storeOf([
      issue("1", { labelIds: [BUG] }),
      issue("2", { statusId: DOING.id, labelIds: [BUG, CHORE] }),
      issue("3", { statusId: DOING.id, deletedAt: NOW, labelIds: [BUG] }),
    ]);

    expect(countIssuesByStatus(store)).toEqual(
      new Map([
        ["todo", 1],
        ["doing", 1],
      ]),
    );
    expect(countIssuesByLabel(store)).toEqual(
      new Map([
        [BUG, 2],
        [CHORE, 1],
      ]),
    );
  });

  it("counts a triage issue, which still wears its labels", () => {
    const store = storeOf([issue("1", { triage: true, labelIds: [BUG] })]);
    expect(countIssuesByLabel(store).get(BUG)).toBe(1);
  });
});

describe("duplicateNameError", () => {
  const existing = [
    { id: "a", name: "Bug" },
    { id: "b", name: "Chore" },
  ];

  it("rejects a clash regardless of case, and an empty name", () => {
    expect(duplicateNameError(existing, "bug")).toBe("bug already exists.");
    expect(duplicateNameError(existing, "  ")).toBe("Enter a name.");
  });

  it("lets a row keep its own name while renaming", () => {
    expect(duplicateNameError(existing, "Bug", "a")).toBe(null);
    expect(duplicateNameError(existing, "Bug", "b")).toBe("Bug already exists.");
  });
});
