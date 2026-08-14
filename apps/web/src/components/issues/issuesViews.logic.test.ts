import {
  IssueCycleId,
  IssueLabelId,
  IssueMilestoneId,
  IssueStatusId,
  IssueViewId,
  ProjectId,
  ProviderDriverKind,
  type IssueView,
  type IssueViewConfig,
} from "@t3tools/contracts";
import { MembershipId } from "@t3tools/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import { issueAssigneeValue, parseIssuesSearch, type IssuesSearch } from "./issuesList.logic";
import {
  DEFAULT_ISSUE_VIEW_CONFIG,
  findIssueViewByName,
  findIssueViewForConfig,
  isIssueViewConfigDirty,
  issueViewConfigFilter,
  issueViewSearchPatch,
  issuesSearchViewConfig,
  moveIssueViewOrder,
  parseIssueAssigneeValue,
  sameIssueViewConfig,
  summarizeIssueViewConfig,
} from "./issuesViews.logic";

const NOW = "2026-08-12T00:00:00.000Z";

const MEMBER = {
  kind: "member",
  membershipId: MembershipId.make("membership-b"),
} as const;

function config(overrides: Partial<IssueViewConfig> = {}): IssueViewConfig {
  return { ...DEFAULT_ISSUE_VIEW_CONFIG, ...overrides };
}

function view(id: string, name: string, overrides: Partial<IssueView> = {}): IssueView {
  return {
    id: IssueViewId.make(id),
    name,
    position: 0,
    config: DEFAULT_ISSUE_VIEW_CONFIG,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** What the router hands the page: raw params in, canonical `IssuesSearch` out. */
function search(raw: Record<string, unknown>): IssuesSearch {
  return parseIssuesSearch(raw);
}

describe("parseIssueAssigneeValue", () => {
  it("reads the user, member, and agent spellings the URL uses", () => {
    expect(parseIssueAssigneeValue("user")).toEqual({ kind: "user" });
    expect(parseIssueAssigneeValue("agent:codex")).toEqual({ kind: "agent", provider: "codex" });
    // The membership survives the round trip, so a saved view names one teammate, not the company.
    expect(parseIssueAssigneeValue("member:membership-a")).toEqual({
      kind: "member",
      membershipId: "membership-a",
    });
    expect(parseIssueAssigneeValue(issueAssigneeValue(MEMBER) ?? "")).toEqual(MEMBER);
  });

  it("drops a value that is not an assignee, so a hand-edited URL cannot poison a save", () => {
    expect(parseIssueAssigneeValue("agent:")).toBeNull();
    expect(parseIssueAssigneeValue("agent:not a slug")).toBeNull();
    expect(parseIssueAssigneeValue("member:")).toBeNull();
    expect(parseIssueAssigneeValue("member: padded ")).toBeNull();
    expect(parseIssueAssigneeValue("nobody")).toBeNull();
  });
});

describe("issuesSearchViewConfig", () => {
  it("reads a bare route as the default view", () => {
    expect(issuesSearchViewConfig(search({}))).toEqual(DEFAULT_ISSUE_VIEW_CONFIG);
  });

  it("omits an empty chip rather than saving it as an empty array", () => {
    const built = issuesSearchViewConfig(search({ label: "bug" }));
    expect(built.labelIds).toEqual(["bug"]);
    expect("statusIds" in built).toBe(false);
    expect("dueFilter" in built).toBe(false);
  });

  it("carries every param the chip bar, the menu, and the toggle write", () => {
    expect(
      issuesSearchViewConfig(
        search({
          tab: "backlog",
          status: "todo,doing",
          project: "p1",
          label: "bug",
          milestone: "m1",
          cycle: "c1",
          assignee: "user,agent:codex",
          priority: "urgent,low",
          due: "overdue",
          group: "project",
          sort: "updated",
          view: "board",
        }),
      ),
    ).toEqual({
      tab: "backlog",
      statusIds: ["todo", "doing"],
      projectIds: ["p1"],
      labelIds: ["bug"],
      milestoneIds: ["m1"],
      cycleIds: ["c1"],
      assignees: [{ kind: "user" }, { kind: "agent", provider: "codex" }],
      priorities: ["urgent", "low"],
      dueFilter: "overdue",
      grouping: "project",
      sortMode: "updated",
      viewMode: "board",
    });
  });

  it("ignores the open detail sheet", () => {
    expect(issuesSearchViewConfig(search({ issue: "PAT-4" }))).toEqual(DEFAULT_ISSUE_VIEW_CONFIG);
  });
});

describe("issueViewConfigFilter", () => {
  it("turns absent chips into empty ones and assignees back into URL spellings", () => {
    expect(
      issueViewConfigFilter(
        config({
          assignees: [{ kind: "agent", provider: ProviderDriverKind.make("claude") }],
          statusIds: [IssueStatusId.make("todo")],
        }),
      ),
    ).toEqual({
      statusIds: ["todo"],
      projectIds: [],
      labelIds: [],
      milestoneIds: [],
      cycleIds: [],
      assignees: ["agent:claude"],
      priorities: [],
      dueFilter: null,
    });
  });
});

describe("issueViewSearchPatch", () => {
  it("clears every param a view of everything does not set", () => {
    expect(issueViewSearchPatch(DEFAULT_ISSUE_VIEW_CONFIG)).toEqual({
      tab: undefined,
      status: undefined,
      project: undefined,
      label: undefined,
      milestone: undefined,
      cycle: undefined,
      assignee: undefined,
      priority: undefined,
      due: undefined,
      group: undefined,
      sort: undefined,
      view: undefined,
    });
  });

  it("writes the params a saved view names", () => {
    expect(
      issueViewSearchPatch(
        config({
          tab: "all",
          labelIds: [IssueLabelId.make("bug"), IssueLabelId.make("chore")],
          cycleIds: [IssueCycleId.make("c1")],
          dueFilter: "week",
          grouping: "assignee",
          sortMode: "created",
          viewMode: "board",
        }),
      ),
    ).toMatchObject({
      tab: "all",
      label: "bug,chore",
      cycle: "c1",
      due: "week",
      group: "assignee",
      sort: "created",
      view: "board",
    });
  });

  it("round-trips: applying a view's patch reads back as that view's config", () => {
    const saved = config({
      tab: "backlog",
      projectIds: [ProjectId.make("p1")],
      assignees: [{ kind: "user" }],
      priorities: ["high"],
      grouping: "priority",
      sortMode: "updated",
      viewMode: "board",
    });
    const applied = {
      ...search({ tab: "active", status: "stale" }),
      ...issueViewSearchPatch(saved),
    };
    expect(issuesSearchViewConfig(applied)).toEqual(saved);
  });
});

/**
 * The round trip the router actually performs. The patch is merged over the current params and the
 * result is handed back through `validateSearch` — so a field that survives the merge but not
 * `parseIssuesSearch` would still come back wrong, which merging alone cannot show.
 */
describe("applying a view through the router", () => {
  /** `navigate({ search: (current) => ({ ...current, ...patch }) })`, then `validateSearch`. */
  function navigate(current: Record<string, unknown>, patch: Partial<IssuesSearch>): IssuesSearch {
    return parseIssuesSearch({ ...current, ...patch });
  }

  it("carries every field of a view, multi-value chips included", () => {
    const everything = config({
      tab: "backlog",
      statusIds: [IssueStatusId.make("s1"), IssueStatusId.make("s2")],
      projectIds: [ProjectId.make("p1")],
      labelIds: [IssueLabelId.make("bug"), IssueLabelId.make("chore")],
      milestoneIds: [IssueMilestoneId.make("m1")],
      cycleIds: [IssueCycleId.make("c1"), IssueCycleId.make("c2")],
      assignees: [{ kind: "user" }, { kind: "agent", provider: ProviderDriverKind.make("codex") }],
      priorities: ["urgent", "low"],
      dueFilter: "overdue",
      grouping: "project",
      sortMode: "created",
      viewMode: "board",
    });
    const applied = navigate(
      { tab: "active", status: "stale", issue: "PAT-9" },
      issueViewSearchPatch(everything),
    );
    expect(issuesSearchViewConfig(applied)).toEqual(everything);
  });

  // The mode is a param like any other, so the thing that makes a board a board has to survive the
  // same trip the filters do: a view saved from the board reopens on the board.
  it("reopens a saved board view as a board", () => {
    const board = config({ viewMode: "board" });
    const applied = navigate({}, issueViewSearchPatch(board));
    expect(applied.view).toBe("board");
    expect(issuesSearchViewConfig(applied)).toEqual(board);
  });

  it("leaves the open detail sheet alone, because it is not part of the question", () => {
    expect(navigate({ issue: "PAT-9" }, issueViewSearchPatch(config({ tab: "all" }))).issue).toBe(
      "PAT-9",
    );
  });

  // Every key is named in the patch, so what the previous view set is cleared rather than
  // intersected with what this one sets.
  it("clears the params a view does not name", () => {
    const applied = navigate(
      {
        tab: "all",
        label: "bug",
        priority: "urgent",
        due: "overdue",
        group: "project",
        sort: "updated",
        view: "board",
      },
      issueViewSearchPatch(DEFAULT_ISSUE_VIEW_CONFIG),
    );
    expect(issuesSearchViewConfig(applied)).toEqual(DEFAULT_ISSUE_VIEW_CONFIG);
    // A view of everything leaves the URL as bare as `/issues`.
    expect(Object.values(applied).every((value) => value === undefined)).toBe(true);
  });
});

describe("sameIssueViewConfig", () => {
  it("ignores the order values were clicked in", () => {
    const left = config({ statusIds: [IssueStatusId.make("a"), IssueStatusId.make("b")] });
    const right = config({ statusIds: [IssueStatusId.make("b"), IssueStatusId.make("a")] });
    expect(sameIssueViewConfig(left, right)).toBe(true);
  });

  it("reads an absent chip and an empty chip as the same question", () => {
    expect(sameIssueViewConfig(config({ labelIds: [] }), DEFAULT_ISSUE_VIEW_CONFIG)).toBe(true);
  });

  it("separates configs that differ by one value, one chip, or one mode", () => {
    const base = config({ labelIds: [IssueLabelId.make("bug")] });
    expect(sameIssueViewConfig(base, config({ labelIds: [IssueLabelId.make("chore")] }))).toBe(
      false,
    );
    expect(
      sameIssueViewConfig(
        base,
        config({ labelIds: [IssueLabelId.make("bug")], dueFilter: "overdue" }),
      ),
    ).toBe(false);
    expect(
      sameIssueViewConfig(base, config({ labelIds: [IssueLabelId.make("bug")], tab: "all" })),
    ).toBe(false);
    expect(
      sameIssueViewConfig(
        base,
        config({ labelIds: [IssueLabelId.make("bug")], viewMode: "board" }),
      ),
    ).toBe(false);
  });

  it("compares assignees by who they name, not by object identity", () => {
    expect(
      sameIssueViewConfig(
        config({ assignees: [{ kind: "user" }] }),
        config({
          assignees: [{ kind: "user" }],
        }),
      ),
    ).toBe(true);
    expect(
      sameIssueViewConfig(
        config({ assignees: [{ kind: "user" }] }),
        config({ assignees: [{ kind: "agent", provider: ProviderDriverKind.make("codex") }] }),
      ),
    ).toBe(false);
  });
});

describe("isIssueViewConfigDirty", () => {
  it("is quiet on a bare route", () => {
    expect(isIssueViewConfigDirty(issuesSearchViewConfig(search({})))).toBe(false);
    // The params a tab click writes still say "active", so the button does not appear from a
    // round trip through the tab bar.
    expect(isIssueViewConfigDirty(issuesSearchViewConfig(search({ tab: "active" })))).toBe(false);
    expect(isIssueViewConfigDirty(issuesSearchViewConfig(search({ issue: "PAT-1" })))).toBe(false);
  });

  it("wakes for a filter, a tab, a grouping, a sort, or the board", () => {
    for (const raw of [
      { label: "bug" },
      { due: "overdue" },
      { tab: "backlog" },
      { group: "project" },
      { sort: "created" },
      { view: "board" },
    ]) {
      expect(isIssueViewConfigDirty(issuesSearchViewConfig(search(raw)))).toBe(true);
    }
  });
});

describe("findIssueViewForConfig", () => {
  const mine = view("v1", "My bugs", {
    config: config({ labelIds: [IssueLabelId.make("bug")], assignees: [{ kind: "user" }] }),
  });
  const board = view("v2", "Board", { config: config({ viewMode: "board" }), position: 1 });

  it("recognises the params a view was saved from, whatever order the chips are in", () => {
    const applied = search({ assignee: "user", label: "bug" });
    expect(findIssueViewForConfig([mine, board], issuesSearchViewConfig(applied))?.id).toBe("v1");
  });

  it("stops recognising it once a chip moves", () => {
    const edited = search({ assignee: "user", label: "bug,chore" });
    expect(findIssueViewForConfig([mine, board], issuesSearchViewConfig(edited))).toBeNull();
  });
});

describe("findIssueViewByName", () => {
  const views = [view("v1", "My bugs"), view("v2", "Board")];

  it("matches case-insensitively, the way the server's conflict check does", () => {
    expect(findIssueViewByName(views, "  my BUGS ")?.id).toBe("v1");
  });

  it("has nothing to match on an empty name", () => {
    expect(findIssueViewByName(views, "   ")).toBeNull();
    expect(findIssueViewByName(views, "Nothing")).toBeNull();
  });
});

describe("moveIssueViewOrder", () => {
  const views = [view("a", "A"), view("b", "B", { position: 1 }), view("c", "C", { position: 2 })];

  it("returns the complete order, not a move", () => {
    expect(moveIssueViewOrder(views, IssueViewId.make("c"), "up")).toEqual(["a", "c", "b"]);
    expect(moveIssueViewOrder(views, IssueViewId.make("a"), "down")).toEqual(["b", "a", "c"]);
  });

  it("refuses the end a view is already at, and a view it does not hold", () => {
    expect(moveIssueViewOrder(views, IssueViewId.make("a"), "up")).toBeNull();
    expect(moveIssueViewOrder(views, IssueViewId.make("c"), "down")).toBeNull();
    expect(moveIssueViewOrder(views, IssueViewId.make("gone"), "up")).toBeNull();
  });
});

describe("summarizeIssueViewConfig", () => {
  it("names the tab alone for a view of everything", () => {
    expect(summarizeIssueViewConfig(DEFAULT_ISSUE_VIEW_CONFIG)).toBe("Active");
  });

  it("counts chips rather than listing them", () => {
    expect(
      summarizeIssueViewConfig(
        config({
          tab: "all",
          labelIds: [IssueLabelId.make("bug"), IssueLabelId.make("chore")],
          dueFilter: "overdue",
        }),
      ),
    ).toBe("All · 2 filters");
  });

  it("says Board instead of a grouping the board ignores", () => {
    expect(summarizeIssueViewConfig(config({ grouping: "project", viewMode: "board" }))).toBe(
      "Active · Board",
    );
    expect(summarizeIssueViewConfig(config({ grouping: "project", sortMode: "created" }))).toBe(
      "Active · Grouped by project · created order",
    );
  });
});
