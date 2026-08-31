/**
 * Everything `/calendar`'s time grid decides without the DOM: what a mode's range is, where a day
 * and an hour sit in pixels, how overlapping events share a column, what packs into the all-day
 * lane and a month cell, and what a finished drag means.
 *
 * Two rules run through the whole module and are why it is arithmetic rather than a date library.
 *
 * **An event is placed in its own zone.** `calendarEvent.timeZone` is, per the contract, the zone
 * used to *interpret and display* the event — so a 09:00 review booked in `Europe/London` is drawn
 * at 09:00 whoever is looking. Which day column it lands in follows from the same reading. That
 * makes every position a function of `(instant, zone)` and nothing else, so the grid is
 * reproducible in a test with no ambient clock and no ambient locale.
 *
 * **A date-only item can never acquire a time.** Issues, milestones, and cycles are `IssueDate`
 * (ADR 0011), so they live in the all-day lane alone and dragging one writes a date. That is
 * enforced structurally rather than by care: a {@link CalendarAllDayItem} carries `timeZone: null`
 * exactly when it is date-only, and {@link resolveCalendarAllDayDrop} has no zone to build an
 * instant from in that case — it can only return {@link CalendarDateWrite}. The type is the
 * invariant; there is no branch to forget.
 *
 * Conversions between a wall clock and an instant go through {@link calendarInstantAt}, which
 * resolves the zone's offset rather than adding `86_400_000`, so dragging an event across a
 * daylight-saving boundary keeps the hour it was at instead of sliding by one.
 *
 * Calendar events are deliberately absent from Timeline mode, which reuses
 * `components/issues/milestonesTimeline.logic` untouched: an hour on a day-wide scale is a
 * sub-pixel hairline.
 *
 * @module components/calendar/calendarGrid.logic
 */
import type { IssueDate } from "@spiritdevs/contracts";
import type { TimestampFormat } from "@spiritdevs/contracts/settings";

import { addIssueDays } from "../issues/issuesList.logic";

// ── Modes and search params ────────────────────────────────────────────

export const CALENDAR_MODES = ["day", "week", "month", "timeline"] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];

/** The week is the mode a calendar is read in; the other three are what you switch to. */
export const DEFAULT_CALENDAR_MODE: CalendarMode = "week";

/** The three modes that are a time grid. Timeline is a Gantt and shares none of this geometry. */
export function isCalendarTimeGridMode(
  mode: CalendarMode,
): mode is Exclude<CalendarMode, "timeline"> {
  return mode !== "timeline";
}

export interface CalendarSearch {
  /** Absent is the week, so a link to the surface carries no params at all. */
  readonly mode?: CalendarMode | undefined;
  /** The day the range is built around, `YYYY-MM-DD`. Absent is today. */
  readonly date?: string | undefined;
}

export type CalendarSearchPatch = Partial<CalendarSearch>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tolerant like {@link parseIssuesSearch}: a hand-edited or stale param falls back to the default
 * rather than failing the route, and each default rides as an absent param so `?mode=week` and a
 * bare URL are the same screen.
 */
export function parseCalendarSearch(raw: Record<string, unknown>): CalendarSearch {
  const mode = raw["mode"];
  const date = raw["date"];
  const matched = CALENDAR_MODES.find((candidate) => candidate === mode);
  return {
    mode: matched === undefined || matched === DEFAULT_CALENDAR_MODE ? undefined : matched,
    date: typeof date === "string" && ISO_DATE.test(date) ? date : undefined,
  };
}

export function calendarMode(search: CalendarSearch): CalendarMode {
  return search.mode ?? DEFAULT_CALENDAR_MODE;
}

/** The day the range is built around. Absent means today, which is what a fresh visit wants. */
export function calendarAnchor(search: CalendarSearch, today: IssueDate): IssueDate {
  return (search.date ?? today) as IssueDate;
}

/** The patch that puts a date in the URL, dropping it again when it is simply today. */
export function calendarAnchorPatch(date: IssueDate, today: IssueDate): CalendarSearchPatch {
  return { date: date === today ? undefined : date };
}

// ── Calendar arithmetic ────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1440;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function utcOf(date: string): number | null {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const at = Date.UTC(year, month - 1, day);
  return Number.isNaN(at) ? null : at;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. Unparseable dates read as 0. */
export function diffCalendarDays(from: string, to: string): number {
  const a = utcOf(from);
  const b = utcOf(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** Monday-based, the same week the timeline's scale snaps to, so the two surfaces agree on a week. */
export function startOfCalendarWeek(date: string): IssueDate {
  const at = utcOf(date);
  if (at === null) return date as IssueDate;
  const weekday = new Date(at).getUTCDay();
  return addIssueDays(date, -((weekday + 6) % 7)) as IssueDate;
}

/** 0 for Monday through 6 for Sunday — the index a week column sits at. */
export function calendarWeekdayIndex(date: string): number {
  const at = utcOf(date);
  if (at === null) return 0;
  return (new Date(at).getUTCDay() + 6) % 7;
}

export function startOfCalendarMonth(date: string): IssueDate {
  return `${date.slice(0, 7)}-01` as IssueDate;
}

/** The first of the month `months` away — the only arithmetic that is not a day count. */
export function shiftCalendarMonths(date: string, months: number): IssueDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return date as IssueDate;
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - nextYear * 12;
  // The 31st of a 30-day month lands on its last day rather than spilling into the next one.
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const clamped = String(Math.min(day, lastDay)).padStart(2, "0");
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth + 1).padStart(2, "0")}-${clamped}` as IssueDate;
}

// ── Ranges ─────────────────────────────────────────────────────────────

export interface CalendarRange {
  readonly start: IssueDate;
  /** Inclusive: the last day drawn, not the exclusive edge after it. */
  readonly end: IssueDate;
}

/**
 * The days a mode draws.
 *
 * Month covers whole Monday-based weeks around the month, because a cell grid that started
 * mid-week would put the 1st under a weekday heading it does not belong to. Timeline has no range
 * of its own — its scale is derived from the milestones it holds — so it answers with the anchor's
 * week, which is only ever used to label the toolbar.
 */
export function calendarRange(mode: CalendarMode, anchor: IssueDate): CalendarRange {
  if (mode === "day") return { start: anchor, end: anchor };
  if (mode === "month") {
    const first = startOfCalendarMonth(anchor);
    const start = startOfCalendarWeek(first);
    const lastOfMonth = addIssueDays(shiftCalendarMonths(first, 1), -1);
    const end = addIssueDays(startOfCalendarWeek(lastOfMonth), 6) as IssueDate;
    return { start, end };
  }
  const start = startOfCalendarWeek(anchor);
  return { start, end: addIssueDays(start, 6) as IssueDate };
}

/**
 * Where the previous or next button lands. Timeline is unmoved on purpose: its scale comes from the
 * milestones it holds rather than from an anchor, so stepping one would move nothing on screen.
 */
export function shiftCalendarAnchor(
  mode: CalendarMode,
  anchor: IssueDate,
  direction: -1 | 1,
): IssueDate {
  if (mode === "timeline") return anchor;
  if (mode === "day") return addIssueDays(anchor, direction) as IssueDate;
  if (mode === "month") return shiftCalendarMonths(anchor, direction);
  return addIssueDays(anchor, direction * 7) as IssueDate;
}

// ── Day columns ────────────────────────────────────────────────────────

export interface CalendarDayColumn {
  readonly date: IssueDate;
  /** Column position, 0-based, in the order the days are drawn. */
  readonly index: number;
  readonly weekdayLabel: string;
  readonly dayLabel: string;
  readonly isToday: boolean;
  readonly isWeekend: boolean;
  /** False for the leading and trailing days a month grid borrows from its neighbours. */
  readonly inAnchorMonth: boolean;
}

export function buildCalendarDays(input: {
  readonly range: CalendarRange;
  readonly today: IssueDate;
  /** The month a month grid is about; every day is in-month for the other modes. */
  readonly anchorMonth?: string | undefined;
}): ReadonlyArray<CalendarDayColumn> {
  const total = Math.max(1, diffCalendarDays(input.range.start, input.range.end) + 1);
  const anchorMonth = input.anchorMonth?.slice(0, 7);
  const days: Array<CalendarDayColumn> = [];
  for (let index = 0; index < total; index += 1) {
    const date = addIssueDays(input.range.start, index) as IssueDate;
    const weekday = calendarWeekdayIndex(date);
    days.push({
      date,
      index,
      weekdayLabel: WEEKDAY_LABELS[weekday] ?? "",
      dayLabel: String(Number(date.slice(8, 10))),
      isToday: date === input.today,
      isWeekend: weekday >= 5,
      inAnchorMonth: anchorMonth === undefined || date.slice(0, 7) === anchorMonth,
    });
  }
  return days;
}

/** `August 2026`, `12 – 18 Aug 2026`, or a single day — what the toolbar names the range. */
export function formatCalendarRangeLabel(mode: CalendarMode, anchor: IssueDate): string {
  const monthName = MONTH_LABELS[Number(anchor.slice(5, 7)) - 1] ?? anchor.slice(5, 7);
  const year = anchor.slice(0, 4);
  if (mode === "month") return `${monthName} ${year}`;
  if (mode === "day") return `${monthName} ${Number(anchor.slice(8, 10))}, ${year}`;
  if (mode === "timeline") return `${monthName} ${year}`;
  const { start, end } = calendarRange("week", anchor);
  const startMonth = MONTH_LABELS[Number(start.slice(5, 7)) - 1] ?? "";
  const endMonth = MONTH_LABELS[Number(end.slice(5, 7)) - 1] ?? "";
  const startDay = Number(start.slice(8, 10));
  const endDay = Number(end.slice(8, 10));
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${startMonth} ${startDay} – ${endDay}, ${end.slice(0, 4)}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${end.slice(0, 4)}`;
}

// ── Hours ──────────────────────────────────────────────────────────────

/** One hour's height. Everything vertical on the time grid is a multiple or a fraction of this. */
export const CALENDAR_HOUR_ROW_PX = 44;
export const CALENDAR_GRID_HEIGHT_PX = 24 * CALENDAR_HOUR_ROW_PX;

/** A five-minute event is one pixel tall. Nobody can grab one pixel, so blocks never render thinner. */
export const CALENDAR_MIN_BLOCK_PX = 18;

/** Drags and click-to-create land on quarter hours, which is the granularity anyone means. */
export const CALENDAR_SNAP_MINUTES = 15;

/** What a click on empty grid creates, before the popover is even opened. */
export const CALENDAR_DEFAULT_EVENT_MINUTES = 60;

export interface CalendarHourRow {
  readonly hour: number;
  readonly y: number;
  readonly label: string;
}

export function calendarMinutesToY(minutes: number): number {
  return (minutes / 60) * CALENDAR_HOUR_ROW_PX;
}

/** The minute a pixel offset lands on, clamped into the day and snapped to the quarter hour. */
export function calendarMinutesAtY(y: number): number {
  const raw = (y / CALENDAR_HOUR_ROW_PX) * 60;
  const snapped = Math.round(raw / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES;
  return Math.min(MINUTES_PER_DAY - CALENDAR_SNAP_MINUTES, Math.max(0, snapped));
}

/** A drag's vertical travel in whole snap steps. Minutes are the only unit a time can move in. */
export function calendarMinutesFromOffset(offsetY: number): number {
  const raw = (offsetY / CALENDAR_HOUR_ROW_PX) * 60;
  return Math.round(raw / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES;
}

const hourFormatterCache = new Map<TimestampFormat, Intl.DateTimeFormat>();

function hourFormatter(format: TimestampFormat): Intl.DateTimeFormat {
  const cached = hourFormatterCache.get(format);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    ...(format === "locale" ? {} : { hour12: format === "12-hour" }),
  });
  hourFormatterCache.set(format, created);
  return created;
}

/** `9:00 AM` or `09:00`, honouring the same timestamp preference the rest of the app reads. */
export function formatCalendarMinutes(minutes: number, format: TimestampFormat): string {
  const clamped = Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(minutes)));
  return hourFormatter(format).format(Date.UTC(1970, 0, 1) + clamped * 60_000);
}

/** Midnight carries no label: the gutter's first line is the top of the grid, not a time on it. */
export function buildCalendarHourRows(format: TimestampFormat): ReadonlyArray<CalendarHourRow> {
  const rows: Array<CalendarHourRow> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    rows.push({
      hour,
      y: hour * CALENDAR_HOUR_ROW_PX,
      label: hour === 0 ? "" : formatCalendarMinutes(hour * 60, format),
    });
  }
  return rows;
}

// ── Zones ──────────────────────────────────────────────────────────────

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // A zone the runtime does not know is not worth losing the event over: draw it in UTC.
    created = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  partsFormatterCache.set(timeZone, created);
  return created;
}

export interface CalendarWallClock {
  /** The calendar day the instant falls on **in that zone**, which is the column it draws in. */
  readonly date: IssueDate;
  /** Minutes past that day's midnight, 0–1439. */
  readonly minutes: number;
}

function readParts(at: number, timeZone: string): CalendarWallClock {
  const parts = partsFormatter(timeZone).formatToParts(at);
  let year = "1970";
  let month = "01";
  let day = "01";
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "year") year = part.value.padStart(4, "0");
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
    // `hour12: false` still renders midnight as 24 in some ICU versions.
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { date: `${year}-${month}-${day}` as IssueDate, minutes: hour * 60 + minute };
}

/** Where an instant sits on the grid: its day and its minute, both read in the event's own zone. */
export function calendarWallClock(at: number, timeZone: string): CalendarWallClock {
  return readParts(at, timeZone);
}

function zoneOffsetMs(at: number, timeZone: string): number {
  const wall = readParts(at, timeZone);
  const asUtc = (utcOf(wall.date) ?? 0) + wall.minutes * 60_000;
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

/**
 * The instant a wall clock names in a zone — the inverse of {@link calendarWallClock}.
 *
 * The two candidates come from the offsets in force a day either side, because on the two days a
 * zone changes offset the answer is not a fixed point of a single guess: at the naive timestamp
 * itself only one of the two offsets is ever visible, so probing it twice finds the same one twice.
 *
 * A candidate counts only if reading it back gives the offset it was built from. Both surviving
 * means the wall clock is ambiguous — the hour an autumn-back repeats — and the earlier instant
 * wins. Neither surviving means it does not exist — the hour a spring-forward skips — and the clock
 * resolves forward past the gap. Those are the choices every calendar makes.
 */
export function calendarInstantAt(date: string, minutes: number, timeZone: string): number {
  const naive = (utcOf(date) ?? 0) + minutes * 60_000;
  const before = zoneOffsetMs(naive - DAY_MS, timeZone);
  const after = zoneOffsetMs(naive + DAY_MS, timeZone);
  if (before === after) return naive - before;

  const earlier = naive - Math.max(before, after);
  const later = naive - Math.min(before, after);
  const earlierHolds = zoneOffsetMs(earlier, timeZone) === Math.max(before, after);
  const laterHolds = zoneOffsetMs(later, timeZone) === Math.min(before, after);
  if (earlierHolds) return earlier;
  if (laterHolds) return later;
  // The skipped hour: `later` is the naive clock read through the offset that ends the gap, which
  // lands exactly the gap's width past the clock nobody can set.
  return later;
}

/**
 * The half-open instant range an all-day span covers in a zone: midnight opening `startDate`
 * through midnight opening the day after `endDate`, which is how `allDay` events are stored.
 */
export function calendarDayBounds(input: {
  readonly startDate: string;
  readonly endDate: string;
  readonly timeZone: string;
}): { readonly startAt: number; readonly endAt: number } {
  return {
    startAt: calendarInstantAt(input.startDate, 0, input.timeZone),
    endAt: calendarInstantAt(addIssueDays(input.endDate, 1), 0, input.timeZone),
  };
}

// ── Timed events ───────────────────────────────────────────────────────

/**
 * What the grid needs to know about one event. A structural input rather than the replica entity,
 * so the geometry is testable without a decoded row and so a mirrored event and a Pathway-owned one
 * differ here by exactly the field that matters.
 */
export interface CalendarEventInput {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startAt: number;
  readonly endAt: number;
  /** IANA name. Both ends of the event are read in it; see the module note. */
  readonly timeZone: string;
  readonly allDay: boolean;
  /** Pathway-owned events are editable; a mirrored Google event is read-only. */
  readonly editable: boolean;
}

/**
 * One event's presence in one day column. An event that runs past midnight has a segment in each
 * day it touches rather than one block hanging off the bottom, because the column below is where
 * the rest of it actually happens.
 */
export interface CalendarEventBlock {
  readonly event: CalendarEventInput;
  readonly key: string;
  readonly columnIndex: number;
  readonly top: number;
  readonly height: number;
  /** Which of the overlapping lanes in its cluster this block sits on. */
  readonly lane: number;
  /** How many lanes the cluster needs — the denominator of the block's width. */
  readonly lanes: number;
  readonly startMinutes: number;
  readonly endMinutes: number;
  /** The event began before this column's midnight, or runs past its end. Draw that edge square. */
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

interface Segment {
  readonly event: CalendarEventInput;
  readonly columnIndex: number;
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

/**
 * Every day column a timed event touches, clipped to each one.
 *
 * A zero-length or backwards event still gets one segment: the service refuses both, so this only
 * catches a row that predates that check, and a row you cannot see is worse than a thin one.
 */
function eventSegments(
  event: CalendarEventInput,
  columnByDate: ReadonlyMap<string, number>,
): ReadonlyArray<Segment> {
  const from = calendarWallClock(event.startAt, event.timeZone);
  const rawTo = calendarWallClock(Math.max(event.endAt, event.startAt), event.timeZone);
  // An event ending exactly at midnight belongs to the day it ran through, not the one after.
  const to =
    rawTo.minutes === 0 && rawTo.date > from.date
      ? { date: addIssueDays(rawTo.date, -1) as IssueDate, minutes: MINUTES_PER_DAY }
      : rawTo;

  const span = Math.max(0, diffCalendarDays(from.date, to.date));
  const segments: Array<Segment> = [];
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addIssueDays(from.date, offset);
    const columnIndex = columnByDate.get(date);
    if (columnIndex === undefined) continue;
    const startMinutes = offset === 0 ? from.minutes : 0;
    const endMinutes = offset === span ? Math.max(to.minutes, startMinutes) : MINUTES_PER_DAY;
    segments.push({
      event,
      columnIndex,
      startMinutes,
      endMinutes,
      clippedStart: offset > 0,
      clippedEnd: offset < span,
    });
  }
  return segments;
}

/** Start, then longest first, then id — a total order, so the lanes are the same on every render. */
function compareSegments(left: Segment, right: Segment): number {
  if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes;
  const leftSpan = left.endMinutes - left.startMinutes;
  const rightSpan = right.endMinutes - right.startMinutes;
  if (leftSpan !== rightSpan) return rightSpan - leftSpan;
  return left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0;
}

/**
 * Timed events as positioned blocks, with overlapping ones sharing their column's width.
 *
 * The packing is the ordinary one and it is the part worth stating: segments are swept in start
 * order into *clusters* — a run with no gap in it — and every block in a cluster is a `1/lanes`
 * slice, so two meetings from 9 to 10 are two half-width blocks and a third at 9:30 makes all three
 * thirds. Widths are decided per cluster rather than per pair, because a pairwise width leaves a
 * chain of overlaps with blocks that visibly do not line up.
 *
 * All-day events are not here: they belong to {@link buildCalendarAllDayLane}.
 */
export function buildCalendarEventBlocks(input: {
  readonly events: ReadonlyArray<CalendarEventInput>;
  readonly days: ReadonlyArray<CalendarDayColumn>;
}): ReadonlyArray<CalendarEventBlock> {
  const columnByDate = new Map(input.days.map((day) => [day.date as string, day.index]));
  const byColumn = new Map<number, Array<Segment>>();
  for (const event of input.events) {
    if (event.allDay) continue;
    for (const segment of eventSegments(event, columnByDate)) {
      const bucket = byColumn.get(segment.columnIndex);
      if (bucket === undefined) byColumn.set(segment.columnIndex, [segment]);
      else bucket.push(segment);
    }
  }

  const blocks: Array<CalendarEventBlock> = [];
  for (const [columnIndex, segments] of byColumn) {
    segments.sort(compareSegments);

    let cluster: Array<{ readonly segment: Segment; readonly lane: number }> = [];
    let clusterEnd = -1;
    /** The last minute taken on each lane of the cluster being built. */
    let laneEnds: Array<number> = [];

    const flush = () => {
      const lanes = Math.max(1, laneEnds.length);
      for (const { segment, lane } of cluster) {
        const top = calendarMinutesToY(segment.startMinutes);
        const rawHeight = calendarMinutesToY(segment.endMinutes) - top;
        blocks.push({
          event: segment.event,
          key: `${segment.event.id}:${columnIndex}`,
          columnIndex,
          top,
          height: Math.max(CALENDAR_MIN_BLOCK_PX, rawHeight),
          lane,
          lanes,
          startMinutes: segment.startMinutes,
          endMinutes: segment.endMinutes,
          clippedStart: segment.clippedStart,
          clippedEnd: segment.clippedEnd,
        });
      }
      cluster = [];
      laneEnds = [];
      clusterEnd = -1;
    };

    for (const segment of segments) {
      // A zero-length row still occupies its start minute, so it does not silently join a gap.
      const end = Math.max(segment.endMinutes, segment.startMinutes + 1);
      if (cluster.length > 0 && segment.startMinutes >= clusterEnd) flush();
      const free = laneEnds.findIndex((taken) => taken <= segment.startMinutes);
      const lane = free === -1 ? laneEnds.length : free;
      laneEnds[lane] = end;
      cluster.push({ segment, lane });
      clusterEnd = Math.max(clusterEnd, end);
    }
    if (cluster.length > 0) flush();
  }

  return blocks;
}

// ── The all-day lane ───────────────────────────────────────────────────

/**
 * What can sit above the hour grid. `event` is an all-day calendar event; the other three are the
 * date-only work items ADR 0011 confines to this lane.
 */
export type CalendarAllDayKind = "event" | "issue" | "milestone" | "cycle";

/**
 * One thing in the all-day lane.
 *
 * `timeZone` is non-null exactly for `event`, and that is load-bearing rather than incidental: it
 * is the only way to turn a dragged date back into an instant, so a date-only item has nothing to
 * build a time out of. See {@link resolveCalendarAllDayDrop}.
 */
export interface CalendarAllDayItem {
  readonly id: string;
  readonly kind: CalendarAllDayKind;
  readonly title: string;
  readonly startDate: IssueDate;
  /** Inclusive. A one-day item repeats its start here. */
  readonly endDate: IssueDate;
  readonly editable: boolean;
  /** Non-null exactly when `kind` is `event`. */
  readonly timeZone: string | null;
}

export interface CalendarAllDayBar {
  readonly item: CalendarAllDayItem;
  readonly columnIndex: number;
  /** How many day columns wide, at least 1. */
  readonly span: number;
  readonly lane: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export interface CalendarAllDayLane {
  readonly bars: ReadonlyArray<CalendarAllDayBar>;
  /** How many stacked rows the lane needs. Zero when nothing lands on the range at all. */
  readonly lanes: number;
}

const EMPTY_ALL_DAY_LANE: CalendarAllDayLane = { bars: [], lanes: 0 };

function compareAllDayItems(left: CalendarAllDayItem, right: CalendarAllDayItem): number {
  if (left.startDate !== right.startDate) return left.startDate < right.startDate ? -1 : 1;
  const leftSpan = diffCalendarDays(left.startDate, left.endDate);
  const rightSpan = diffCalendarDays(right.startDate, right.endDate);
  if (leftSpan !== rightSpan) return rightSpan - leftSpan;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The all-day lane, packed into as few rows as the spans allow.
 *
 * Longest first within a start date, so a week-long milestone takes the top row and the one-day
 * items settle underneath it rather than pushing it down. An item with no day on the range is left
 * out entirely rather than clamped to an edge — a bar parked on the edge would name a day it does
 * not cover — and one that only partly fits is clipped and says so.
 */
export function buildCalendarAllDayLane(input: {
  readonly items: ReadonlyArray<CalendarAllDayItem>;
  readonly days: ReadonlyArray<CalendarDayColumn>;
}): CalendarAllDayLane {
  const first = input.days[0];
  const last = input.days[input.days.length - 1];
  if (first === undefined || last === undefined) return EMPTY_ALL_DAY_LANE;

  const bars: Array<CalendarAllDayBar> = [];
  /** The last column already taken on each lane. */
  const laneEnds: Array<number> = [];

  for (const item of [...input.items].sort(compareAllDayItems)) {
    // Backwards dates are refused by the service; this only catches a row that predates that.
    const endDate = item.endDate < item.startDate ? item.startDate : item.endDate;
    if (endDate < first.date || item.startDate > last.date) continue;

    const rawStart = diffCalendarDays(first.date, item.startDate);
    const rawEnd = diffCalendarDays(first.date, endDate);
    const columnIndex = Math.max(0, rawStart);
    const span = Math.min(input.days.length - 1, rawEnd) - columnIndex + 1;
    if (span <= 0) continue;

    const free = laneEnds.findIndex((taken) => taken < columnIndex);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = columnIndex + span - 1;
    bars.push({
      item,
      columnIndex,
      span,
      lane,
      clippedStart: rawStart < 0,
      clippedEnd: rawEnd > input.days.length - 1,
    });
  }

  let lanes = 0;
  for (const bar of bars) lanes = Math.max(lanes, bar.lane + 1);
  return { bars, lanes };
}

// ── Month cells ────────────────────────────────────────────────────────

/**
 * One line in a month cell. A month cell is a list, not a grid — an hour has no height at this
 * scale — so a chip carries a time as text and nothing positional.
 */
export interface CalendarMonthChip {
  readonly id: string;
  readonly kind: CalendarAllDayKind;
  readonly title: string;
  /** The start time for a timed event; null for anything all-day. */
  readonly time: string | null;
  readonly editable: boolean;
  /** False on the continuation days of a multi-day span, which read as a bar rather than a chip. */
  readonly startsHere: boolean;
}

export interface CalendarMonthCell {
  readonly date: IssueDate;
  readonly inAnchorMonth: boolean;
  readonly isToday: boolean;
  readonly chips: ReadonlyArray<CalendarMonthChip>;
  /** How many chips did not fit — what the `+n more` row says. Zero when everything fits. */
  readonly overflow: number;
}

/**
 * A month as day cells with their chips.
 *
 * All-day spans come first and in lane order, so a milestone running Tuesday to Friday sits on the
 * same line in all four cells rather than jumping as each day's timed events change. Timed events
 * follow in start order. A cell holds `capacity` chips and counts the rest, because a cell that
 * grows to fit makes the row it is in grow with it and the month stops being a grid.
 */
export function buildCalendarMonthCells(input: {
  readonly days: ReadonlyArray<CalendarDayColumn>;
  readonly allDay: ReadonlyArray<CalendarAllDayItem>;
  readonly events: ReadonlyArray<CalendarEventInput>;
  readonly capacity: number;
  readonly timestampFormat: TimestampFormat;
}): ReadonlyArray<CalendarMonthCell> {
  const lane = buildCalendarAllDayLane({ items: input.allDay, days: input.days });
  const spanning = new Map<number, Array<CalendarMonthChip>>();
  for (const bar of [...lane.bars].sort((left, right) => left.lane - right.lane)) {
    for (let offset = 0; offset < bar.span; offset += 1) {
      const columnIndex = bar.columnIndex + offset;
      const chip: CalendarMonthChip = {
        id: bar.item.id,
        kind: bar.item.kind,
        title: bar.item.title,
        time: null,
        editable: bar.item.editable,
        startsHere: offset === 0 && !bar.clippedStart,
      };
      const bucket = spanning.get(columnIndex);
      if (bucket === undefined) spanning.set(columnIndex, [chip]);
      else bucket.push(chip);
    }
  }

  const timed = new Map<string, Array<CalendarEventInput>>();
  for (const event of input.events) {
    if (event.allDay) continue;
    const { date } = calendarWallClock(event.startAt, event.timeZone);
    const bucket = timed.get(date);
    if (bucket === undefined) timed.set(date, [event]);
    else bucket.push(event);
  }

  const capacity = Math.max(0, input.capacity);
  return input.days.map((day) => {
    const chips: Array<CalendarMonthChip> = [...(spanning.get(day.index) ?? [])];
    for (const event of (timed.get(day.date) ?? []).sort(
      (left, right) =>
        left.startAt - right.startAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )) {
      chips.push({
        id: event.id,
        kind: "event",
        title: event.title,
        time: formatCalendarMinutes(
          calendarWallClock(event.startAt, event.timeZone).minutes,
          input.timestampFormat,
        ),
        editable: event.editable,
        startsHere: true,
      });
    }
    return {
      date: day.date,
      inAnchorMonth: day.inAnchorMonth,
      isToday: day.isToday,
      chips: chips.slice(0, capacity),
      overflow: Math.max(0, chips.length - capacity),
    };
  });
}

// ── Drops ──────────────────────────────────────────────────────────────

/** Which part of a block the pointer grabbed. The body moves both ends; an edge moves one. */
export type CalendarDragEdge = "move" | "start" | "end";

/** Grabbing within this many pixels of an end resizes it; anywhere else moves the whole block. */
export const CALENDAR_EDGE_GRAB_PX = 8;

/**
 * Where a press inside a block landed. A block short enough that the two edge zones would meet is
 * all body: a short event you cannot move is worse than one you cannot resize by dragging, and the
 * popover resizes it either way.
 */
export function calendarGrabEdge(input: {
  readonly offsetY: number;
  readonly height: number;
}): CalendarDragEdge {
  if (input.height < CALENDAR_EDGE_GRAB_PX * 3) return "move";
  if (input.offsetY <= CALENDAR_EDGE_GRAB_PX) return "start";
  if (input.offsetY >= input.height - CALENDAR_EDGE_GRAB_PX) return "end";
  return "move";
}

/** A write in instants — what an event of any kind stores. */
export interface CalendarInstantWrite {
  readonly _tag: "Instants";
  readonly startAt: number;
  readonly endAt: number;
}

/** A write in dates — the only thing a date-only work item can ever be given. */
export interface CalendarDateWrite {
  readonly _tag: "Dates";
  readonly startDate: IssueDate;
  readonly endDate: IssueDate;
}

export type CalendarDropWrite = CalendarInstantWrite | CalendarDateWrite;

/**
 * What a finished drag on the hour grid means, or null when it means nothing — no travel, or a
 * resize that would leave the event with no duration.
 *
 * The travel is applied to the *wall clock* in the event's own zone and converted back, so a block
 * dragged from Saturday to Monday across a clock change stays at the hour it was at. Both ends stay
 * in order by clamping rather than by swapping: dragging the start past the end parks it one snap
 * step before, which is what the block looked like it was doing.
 */
export function resolveCalendarTimedDrop(input: {
  readonly event: Pick<CalendarEventInput, "startAt" | "endAt" | "timeZone">;
  readonly edge: CalendarDragEdge;
  readonly deltaDays: number;
  readonly deltaMinutes: number;
}): CalendarInstantWrite | null {
  const { deltaDays, deltaMinutes, edge, event } = input;
  if (deltaDays === 0 && deltaMinutes === 0) return null;

  const from = calendarWallClock(event.startAt, event.timeZone);
  const to = calendarWallClock(event.endAt, event.timeZone);

  const shifted = (clock: CalendarWallClock): CalendarWallClock => {
    const total = clock.minutes + deltaMinutes;
    const carried = Math.floor(total / MINUTES_PER_DAY);
    return {
      date: addIssueDays(clock.date, deltaDays + carried) as IssueDate,
      minutes: total - carried * MINUTES_PER_DAY,
    };
  };
  const instant = (clock: CalendarWallClock) =>
    calendarInstantAt(clock.date, clock.minutes, event.timeZone);

  if (edge === "move") {
    const startAt = instant(shifted(from));
    return { _tag: "Instants", startAt, endAt: startAt + (event.endAt - event.startAt) };
  }

  const minimum = CALENDAR_SNAP_MINUTES * 60_000;
  if (edge === "start") {
    const startAt = Math.min(instant(shifted(from)), event.endAt - minimum);
    return startAt === event.startAt ? null : { _tag: "Instants", startAt, endAt: event.endAt };
  }
  const endAt = Math.max(instant(shifted(to)), event.startAt + minimum);
  return endAt === event.endAt ? null : { _tag: "Instants", startAt: event.startAt, endAt };
}

/**
 * What a finished drag in the all-day lane means, or null when it means nothing.
 *
 * This is where ADR 0011's rule is kept, and it is kept by the return type rather than by a check
 * anyone has to remember: an item with no `timeZone` is a date-only issue, milestone, or cycle, and
 * the only write this function can construct for it is a {@link CalendarDateWrite}. There is no
 * instant to be had, so there is no time to write.
 */
export function resolveCalendarAllDayDrop(input: {
  readonly item: Pick<CalendarAllDayItem, "startDate" | "endDate" | "timeZone">;
  readonly deltaDays: number;
}): CalendarDropWrite | null {
  if (input.deltaDays === 0) return null;
  const startDate = addIssueDays(input.item.startDate, input.deltaDays) as IssueDate;
  const endDate = addIssueDays(input.item.endDate, input.deltaDays) as IssueDate;
  const { timeZone } = input.item;
  if (timeZone === null) return { _tag: "Dates", startDate, endDate };
  return { _tag: "Instants", ...calendarDayBounds({ startDate, endDate, timeZone }) };
}

/**
 * Dragging a timed event into the all-day lane, or an all-day one down onto the hours. Null when
 * the event is already the way it is being dropped, and null for anything that is not an event —
 * a date-only item has no hours to be given.
 */
export function resolveCalendarAllDayToggle(input: {
  readonly event: Pick<CalendarEventInput, "startAt" | "endAt" | "timeZone" | "allDay">;
  readonly allDay: boolean;
  readonly date: IssueDate;
}): CalendarInstantWrite | null {
  if (input.event.allDay === input.allDay) return null;
  if (input.allDay) {
    return {
      _tag: "Instants",
      ...calendarDayBounds({
        startDate: input.date,
        endDate: input.date,
        timeZone: input.event.timeZone,
      }),
    };
  }
  // Back onto the hours as an hour, at the start of the working day rather than at midnight.
  const startAt = calendarInstantAt(input.date, 9 * 60, input.event.timeZone);
  return {
    _tag: "Instants",
    startAt,
    endAt: startAt + CALENDAR_DEFAULT_EVENT_MINUTES * 60_000,
  };
}

/**
 * The event a click on empty grid would create: the snapped slot under the pointer, an hour long,
 * clamped so a click near midnight makes an event that ends on the same day it started.
 */
export function resolveCalendarNewEvent(input: {
  readonly date: IssueDate;
  readonly minutes: number;
  readonly timeZone: string;
}): CalendarInstantWrite {
  const start = Math.min(
    MINUTES_PER_DAY - CALENDAR_DEFAULT_EVENT_MINUTES,
    Math.max(0, Math.round(input.minutes / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES),
  );
  return {
    _tag: "Instants",
    startAt: calendarInstantAt(input.date, start, input.timeZone),
    endAt: calendarInstantAt(input.date, start + CALENDAR_DEFAULT_EVENT_MINUTES, input.timeZone),
  };
}
