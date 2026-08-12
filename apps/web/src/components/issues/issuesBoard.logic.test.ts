import {
  IssueId,
  IssueLabelId,
  IssueStatusId,
  ProjectId,
  type Issue,
  type IssueStatus,
  type IssueStatusCategory,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { IssuesGrouping } from "~/state/issues";
import {
  EMPTY_ISSUES_BOARD_COLUMNS,
  findIssuesBoardCard,
  findIssuesBoardColumn,
  isIssuesBoardSortable,
  issuesBoardCardDragId,
  issuesBoardColumnDropId,
  issuesBoardColumns,
  issuesBoardDropEdge,
  parseIssuesBoardDragId,
  resolveIssuesBoardDrop,
  type IssuesBoardColumn,
} from "./issuesBoard.logic";
import {
  buildIssuesView,
  NO_ISSUES_LIST_FILTER,
  withIssuesFilterValues,
  type IssuesListFilter,
} from "./issuesList.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const TODAY = "2026-08-12";

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
const DONE = status("done", "completed", 2);

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
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function grouping(groups: ReadonlyArray<[IssueStatus, ReadonlyArray<Issue>]>): IssuesGrouping {
  return {
    groups: groups.map(([groupStatus, issues]) => ({ status: groupStatus, issues })),
    total: groups.reduce((count, [, issues]) => count + issues.length, 0),
  };
}

/** The board as the page builds it: the tab's grouping through the chip bar, narrowed to columns. */
function board(
  groups: ReadonlyArray<[IssueStatus, ReadonlyArray<Issue>]>,
  filter: IssuesListFilter = NO_ISSUES_LIST_FILTER,
): ReadonlyArray<IssuesBoardColumn> {
  return issuesBoardColumns(
    buildIssuesView({
      grouping: grouping(groups),
      filter,
      today: TODAY,
      groupBy: "status",
      sortMode: "manual",
    }),
  );
}

function columnIssueIds(columns: ReadonlyArray<IssuesBoardColumn>, statusId: string) {
  return (
    findIssuesBoardColumn(columns, IssueStatusId.make(statusId))?.issues.map((row) => row.id) ?? []
  );
}

/** A fractional key is opaque, so the only claim worth making is where it lands between neighbours. */
function expectBetween(key: string | undefined, before: string | null, after: string | null) {
  expect(key).toBeTypeOf("string");
  if (key === undefined) return;
  if (before !== null) expect(key > before).toBe(true);
  if (after !== null) expect(key < after).toBe(true);
}

describe("issuesBoardColumns", () => {
  it("keeps one column per status in the grouping's order, empties included", () => {
    const columns = board([
      [TODO, [issue("a")]],
      [DOING, []],
      [DONE, [issue("b", { statusId: DONE.id })]],
    ]);
    expect(columns.map((column) => column.status.id)).toEqual([TODO.id, DOING.id, DONE.id]);
    expect(columns.map((column) => column.issues.length)).toEqual([1, 0, 1]);
  });

  it("renders the filtered set, and keeps a column the filter emptied", () => {
    const columns = board(
      [
        [TODO, [issue("a", { priority: "urgent" }), issue("b")]],
        [DOING, [issue("c", { statusId: DOING.id })]],
      ],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "priority", ["urgent"]),
    );
    expect(columnIssueIds(columns, "todo")).toEqual([IssueId.make("a")]);
    expect(columnIssueIds(columns, "doing")).toEqual([]);
  });

  it("orders a column by the manual key the drag writes", () => {
    const columns = board([
      [
        TODO,
        [
          issue("late", { sortOrder: "y" }),
          issue("early", { sortOrder: "b" }),
          issue("middle", { sortOrder: "m" }),
        ],
      ],
    ]);
    expect(columnIssueIds(columns, "todo")).toEqual([
      IssueId.make("early"),
      IssueId.make("middle"),
      IssueId.make("late"),
    ]);
  });

  it("drops a group that names no status, because a board has no such column", () => {
    const view = buildIssuesView({
      grouping: grouping([[TODO, [issue("a")]]]),
      filter: NO_ISSUES_LIST_FILTER,
      today: TODAY,
      groupBy: "project",
      sortMode: "manual",
    });
    expect(issuesBoardColumns(view)).toEqual(EMPTY_ISSUES_BOARD_COLUMNS);
  });
});

describe("findIssuesBoardCard", () => {
  it("finds a card in any column and answers null for one the board does not hold", () => {
    const columns = board([
      [TODO, [issue("a")]],
      [DOING, [issue("b", { statusId: DOING.id })]],
    ]);
    expect(findIssuesBoardCard(columns, IssueId.make("b"))?.key).toBe("PAT-b");
    expect(findIssuesBoardCard(columns, IssueId.make("nope"))).toBeNull();
  });
});

describe("drag ids", () => {
  it("round-trips a card and a column through one namespace", () => {
    expect(parseIssuesBoardDragId(issuesBoardCardDragId(IssueId.make("iss_1")))).toEqual({
      kind: "card",
      issueId: "iss_1",
    });
    expect(parseIssuesBoardDragId(issuesBoardColumnDropId(IssueStatusId.make("st_1")))).toEqual({
      kind: "column",
      statusId: "st_1",
    });
  });

  it("cannot confuse a card with a column that shares its raw id", () => {
    expect(issuesBoardCardDragId(IssueId.make("x"))).not.toBe(
      issuesBoardColumnDropId(IssueStatusId.make("x")),
    );
  });

  it("refuses an unprefixed or empty id rather than guessing", () => {
    expect(parseIssuesBoardDragId("iss_1")).toBeNull();
    expect(parseIssuesBoardDragId("")).toBeNull();
    expect(parseIssuesBoardDragId("issue-card:")).toBeNull();
    expect(parseIssuesBoardDragId("issue-column:")).toBeNull();
  });
});

describe("issuesBoardDropEdge", () => {
  it("reads the dragged card's centre against the hovered card's midline", () => {
    expect(issuesBoardDropEdge({ activeCenterY: 40, overTop: 0, overHeight: 100 })).toBe("before");
    expect(issuesBoardDropEdge({ activeCenterY: 60, overTop: 0, overHeight: 100 })).toBe("after");
    expect(issuesBoardDropEdge({ activeCenterY: 50, overTop: 0, overHeight: 100 })).toBe("before");
  });

  it("falls back to before when the drag never translated", () => {
    expect(issuesBoardDropEdge({ activeCenterY: null, overTop: 0, overHeight: 100 })).toBe(
      "before",
    );
  });
});

describe("resolveIssuesBoardDrop", () => {
  const A = issue("a", { sortOrder: "b" });
  const B = issue("b", { sortOrder: "m" });
  const C = issue("c", { sortOrder: "t" });
  const D = issue("d", { statusId: DOING.id, sortOrder: "d" });
  const E = issue("e", { statusId: DOING.id, sortOrder: "s" });

  const COLUMNS = board([
    [TODO, [A, B, C]],
    [DOING, [D, E]],
    [DONE, []],
  ]);

  function drop(activeId: string, overId: string | null, edge?: "before" | "after") {
    return resolveIssuesBoardDrop({
      columns: COLUMNS,
      activeId: issuesBoardCardDragId(IssueId.make(activeId)),
      overId,
      ...(edge === undefined ? {} : { edge }),
      sortMode: "manual",
    });
  }

  const card = (id: string) => issuesBoardCardDragId(IssueId.make(id));
  const tail = (id: string) => issuesBoardColumnDropId(IssueStatusId.make(id));

  it("reorders inside a column without touching the status", () => {
    // a over c is arrayMove(0 → 2): the card lands last, between c and nothing.
    const result = drop("a", card("c"));
    expect(result?.issueId).toBe(IssueId.make("a"));
    expect(result?.statusId).toBeNull();
    expectBetween(result?.sortOrder, C.sortOrder, null);
  });

  it("reorders upwards, landing in front of the card it was dropped on", () => {
    const result = drop("c", card("a"));
    expect(result?.statusId).toBeNull();
    expectBetween(result?.sortOrder, null, A.sortOrder);
  });

  it("ignores the edge inside a column, because the sortable preview already chose the slot", () => {
    expect(drop("a", card("c"), "before")?.sortOrder).toBe(
      drop("a", card("c"), "after")?.sortOrder,
    );
  });

  it("sets the status and the key in one drop across columns", () => {
    const result = drop("a", card("e"), "after");
    expect(result?.issueId).toBe(IssueId.make("a"));
    expect(result?.statusId).toBe(DOING.id);
    expectBetween(result?.sortOrder, E.sortOrder, null);
  });

  it("honours the edge across columns, where nothing animated to imply a slot", () => {
    const result = drop("a", card("e"), "before");
    expect(result?.statusId).toBe(DOING.id);
    expectBetween(result?.sortOrder, D.sortOrder, E.sortOrder);
  });

  it("defaults to before when the caller passes no edge", () => {
    expect(drop("a", card("e"))?.sortOrder).toBe(drop("a", card("e"), "before")?.sortOrder);
  });

  it("appends when the drop lands on a column's tail", () => {
    const result = drop("a", tail("doing"));
    expect(result?.statusId).toBe(DOING.id);
    expectBetween(result?.sortOrder, E.sortOrder, null);
  });

  it("moves into an empty column", () => {
    const result = drop("a", tail("done"));
    expect(result?.statusId).toBe(DONE.id);
    expect(result?.sortOrder).toBeTypeOf("string");
  });

  it("appends within its own column, measured against the siblings it left behind", () => {
    const result = drop("a", tail("todo"));
    expect(result?.statusId).toBeNull();
    expectBetween(result?.sortOrder, C.sortOrder, null);
  });

  it("writes nothing when the card lands where it already was", () => {
    expect(drop("a", card("a"))).toBeNull();
    expect(drop("c", tail("todo"))).toBeNull();
    // b over b's own slot: arrayMove(1 → 1) is the identity.
    expect(drop("b", card("b"))).toBeNull();
  });

  it("writes nothing when there is no drop target", () => {
    expect(drop("a", null)).toBeNull();
  });

  it("refuses an active id that is not a card, or a card the board does not hold", () => {
    expect(
      resolveIssuesBoardDrop({
        columns: COLUMNS,
        activeId: tail("todo"),
        overId: card("a"),
        sortMode: "manual",
      }),
    ).toBeNull();
    expect(
      resolveIssuesBoardDrop({
        columns: COLUMNS,
        activeId: "junk",
        overId: card("a"),
        sortMode: "manual",
      }),
    ).toBeNull();
    expect(drop("ghost", card("a"))).toBeNull();
  });

  it("refuses an over id that names nothing on the board", () => {
    expect(drop("a", "junk")).toBeNull();
    expect(drop("a", card("ghost"))).toBeNull();
    expect(drop("a", tail("archived"))).toBeNull();
  });

  it("refuses rather than break the order when no key fits after the last card", () => {
    const columns = board([
      [TODO, [issue("a", { sortOrder: "b" }), issue("z", { sortOrder: "Z9" })]],
      [DOING, []],
    ]);
    expect(
      resolveIssuesBoardDrop({
        columns,
        activeId: issuesBoardCardDragId(IssueId.make("a")),
        overId: issuesBoardColumnDropId(TODO.id),
        sortMode: "manual",
      }),
    ).toBeNull();
  });

  it("resolves against the filtered board, so a hidden card is never a neighbour", () => {
    const columns = board(
      [
        [
          TODO,
          [
            issue("a", { sortOrder: "b", projectId: ProjectId.make("p1") }),
            issue("hidden", { sortOrder: "j" }),
            issue("c", { sortOrder: "t", projectId: ProjectId.make("p1") }),
          ],
        ],
        [DOING, []],
      ],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "project", ["p1"]),
    );
    expect(columnIssueIds(columns, "todo")).toEqual([IssueId.make("a"), IssueId.make("c")]);
    const result = resolveIssuesBoardDrop({
      columns,
      activeId: issuesBoardCardDragId(IssueId.make("c")),
      overId: issuesBoardCardDragId(IssueId.make("a")),
      sortMode: "manual",
    });
    expectBetween(result?.sortOrder, null, "b");
  });

  it("carries a label-filtered card across columns unchanged in every other respect", () => {
    const bug = IssueLabelId.make("bug");
    const columns = board(
      [
        [TODO, [issue("a", { labelIds: [bug] }), issue("b")]],
        [DONE, []],
      ],
      withIssuesFilterValues(NO_ISSUES_LIST_FILTER, "label", [bug]),
    );
    const result = resolveIssuesBoardDrop({
      columns,
      activeId: issuesBoardCardDragId(IssueId.make("a")),
      overId: issuesBoardColumnDropId(DONE.id),
      sortMode: "manual",
    });
    expect(result).toEqual({
      issueId: IssueId.make("a"),
      sortOrder: result?.sortOrder,
      statusId: DONE.id,
    });
  });
});

/**
 * A drop reads the keys of the cards it landed between, so it only names a slot while the column
 * is in key order. These are the drags that used to write anyway.
 */
describe("a board ordered by anything but the manual key", () => {
  // Manual order a < b < c; every other axis reverses it, so a slot read off the screen is a slot
  // in the wrong array.
  const A = issue("a", { sortOrder: "b", updatedAt: "2026-01-01T00:00:00.000Z", priority: "low" });
  const B = issue("b", { sortOrder: "m", updatedAt: "2026-02-01T00:00:00.000Z", priority: "high" });
  const C = issue("c", {
    sortOrder: "y",
    updatedAt: "2026-03-01T00:00:00.000Z",
    priority: "urgent",
  });

  const columnsFor = (sortMode: "manual" | "updated" | "priority") =>
    issuesBoardColumns(
      buildIssuesView({
        grouping: grouping([[TODO, [A, B, C]]]),
        filter: NO_ISSUES_LIST_FILTER,
        today: TODAY,
        groupBy: "status",
        sortMode,
      }),
    );

  it("renders the column in the order that was asked for", () => {
    expect(columnIssueIds(columnsFor("manual"), "todo")).toEqual(["a", "b", "c"]);
    expect(columnIssueIds(columnsFor("updated"), "todo")).toEqual(["c", "b", "a"]);
    expect(columnIssueIds(columnsFor("priority"), "todo")).toEqual(["c", "b", "a"]);
  });

  it("is not sortable, so the cards never enter the drag registries", () => {
    expect(isIssuesBoardSortable("manual")).toBe(true);
    for (const sortMode of ["updated", "created", "priority"] as const) {
      expect(isIssuesBoardSortable(sortMode)).toBe(false);
    }
  });

  // Displayed c, b, a. Dragging `a` to the top used to resolve against siblings [c, b] — keys
  // "y" then "m" — and write "m", which is `b`'s own key: a duplicate that leaves the manual
  // order untouched while `updatedAt` sends the card to the top of the column regardless.
  it("writes nothing rather than a key read off neighbours that are not in key order", () => {
    for (const sortMode of ["updated", "priority"] as const) {
      expect(
        resolveIssuesBoardDrop({
          columns: columnsFor(sortMode),
          activeId: issuesBoardCardDragId(A.id),
          overId: issuesBoardCardDragId(C.id),
          sortMode,
        }),
      ).toBeNull();
    }
  });

  it("refuses the tail and the cross-column drop too, not just the reorder", () => {
    expect(
      resolveIssuesBoardDrop({
        columns: columnsFor("updated"),
        activeId: issuesBoardCardDragId(A.id),
        overId: issuesBoardColumnDropId(TODO.id),
        sortMode: "updated",
      }),
    ).toBeNull();
  });

  // The same gesture on the same board, with only the ordering changed: this is the drop the
  // guard is protecting, and it still has to land.
  it("still writes under manual order", () => {
    const result = resolveIssuesBoardDrop({
      columns: columnsFor("manual"),
      activeId: issuesBoardCardDragId(C.id),
      overId: issuesBoardCardDragId(A.id),
      sortMode: "manual",
    });
    expect(result?.issueId).toBe(C.id);
    expectBetween(result?.sortOrder, null, A.sortOrder);
  });
});
