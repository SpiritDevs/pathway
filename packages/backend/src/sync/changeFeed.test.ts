import { describe, expect, it } from "vite-plus/test";

import {
  changeRetainUntil,
  clampPageLimit,
  isCursorExpired,
  measureSerializedBytes,
  takeChangePage,
} from "./changeFeed.ts";
import { SYNC_FEED_RETENTION_MS, SYNC_MAX_CHANGES_PER_PAGE } from "./protocol.ts";

interface Row {
  readonly version: number;
  readonly teamId: string | null;
}

const rows: readonly Row[] = [
  { version: 1, teamId: null },
  { version: 2, teamId: "team-a" },
  { version: 3, teamId: "team-b" },
  { version: 4, teamId: null },
];

const size = () => 10;

describe("takeChangePage", () => {
  it("returns visible rows and a cursor at the last row it consumed", () => {
    const page = takeChangePage(rows, 0, { sizeOf: size, isVisible: () => true });

    expect(page.changes.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(page.cursor).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it("advances the cursor over rows the caller may not read", () => {
    const page = takeChangePage(rows, 0, {
      sizeOf: size,
      isVisible: (row) => row.teamId === "team-a",
    });

    expect(page.changes.map((row) => row.version)).toEqual([2]);
    expect(page.cursor).toBe(4);
  });

  it("still advances the cursor when filtering empties the page", () => {
    const page = takeChangePage(rows, 0, { sizeOf: size, isVisible: () => false });

    expect(page.changes).toEqual([]);
    expect(page.cursor).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it("stops at the row ceiling and reports more work", () => {
    const page = takeChangePage(rows, 0, { sizeOf: size, isVisible: () => true, maxRows: 2 });

    expect(page.changes.map((row) => row.version)).toEqual([1, 2]);
    expect(page.cursor).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("stops before the row that would cross the byte ceiling", () => {
    const page = takeChangePage(rows, 0, { sizeOf: size, isVisible: () => true, maxBytes: 25 });

    expect(page.changes.map((row) => row.version)).toEqual([1, 2]);
    expect(page.cursor).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("always delivers the first visible row, even when it alone exceeds the byte ceiling", () => {
    const page = takeChangePage(rows, 0, {
      sizeOf: () => 5_000,
      isVisible: () => true,
      maxBytes: 100,
    });

    expect(page.changes.map((row) => row.version)).toEqual([1]);
    expect(page.hasMore).toBe(true);
    // Reported rather than silently shipped: the row goes out because the feed would otherwise
    // wedge, and the caller logs that the page went over budget.
    expect(page.oversizedRow).toEqual({ version: 1, bytes: 5_000 });
    // The cursor moved past it, so the next drain never sees it again.
    expect(page.cursor).toBe(1);
  });

  it("does not pair an oversized row with anything else", () => {
    const page = takeChangePage(rows, 0, {
      sizeOf: (row) => (row.version === 1 ? 5_000 : 1),
      isVisible: () => true,
      maxBytes: 100,
    });

    expect(page.changes.map((row) => row.version)).toEqual([1]);
  });

  it("reports no oversized row on an ordinary page", () => {
    const page = takeChangePage(rows, 0, { sizeOf: size, isVisible: () => true });

    expect(page.oversizedRow).toBeNull();
  });

  it("never returns an empty page at the same cursor with more work waiting", () => {
    const page = takeChangePage(rows, 0, {
      sizeOf: size,
      isVisible: () => true,
      maxRows: clampPageLimit(0, SYNC_MAX_CHANGES_PER_PAGE),
    });

    expect(page.changes).not.toEqual([]);
    expect(page.cursor).toBeGreaterThan(0);
  });

  it("keeps the incoming cursor when there is nothing to read", () => {
    const page = takeChangePage([], 12, { sizeOf: size, isVisible: () => true });

    expect(page).toEqual({ changes: [], cursor: 12, hasMore: false, oversizedRow: null });
  });
});

describe("clampPageLimit", () => {
  it("clamps a zero or negative limit up to one row", () => {
    expect(clampPageLimit(0, SYNC_MAX_CHANGES_PER_PAGE)).toBe(1);
    expect(clampPageLimit(-5, SYNC_MAX_CHANGES_PER_PAGE)).toBe(1);
  });

  it("clamps down to the ceiling and truncates fractions", () => {
    expect(clampPageLimit(SYNC_MAX_CHANGES_PER_PAGE + 1, SYNC_MAX_CHANGES_PER_PAGE)).toBe(
      SYNC_MAX_CHANGES_PER_PAGE,
    );
    expect(clampPageLimit(2.9, SYNC_MAX_CHANGES_PER_PAGE)).toBe(2);
    expect(clampPageLimit(0.4, SYNC_MAX_CHANGES_PER_PAGE)).toBe(1);
  });

  it("falls back to the ceiling for an absent or non-finite limit", () => {
    expect(clampPageLimit(undefined, SYNC_MAX_CHANGES_PER_PAGE)).toBe(SYNC_MAX_CHANGES_PER_PAGE);
    expect(clampPageLimit(Number.NaN, SYNC_MAX_CHANGES_PER_PAGE)).toBe(SYNC_MAX_CHANGES_PER_PAGE);
    expect(clampPageLimit(Number.POSITIVE_INFINITY, SYNC_MAX_CHANGES_PER_PAGE)).toBe(
      SYNC_MAX_CHANGES_PER_PAGE,
    );
  });
});

describe("measureSerializedBytes", () => {
  it("counts UTF-8 bytes rather than string length", () => {
    // Three bytes per character in UTF-8, one JS string character each.
    const payload = { title: "課題課題課題" };

    expect(JSON.stringify(payload).length).toBe(18);
    expect(measureSerializedBytes(payload)).toBe(30);
  });

  it("counts an absent payload as the null it serializes to", () => {
    expect(measureSerializedBytes(undefined)).toBe(4);
  });
});

describe("isCursorExpired", () => {
  it("accepts a cursor sitting exactly one below the oldest retained change", () => {
    expect(isCursorExpired(9, 10)).toBe(false);
  });

  it("expires a cursor with a gap it can never fill", () => {
    expect(isCursorExpired(8, 10)).toBe(true);
  });
});

describe("changeRetainUntil", () => {
  it("retains changes for ninety days", () => {
    expect(changeRetainUntil(1_000)).toBe(1_000 + SYNC_FEED_RETENTION_MS);
    expect(SYNC_FEED_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});
