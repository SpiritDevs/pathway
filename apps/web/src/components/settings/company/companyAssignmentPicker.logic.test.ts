import { describe, expect, it } from "vite-plus/test";

import {
  applyVisibleAssignmentDelta,
  assignmentSelectionSummary,
  filterAssignmentItems,
  matchesAssignmentSearch,
  normalizeAssignmentSearch,
  type CompanyAssignmentPickerItem,
} from "./companyAssignmentPicker.logic";

const items = [
  {
    id: "ada",
    primaryLabel: "Ada Lovelace",
    secondaryLabel: "ada@example.com",
    searchableText: "Ada Lovelace ada@example.com",
    status: "active",
    selected: false,
    mayAdd: true,
    mayRemove: false,
  },
  {
    id: "grace",
    primaryLabel: "Grace Hopper",
    secondaryLabel: "grace@navy.example",
    searchableText: "Grace Hopper grace@navy.example",
    status: "locked",
    selected: true,
    mayAdd: false,
    mayRemove: true,
  },
  {
    id: "retired",
    primaryLabel: "Retired team",
    secondaryLabel: "Historical work",
    searchableText: "Retired team Historical work",
    status: "archived",
    statusLabel: "Archived",
    selected: true,
    mayAdd: false,
    mayRemove: true,
  },
] satisfies ReadonlyArray<CompanyAssignmentPickerItem>;

describe("company assignment picker logic", () => {
  it("normalizes whitespace and matches every case-insensitive token across labels", () => {
    expect(normalizeAssignmentSearch("  ADA   Example.COM ")).toBe("ada example.com");
    expect(matchesAssignmentSearch(items[0]!.searchableText, "LOVE  ADA@EXAMPLE")).toBe(true);
    expect(matchesAssignmentSearch(items[0]!.searchableText, "Ada navy")).toBe(false);
  });

  it("composes assignment and membership-state filters without reordering", () => {
    expect(
      filterAssignmentItems(items, { query: "", assignment: "selected", status: "locked" }).map(
        (item) => item.id,
      ),
    ).toEqual(["grace"]);
    expect(
      filterAssignmentItems(items, { query: "", assignment: "all", status: "all" }).map(
        (item) => item.id,
      ),
    ).toEqual(["ada", "grace", "retired"]);
  });

  it("counts selected, visible, eligible, and removable options", () => {
    const summary = assignmentSelectionSummary(items, items.slice(0, 2));
    expect(summary).toMatchObject({ total: 3, visible: 2, selected: 2, visibleSelected: 1 });
    expect(summary.addIds).toEqual(["ada"]);
    expect(summary.removeIds).toEqual(["grace"]);
  });

  it("selects and clears only visible eligible ids, preserving hidden selections", () => {
    const selected = new Set(["hidden", "grace"]);
    expect([
      ...applyVisibleAssignmentDelta(selected, { addIds: ["ada"], removeIds: ["grace"] }),
    ]).toEqual(["hidden", "ada"]);
  });

  it("detects the 500-change limit", () => {
    const base = items[0]!;
    const many: ReadonlyArray<CompanyAssignmentPickerItem> = Array.from(
      { length: 501 },
      (_, index) => ({ ...base, id: `member-${index}` }),
    );
    expect(assignmentSelectionSummary(many, many).addOverLimit).toBe(true);
  });

  it("keeps a selected archived team visible and removable", () => {
    const visible = filterAssignmentItems(items, {
      query: "retired historical",
      assignment: "selected",
    });
    expect(visible).toEqual([expect.objectContaining({ id: "retired", mayRemove: true })]);
  });

  it("produces an empty result and returns to the source state when filters reset", () => {
    expect(filterAssignmentItems(items, { query: "nobody", assignment: "all" })).toEqual([]);
    expect(filterAssignmentItems(items, { query: "", assignment: "all" })).toEqual(items);
  });
});
