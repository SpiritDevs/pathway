/**
 * The geometry and the drop resolution behind `/issues/milestones?view=timeline`.
 *
 * Everything here is arithmetic over `YYYY-MM-DD` strings and pixels: where a day sits on the
 * scale, how wide a milestone's bar is, and what a finished drag means in dates. It is pure for the
 * same reason {@link resolveIssuesBoardDrop} is — a drag is impossible to test and easy to get
 * wrong, so the component only measures the pointer and dispatches, and the decisions live here.
 *
 * There is no date library in this repo and there is not going to be one for this: a calendar day
 * has no time zone under it, so `Date.UTC` plus string compare is the whole calculation.
 *
 * The same arithmetic is the Gantt behind `/calendar`'s Timeline mode (ADR 0011), which is why the
 * scale, the rows, and the bands are separate functions rather than one screen's worth of state:
 * rows are projects that expand to their milestones, cycles are a band across the header, and issue
 * due dates are ticks on their project's row. A caller hands in dates and gets pixels back, so the
 * two surfaces cannot drift. Calendar events are deliberately absent and there is no row type that
 * would take one — an hour on a day-wide scale is a sub-pixel hairline.
 *
 * @module components/issues/milestonesTimeline.logic
 */
import type {
  Issue,
  IssueCycle,
  IssueDate,
  IssueMilestone,
  IssueMilestoneId,
  ProjectId,
} from "@spiritdevs/contracts";

import type { IssueProgress } from "~/state/issues";
import { addIssueDays } from "./issuesList.logic";
import { milestoneProgressRatio, type MilestonesOverviewGroup } from "./milestonesOverview.logic";

// ── Calendar arithmetic ────────────────────────────────────────────────

/** Written out rather than imported: `issuesList.logic` keeps its copy private, and this is 12 words. */
const MONTH_LABELS = [
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

const DAY_MS = 86_400_000;

function utcOf(date: string): number | null {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const at = Date.UTC(year, month - 1, day);
  return Number.isNaN(at) ? null : at;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. Unparseable dates read as 0. */
export function diffTimelineDays(from: string, to: string): number {
  const a = utcOf(from);
  const b = utcOf(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** Monday-based, so a week column starts where a work week does. */
function startOfWeek(date: string): string {
  const at = utcOf(date);
  if (at === null) return date;
  const weekday = new Date(at).getUTCDay();
  return addIssueDays(date, -((weekday + 6) % 7));
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function startOfQuarter(date: string): string {
  const month = Number(date.slice(5, 7));
  if (Number.isNaN(month)) return startOfMonth(date);
  const first = String(month - ((month - 1) % 3)).padStart(2, "0");
  return `${date.slice(0, 4)}-${first}-01`;
}

/** The first of the month after this one — the exclusive end a month tick walk steps to. */
function nextMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (Number.isNaN(year) || Number.isNaN(month)) return date;
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

// ── Scale ──────────────────────────────────────────────────────────────

export const TIMELINE_ZOOMS = ["week", "month", "quarter"] as const;
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];

export const TIMELINE_ZOOM_LABELS: Readonly<Record<TimelineZoom, string>> = {
  week: "Weeks",
  month: "Months",
  quarter: "Quarters",
};

/**
 * `dayWidth` is what a zoom actually is — the tick cadence and the padding follow from how much
 * calendar fits on screen at that width. `padDays` is breathing room added before the range is
 * snapped outward to a boundary, so a milestone ending on the last day of a month still has empty
 * scale to its right to be dragged into.
 */
const ZOOMS: Readonly<
  Record<TimelineZoom, { readonly dayWidth: number; readonly padDays: number }>
> = {
  week: { dayWidth: 32, padDays: 7 },
  month: { dayWidth: 12, padDays: 7 },
  quarter: { dayWidth: 4, padDays: 31 },
};

export interface TimelineTick {
  readonly date: string;
  readonly x: number;
  readonly label: string;
  /** A period boundary — the start of a week, a month, or a quarter, depending on the zoom. */
  readonly major: boolean;
}

export interface TimelineScale {
  readonly zoom: TimelineZoom;
  /** First day on the scale, snapped outward to the zoom's boundary. */
  readonly start: string;
  /** Last day on the scale, inclusive. */
  readonly end: string;
  readonly days: number;
  readonly dayWidth: number;
  readonly width: number;
  readonly ticks: ReadonlyArray<TimelineTick>;
}

export interface TimelineRange {
  readonly start: string;
  readonly end: string;
}

/**
 * What the scale has to cover: every date any milestone carries, plus today, so the today rule is
 * always somewhere on screen. A tracker whose milestones are all undated still gets a scale — it is
 * the empty grid a tray chip is dragged onto.
 */
export function milestonesTimelineRange(
  milestones: ReadonlyArray<Pick<IssueMilestone, "startDate" | "targetDate">>,
  today: string,
): TimelineRange {
  let start = today;
  let end = today;
  for (const milestone of milestones) {
    for (const date of [milestone.startDate, milestone.targetDate]) {
      if (date === null) continue;
      if (date < start) start = date;
      if (date > end) end = date;
    }
  }
  return { start, end };
}

function tickLabel(date: string, zoom: TimelineZoom): string {
  const month = MONTH_LABELS[Number(date.slice(5, 7)) - 1] ?? date.slice(5, 7);
  const day = String(Number(date.slice(8, 10)));
  if (zoom === "week") return day;
  if (zoom === "month") return `${month} ${day}`;
  // A quarter's columns are months, and January is where saying the year earns its space.
  return date.slice(5, 7) === "01" ? `${month} ${date.slice(0, 4)}` : month;
}

/**
 * Day columns, the ticks drawn over them, and the total pixel width the lanes take.
 *
 * The range is padded and then snapped outward to the zoom's own period, so switching zoom never
 * cuts a bar in half: `week` lands on Mondays, `month` on the 1st, `quarter` on Jan/Apr/Jul/Oct.
 * Ticks are one per day at `week`, one per week at `month`, and one per month at `quarter`.
 */
export function buildTimelineScale(range: TimelineRange, zoom: TimelineZoom): TimelineScale {
  const { dayWidth, padDays } = ZOOMS[zoom];
  const rawEnd = range.end < range.start ? range.start : range.end;
  const padded = { start: addIssueDays(range.start, -padDays), end: addIssueDays(rawEnd, padDays) };

  const start =
    zoom === "week"
      ? startOfWeek(padded.start)
      : zoom === "month"
        ? startOfMonth(padded.start)
        : startOfQuarter(padded.start);
  const endExclusive =
    zoom === "week"
      ? addIssueDays(startOfWeek(padded.end), 7)
      : zoom === "month"
        ? nextMonth(startOfMonth(padded.end))
        : nextMonth(nextMonth(nextMonth(startOfQuarter(padded.end))));
  const days = Math.max(1, diffTimelineDays(start, endExclusive));

  const ticks: Array<TimelineTick> = [];
  if (zoom === "week") {
    for (let day = 0; day < days; day += 1) {
      const date = addIssueDays(start, day);
      ticks.push({
        date,
        x: day * dayWidth,
        label: tickLabel(date, zoom),
        major: date === startOfWeek(date),
      });
    }
  } else if (zoom === "month") {
    for (let day = 0; day < days; day += 7) {
      const date = addIssueDays(start, day);
      ticks.push({
        date,
        x: day * dayWidth,
        label: tickLabel(date, zoom),
        // The week that opens a month is the one the eye uses to find the month.
        major: Number(date.slice(8, 10)) <= 7,
      });
    }
  } else {
    for (let date = start; date < endExclusive; date = nextMonth(date)) {
      ticks.push({
        date,
        x: diffTimelineDays(start, date) * dayWidth,
        label: tickLabel(date, zoom),
        major: date === startOfQuarter(date),
      });
    }
  }

  return {
    zoom,
    start,
    end: addIssueDays(start, days - 1),
    days,
    dayWidth,
    width: days * dayWidth,
    ticks,
  };
}

/** The left edge of a day's column. Off-scale dates give an off-scale x; callers clamp. */
export function timelineX(scale: TimelineScale, date: string): number {
  return diffTimelineDays(scale.start, date) * scale.dayWidth;
}

/** The day a pixel offset lands in, clamped to the scale — a drop outside it is still a real date. */
export function timelineDateAtX(scale: TimelineScale, x: number): IssueDate {
  const day = Math.min(scale.days - 1, Math.max(0, Math.floor(x / scale.dayWidth)));
  return addIssueDays(scale.start, day) as IssueDate;
}

/** A drag's horizontal travel in whole days. Days are the only unit a date can move in. */
export function timelineDaysFromOffset(scale: TimelineScale, offsetX: number): number {
  return Math.round(offsetX / scale.dayWidth);
}

// ── Rows ───────────────────────────────────────────────────────────────

/**
 * Which ends the milestone actually carries. `start` and `target` render as a one-day marker rather
 * than a guessed span — a milestone dated one way is a checkpoint, and inventing the other end on
 * screen would make it look like something the user set.
 */
export type TimelineBarDates = "both" | "start" | "target";

export interface TimelineBar {
  readonly milestone: IssueMilestone;
  readonly x: number;
  readonly width: number;
  readonly completionRatio: number;
  readonly dated: TimelineBarDates;
}

/**
 * What a due-date tick needs to know about the issue under it. A `Pick` rather than the whole
 * {@link Issue} so a caller can hand over a projection: the tick draws a mark and names it, and
 * everything else about the issue belongs to whatever opens when the mark is pressed.
 */
export type TimelineDueIssue = Pick<Issue, "id" | "key" | "title" | "projectId" | "dueDate">;

/**
 * One day's worth of due dates on a project's row. Grouped by day rather than one entry per issue
 * because a day is 4px wide at quarter zoom: two issues due together are one mark carrying both,
 * not two marks on the same pixel.
 */
export interface TimelineDueTick {
  readonly date: IssueDate;
  /** The centre of the day's column — a due date is a point on the scale, not a span of it. */
  readonly x: number;
  readonly issues: ReadonlyArray<TimelineDueIssue>;
}

export interface TimelineRow {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly bars: ReadonlyArray<TimelineBar>;
  /** Milestones with no dates at all: they have no place on the scale, so they live in the tray. */
  readonly undated: ReadonlyArray<IssueMilestone>;
  /**
   * Issue due dates, on the project's own row rather than on a row each — an issue is a day, and a
   * row per day would bury the milestones the row is about. Empty unless a caller passes issues.
   */
  readonly dueTicks: ReadonlyArray<TimelineDueTick>;
}

export interface TimelineRows {
  readonly rows: ReadonlyArray<TimelineRow>;
  /** Every project's undated milestones, in row order — what the one shared tray shows. */
  readonly undated: ReadonlyArray<IssueMilestone>;
}

const NO_PROGRESS: IssueProgress = { done: 0, total: 0 };
const NO_DUE_TICKS: ReadonlyArray<TimelineDueTick> = [];

function barGeometry(
  milestone: IssueMilestone,
  scale: TimelineScale,
): { readonly x: number; readonly width: number; readonly dated: TimelineBarDates } | null {
  const { startDate, targetDate } = milestone;
  if (startDate === null && targetDate === null) return null;
  const dated: TimelineBarDates =
    startDate !== null && targetDate !== null ? "both" : startDate !== null ? "start" : "target";
  const from = startDate ?? (targetDate as string);
  const rawTo = targetDate ?? (startDate as string);
  // Backwards dates are refused by the service, so this only catches a row that predates that check.
  const to = rawTo < from ? from : rawTo;

  const left = timelineX(scale, from);
  const right = timelineX(scale, to) + scale.dayWidth;
  const clampedLeft = Math.min(Math.max(0, left), scale.width);
  const clampedRight = Math.max(clampedLeft, Math.min(scale.width, right));
  return { x: clampedLeft, width: Math.max(scale.dayWidth, clampedRight - clampedLeft), dated };
}

/** Bucketed once for the whole build: a group scanning every issue would be a scan per project. */
function dueIssuesByProject(
  issues: ReadonlyArray<TimelineDueIssue>,
): ReadonlyMap<ProjectId, ReadonlyArray<TimelineDueIssue>> {
  const byProject = new Map<ProjectId, Array<TimelineDueIssue>>();
  for (const issue of issues) {
    if (issue.dueDate === null || issue.projectId === null) continue;
    const bucket = byProject.get(issue.projectId);
    if (bucket === undefined) byProject.set(issue.projectId, [issue]);
    else bucket.push(issue);
  }
  return byProject;
}

/**
 * One tick per day, in date order. A due date off the scale is dropped rather than clamped to its
 * edge: unlike a bar, which is a span the edge honestly truncates, a mark parked on the edge would
 * name a day it does not fall on.
 */
function dueTicksOn(
  issues: ReadonlyArray<TimelineDueIssue>,
  scale: TimelineScale,
): ReadonlyArray<TimelineDueTick> {
  const byDate = new Map<IssueDate, Array<TimelineDueIssue>>();
  for (const issue of issues) {
    const date = issue.dueDate;
    if (date === null || date < scale.start || date > scale.end) continue;
    const bucket = byDate.get(date);
    if (bucket === undefined) byDate.set(date, [issue]);
    else bucket.push(issue);
  }
  if (byDate.size === 0) return NO_DUE_TICKS;
  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, held]) => ({
      date,
      x: timelineX(scale, date) + scale.dayWidth / 2,
      issues: held,
    }));
}

export interface TimelineRowsInput {
  /** The overview's grouping, unchanged: the timeline is the same set the list shows. */
  readonly groups: ReadonlyArray<MilestonesOverviewGroup>;
  readonly progressByMilestone: ReadonlyMap<IssueMilestoneId, IssueProgress>;
  readonly scale: TimelineScale;
  /**
   * Issues whose due dates mark their project's row. Left out by `/issues/milestones?view=timeline`,
   * which is milestones and nothing else; `/calendar`'s Timeline mode passes the ones its layers ask
   * for. An issue naming a project with no row is dropped, the rule milestones already follow.
   */
  readonly issues?: ReadonlyArray<TimelineDueIssue> | undefined;
}

/**
 * The overview's project groups read as lanes. Grouping is not redone here — {@link
 * milestonesOverviewGroups} already decided which projects show and in what order, and the timeline
 * being the same set as the list is the point of it being a view toggle.
 *
 * A project whose milestones are all undated keeps an empty lane, because the lane is where they
 * land when they are dragged out of the tray.
 */
export function buildTimelineRows(input: TimelineRowsInput): TimelineRows {
  const { groups, issues, progressByMilestone, scale } = input;
  const dueByProject = issues === undefined ? null : dueIssuesByProject(issues);

  const rows: Array<TimelineRow> = [];
  const undated: Array<IssueMilestone> = [];
  for (const group of groups) {
    const bars: Array<TimelineBar> = [];
    const groupUndated: Array<IssueMilestone> = [];
    for (const milestone of group.milestones) {
      const geometry = barGeometry(milestone, scale);
      if (geometry === null) {
        groupUndated.push(milestone);
        continue;
      }
      bars.push({
        milestone,
        ...geometry,
        completionRatio: milestoneProgressRatio(
          progressByMilestone.get(milestone.id) ?? NO_PROGRESS,
        ),
      });
    }
    rows.push({
      projectId: group.projectId,
      title: group.title,
      bars,
      undated: groupUndated,
      // A logical project answers to every id it aggregates, so its issues arrive under any of them.
      dueTicks:
        dueByProject === null
          ? NO_DUE_TICKS
          : dueTicksOn(
              [...new Set(group.projectIds ?? [group.projectId])].flatMap((projectId) => [
                ...(dueByProject.get(projectId) ?? []),
              ]),
              scale,
            ),
    });
    undated.push(...groupUndated);
  }
  return { rows, undated };
}

// ── Lanes ──────────────────────────────────────────────────────────────

/**
 * A project row and the milestone rows it opens onto, flattened into the order they render in.
 *
 * The flattening lives here rather than in a component because it is the part the two surfaces have
 * to agree on: a project is one row whether or not it is showing its milestones, and a project
 * showing none keeps a row of its own, because that empty lane is what a tray chip is dropped onto.
 * `key` is the React key, decided here so the same list cannot be keyed two ways.
 */
export type TimelineLane =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly row: TimelineRow;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "milestone";
      readonly key: string;
      readonly projectId: ProjectId;
      readonly bar: TimelineBar;
    }
  | { readonly kind: "empty"; readonly key: string; readonly projectId: ProjectId };

/** Collapsed rather than expanded, because a project arrives open and closing one is the exception. */
export function timelineLanes(
  rows: ReadonlyArray<TimelineRow>,
  collapsed: ReadonlySet<ProjectId>,
): ReadonlyArray<TimelineLane> {
  const lanes: Array<TimelineLane> = [];
  for (const row of rows) {
    const expanded = !collapsed.has(row.projectId);
    lanes.push({ kind: "project", key: `project:${row.projectId}`, row, expanded });
    if (!expanded) continue;
    if (row.bars.length === 0) {
      lanes.push({ kind: "empty", key: `empty:${row.projectId}`, projectId: row.projectId });
      continue;
    }
    for (const bar of row.bars) {
      lanes.push({
        kind: "milestone",
        key: `milestone:${bar.milestone.id}`,
        projectId: row.projectId,
        bar,
      });
    }
  }
  return lanes;
}

// ── Cycle bands ────────────────────────────────────────────────────────

/**
 * A cycle across the header rather than on a row of its own: a cycle spans every project at once,
 * so it is the period the rows are read against, not another bar among them.
 */
export interface TimelineCycleBand {
  readonly cycle: IssueCycle;
  readonly x: number;
  readonly width: number;
  /** The band runs off that end of the scale rather than ending there — draw it square, not round. */
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
  /** Which header row it sits on. Always 0 until two cycles overlap, which nothing forbids. */
  readonly lane: number;
}

/** Ascending `startDate`, `id` breaking ties — the order the bands are packed into rows in. */
function compareCycleOrder(left: IssueCycle, right: IssueCycle): number {
  if (left.startDate !== right.startDate) return left.startDate < right.startDate ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Cycles as bands over the scale, in the order they start.
 *
 * A cycle with no day on the scale is left out entirely rather than clamped to an edge, and one
 * that only partly fits is clipped and says so. Overlapping cycles stack onto further header rows:
 * two can be active at once, and two bands on one row would read as a single wrong period.
 */
export function buildTimelineCycleBands(
  cycles: ReadonlyArray<IssueCycle>,
  scale: TimelineScale,
): ReadonlyArray<TimelineCycleBand> {
  const bands: Array<TimelineCycleBand> = [];
  /** The last day already taken on each header row. */
  const laneEnds: Array<string> = [];

  for (const cycle of [...cycles].sort(compareCycleOrder)) {
    // Backwards dates are refused by the service, so this only catches a row that predates that.
    const end = cycle.endDate < cycle.startDate ? cycle.startDate : cycle.endDate;
    if (end < scale.start || cycle.startDate > scale.end) continue;

    const free = laneEnds.findIndex((taken) => taken < cycle.startDate);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = end;

    const left = Math.max(0, timelineX(scale, cycle.startDate));
    const right = Math.min(scale.width, timelineX(scale, end) + scale.dayWidth);
    bands.push({
      cycle,
      x: left,
      width: Math.max(scale.dayWidth, right - left),
      clippedStart: cycle.startDate < scale.start,
      clippedEnd: end > scale.end,
      lane,
    });
  }
  return bands;
}

/**
 * How many header rows the bands need. Zero when no cycle touches the scale, which is what keeps
 * the header exactly the height it was on a surface that passes none.
 */
export function timelineCycleBandLanes(bands: ReadonlyArray<TimelineCycleBand>): number {
  let lanes = 0;
  for (const band of bands) lanes = Math.max(lanes, band.lane + 1);
  return lanes;
}

// ── Drag ids ───────────────────────────────────────────────────────────

/**
 * `@dnd-kit` keys draggables and droppables in one namespace, so a bar, a tray chip, and the two
 * drop zones have to be told apart by their ids. Prefixing is also what keeps the resolution below
 * pure: it never reads a DOM node or a `data` bag.
 */
const BAR_DRAG_PREFIX = "milestone-bar:";
const TRAY_DRAG_PREFIX = "milestone-tray:";

export const TIMELINE_GRID_DROP_ID = "milestone-grid";
export const TIMELINE_TRAY_DROP_ID = "milestone-tray";

export function timelineBarDragId(milestoneId: IssueMilestoneId): string {
  return `${BAR_DRAG_PREFIX}${milestoneId}`;
}

export function timelineTrayDragId(milestoneId: IssueMilestoneId): string {
  return `${TRAY_DRAG_PREFIX}${milestoneId}`;
}

export type TimelineDragId =
  | { readonly kind: "bar"; readonly milestoneId: IssueMilestoneId }
  | { readonly kind: "tray"; readonly milestoneId: IssueMilestoneId };

export function parseTimelineDragId(id: string): TimelineDragId | null {
  if (id.startsWith(BAR_DRAG_PREFIX)) {
    const milestoneId = id.slice(BAR_DRAG_PREFIX.length);
    return milestoneId.length === 0
      ? null
      : { kind: "bar", milestoneId: milestoneId as IssueMilestoneId };
  }
  if (id.startsWith(TRAY_DRAG_PREFIX)) {
    const milestoneId = id.slice(TRAY_DRAG_PREFIX.length);
    return milestoneId.length === 0
      ? null
      : { kind: "tray", milestoneId: milestoneId as IssueMilestoneId };
  }
  return null;
}

// ── Drop resolution ────────────────────────────────────────────────────

/** Which part of the bar the pointer grabbed. The body moves both ends; an edge moves one. */
export type TimelineDragEdge = "start" | "end" | "move";

/** One `issues.milestoneUpdate` patch — both fields, because a drag can change either or both. */
export interface TimelineDates {
  readonly startDate: IssueDate | null;
  readonly targetDate: IssueDate | null;
}

/** Grabbing within this many pixels of an end resizes it; anywhere else moves the whole bar. */
export const TIMELINE_EDGE_GRAB_PX = 10;

/**
 * Where a press inside a bar landed. A bar narrow enough that the two edge zones would meet is all
 * body: a one-day bar you cannot move is worse than a one-day bar you cannot resize by dragging,
 * and the popover resizes it either way.
 */
export function timelineGrabEdge(input: {
  readonly offsetX: number;
  readonly width: number;
}): TimelineDragEdge {
  if (input.width < TIMELINE_EDGE_GRAB_PX * 3) return "move";
  if (input.offsetX <= TIMELINE_EDGE_GRAB_PX) return "start";
  if (input.offsetX >= input.width - TIMELINE_EDGE_GRAB_PX) return "end";
  return "move";
}

/**
 * What a finished drag means in dates, or null when it means nothing — no travel, or a milestone
 * with no date to move (a tray chip is scheduled by {@link resolveTimelineSchedule} instead).
 *
 * Both ends are kept in order by clamping rather than by swapping: dragging the start past the
 * target parks it *on* the target, which is what the bar looked like it was doing, and is the
 * constraint the service enforces anyway. Dragging an edge of a one-ended milestone gives it the
 * other end, which is how a checkpoint becomes a span without opening a dialog.
 */
export function resolveTimelineDrag(input: {
  readonly milestone: Pick<IssueMilestone, "startDate" | "targetDate">;
  readonly edge: TimelineDragEdge;
  readonly deltaDays: number;
}): TimelineDates | null {
  const { startDate, targetDate } = input.milestone;
  if (input.deltaDays === 0) return null;
  if (startDate === null && targetDate === null) return null;

  if (input.edge === "move") {
    return {
      startDate:
        startDate === null ? null : (addIssueDays(startDate, input.deltaDays) as IssueDate),
      targetDate:
        targetDate === null ? null : (addIssueDays(targetDate, input.deltaDays) as IssueDate),
    };
  }

  if (input.edge === "start") {
    const moved = addIssueDays(startDate ?? (targetDate as string), input.deltaDays);
    const next = targetDate !== null && moved > targetDate ? targetDate : moved;
    return next === startDate ? null : { startDate: next as IssueDate, targetDate };
  }

  const moved = addIssueDays(targetDate ?? (startDate as string), input.deltaDays);
  const next = startDate !== null && moved < startDate ? startDate : moved;
  return next === targetDate ? null : { startDate, targetDate: next as IssueDate };
}

/**
 * A milestone dragged out of the tray lands as a week rather than as a zero-width point: the first
 * thing anyone does after scheduling one is drag its ends, and there has to be something to grab.
 */
export const TIMELINE_DEFAULT_SPAN_DAYS = 7;

export function resolveTimelineSchedule(date: string): TimelineDates {
  return {
    startDate: date as IssueDate,
    targetDate: addIssueDays(date, TIMELINE_DEFAULT_SPAN_DAYS - 1) as IssueDate,
  };
}

/**
 * Dragging a bar back to the tray clears both dates — the way out for the way in above. Null when
 * there is nothing to clear, so a chip dropped back where it started writes nothing.
 */
export function resolveTimelineUnschedule(
  milestone: Pick<IssueMilestone, "startDate" | "targetDate">,
): TimelineDates | null {
  if (milestone.startDate === null && milestone.targetDate === null) return null;
  return { startDate: null, targetDate: null };
}
