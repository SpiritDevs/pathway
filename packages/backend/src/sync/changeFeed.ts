/**
 * Change-feed paging and retention.
 *
 * The cursor is a company version, not a row offset, and it advances over rows the caller may not
 * see. A page that permission-filtering empties still moves the cursor; otherwise a member who
 * cannot read one busy team would re-read the same window forever.
 *
 * @module sync/changeFeed
 */
import {
  SYNC_FEED_RETENTION_MS,
  SYNC_MAX_CHANGE_PAGE_BYTES,
  SYNC_MAX_CHANGES_PER_PAGE,
} from "./protocol.ts";

export interface ChangeFeedRow {
  readonly version: number;
}

export interface ChangePageOptions<Row extends ChangeFeedRow> {
  /** UTF-8 byte cost of the row as it will be serialized to the client, envelope included. */
  readonly sizeOf: (row: Row) => number;
  /** Current authorization applied to the row; false drops the payload but not the cursor. */
  readonly isVisible: (row: Row) => boolean;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

export interface ChangePage<Row extends ChangeFeedRow> {
  readonly changes: readonly Row[];
  /** Version the client persists; every row at or below it has been delivered or filtered away. */
  readonly cursor: number;
  /** True when the scan stopped on a ceiling rather than running out of rows. */
  readonly hasMore: boolean;
  /**
   * The single row that had to be delivered alone because it exceeds the byte ceiling by itself,
   * or `null`. Delivering it is the deliberate choice — a feed that refuses its next row can never
   * advance — but it is reported so the caller logs it instead of shipping an over-budget page in
   * silence.
   */
  readonly oversizedRow: { readonly version: number; readonly bytes: number } | null;
}

const encoder = new TextEncoder();

/**
 * Byte cost of one serialized value, counted the way the wire counts it. JS string length is a
 * count of UTF-16 code units, so measuring with it under-counts every non-ASCII character — an
 * issue title in Japanese costs three bytes a character and would blow a page budget sized in
 * `length`.
 */
export function measureSerializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value ?? null)).length;
}

/**
 * Clamps a caller-supplied page limit into `[1, max]`. The lower clamp is the load-bearing half: a
 * limit of zero with rows waiting would return an empty page at the unchanged cursor with
 * `hasMore`, and a client that drains until `hasMore` is false would loop forever.
 */
export function clampPageLimit(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return max;
  return Math.min(Math.max(1, Math.trunc(requested)), max);
}

/**
 * Consumes `rows` — already read in ascending version order from the caller's cursor — until a
 * ceiling is hit. The first visible row is always included even if it alone exceeds the byte
 * ceiling, because a feed that cannot deliver its next row is stuck; that case comes back in
 * {@link ChangePage.oversizedRow} so it is logged rather than silently repeated.
 */
export function takeChangePage<Row extends ChangeFeedRow>(
  rows: readonly Row[],
  cursor: number,
  options: ChangePageOptions<Row>,
): ChangePage<Row> {
  const maxRows = Math.max(1, Math.trunc(options.maxRows ?? SYNC_MAX_CHANGES_PER_PAGE));
  const maxBytes = options.maxBytes ?? SYNC_MAX_CHANGE_PAGE_BYTES;

  const changes: Row[] = [];
  let nextCursor = cursor;
  let bytes = 0;
  let consumed = 0;
  let oversizedRow: { readonly version: number; readonly bytes: number } | null = null;

  for (const row of rows) {
    if (!options.isVisible(row)) {
      nextCursor = row.version;
      consumed += 1;
      continue;
    }
    if (changes.length >= maxRows) break;
    const size = options.sizeOf(row);
    if (changes.length > 0 && bytes + size > maxBytes) break;
    if (changes.length === 0 && size > maxBytes) {
      oversizedRow = { version: row.version, bytes: size };
    }
    changes.push(row);
    bytes += size;
    nextCursor = row.version;
    consumed += 1;
    // An oversized row goes out on its own: pairing it with anything else would push a page
    // further past a ceiling that exists to keep the response deliverable.
    if (oversizedRow !== null) break;
  }

  return { changes, cursor: nextCursor, hasMore: consumed < rows.length, oversizedRow };
}

/**
 * Rows one database read pulls while a page is being filled. The first read happens before any row
 * has been measured, so this is also the worst case a caller can be surprised by: one operation's
 * arguments are capped at `SYNC_MAX_OPERATION_ARGS_BYTES` (512 KiB), which bounds a change payload,
 * and eight of those stay comfortably inside Convex's per-transaction read limit.
 */
export const SYNC_READ_CHUNK_ROWS = 8;

export interface BoundedReadOptions<Row> {
  /** Hard row ceiling for the whole read. */
  readonly maxRows: number;
  /** Byte ceiling for what is *read*, which is the budget a transaction actually spends. */
  readonly maxBytes: number;
  /** Rows per database read; the first read costs at most this many rows of budget. */
  readonly chunkSize?: number;
  readonly sizeOf: (row: Row) => number;
  /** Reads the next slice after `after` — `undefined` on the first call — of at most `limit` rows. */
  readonly read: (after: Row | undefined, limit: number) => Promise<readonly Row[]>;
}

export interface BoundedRead<Row> {
  readonly rows: readonly Row[];
  /** Measured size of everything read, so a caller walking several sources can share one budget. */
  readonly bytes: number;
  /** True when a read came back short: the source has nothing left past these rows. */
  readonly exhausted: boolean;
}

/**
 * Reads rows in chunks until a row or byte ceiling is reached.
 *
 * The row ceiling alone is not a bound on the work: change payloads are whole entity snapshots and
 * a description may be 100,000 characters, so a stretch of large rows makes a fixed hundred-row
 * fetch read tens of megabytes and blow the transaction's read limit — for every client whose
 * cursor sits before that stretch, on every retry, with no smaller page size to escape into. Sizing
 * later chunks from the average row seen so far keeps a run of large rows from overshooting.
 *
 * The read deliberately stops *after* crossing `maxBytes` rather than before: the extra rows let the
 * caller's pager see that more work remains and report `hasMore` honestly.
 */
export async function readBoundedRows<Row>(
  options: BoundedReadOptions<Row>,
): Promise<BoundedRead<Row>> {
  const maxRows = Math.max(1, Math.trunc(options.maxRows));
  const chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? SYNC_READ_CHUNK_ROWS));
  const rows: Row[] = [];
  let bytes = 0;

  while (rows.length < maxRows && bytes <= options.maxBytes) {
    let limit = Math.min(chunkSize, maxRows - rows.length);
    if (rows.length > 0) {
      const averageBytes = Math.max(1, Math.ceil(bytes / rows.length));
      limit = Math.min(limit, Math.max(1, Math.ceil((options.maxBytes - bytes) / averageBytes)));
    }
    const chunk = await options.read(rows[rows.length - 1], limit);
    for (const row of chunk) {
      rows.push(row);
      bytes += options.sizeOf(row);
    }
    if (chunk.length < limit) return { rows, bytes, exhausted: true };
  }

  return { rows, bytes, exhausted: false };
}

export function changeRetainUntil(now: number): number {
  return now + SYNC_FEED_RETENTION_MS;
}

/**
 * A cursor older than the retained feed cannot be caught up incrementally: the changes that would
 * have carried it forward are gone, so the client discards its replica and bootstraps.
 *
 * The client's next needed version is `cursor + 1`, so sitting exactly one below the oldest
 * retained version is still recoverable.
 */
export function isCursorExpired(cursor: number, oldestRetainedVersion: number): boolean {
  return cursor + 1 < oldestRetainedVersion;
}
