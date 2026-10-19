import { describe, expect, it } from "@effect/vitest";

import {
  compareSyncOrder,
  sortBySyncOrder,
  syncOrderKeyAfter,
  syncOrderKeyBetween,
} from "./orderKey.ts";

describe("sync order keys", () => {
  it("produces a key strictly between two neighbours", () => {
    const first = syncOrderKeyAfter(null);
    const second = syncOrderKeyAfter(first);
    const between = syncOrderKeyBetween(first, second);

    expect(between).not.toBeNull();
    expect(first < (between ?? "")).toBe(true);
    expect((between ?? "") < second).toBe(true);
  });

  it("keeps appending after a key it cannot parse", () => {
    const appended = syncOrderKeyAfter("not-a-key");

    expect(appended > "not-a-key").toBe(true);
  });

  it("refuses to invent a key for reversed neighbours", () => {
    expect(syncOrderKeyBetween("nn", "n")).toBeNull();
  });

  it("breaks equal keys by entity id so every client agrees", () => {
    const rows = [
      { id: "note-c", orderKey: "n" },
      { id: "note-a", orderKey: "n" },
      { id: "note-b", orderKey: "m" },
    ];

    expect(sortBySyncOrder(rows).map((row) => row.id)).toEqual(["note-b", "note-a", "note-c"]);
    expect(compareSyncOrder(rows[0]!, rows[0]!)).toBe(0);
  });
});
