/**
 * Geometry for the milestone burn-up chart.
 *
 * Every number the SVG draws is computed here, the way `UsageProviderChart` keeps its scale in a
 * tested sibling: a path string is unreadable once rendered, so the only way to know the line goes
 * where the data says is to assert on it before it becomes one.
 *
 * The x axis spans whole calendar days from the first point through the *later* of the last point
 * and the target date. Stopping at the last point would put the ideal line's endpoint off canvas
 * and hide the gap between where the milestone is and where it was meant to be, which is the
 * question the chart exists to answer.
 *
 * @module components/issues/milestoneBurnUp.logic
 */
import type { IssueMilestoneHistoryPoint } from "@spiritdevs/contracts";

import { addIssueDays } from "./issuesList.logic";

const MS_PER_DAY = 86_400_000;
const TICK_COUNT = 4;

export const BURN_UP_VIEW_WIDTH = 720;
export const BURN_UP_VIEW_HEIGHT = 200;

/** A sliver above the top gridline, so a 2px stroke at the peak is not shaved off by the edge. */
export const BURN_UP_PLOT_TOP = 8;

/** One day is a dot, not a trend: below this the chart says so instead of drawing nothing. */
export const BURN_UP_MIN_POINTS = 2;

/** View units two direct labels must keep between them before one is nudged off the other. */
const LABEL_MIN_GAP = 13;

export interface BurnUpInput {
  /** Ascending by date, one per day, as the server returns them. */
  readonly points: ReadonlyArray<IssueMilestoneHistoryPoint>;
  readonly startDate: string | null;
  readonly targetDate: string | null;
}

/** One day, with its plotted position beside the counts the tooltip reads. */
export interface BurnUpColumn extends IssueMilestoneHistoryPoint {
  readonly x: number;
  readonly scopeY: number;
  readonly completedY: number;
}

export interface BurnUpTick {
  readonly value: number;
  readonly y: number;
}

export interface BurnUpIdeal {
  readonly path: string;
  /** The endpoint, so the component can mark where the plan lands. */
  readonly x: number;
  readonly y: number;
}

export interface BurnUpChart {
  readonly columns: ReadonlyArray<BurnUpColumn>;
  /** The last day, which carries both direct labels. */
  readonly last: BurnUpColumn;
  /** Top of the value axis; `0` only when the milestone held nothing on every day drawn. */
  readonly max: number;
  readonly ticks: ReadonlyArray<BurnUpTick>;
  readonly completedArea: string;
  readonly completedLine: string;
  readonly scopeLine: string;
  /** Null unless the milestone carries both dates, and null for a span of one day. */
  readonly ideal: BurnUpIdeal | null;
  /** First, middle and last day of the axis, for the three labels under it. */
  readonly axisDates: readonly [string, string, string];
  /** Days the axis spans, both ends included. */
  readonly domainDays: number;
  /** Where the first point sits in that span — non-zero when the milestone started before it. */
  readonly firstDayOffset: number;
}

function dayNumber(date: string | null): number | null {
  if (date === null) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const at = Date.UTC(year, month - 1, day);
  return Number.isNaN(at) ? null : at / MS_PER_DAY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A whole-issue axis: the step is always an integer, so no tick ever reads "2.5 issues".
 *
 * The maximum rounds *up* past the peak rather than stopping below it, for the same reason
 * `niceScale` does in the usage chart — a peak drawn above the top gridline is a peak clipped.
 */
export function niceCountScale(
  peak: number,
  count: number,
): { readonly max: number; readonly ticks: ReadonlyArray<number> } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = Math.max(1, peak / count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

function linePath(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

/**
 * The whole chart in one pass, or null when there is nothing worth drawing.
 *
 * Segments are straight rather than smoothed: a burn-up counts issues, and a curve between two
 * days invents fractional issues on the days in between that nobody ever completed.
 */
export function buildBurnUpChart(input: BurnUpInput): BurnUpChart | null {
  const { points } = input;
  if (points.length < BURN_UP_MIN_POINTS) return null;

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;

  const firstDay = dayNumber(first.date);
  const lastDay = dayNumber(last.date);
  if (firstDay === null || lastDay === null || lastDay < firstDay) return null;

  const startDay = dayNumber(input.startDate);
  const targetDay = dayNumber(input.targetDate);
  const domainStartDay = Math.min(firstDay, startDay ?? firstDay);
  const domainEndDay = Math.max(lastDay, targetDay ?? lastDay);
  const domainDays = domainEndDay - domainStartDay + 1;
  const stepX = domainDays <= 1 ? 0 : BURN_UP_VIEW_WIDTH / (domainDays - 1);
  const toX = (day: number) => (day - domainStartDay) * stepX;

  const peak = points.reduce(
    (highest, point) => Math.max(highest, point.scope, point.completed),
    0,
  );
  const { max, ticks: tickValues } = niceCountScale(peak, TICK_COUNT);
  const toY = (value: number) =>
    max === 0
      ? BURN_UP_VIEW_HEIGHT
      : BURN_UP_VIEW_HEIGHT - (value / max) * (BURN_UP_VIEW_HEIGHT - BURN_UP_PLOT_TOP);

  const columns = points.map((point, index) => ({
    ...point,
    x: toX(dayNumber(point.date) ?? firstDay + index),
    scopeY: toY(point.scope),
    completedY: toY(point.completed),
  }));
  const lastColumn = columns[columns.length - 1];
  const firstColumn = columns[0];
  if (lastColumn === undefined || firstColumn === undefined) return null;

  const completedLine = linePath(columns.map((column) => ({ x: column.x, y: column.completedY })));
  const baseline = BURN_UP_VIEW_HEIGHT;
  const domainStartDate = addIssueDays(first.date, domainStartDay - firstDay);

  return {
    columns,
    last: lastColumn,
    max,
    ticks: tickValues.map((value) => ({ value, y: toY(value) })),
    completedArea: `${completedLine} L${lastColumn.x.toFixed(2)},${baseline} L${firstColumn.x.toFixed(2)},${baseline} Z`,
    completedLine,
    scopeLine: linePath(columns.map((column) => ({ x: column.x, y: column.scopeY }))),
    ideal:
      startDay === null || targetDay === null || targetDay <= startDay
        ? null
        : {
            path: linePath([
              { x: toX(startDay), y: toY(0) },
              { x: toX(targetDay), y: toY(last.scope) },
            ]),
            x: toX(targetDay),
            y: toY(last.scope),
          },
    axisDates: [
      domainStartDate,
      addIssueDays(domainStartDate, Math.floor((domainDays - 1) / 2)),
      addIssueDays(domainStartDate, domainDays - 1),
    ],
    domainDays,
    firstDayOffset: firstDay - domainStartDay,
  };
}

/**
 * The day under the pointer, from its position across the plot.
 *
 * Snaps to the nearest whole day and then clamps into the days that have data, so a pointer out
 * past the target date reads the last real day rather than nothing at all.
 */
export function burnUpIndexAtFraction(chart: BurnUpChart, fraction: number): number {
  const day = Math.round(clamp(fraction, 0, 1) * (chart.domainDays - 1));
  return clamp(day - chart.firstDayOffset, 0, chart.columns.length - 1);
}

export interface BurnUpDirectLabel {
  /** Percent across the plot, so the label can be positioned in HTML over a stretched viewBox. */
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly value: number;
}

export interface BurnUpDirectLabels {
  readonly completed: BurnUpDirectLabel;
  readonly scope: BurnUpDirectLabel;
}

/**
 * Where the two end-of-series labels sit.
 *
 * A milestone that finished has `completed === scope`, which would stack both labels on one pixel;
 * when they converge the pair is pushed apart evenly rather than one winning, so neither number
 * moves far from the line it belongs to.
 */
export function burnUpDirectLabels(chart: BurnUpChart): BurnUpDirectLabels {
  const { last } = chart;
  const gap = last.completedY - last.scopeY;
  const nudge = gap >= LABEL_MIN_GAP ? 0 : (LABEL_MIN_GAP - gap) / 2;
  const toPercent = (y: number) => (clamp(y, 0, BURN_UP_VIEW_HEIGHT) / BURN_UP_VIEW_HEIGHT) * 100;
  const leftPercent = (last.x / BURN_UP_VIEW_WIDTH) * 100;

  return {
    completed: {
      leftPercent,
      topPercent: toPercent(last.completedY + nudge),
      value: last.completed,
    },
    scope: { leftPercent, topPercent: toPercent(last.scopeY - nudge), value: last.scope },
  };
}
