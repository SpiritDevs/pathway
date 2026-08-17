import {
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueStatusId,
  ProjectId,
  type Issue,
  type IssueMilestone,
  type IssueStatus,
  type IssueStatusCategory,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_ISSUES_STORE, type IssuesStore } from "../../../state/issues";
import {
  ISSUE_STATUS_CATEGORY_OPTIONS,
  countIssuesByLabel,
  countIssuesByStatus,
  duplicateNameError,
  issueKeyPrefixError,
  issueMilestoneCreateInput,
  issueMilestoneDateEdit,
  issueMilestoneDatesError,
  issueMilestoneDraftError,
  issueStatusDeletability,
  issueStatusReassignmentOptions,
  normalizeIssueKeyPrefix,
  reorderedIssueMilestoneIds,
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

describe("ISSUE_STATUS_CATEGORY_OPTIONS", () => {
  it("keeps review between active implementation and completion", () => {
    expect(ISSUE_STATUS_CATEGORY_OPTIONS.map((option) => option.category)).toEqual([
      "backlog",
      "unstarted",
      "started",
      "review",
      "completed",
      "canceled",
    ]);
  });
});

describe("issueKeyPrefixError", () => {
  it("accepts what the contract's pattern accepts", () => {
    expect(issueKeyPrefixError("PAT")).toBe(null);
    expect(issueKeyPrefixError("  pat  ")).toBe(null);
    expect(issueKeyPrefixError("A")).toBe(null);
    expect(issueKeyPrefixError("PathwayX9")).toBe(null);
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

const ALPHA = ProjectId.make("alpha");

function milestone(id: string, dates: Partial<IssueMilestone> = {}): IssueMilestone {
  return {
    id: IssueMilestoneId.make(id),
    projectId: ALPHA,
    name: id,
    description: null,
    startDate: null,
    targetDate: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...dates,
  };
}

describe("reorderedIssueMilestoneIds", () => {
  const milestones = [milestone("beta"), milestone("v1"), milestone("v2")];

  it("moves the dragged milestone to the slot it was dropped on", () => {
    expect(reorderedIssueMilestoneIds({ milestones, activeId: "v2", overId: "beta" })).toEqual([
      "v2",
      "beta",
      "v1",
    ]);
  });

  it("returns null when the drop changed nothing", () => {
    expect(reorderedIssueMilestoneIds({ milestones, activeId: "v1", overId: "v1" })).toBe(null);
    // A milestone from another project's group is not in this list, so its drop is not an order.
    expect(reorderedIssueMilestoneIds({ milestones, activeId: "v1", overId: "elsewhere" })).toBe(
      null,
    );
  });
});

describe("issueMilestoneDatesError", () => {
  it("refuses a milestone that ends before it starts", () => {
    expect(issueMilestoneDatesError("2026-09-01", "2026-08-01")).toBe(
      "A milestone cannot start after its target date.",
    );
  });

  it("accepts a single day, a forward range, and a half-dated milestone", () => {
    expect(issueMilestoneDatesError("2026-08-01", "2026-08-01")).toBe(null);
    expect(issueMilestoneDatesError("2026-08-01", "2026-09-01")).toBe(null);
    expect(issueMilestoneDatesError(null, "2026-08-01")).toBe(null);
    expect(issueMilestoneDatesError("2026-08-01", null)).toBe(null);
  });
});

describe("issueMilestoneDateEdit", () => {
  const dated = milestone("v1", { startDate: "2026-08-01", targetDate: "2026-09-01" });

  it("patches one end of the range", () => {
    expect(issueMilestoneDateEdit(dated, "targetDate", "2026-10-01")).toEqual({
      kind: "patch",
      patch: { targetDate: "2026-10-01" },
    });
    expect(issueMilestoneDateEdit(dated, "startDate", "2026-07-01")).toEqual({
      kind: "patch",
      patch: { startDate: "2026-07-01" },
    });
  });

  it("clears a date when the field is emptied", () => {
    expect(issueMilestoneDateEdit(dated, "startDate", "")).toEqual({
      kind: "patch",
      patch: { startDate: null },
    });
    expect(issueMilestoneDateEdit(milestone("v2"), "startDate", "")).toEqual({ kind: "unchanged" });
  });

  it("leaves a half-typed day and an unmoved one alone", () => {
    expect(issueMilestoneDateEdit(dated, "startDate", "0002-08")).toEqual({ kind: "unchanged" });
    expect(issueMilestoneDateEdit(dated, "startDate", "2026-08-01")).toEqual({ kind: "unchanged" });
  });

  it("refuses an edit that would invert the range, against the other end as it stands", () => {
    expect(issueMilestoneDateEdit(dated, "startDate", "2026-10-01")).toEqual({
      kind: "invalid",
      error: "A milestone cannot start after its target date.",
    });
    expect(issueMilestoneDateEdit(dated, "targetDate", "2026-07-01")).toEqual({
      kind: "invalid",
      error: "A milestone cannot start after its target date.",
    });
    // Clearing the other end first makes the same edit fine.
    expect(issueMilestoneDateEdit(milestone("v2"), "startDate", "2026-10-01")).toEqual({
      kind: "patch",
      patch: { startDate: "2026-10-01" },
    });
  });
});

describe("issueMilestoneDraftError", () => {
  const existing = [{ id: "v1", name: "v1" }];

  it("accepts a named milestone with no dates, one date, or a forward range", () => {
    expect(issueMilestoneDraftError({ name: "v2", startDate: "", targetDate: "" }, existing)).toBe(
      null,
    );
    expect(
      issueMilestoneDraftError({ name: "v2", startDate: "", targetDate: "2026-09-01" }, existing),
    ).toBe(null);
    expect(
      issueMilestoneDraftError(
        { name: "v2", startDate: "2026-08-01", targetDate: "2026-09-01" },
        existing,
      ),
    ).toBe(null);
  });

  it("rejects a name the project already uses, but not one another project uses", () => {
    expect(issueMilestoneDraftError({ name: "V1", startDate: "", targetDate: "" }, existing)).toBe(
      "V1 already exists.",
    );
    expect(issueMilestoneDraftError({ name: "V1", startDate: "", targetDate: "" }, [])).toBe(null);
    expect(issueMilestoneDraftError({ name: "  ", startDate: "", targetDate: "" }, existing)).toBe(
      "Enter a name.",
    );
  });

  it("rejects a half-typed day and a backwards range", () => {
    expect(
      issueMilestoneDraftError({ name: "v2", startDate: "0002-0", targetDate: "" }, existing),
    ).toBe("Pick a whole start date.");
    expect(
      issueMilestoneDraftError({ name: "v2", startDate: "", targetDate: "0002-0" }, existing),
    ).toBe("Pick a whole target date.");
    expect(
      issueMilestoneDraftError(
        { name: "v2", startDate: "2026-09-01", targetDate: "2026-08-01" },
        existing,
      ),
    ).toBe("A milestone cannot start after its target date.");
  });
});

describe("issueMilestoneCreateInput", () => {
  it("trims the name and sends only the dates that were filled in", () => {
    expect(
      issueMilestoneCreateInput(ALPHA, { name: "  v2  ", startDate: "", targetDate: "" }),
    ).toEqual({ projectId: ALPHA, name: "v2" });
    expect(
      issueMilestoneCreateInput(ALPHA, {
        name: "v2",
        startDate: "2026-08-01",
        targetDate: "2026-09-01",
      }),
    ).toEqual({
      projectId: ALPHA,
      name: "v2",
      startDate: "2026-08-01",
      targetDate: "2026-09-01",
    });
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
