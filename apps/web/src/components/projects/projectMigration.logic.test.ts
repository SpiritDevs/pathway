import { describe, expect, it } from "vite-plus/test";

import {
  matchMapping,
  matchesAreComplete,
  normalizeMatchName,
  proposeMatches,
  unmatchedSourceIds,
} from "./projectMigration.logic";

describe("migration name normalisation", () => {
  it("ignores case, spacing, and punctuation", () => {
    expect(normalizeMatchName("In Progress")).toBe(normalizeMatchName("in-progress"));
    expect(normalizeMatchName("To Do")).toBe(normalizeMatchName("todo"));
    expect(normalizeMatchName("Won't fix")).toBe(normalizeMatchName("wontfix"));
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeMatchName("Done")).not.toBe(normalizeMatchName("Dropped"));
  });
});

describe("migration match proposals", () => {
  const source = [
    { id: "s-todo", name: "Todo", category: "unstarted" },
    { id: "s-doing", name: "In Progress", category: "started" },
    { id: "s-done", name: "Done", category: "completed" },
    { id: "s-icebox", name: "Icebox", category: "backlog" },
  ];

  it("takes an exact name over anything else", () => {
    const matches = proposeMatches(source, [
      { id: "t-done", name: "Done", category: "completed" },
      { id: "t-complete", name: "Complete", category: "completed" },
    ]);
    expect(matches.find((match) => match.sourceId === "s-done")).toEqual({
      sourceId: "s-done",
      targetId: "t-done",
      confidence: "exact",
    });
  });

  it("matches through case and punctuation differences", () => {
    const matches = proposeMatches(source, [{ id: "t-doing", name: "in-progress" }]);
    expect(matches.find((match) => match.sourceId === "s-doing")).toEqual({
      sourceId: "s-doing",
      targetId: "t-doing",
      confidence: "close",
    });
  });

  it("falls back to an unambiguous category match", () => {
    const matches = proposeMatches(source, [
      { id: "t-backlog", name: "Someday", category: "backlog" },
    ]);
    expect(matches.find((match) => match.sourceId === "s-icebox")).toEqual({
      sourceId: "s-icebox",
      targetId: "t-backlog",
      confidence: "close",
    });
  });

  it("refuses a category match when more than one candidate would fit", () => {
    const matches = proposeMatches(
      [{ id: "s-icebox", name: "Icebox", category: "backlog" }],
      [
        { id: "t-a", name: "Someday", category: "backlog" },
        { id: "t-b", name: "Maybe", category: "backlog" },
      ],
    );
    // Two plausible homes is not a decision this can make for someone.
    expect(matches[0]?.targetId).toBeNull();
  });

  it("never claims one destination twice", () => {
    const matches = proposeMatches(
      [
        { id: "s-done", name: "Done" },
        { id: "s-shipped", name: "done" },
      ],
      [{ id: "t-done", name: "Done" }],
    );
    expect(matches[0]).toMatchObject({ targetId: "t-done", confidence: "exact" });
    // The second would normalise to the same target; collapsing them would hide that nobody chose.
    expect(matches[1]?.targetId).toBeNull();
  });

  it("leaves a value with no plausible home unmatched", () => {
    const matches = proposeMatches(
      [{ id: "s-odd", name: "Blocked externally" }],
      [{ id: "t-todo", name: "Todo" }],
    );
    expect(matches).toEqual([{ sourceId: "s-odd", targetId: null, confidence: "none" }]);
  });

  it("returns one proposal per source value, in order", () => {
    const matches = proposeMatches(source, []);
    expect(matches.map((match) => match.sourceId)).toEqual([
      "s-todo",
      "s-doing",
      "s-done",
      "s-icebox",
    ]);
  });
});

describe("migration readiness", () => {
  it("is incomplete while any source value is unmapped", () => {
    const matches = [
      { sourceId: "a", targetId: "x", confidence: "exact" as const },
      { sourceId: "b", targetId: null, confidence: "none" as const },
    ];
    expect(matchesAreComplete(matches)).toBe(false);
    expect(unmatchedSourceIds(matches)).toEqual(["b"]);
  });

  it("produces the id pairs the move takes once every row is decided", () => {
    const matches = [
      { sourceId: "a", targetId: "x", confidence: "exact" as const },
      { sourceId: "b", targetId: "y", confidence: "close" as const },
    ];
    expect(matchesAreComplete(matches)).toBe(true);
    expect(matchMapping(matches)).toEqual([
      { from: "a", to: "x" },
      { from: "b", to: "y" },
    ]);
  });
});
