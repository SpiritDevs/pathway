import {
  IssueCycleId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueStatusId,
  ProjectId,
  ProviderDriverKind,
  type Issue,
  type IssueLabel,
  type IssueStatus,
  type IssueStatusCategory,
} from "@spiritdevs/contracts";
import { MembershipId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_ISSUES_STORE, type IssuesGrouping, type IssuesStore } from "~/state/issues";
import {
  EMPTY_ISSUES_SELECTION,
  activateIssueRow,
  ISSUE_ASSIGNEE_USER_VALUE,
  NO_ISSUES_LIST_FILTER,
  activeIssuesFilterFields,
  addIssueDays,
  applyIssuesFilter,
  buildIssuesListRows,
  buildIssuesView,
  countIssuesByCycle,
  effectiveIssueSortMode,
  effectiveIssuesGrouping,
  filterIssuesFilterOptions,
  formatIssueDateRange,
  findIssueRowIndex,
  formatIssueDueDate,
  indexIssueLabels,
  isIssueDueDatePast,
  isIssuesListFilterActive,
  issueAssigneeValue,
  issueIdsInRows,
  issueLabelSelectionState,
  issueRangeIds,
  resolveIssuesFilterUserAssignee,
  issueSelectModeForModifiers,
  issueSortModeHint,
  issuesFilterHasValue,
  issuesFilterSearchPatch,
  issuesFilterValueLabels,
  issuesFilterValues,
  issuesSearchFilter,
  issuesSearchGrouping,
  issuesSearchSortMode,
  issuesSearchViewMode,
  matchesIssuesFilter,
  parseIssuesSearch,
  pruneIssuesSelection,
  resolveIssueRowLabels,
  resolveIssuesListKeyAction,
  selectIssueRow,
  soleIssuesFilterValue,
  summarizeIssuesFilterValues,
  toggleIssueLabelIds,
  toggleIssuesFilterValue,
  withIssuesFilterValues,
  type IssuesListFilter,
  type IssuesSearch,
  type IssuesSearchPatch,
  type IssuesSelection,
  type IssuesView,
} from "./issuesList.logic";

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

const TODO = status("todo", "unstarted", 0);
const DOING = status("doing", "started", 1);

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

function label(id: string, name = id): IssueLabel {
  return { id: IssueLabelId.make(id), name, color: "#ff0000", createdAt: NOW };
}

function grouping(groups: ReadonlyArray<[IssueStatus, ReadonlyArray<Issue>]>): IssuesGrouping {
  return {
    groups: groups.map(([groupStatus, issues]) => ({ status: groupStatus, issues })),
    total: groups.reduce((count, [, issues]) => count + issues.length, 0),
  };
}

const TODAY = "2026-08-12";

/** The stage-2 shape of the view: grouped by status, manual order, nothing filtered out. */
function statusView(
  groups: ReadonlyArray<[IssueStatus, ReadonlyArray<Issue>]>,
  filter: IssuesListFilter = NO_ISSUES_LIST_FILTER,
): IssuesView {
  return buildIssuesView({
    grouping: grouping(groups),
    filter,
    today: TODAY,
    groupBy: "status",
    sortMode: "manual",
  });
}

const NO_COLLAPSED = new Set<string>();

function store(issues: ReadonlyArray<Issue>): IssuesStore {
  return { ...EMPTY_ISSUES_STORE, issuesById: new Map(issues.map((row) => [row.id, row])) };
}

describe("parseIssuesSearch", () => {
  it("keeps a bare route free of query params", () => {
    expect(parseIssuesSearch({})).toEqual({
      tab: undefined,
      triage: undefined,
      issue: undefined,
      status: undefined,
      project: undefined,
      milestone: undefined,
      cycle: undefined,
      label: undefined,
      assignee: undefined,
      priority: undefined,
      due: undefined,
      group: undefined,
      sort: undefined,
      view: undefined,
    });
  });

  it("reads the tab, the issue key, and every filter", () => {
    expect(
      parseIssuesSearch({
        tab: "backlog",
        issue: "PAT-221",
        status: "s1,s2",
        project: "p1",
        milestone: "m1",
        cycle: "c1",
        label: "l1,l2",
        assignee: "user,agent:codex",
        priority: "urgent,low",
        due: "overdue",
        group: "project",
        sort: "updated",
        view: "board",
      }),
    ).toEqual({
      tab: "backlog",
      triage: undefined,
      issue: "PAT-221",
      status: "s1,s2",
      project: "p1",
      milestone: "m1",
      cycle: "c1",
      label: "l1,l2",
      assignee: "user,agent:codex",
      priority: "urgent,low",
      due: "overdue",
      group: "project",
      sort: "updated",
      view: "board",
    });
  });

  it("drops junk rather than rendering a tab nobody has", () => {
    expect(parseIssuesSearch({ tab: "done", issue: 12, project: "" }).tab).toBeUndefined();
    expect(parseIssuesSearch({ issue: 12 }).issue).toBeUndefined();
    expect(parseIssuesSearch({ project: "" }).project).toBeUndefined();
    expect(parseIssuesSearch({ group: "colour", sort: "loudest" })).toMatchObject({
      group: undefined,
      sort: undefined,
    });
  });

  it("reads triage as a mode, and writes the default as an absent param", () => {
    // A link a person pastes carries the string; the router hands back the boolean.
    expect(parseIssuesSearch({ triage: "true" }).triage).toBe(true);
    expect(parseIssuesSearch({ triage: true }).triage).toBe(true);
    expect(parseIssuesSearch({ triage: "false" }).triage).toBeUndefined();
    expect(parseIssuesSearch({ triage: 1 }).triage).toBeUndefined();
  });

  it("canonicalises a hand-edited list param", () => {
    expect(parseIssuesSearch({ label: " a , ,b, a " }).label).toBe("a,b");
    expect(parseIssuesSearch({ priority: "urgent,nonsense,low" }).priority).toBe("urgent,low");
    expect(
      parseIssuesSearch({ assignee: "user,agent:,member:,nobody,member:m1,agent:codex" }).assignee,
    ).toBe("user,member:m1,agent:codex");
    expect(parseIssuesSearch({ due: "someday" }).due).toBeUndefined();
  });

  it("still honours stage 2's ?mine=true as the human's assignee", () => {
    expect(parseIssuesSearch({ mine: "true" }).assignee).toBe(ISSUE_ASSIGNEE_USER_VALUE);
    // An explicit assignee wins: the two cannot disagree unless the URL was hand-edited.
    expect(parseIssuesSearch({ mine: true, assignee: "agent:codex" }).assignee).toBe("agent:codex");
  });

  it("falls back to status grouping, manual order, and the list", () => {
    expect(issuesSearchGrouping(parseIssuesSearch({}))).toBe("status");
    expect(issuesSearchSortMode(parseIssuesSearch({}))).toBe("manual");
    expect(issuesSearchViewMode(parseIssuesSearch({}))).toBe("list");
    expect(issuesSearchGrouping(parseIssuesSearch({ group: "assignee" }))).toBe("assignee");
    expect(issuesSearchSortMode(parseIssuesSearch({ sort: "created" }))).toBe("created");
    expect(issuesSearchViewMode(parseIssuesSearch({ view: "board" }))).toBe("board");
    expect(issuesSearchViewMode(parseIssuesSearch({ view: "kanban" }))).toBe("list");
  });

  it("holds the board to status grouping, whatever the list left in the URL", () => {
    expect(effectiveIssuesGrouping("project", "board")).toBe("status");
    expect(effectiveIssuesGrouping("project", "list")).toBe("project");
    // Which is also what keeps manual order honoured on the board: it is the status grouping.
    expect(effectiveIssueSortMode("manual", effectiveIssuesGrouping("project", "board"))).toBe(
      "manual",
    );
  });

  it("round-trips a filter through the params", () => {
    const filter: IssuesListFilter = {
      statusIds: ["s1"],
      projectIds: ["p1", "p2"],
      labelIds: ["l1"],
      milestoneIds: [],
      cycleIds: ["c1"],
      assignees: [ISSUE_ASSIGNEE_USER_VALUE],
      priorities: ["urgent"],
      dueFilter: "week",
    };
    const patch = issuesFilterSearchPatch(filter);
    expect(patch.project).toBe("p1,p2");
    expect(patch.milestone).toBeUndefined();
    expect(issuesSearchFilter(parseIssuesSearch({ ...patch }))).toEqual(filter);
  });
});

describe("the filter model", () => {
  it("reports the active fields in chip order", () => {
    const filter = withIssuesFilterValues(
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "priority", ["urgent"]),
      "label",
      ["l1"],
    );
    expect(activeIssuesFilterFields(filter)).toEqual(["label", "priority"]);
    expect(isIssuesListFilterActive(NO_ISSUES_LIST_FILTER)).toBe(false);
    expect(isIssuesListFilterActive(filter)).toBe(true);
  });

  it("toggles a value inside a field without touching the others", () => {
    const one = toggleIssuesFilterValue(NO_ISSUES_LIST_FILTER, "label", "l1");
    const two = toggleIssuesFilterValue(one, "label", "l2");
    const withProject = toggleIssuesFilterValue(two, "project", "p1");
    expect(issuesFilterValues(withProject, "label")).toEqual(["l1", "l2"]);
    expect(
      issuesFilterValues(toggleIssuesFilterValue(withProject, "label", "l1"), "label"),
    ).toEqual(["l2"]);
    expect(issuesFilterValues(withProject, "project")).toEqual(["p1"]);
  });

  it("keeps the due filter a single value, and toggling the same one clears it", () => {
    const overdue = toggleIssuesFilterValue(NO_ISSUES_LIST_FILTER, "due", "overdue");
    expect(overdue.dueFilter).toBe("overdue");
    expect(toggleIssuesFilterValue(overdue, "due", "week").dueFilter).toBe("overdue");
    expect(toggleIssuesFilterValue(overdue, "due", "overdue").dueFilter).toBeNull();
    expect(withIssuesFilterValues(overdue, "due", ["nonsense"]).dueFilter).toBeNull();
  });

  it("drops values a closed field cannot hold", () => {
    expect(withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "priority", ["urgent", "later"])).toEqual({
      ...NO_ISSUES_LIST_FILTER,
      priorities: ["urgent"],
    });
    expect(
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "assignee", ["user", "agent:", "someone"]),
    ).toEqual({ ...NO_ISSUES_LIST_FILTER, assignees: ["user"] });
  });

  it("deduplicates rather than stacking the same value twice", () => {
    expect(
      issuesFilterValues(
        withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "label", ["a", "a", "b"]),
        "label",
      ),
    ).toEqual(["a", "b"]);
  });

  it("sets one field from a sidebar click and leaves every other chip standing", () => {
    const start = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "label", ["l1", "l2"]);
    const next = applyIssuesFilter(start, "project", "p1");
    expect(issuesFilterValues(next, "project")).toEqual(["p1"]);
    expect(issuesFilterValues(next, "label")).toEqual(["l1", "l2"]);
    expect(issuesFilterHasValue(next, "project", "p1")).toBe(true);
    expect(issuesFilterHasValue(next, "project", "p2")).toBe(false);
    // A second click replaces its own field rather than adding to it.
    expect(issuesFilterValues(applyIssuesFilter(next, "project", "p2"), "project")).toEqual(["p2"]);
    expect(issuesFilterValues(applyIssuesFilter(next, "project", null), "project")).toEqual([]);
  });

  it("only names a default when a field holds exactly one value", () => {
    const one = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "project", ["p1"]);
    expect(soleIssuesFilterValue(one, "project")).toBe("p1");
    expect(
      soleIssuesFilterValue(withIssuesFilterValues(one, "project", ["p1", "p2"]), "project"),
    ).toBeNull();
    expect(soleIssuesFilterValue(NO_ISSUES_LIST_FILTER, "project")).toBeNull();
  });

  /**
   * The sidebar and the chip bar write the same params through the same patch, so a filter is one
   * question however it was asked. They differ in one deliberate way: a sidebar row *is* its
   * field's value, where a chip's checkbox ORs into it.
   */
  describe("against the chip bar", () => {
    /** Both surfaces navigate the same way: patch merged over the params, then re-validated. */
    const navigate = (current: IssuesSearch | Record<string, unknown>, patch: IssuesSearchPatch) =>
      parseIssuesSearch({ ...current, ...patch });

    it("reaches the same params from a sidebar row and a chip on an empty field", () => {
      const start = parseIssuesSearch({ label: "bug" });
      const filter = issuesSearchFilter(start);
      const sidebar = navigate(
        start,
        issuesFilterSearchPatch(applyIssuesFilter(filter, "project", "p1")),
      );
      const chip = navigate(
        start,
        issuesFilterSearchPatch(toggleIssuesFilterValue(filter, "project", "p1")),
      );
      expect(sidebar).toEqual(chip);
      // Neither one clears the chip that was already up.
      expect(issuesSearchFilter(sidebar).labelIds).toEqual(["bug"]);
    });

    it("replaces where a chip widens, once the field already holds something", () => {
      const start = parseIssuesSearch({ project: "p1" });
      const filter = issuesSearchFilter(start);
      const patchFor = (next: IssuesListFilter) =>
        issuesSearchFilter(navigate(start, issuesFilterSearchPatch(next))).projectIds;
      expect(patchFor(applyIssuesFilter(filter, "project", "p2"))).toEqual(["p2"]);
      expect(patchFor(toggleIssuesFilterValue(filter, "project", "p2"))).toEqual(["p1", "p2"]);
    });

    it("survives the URL with several values in one chip", () => {
      const many = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "cycle", ["c1", "c2", "c3"]);
      expect(issuesSearchFilter(navigate({}, issuesFilterSearchPatch(many))).cycleIds).toEqual([
        "c1",
        "c2",
        "c3",
      ]);
    });
  });
});

describe("matchesIssuesFilter", () => {
  const project = ProjectId.make("p1");
  const bug = IssueLabelId.make("bug");
  const chore = IssueLabelId.make("chore");

  it("ORs inside a field", () => {
    const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "priority", ["urgent", "high"]);
    expect(matchesIssuesFilter(issue("1", { priority: "high" }), filter, TODAY)).toBe(true);
    expect(matchesIssuesFilter(issue("2", { priority: "low" }), filter, TODAY)).toBe(false);
  });

  it("ANDs across fields", () => {
    const filter = withIssuesFilterValues(
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "project", [project]),
      "label",
      [bug],
    );
    expect(
      matchesIssuesFilter(issue("1", { projectId: project, labelIds: [bug] }), filter, TODAY),
    ).toBe(true);
    expect(matchesIssuesFilter(issue("2", { projectId: project }), filter, TODAY)).toBe(false);
    expect(matchesIssuesFilter(issue("3", { labelIds: [bug] }), filter, TODAY)).toBe(false);
  });

  it("matches an issue carrying any one of the chip's labels", () => {
    const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "label", [bug]);
    expect(matchesIssuesFilter(issue("1", { labelIds: [chore, bug] }), filter, TODAY)).toBe(true);
    expect(matchesIssuesFilter(issue("2", { labelIds: [chore] }), filter, TODAY)).toBe(false);
  });

  it("never matches an empty field against an issue that has none", () => {
    const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "milestone", ["m1"]);
    expect(matchesIssuesFilter(issue("1", { milestoneId: null }), filter, TODAY)).toBe(false);
  });

  it("names an assignee the way the URL spells it", () => {
    const codex = ProviderDriverKind.make("codex");
    const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "assignee", [
      ISSUE_ASSIGNEE_USER_VALUE,
      "agent:codex",
    ]);
    expect(matchesIssuesFilter(issue("1", { assignee: { kind: "user" } }), filter, TODAY)).toBe(
      true,
    );
    expect(
      matchesIssuesFilter(
        issue("2", { assignee: { kind: "agent", provider: codex } }),
        filter,
        TODAY,
      ),
    ).toBe(true);
    expect(matchesIssuesFilter(issue("3"), filter, TODAY)).toBe(false);
  });

  it("tells two company members apart in an assignee chip", () => {
    const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "assignee", [
      "member:membership-a",
    ]);
    const mine = issue("1", {
      assignee: { kind: "member", membershipId: MembershipId.make("membership-a") },
    });
    const theirs = issue("2", {
      assignee: { kind: "member", membershipId: MembershipId.make("membership-b") },
    });
    expect(issueAssigneeValue(mine.assignee)).toBe("member:membership-a");
    expect(matchesIssuesFilter(mine, filter, TODAY)).toBe(true);
    // Without the membership in the token every teammate would answer to every teammate's chip.
    expect(matchesIssuesFilter(theirs, filter, TODAY)).toBe(false);
  });

  it("maps the legacy user filter to the signed-in member in replica mode", () => {
    const legacy = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "assignee", ["user"]);
    const resolved = resolveIssuesFilterUserAssignee(legacy, "membership-a");
    expect(resolved.assignees).toEqual(["member:membership-a"]);
    expect(
      matchesIssuesFilter(
        issue("mine", {
          assignee: { kind: "member", membershipId: MembershipId.make("membership-a") },
        }),
        resolved,
        TODAY,
      ),
    ).toBe(true);
  });

  it("buckets due dates around today", () => {
    const rows = {
      late: issue("late", { dueDate: "2026-08-11" }),
      today: issue("today", { dueDate: TODAY }),
      soon: issue("soon", { dueDate: "2026-08-19" }),
      month: issue("month", { dueDate: "2026-09-05" }),
      far: issue("far", { dueDate: "2026-12-01" }),
      never: issue("never"),
    };
    const matching = (due: string) => {
      const filter = withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "due", [due]);
      return Object.entries(rows)
        .filter(([, row]) => matchesIssuesFilter(row, filter, TODAY))
        .map(([name]) => name);
    };

    expect(matching("overdue")).toEqual(["late"]);
    // The window is forward-looking: overdue is its own bucket rather than part of both others.
    expect(matching("week")).toEqual(["today", "soon"]);
    expect(matching("month")).toEqual(["today", "soon", "month"]);
    expect(matching("none")).toEqual(["never"]);
  });

  it("adds days across a month boundary", () => {
    expect(addIssueDays("2026-08-28", 7)).toBe("2026-09-04");
    expect(addIssueDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addIssueDays("nonsense", 7)).toBe("nonsense");
  });
});

describe("buildIssuesView", () => {
  it("keeps a status header standing after its last matching issue is filtered out", () => {
    const project = ProjectId.make("project-1");
    const view = statusView(
      [
        [TODO, [issue("1", { projectId: project }), issue("2")]],
        [DOING, [issue("3")]],
      ],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "project", [project]),
    );

    expect(view.groups).toHaveLength(2);
    expect(view.groups[1]?.issues).toEqual([]);
    expect(view.total).toBe(1);
  });

  it("groups by priority, most urgent first, dropping the empty buckets", () => {
    const view = buildIssuesView({
      grouping: grouping([
        [TODO, [issue("1", { priority: "low" }), issue("2", { priority: "urgent" })]],
        [DOING, [issue("3", { priority: "low" })]],
      ]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "priority",
      sortMode: "manual",
    });

    expect(view.groups.map((group) => group.id)).toEqual(["priority:urgent", "priority:low"]);
    expect(view.groups[1]?.issues.map((row) => row.id)).toEqual(["1", "3"]);
    expect(view.groups[0]?.priority).toBe("urgent");
    expect(view.total).toBe(3);
  });

  it("groups by project alphabetically, with the unowned issues last", () => {
    const alpha = ProjectId.make("p-alpha");
    const zulu = ProjectId.make("p-zulu");
    const view = buildIssuesView({
      grouping: grouping([
        [TODO, [issue("1", { projectId: zulu }), issue("2"), issue("3", { projectId: alpha })]],
      ]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "project",
      sortMode: "manual",
      projectTitles: new Map([
        [alpha as string, "Alpha"],
        [zulu as string, "Zulu"],
      ]),
    });

    expect(view.groups.map((group) => group.label)).toEqual(["Alpha", "Zulu", "No project"]);
    expect(view.groups.map((group) => group.id)).toEqual([
      `project:${alpha}`,
      `project:${zulu}`,
      "project:none",
    ]);
  });

  it("falls back to the raw id when a project title is unknown", () => {
    const gone = ProjectId.make("p-gone");
    const view = buildIssuesView({
      grouping: grouping([[TODO, [issue("1", { projectId: gone })]]]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "project",
      sortMode: "manual",
    });
    expect(view.groups[0]?.label).toBe("p-gone");
  });

  it("groups by assignee with the human first and nobody last", () => {
    const codex = ProviderDriverKind.make("codex");
    const view = buildIssuesView({
      grouping: grouping([
        [
          TODO,
          [
            issue("1"),
            issue("2", { assignee: { kind: "agent", provider: codex } }),
            issue("3", { assignee: { kind: "user" } }),
          ],
        ],
      ]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "assignee",
      sortMode: "manual",
      assigneeLabels: new Map([["agent:codex", "Codex"]]),
    });

    expect(view.groups.map((group) => group.label)).toEqual(["You", "Codex", "Unassigned"]);
    expect(view.groups.map((group) => group.id)).toEqual([
      "assignee:user",
      "assignee:agent:codex",
      "assignee:none",
    ]);
  });

  it("gives every company member their own assignee group, ahead of the agents", () => {
    const codex = ProviderDriverKind.make("codex");
    const view = buildIssuesView({
      grouping: grouping([
        [
          TODO,
          [
            issue("1"),
            issue("2", { assignee: { kind: "agent", provider: codex } }),
            issue("3", { assignee: { kind: "user" } }),
            issue("4", {
              assignee: { kind: "member", membershipId: MembershipId.make("membership-b") },
            }),
            issue("5", {
              assignee: { kind: "member", membershipId: MembershipId.make("membership-a") },
            }),
          ],
        ],
      ]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "assignee",
      sortMode: "manual",
      assigneeLabels: new Map([
        ["agent:codex", "Codex"],
        ["member:membership-a", "Ada"],
      ]),
    });

    // An unnamed teammate never leaks their opaque membership id into the UI.
    expect(view.groups.map((group) => group.label)).toEqual([
      "You",
      "Ada",
      "Unknown member",
      "Codex",
      "Unassigned",
    ]);
    expect(view.groups.map((group) => group.id)).toEqual([
      "assignee:user",
      "assignee:member:membership-a",
      "assignee:member:membership-b",
      "assignee:agent:codex",
      "assignee:none",
    ]);
  });

  it("collapses to one unnamed group when nothing is grouped", () => {
    const view = buildIssuesView({
      grouping: grouping([
        [TODO, [issue("1")]],
        [DOING, [issue("2")]],
      ]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "none",
      sortMode: "manual",
    });

    expect(view.groups).toHaveLength(1);
    expect(buildIssuesListRows(view, NO_COLLAPSED).map((row) => row.id)).toEqual([
      "issue:1",
      "issue:2",
    ]);
  });

  it("has no groups at all when every issue is filtered away", () => {
    const view = buildIssuesView({
      grouping: grouping([[TODO, [issue("1")]]]),
      filter: withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "priority", ["urgent"]),
      today: TODAY,
      groupBy: "none",
      sortMode: "manual",
    });
    expect(view.groups).toEqual([]);
    expect(view.total).toBe(0);
  });
});

describe("ordering", () => {
  const rows = [
    issue("a", {
      sortOrder: "c",
      priority: "low",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    }),
    issue("b", {
      sortOrder: "a",
      priority: "none",
      updatedAt: "2026-08-03T00:00:00.000Z",
      createdAt: "2026-07-03T00:00:00.000Z",
    }),
    issue("c", {
      sortOrder: "b",
      priority: "urgent",
      updatedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-07-02T00:00:00.000Z",
    }),
  ];

  const ordered = (sortMode: "manual" | "priority" | "updated" | "created") =>
    buildIssuesView({
      grouping: grouping([[TODO, rows]]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "status",
      sortMode,
    }).groups[0]?.issues.map((row) => row.id);

  it("sorts by the fractional key, then priority, then the timestamps", () => {
    expect(ordered("manual")).toEqual(["b", "c", "a"]);
    expect(ordered("priority")).toEqual(["c", "a", "b"]);
    expect(ordered("updated")).toEqual(["b", "c", "a"]);
    expect(ordered("created")).toEqual(["b", "c", "a"]);
  });

  it("stands priority in for manual anywhere the manual key is invisible", () => {
    expect(effectiveIssueSortMode("manual", "status")).toBe("manual");
    expect(effectiveIssueSortMode("manual", "project")).toBe("priority");
    expect(effectiveIssueSortMode("updated", "project")).toBe("updated");
    expect(issueSortModeHint("manual", "status")).toBeNull();
    expect(issueSortModeHint("manual", "none")).toContain("priority");

    const view = buildIssuesView({
      grouping: grouping([[TODO, rows]]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "none",
      sortMode: "manual",
    });
    expect(view.sortMode).toBe("priority");
    expect(view.groups[0]?.issues.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  // The converse case: the board is always grouped by status, so manual always applies and the
  // list's hint never fires there. What the board has to explain instead is the missing drag.
  it("explains the board's drag rather than its order", () => {
    expect(issueSortModeHint("manual", "status", "board")).toBeNull();
    expect(issueSortModeHint("updated", "status", "board")).toContain("manual order");
    // A grouping carried over from the list is ignored by the board, so it must not change the
    // sentence either.
    expect(issueSortModeHint("manual", "project", "board")).toBeNull();
    expect(issueSortModeHint("manual", "project", "list")).toContain("priority");
  });
});

describe("chip presentation", () => {
  const options = [
    { value: "l1", label: "Bug" },
    { value: "l2", label: "Chore" },
  ];

  it("names a value it knows and falls back to the id it does not", () => {
    expect(issuesFilterValueLabels(["l2", "gone"], options)).toEqual(["Chore", "gone"]);
  });

  it("summarises the values as the first name plus a count", () => {
    expect(summarizeIssuesFilterValues([])).toBe("Any");
    expect(summarizeIssuesFilterValues(["Bug"])).toBe("Bug");
    expect(summarizeIssuesFilterValues(["Bug", "Chore", "Docs"])).toBe("Bug +2");
  });

  it("searches the options case-insensitively", () => {
    expect(filterIssuesFilterOptions(options, "  ch ").map((option) => option.value)).toEqual([
      "l2",
    ]);
    expect(filterIssuesFilterOptions(options, "")).toEqual(options);
  });
});

describe("buildIssuesListRows", () => {
  it("interleaves headers with their issues", () => {
    const rows = buildIssuesListRows(
      statusView([
        [TODO, [issue("1"), issue("2")]],
        [DOING, [issue("3")]],
      ]),
      NO_COLLAPSED,
    );

    expect(rows.map((row) => row.id)).toEqual([
      "group:status:todo",
      "issue:1",
      "issue:2",
      "group:status:doing",
      "issue:3",
    ]);
  });

  it("drops the issues of a collapsed group but keeps its count", () => {
    const rows = buildIssuesListRows(
      statusView([
        [TODO, [issue("1"), issue("2")]],
        [DOING, [issue("3")]],
      ]),
      new Set([`status:${TODO.id}`]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "group:status:todo",
      "group:status:doing",
      "issue:3",
    ]);
    const header = rows[0];
    expect(header?.kind === "header" && header.count).toBe(2);
    expect(issueIdsInRows(rows)).toEqual(["3"]);
  });

  it("locates an issue row by id", () => {
    const rows = buildIssuesListRows(statusView([[TODO, [issue("1"), issue("2")]]]), NO_COLLAPSED);
    expect(findIssueRowIndex(rows, IssueId.make("2"))).toBe(2);
    expect(findIssueRowIndex(rows, null)).toBe(-1);
  });
});

describe("selectIssueRow", () => {
  const ids = ["1", "2", "3", "4"].map((value) => IssueId.make(value));

  it("replaces the selection on a plain click", () => {
    const selection = selectIssueRow(EMPTY_ISSUES_SELECTION, {
      ids,
      issueId: ids[2] as IssueId,
      mode: "replace",
    });

    expect([...selection.ids]).toEqual(["3"]);
    expect(selection.activeId).toBe("3");
    expect(selection.anchorId).toBe("3");
  });

  it("extends from the anchor rather than unioning two ranges", () => {
    const first = selectIssueRow(EMPTY_ISSUES_SELECTION, {
      ids,
      issueId: ids[0] as IssueId,
      mode: "replace",
    });
    const wide = selectIssueRow(first, { ids, issueId: ids[3] as IssueId, mode: "range" });
    const narrow = selectIssueRow(wide, { ids, issueId: ids[1] as IssueId, mode: "range" });

    expect([...wide.ids]).toEqual(["1", "2", "3", "4"]);
    expect([...narrow.ids]).toEqual(["1", "2"]);
    expect(narrow.anchorId).toBe("1");
  });

  it("selects upward when the range runs backwards", () => {
    expect(issueRangeIds(ids, ids[3] as IssueId, ids[1] as IssueId)).toEqual(["2", "3", "4"]);
  });

  it("falls back to a plain select when a range has no anchor", () => {
    const selection = selectIssueRow(EMPTY_ISSUES_SELECTION, {
      ids,
      issueId: ids[1] as IssueId,
      mode: "range",
    });
    expect([...selection.ids]).toEqual(["2"]);
  });

  it("toggles a row in and out and keeps the cursor on something selected", () => {
    const one = selectIssueRow(EMPTY_ISSUES_SELECTION, {
      ids,
      issueId: ids[0] as IssueId,
      mode: "replace",
    });
    const two = selectIssueRow(one, { ids, issueId: ids[2] as IssueId, mode: "toggle" });
    expect([...two.ids]).toEqual(["1", "3"]);
    expect(two.activeId).toBe("3");

    const back = selectIssueRow(two, { ids, issueId: ids[2] as IssueId, mode: "toggle" });
    expect([...back.ids]).toEqual(["1"]);
    expect(back.activeId).toBe("1");
  });

  it("reads modifiers the way a file list does", () => {
    expect(issueSelectModeForModifiers({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(
      "range",
    );
    expect(issueSelectModeForModifiers({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      "toggle",
    );
    expect(issueSelectModeForModifiers({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(
      "toggle",
    );
    expect(issueSelectModeForModifiers({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(
      "replace",
    );
  });
});

describe("activateIssueRow", () => {
  it("moves the active row without changing checkbox selection", () => {
    const selectedId = IssueId.make("1");
    const activeId = IssueId.make("2");
    const selection: IssuesSelection = {
      ids: new Set([selectedId]),
      anchorId: selectedId,
      activeId: selectedId,
    };

    const activated = activateIssueRow(selection, activeId);

    expect([...activated.ids]).toEqual([selectedId]);
    expect(activated.anchorId).toBe(selectedId);
    expect(activated.activeId).toBe(activeId);
  });
});

describe("pruneIssuesSelection", () => {
  it("drops rows the list stopped showing", () => {
    const selection: IssuesSelection = {
      ids: new Set([IssueId.make("1"), IssueId.make("2")]),
      anchorId: IssueId.make("2"),
      activeId: IssueId.make("2"),
    };

    const pruned = pruneIssuesSelection(selection, [IssueId.make("1")]);
    expect([...pruned.ids]).toEqual(["1"]);
    expect(pruned.anchorId).toBeNull();
    expect(pruned.activeId).toBeNull();
  });

  it("returns the same object when everything is still visible", () => {
    const selection: IssuesSelection = {
      ids: new Set([IssueId.make("1")]),
      anchorId: IssueId.make("1"),
      activeId: IssueId.make("1"),
    };
    expect(pruneIssuesSelection(selection, [IssueId.make("1"), IssueId.make("2")])).toBe(selection);
  });
});

describe("resolveIssuesListKeyAction", () => {
  const ids = ["1", "2", "3"].map((value) => IssueId.make(value));
  const base = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ids,
    hasSelection: true,
  };

  it("opens a new issue with either Command-N or Control-N", () => {
    expect(
      resolveIssuesListKeyAction({ ...base, key: "n", metaKey: true, activeId: null }),
    ).toEqual({ _tag: "new" });
    expect(
      resolveIssuesListKeyAction({ ...base, key: "n", ctrlKey: true, activeId: null }),
    ).toEqual({ _tag: "new" });
  });

  it("leaves modified variants of the new issue shortcut alone", () => {
    expect(
      resolveIssuesListKeyAction({
        ...base,
        key: "n",
        metaKey: true,
        shiftKey: true,
        activeId: null,
      }),
    ).toBeNull();
    expect(
      resolveIssuesListKeyAction({
        ...base,
        key: "n",
        metaKey: true,
        ctrlKey: true,
        activeId: null,
      }),
    ).toBeNull();
  });

  it("moves the cursor with j/k and the arrows", () => {
    expect(resolveIssuesListKeyAction({ ...base, key: "j", activeId: ids[0] as IssueId })).toEqual({
      _tag: "select",
      issueId: "2",
    });
    expect(
      resolveIssuesListKeyAction({ ...base, key: "ArrowDown", activeId: ids[0] as IssueId }),
    ).toEqual({ _tag: "select", issueId: "2" });
    expect(resolveIssuesListKeyAction({ ...base, key: "k", activeId: ids[2] as IssueId })).toEqual({
      _tag: "select",
      issueId: "2",
    });
  });

  it("starts at the end the cursor is coming from", () => {
    expect(resolveIssuesListKeyAction({ ...base, key: "j", activeId: null })).toEqual({
      _tag: "select",
      issueId: "1",
    });
    expect(resolveIssuesListKeyAction({ ...base, key: "k", activeId: null })).toEqual({
      _tag: "select",
      issueId: "3",
    });
  });

  it("stops at the ends instead of wrapping", () => {
    expect(
      resolveIssuesListKeyAction({ ...base, key: "k", activeId: ids[0] as IssueId }),
    ).toBeNull();
    expect(
      resolveIssuesListKeyAction({ ...base, key: "j", activeId: ids[2] as IssueId }),
    ).toBeNull();
  });

  it("opens the cursor row on Enter and clears on Escape", () => {
    expect(
      resolveIssuesListKeyAction({ ...base, key: "Enter", activeId: ids[1] as IssueId }),
    ).toEqual({ _tag: "open", issueId: "2" });
    expect(resolveIssuesListKeyAction({ ...base, key: "Enter", activeId: null })).toBeNull();
    expect(resolveIssuesListKeyAction({ ...base, key: "Escape", activeId: null })).toEqual({
      _tag: "clear",
    });
    expect(
      resolveIssuesListKeyAction({ ...base, key: "Escape", activeId: null, hasSelection: false }),
    ).toBeNull();
  });

  it("declines keys it does not own so the caller leaves them alone", () => {
    expect(
      resolveIssuesListKeyAction({ ...base, key: "a", activeId: ids[0] as IssueId }),
    ).toBeNull();
    expect(
      resolveIssuesListKeyAction({ ...base, key: "j", metaKey: true, activeId: ids[0] as IssueId }),
    ).toBeNull();
    expect(
      resolveIssuesListKeyAction({
        ...base,
        key: "j",
        shiftKey: true,
        activeId: ids[0] as IssueId,
      }),
    ).toBeNull();
    expect(resolveIssuesListKeyAction({ ...base, key: "j", ids: [], activeId: null })).toBeNull();
  });
});

describe("row presentation", () => {
  it("calls a day before today past", () => {
    expect(isIssueDueDatePast("2026-08-11", "2026-08-12")).toBe(true);
    expect(isIssueDueDatePast("2026-08-12", "2026-08-12")).toBe(false);
    expect(isIssueDueDatePast("2026-09-01", "2026-08-12")).toBe(false);
  });

  it("shows the year only when it is not the current one", () => {
    expect(formatIssueDueDate("2026-08-12", "2026-08-12")).toBe("Aug 12");
    expect(formatIssueDueDate("2025-01-03", "2026-08-12")).toBe("Jan 3, 2025");
  });

  it("collapses label chips past the row budget and drops unknown ids", () => {
    const labels = indexIssueLabels([label("a"), label("b"), label("c"), label("d")]);
    const ids = ["a", "b", "c", "d"].map((value) => IssueLabelId.make(value));

    const resolved = resolveIssueRowLabels(ids, labels, 3);
    expect(resolved.shown.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(resolved.overflow).toBe(1);

    const withGhost = resolveIssueRowLabels(
      [IssueLabelId.make("gone"), ids[0] as IssueLabelId],
      labels,
      3,
    );
    expect(withGhost.shown.map((row) => row.id)).toEqual(["a"]);
    expect(withGhost.overflow).toBe(0);
  });
});

describe("label menu state", () => {
  const bug = IssueLabelId.make("bug");

  it("distinguishes a partial selection from a complete one", () => {
    expect(issueLabelSelectionState([issue("1", { labelIds: [bug] }), issue("2")], bug)).toBe(
      "some",
    );
    expect(
      issueLabelSelectionState(
        [issue("1", { labelIds: [bug] }), issue("2", { labelIds: [bug] })],
        bug,
      ),
    ).toBe("all");
    expect(issueLabelSelectionState([issue("1")], bug)).toBe("none");
    expect(issueLabelSelectionState([], bug)).toBe("none");
  });

  it("toggles a label id in place", () => {
    expect(toggleIssueLabelIds([], bug)).toEqual([bug]);
    expect(toggleIssueLabelIds([bug], bug)).toEqual([]);
  });
});

describe("milestone and cycle filters", () => {
  const milestone = IssueMilestoneId.make("m1");
  const cycle = IssueCycleId.make("c1");

  it("intersects a milestone with the tab's statuses", () => {
    const view = statusView(
      [[TODO, [issue("1", { milestoneId: milestone }), issue("2")]]],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "milestone", [milestone]),
    );
    expect(view.groups[0]?.issues.map((row) => row.id)).toEqual(["1"]);
    expect(view.total).toBe(1);
  });

  it("filters by cycle independently of the project", () => {
    const view = statusView(
      [
        [
          TODO,
          [
            issue("1", { cycleId: cycle, projectId: ProjectId.make("p1") }),
            issue("2", { cycleId: cycle }),
            issue("3"),
          ],
        ],
      ],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "cycle", [cycle]),
    );
    expect(view.groups[0]?.issues.map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("counts a cycle's issues, skipping deleted and triage rows", () => {
    const counts = countIssuesByCycle(
      store([
        issue("1", { cycleId: cycle }),
        issue("2", { cycleId: cycle }),
        issue("3", { cycleId: cycle, triage: true }),
        issue("4", { cycleId: cycle, deletedAt: NOW }),
        issue("5"),
      ]),
    );
    expect(counts.get(cycle)).toBe(2);
    expect(counts.size).toBe(1);
  });
});

describe("formatIssueDateRange", () => {
  const today = "2026-08-12";

  it("prints a range inside this year without any year at all", () => {
    expect(formatIssueDateRange("2026-08-12", "2026-08-25", today)).toBe("Aug 12 – Aug 25");
  });

  it("prints another year once, at the end", () => {
    expect(formatIssueDateRange("2027-01-04", "2027-01-17", today)).toBe("Jan 4 – Jan 17, 2027");
  });

  it("prints both years when the range crosses one", () => {
    expect(formatIssueDateRange("2026-12-28", "2027-01-08", today)).toBe("Dec 28 – Jan 8, 2027");
  });
});
