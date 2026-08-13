/**
 * Everything the Email analytics view decides that does not need the DOM: the range presets, the
 * bucket grid, the axis scale, and the empty test.
 *
 * The load-bearing part is the bucket grid. `email.analytics` groups with SQLite's
 * `strftime('%Y-%m-%dT%H:00:00.000Z', received_at)` and returns *only* the buckets that had mail,
 * so a quiet Tuesday is absent rather than zero. A chart drawn straight off that array would put
 * Monday next to Wednesday and lie about the shape of the week. So the client owns the grid: it
 * derives every bucket start in the window and joins the server's counts onto it, filling the gaps
 * with zero.
 *
 * That grid is built in **UTC** because the server truncates in UTC. Bucketing locally would land
 * the client's slots between the server's, and every join would miss. It is why the view labels its
 * buckets UTC rather than quietly renaming them to local time.
 *
 * @module components/email/emailAnalytics.logic
 */
import type {
  EmailAnalyticsInput,
  EmailAnalyticsInterval,
  EmailAnalyticsResult,
  EmailInboxScope,
  EmailProjectMessageCount,
  EmailVolumePoint,
  ProjectId,
} from "@t3tools/contracts";

// ── Ranges ─────────────────────────────────────────────────────────────

/** Modest by design: eight rows read at a glance, and the server caps the request anyway. */
export const TOP_EMAIL_ADDRESS_LIMIT = 8;

export const EMAIL_ANALYTICS_RANGE_IDS = ["24h", "7d", "30d"] as const;
export type EmailAnalyticsRangeId = (typeof EMAIL_ANALYTICS_RANGE_IDS)[number];

export interface EmailAnalyticsRange {
  readonly id: EmailAnalyticsRangeId;
  /** Reads after "Last": "Last 7 days". */
  readonly label: string;
  readonly interval: EmailAnalyticsInterval;
  readonly bucketCount: number;
}

/**
 * The interval is not a separate control: `EmailAnalyticsInterval` has exactly two members, and
 * which one a range wants is decided by the range. Hours over a month would be 720 columns.
 */
export const EMAIL_ANALYTICS_RANGES: ReadonlyArray<EmailAnalyticsRange> = Object.freeze([
  { id: "24h", label: "24 hours", interval: "hour", bucketCount: 24 },
  { id: "7d", label: "7 days", interval: "day", bucketCount: 7 },
  { id: "30d", label: "30 days", interval: "day", bucketCount: 30 },
] as const);

/** A week of days: long enough to have a shape, short enough that every column is readable. */
export const DEFAULT_EMAIL_ANALYTICS_RANGE: EmailAnalyticsRange = Object.freeze({
  id: "7d",
  label: "7 days",
  interval: "day",
  bucketCount: 7,
} as const);

export function emailAnalyticsRange(id: string | undefined): EmailAnalyticsRange {
  // Every caller has to get a range back, so an unknown id reads as the default rather than as an
  // empty chart nobody can leave.
  return EMAIL_ANALYTICS_RANGES.find((range) => range.id === id) ?? DEFAULT_EMAIL_ANALYTICS_RANGE;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function emailBucketDurationMs(interval: EmailAnalyticsInterval): number {
  return interval === "hour" ? HOUR_MS : DAY_MS;
}

// ── Window ─────────────────────────────────────────────────────────────

export interface EmailAnalyticsWindow {
  readonly range: EmailAnalyticsRange;
  /** Inclusive; the server compares `received_at >= from`. */
  readonly from: string;
  /** Exclusive; the server compares `received_at < to`. */
  readonly to: string;
  /** Every bucket start in the window, oldest first — the grid the counts are joined onto. */
  readonly bucketStarts: ReadonlyArray<string>;
}

/**
 * The window for a range as of `now`.
 *
 * Both edges snap to a bucket boundary, and `to` is the *end* of the bucket `now` falls in, so the
 * current hour or day is a full column rather than a stub that shrinks the more you look at it.
 *
 * Flooring epoch milliseconds is what makes this UTC: the epoch starts at a UTC midnight and a UTC
 * day is always exactly 24h, so no calendar arithmetic is needed and no DST seam can appear.
 */
export function deriveEmailAnalyticsWindow(
  rangeId: string | undefined,
  now: Date,
): EmailAnalyticsWindow {
  const range = emailAnalyticsRange(rangeId);
  const size = emailBucketDurationMs(range.interval);
  const nowMs = Number.isNaN(now.getTime()) ? 0 : now.getTime();
  const end = Math.floor(nowMs / size) * size + size;
  const start = end - range.bucketCount * size;
  return {
    range,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    bucketStarts: Array.from({ length: range.bucketCount }, (_, index) =>
      new Date(start + index * size).toISOString(),
    ),
  };
}

/**
 * How long the window derived as of `now` stays truthful: the ms until its exclusive `to` passes.
 *
 * The panel arms one timeout on this — a boundary alarm, not a ticking clock — so a view left open
 * across an hour or UTC-day boundary re-derives its window instead of requesting the original `to`
 * forever and silently excluding everything captured after it.
 */
export function emailWindowAdvanceDelayMs(window: EmailAnalyticsWindow, now: Date): number {
  const nowMs = now.getTime();
  const toMs = Date.parse(window.to);
  if (Number.isNaN(nowMs) || Number.isNaN(toMs)) return 0;
  return Math.max(0, toMs - nowMs);
}

/** The request for one scope over one window. Scope comes from the URL; the window from the range. */
export function emailAnalyticsInput(
  scope: EmailInboxScope,
  window: EmailAnalyticsWindow,
): EmailAnalyticsInput {
  return {
    scope,
    from: window.from,
    to: window.to,
    interval: window.range.interval,
    topAddressLimit: TOP_EMAIL_ADDRESS_LIMIT,
  };
}

// ── Buckets ────────────────────────────────────────────────────────────

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function utcDayLabel(at: Date): string {
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** The axis tick: as short as it can be, because thirty of them share one row. */
export function formatEmailBucketLabel(iso: string, interval: EmailAnalyticsInterval): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return interval === "hour" ? `${String(at.getUTCHours()).padStart(2, "0")}:00` : utcDayLabel(at);
}

/** The tooltip and table form: names the whole bucket, and says which clock it is on. */
export function formatEmailBucketRangeLabel(iso: string, interval: EmailAnalyticsInterval): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  if (interval === "day") return `${utcDayLabel(at)} UTC`;
  const next = new Date(at.getTime() + HOUR_MS);
  const hour = (value: Date) => `${String(value.getUTCHours()).padStart(2, "0")}:00`;
  return `${utcDayLabel(at)}, ${hour(at)}–${hour(next)} UTC`;
}

export interface EmailVolumeBucket {
  readonly bucketStart: string;
  readonly label: string;
  readonly messageCount: number;
}

/**
 * The server's counts joined onto the window's grid.
 *
 * A bucket the server did not return is a bucket with no mail, not a gap: it is filled with zero so
 * the columns stay evenly spaced in time.
 */
export function fillEmailVolumeBuckets(
  window: EmailAnalyticsWindow,
  points: ReadonlyArray<EmailVolumePoint>,
): ReadonlyArray<EmailVolumeBucket> {
  const counts = new Map(points.map((point) => [point.bucketStart, point.messageCount]));
  return window.bucketStarts.map((bucketStart) => ({
    bucketStart,
    label: formatEmailBucketLabel(bucketStart, window.range.interval),
    messageCount: counts.get(bucketStart) ?? 0,
  }));
}

/** The tallest column, or `-1` when the window is silent. Ties go to the earliest bucket. */
export function emailPeakBucketIndex(buckets: ReadonlyArray<EmailVolumeBucket>): number {
  let peakIndex = -1;
  let peakCount = 0;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.messageCount > peakCount) {
      peakIndex = index;
      peakCount = bucket.messageCount;
    }
  }
  return peakIndex;
}

// ── Axes ───────────────────────────────────────────────────────────────

const AXIS_FACTORS = [1, 2, 2.5, 5, 10] as const;

/** The smallest clean step at or above `raw`. Message counts are integers, so the step is too. */
function niceAxisStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const factor of AXIS_FACTORS) {
    const step = factor * magnitude;
    if (Number.isInteger(step) && step >= raw) return step;
  }
  return Math.max(1, Math.round(10 * magnitude));
}

export interface EmailVolumeAxis {
  readonly max: number;
  readonly ticks: ReadonlyArray<number>;
}

/**
 * The y scale for a peak.
 *
 * `max` is deliberately one whole step *above* the peak rather than equal to it: the tallest column
 * then stops short of the top, which leaves room for the value label that sits on its cap and keeps
 * the chart from reading as clipped.
 */
export function emailVolumeAxis(peak: number, divisions = 4): EmailVolumeAxis {
  const safe = Number.isFinite(peak) && peak > 0 ? Math.ceil(peak) : 0;
  const step = niceAxisStep(safe / divisions);
  const max = step * (Math.floor(safe / step) + 1);
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

/** How many buckets share one printed tick, so thirty columns do not print thirty labels. */
export function emailAxisLabelStride(bucketCount: number, maxLabels = 8): number {
  if (bucketCount <= maxLabels || maxLabels < 1) return 1;
  return Math.ceil(bucketCount / maxLabels);
}

/** Labels are counted back from the newest bucket, so the right edge is always named. */
export function isEmailAxisLabelled(index: number, bucketCount: number, stride: number): boolean {
  if (stride <= 1) return true;
  return (bucketCount - 1 - index) % stride === 0;
}

/** A mark's length as a percentage of the track. Zero never draws, so a 0 stays visibly absent. */
export function emailBarPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.round((value / max) * 1000) / 10);
}

// ── Result shape ───────────────────────────────────────────────────────

export function emailVolumeTotal(points: ReadonlyArray<EmailVolumePoint>): number {
  return points.reduce((total, point) => total + point.messageCount, 0);
}

/**
 * Whether the scope captured nothing in the window.
 *
 * Read off `volumeOverTime` rather than off `captureLatency.messageCount`: both are computed from
 * the same filtered rows, and volume is the series the headline chart draws, so the empty state and
 * the chart can never disagree.
 */
export function isEmailAnalyticsEmpty(result: EmailAnalyticsResult): boolean {
  return emailVolumeTotal(result.volumeOverTime) === 0;
}

/**
 * The per-project breakdown only means something across every inbox. Inside one project it is a
 * single row restating the total, which is the one-bar bar chart worth not drawing.
 */
export function showsEmailProjectBreakdown(scope: EmailInboxScope): boolean {
  return scope.type === "all";
}

/** A null `projectId` is the Unassigned inbox, not a missing name. */
export function emailProjectCountLabel(
  row: EmailProjectMessageCount,
  projectTitles: ReadonlyMap<ProjectId, string>,
): string {
  if (row.projectId === null) return "Unassigned";
  return projectTitles.get(row.projectId) ?? row.mailSlug ?? row.projectId;
}
