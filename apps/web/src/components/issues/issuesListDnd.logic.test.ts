import {
  IssueId,
  IssueStatusId,
  type Issue,
  type IssueStatus,
  type IssueStatusCategory,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { IssuesGrouping } from "~/state/issues";
import { buildIssuesView, NO_ISSUES_LIST_FILTER, type IssuesView } from "./issuesList.logic";
import {
  isIssuesListSortable,
  issuesListDropEdge,
  issuesListGroupDropId,
  issuesListRowDragId,
  resolveIssuesListDrop,
} from "./issuesListDnd.logic";

const NOW = "2026-08-15T00:00:00.000Z";

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

const TODO = status("todo", "unstarted", 0);
const DOING = status("doing", "started", 1);

function issue(id: string, overrides: Partial<Omit<Issue, "id">> = {}): Issue {
  return {
    id: IssueId.make(id),
    key: `ISS-${id}`,
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

function view(
  groups: ReadonlyArray<[IssueStatus, ReadonlyArray<Issue>]>,
  sortMode: "manual" | "priority" = "manual",
): IssuesView {
  const grouping: IssuesGrouping = {
    groups: groups.map(([groupStatus, issues]) => ({ status: groupStatus, issues })),
    total: groups.reduce((total, [, issues]) => total + issues.length, 0),
  };
  return buildIssuesView({
    grouping,
    filter: NO_ISSUES_LIST_FILTER,
    today: "2026-08-15",
    groupBy: "status",
    sortMode,
  });
}

function expectBetween(key: string | undefined, before: string | null, after: string | null) {
  expect(key).toBeTypeOf("string");
  if (key === undefined) return;
  if (before !== null) expect(key > before).toBe(true);
  if (after !== null) expect(key < after).toBe(true);
}

describe("issues list drag", () => {
  const A = issue("a", { sortOrder: "b", priority: "urgent" });
  const B = issue("b", { sortOrder: "m", priority: "none" });
  const C = issue("c", { sortOrder: "t", priority: "high" });
  const D = issue("d", { statusId: DOING.id, sortOrder: "d", priority: "low" });
  const E = issue("e", { statusId: DOING.id, sortOrder: "s", priority: "medium" });
  const VIEW = view([
    [TODO, [A, B, C]],
    [DOING, [D, E]],
  ]);
  const row = (id: string) => issuesListRowDragId(IssueId.make(id));
  const group = (id: string) => issuesListGroupDropId(IssueStatusId.make(id));
  const drop = (active: string, over: string, edge: "before" | "after" = "before") =>
    resolveIssuesListDrop({ view: VIEW, activeId: row(active), overId: over, edge });

  it("uses the hovered row edge for exact moves in either direction", () => {
    expectBetween(drop("a", row("c"), "before")?.sortOrder, B.sortOrder, C.sortOrder);
    expectBetween(drop("a", row("c"), "after")?.sortOrder, C.sortOrder, null);
    expectBetween(drop("c", row("a"), "after")?.sortOrder, A.sortOrder, B.sortOrder);
  });

  it("changes status and position together without changing priority", () => {
    const result = drop("a", row("e"), "before");
    expect(result?.statusId).toBe(DOING.id);
    expectBetween(result?.sortOrder, D.sortOrder, E.sortOrder);
    expect(A.priority).toBe("urgent");
  });

  it("drops at the start of an empty or populated status through its header", () => {
    expectBetween(drop("c", group("todo"))?.sortOrder, null, A.sortOrder);
    expectBetween(drop("a", group("doing"))?.sortOrder, null, D.sortOrder);
  });

  it("does not write when the row stays in its current slot", () => {
    expect(drop("b", row("a"), "after")).toBeNull();
    expect(drop("b", row("c"), "before")).toBeNull();
    expect(drop("a", group("todo"))).toBeNull();
    expect(drop("a", row("a"))).toBeNull();
  });

  it("only enables the gesture for manual status ordering", () => {
    expect(isIssuesListSortable(VIEW)).toBe(true);
    expect(isIssuesListSortable(view([[TODO, [A, B, C]]], "priority"))).toBe(false);
    expect(isIssuesListSortable({ ...VIEW, grouping: "priority", sortMode: "manual" })).toBe(false);
  });

  it("reads the pointer edge from the dragged row centre", () => {
    expect(issuesListDropEdge({ activeCenterY: 10, overTop: 0, overHeight: 30 })).toBe("before");
    expect(issuesListDropEdge({ activeCenterY: 20, overTop: 0, overHeight: 30 })).toBe("after");
  });
});
