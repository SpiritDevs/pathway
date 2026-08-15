import { describe, expect, it } from "vite-plus/test";

import {
  changeRetainUntil,
  clampPageLimit,
  isCursorExpired,
  measureSerializedBytes,
  readBoundedRows,
  SYNC_READ_CHUNK_ROWS,
  takeChangePage,
} from "./changeFeed.ts";
import {
  SYNC_FEED_RETENTION_MS,
  SYNC_MAX_CHANGE_PAGE_BYTES,
  SYNC_MAX_CHANGES_PER_PAGE,
} from "./protocol.ts";

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

describe("readBoundedRows", () => {
  interface SizedRow {
    readonly index: number;
    readonly bytes: number;
  }

  /** A table of `total` rows, each `bytes` big, that records how many rows each read asked for. */
  function source(total: number, bytes: number) {
    const requested: number[] = [];
    const read = (after: SizedRow | undefined, limit: number) => {
      requested.push(limit);
      const from = after === undefined ? 0 : after.index + 1;
      return Promise.resolve(
        Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, offset) => ({
          index: from + offset,
          bytes,
        })),
      );
    };
    return { requested, read, sizeOf: (row: SizedRow) => row.bytes };
  }

  it("fills the row ceiling in chunks and never asks for more than it may keep", async () => {
    const table = source(100, 10);

    const result = await readBoundedRows({
      maxRows: 20,
      maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      sizeOf: table.sizeOf,
      read: table.read,
    });

    expect(result.rows).toHaveLength(20);
    expect(result.exhausted).toBe(false);
    expect(Math.max(...table.requested)).toBeLessThanOrEqual(SYNC_READ_CHUNK_ROWS);
    expect(table.requested.reduce((sum, limit) => sum + limit, 0)).toBe(20);
  });

  it("reports exhaustion when the source runs out before either ceiling", async () => {
    const table = source(5, 10);

    const result = await readBoundedRows({
      maxRows: 100,
      maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      sizeOf: table.sizeOf,
      read: table.read,
    });

    expect(result.rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.bytes).toBe(50);
    expect(result.exhausted).toBe(true);
  });

  // The regression this exists for: a fixed hundred-row fetch of change documents reads whatever
  // those hundred rows happen to weigh, which for a stretch of large payloads is tens of megabytes
  // — past the transaction read limit, for every client whose cursor sits before that stretch.
  it("stops on the byte ceiling long before the row ceiling", async () => {
    const table = source(SYNC_MAX_CHANGES_PER_PAGE, 100_000);

    const result = await readBoundedRows({
      maxRows: SYNC_MAX_CHANGES_PER_PAGE,
      maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      sizeOf: table.sizeOf,
      read: table.read,
    });

    expect(result.rows.length).toBeLessThan(SYNC_MAX_CHANGES_PER_PAGE);
    // Only just past the ceiling: the overshoot is one chunk sized from the rows already measured,
    // which is what lets the caller see that more work remains.
    expect(result.bytes).toBeLessThan(2 * SYNC_MAX_CHANGE_PAGE_BYTES);
    expect(result.exhausted).toBe(false);
    // Nothing was read that the budget did not pay for: the whole hundred rows are 10 MiB.
    const rowsRead = table.requested.reduce((sum, limit) => sum + limit, 0);
    expect(rowsRead * 100_000).toBeLessThan(2 * SYNC_MAX_CHANGE_PAGE_BYTES);
  });

  it("still reads one row when a single row is bigger than the whole budget", async () => {
    const table = source(4, 4 * SYNC_MAX_CHANGE_PAGE_BYTES);

    const result = await readBoundedRows({
      maxRows: SYNC_MAX_CHANGES_PER_PAGE,
      maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      chunkSize: 1,
      sizeOf: table.sizeOf,
      read: table.read,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.exhausted).toBe(false);
  });

  it("clamps a zero row ceiling up to one, so a caller cannot spin on an empty read", async () => {
    const table = source(10, 10);

    const result = await readBoundedRows({
      maxRows: 0,
      maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      sizeOf: table.sizeOf,
      read: table.read,
    });

    expect(result.rows).toHaveLength(1);
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
