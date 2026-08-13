/**
 * The numbers behind the milestone detail page's KPI row.
 *
 * All of it is arithmetic over three inputs — the milestone's dates, its `{done,total}` rollup, and
 * today — so it lives here rather than inside the page. "Is this milestone behind?" is a claim, and
 * a claim computed while rendering can only be checked by looking at it.
 *
 * Spans are whole calendar days and count today at both ends: a milestone created this morning has
 * one elapsed day rather than zero, which is what keeps `pace` from dividing by nothing, and a
 * target of today still leaves today to finish in.
 *
 * @module components/issues/milestoneDetail.logic
 */
import type { IssueMilestone, IssueMilestoneStatus, IssueStatusCategory } from "@t3tools/contracts";

import type { IssueProgress } from "~/state/issues";
import { addIssueDays } from "./issuesList.logic";

const MS_PER_DAY = 86_400_000;

/**
 * How far short of the pace the target needs a milestone may fall before it stops reading "at
 * risk" and starts reading "behind". Three quarters of the required pace is roughly "one more good
 * week would fix this"; below it, the plan is the thing that has to change.
 */
export const MILESTONE_AT_RISK_PACE_RATIO = 0.75;

/** The `Badge` variants a milestone reads in. Each one ships beside a word, never on its own. */
export type MilestoneTone = "success" | "warning" | "error" | "info" | "outline";

export interface MilestoneToneLabel {
  readonly label: string;
  readonly tone: MilestoneTone;
}

/** Whether the current pace lands the remaining work on the target date. */
export type MilestonePaceVerdict = "on-track" | "at-risk" | "behind" | "unknown";

function dayIndex(date: string): number | null {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const at = Date.UTC(year, month - 1, day);
  return Number.isNaN(at) ? null : at / MS_PER_DAY;
}

/** Whole days from `from` to `to`, negative when `to` is the earlier one. Null if either is junk. */
function daysBetween(from: string, to: string): number | null {
  const start = dayIndex(from);
  const end = dayIndex(to);
  if (start === null || end === null) return null;
  return end - start;
}

/**
 * The `started` half of the tally `issueMilestoneStatusOn` reads, from the category breakdown.
 *
 * Derived by subtraction rather than by listing the categories that count: `total` already drops
 * canceled work and `done` is the completed slice, so everything left over that is not still
 * waiting to be planned is in flight. A category added later — `review` was — therefore lands on
 * the started side without an edit here.
 */
export function milestoneStartedCount(
  progress: IssueProgress,
  counts: ReadonlyMap<IssueStatusCategory, number>,
): number {
  const notBegun = (counts.get("backlog") ?? 0) + (counts.get("unstarted") ?? 0);
  return Math.max(0, progress.total - progress.done - notBegun);
}

export interface MilestoneKpiInput {
  readonly milestone: Pick<IssueMilestone, "startDate" | "targetDate" | "createdAt">;
  readonly progress: IssueProgress;
  /** `YYYY-MM-DD`, passed in so the tiles read the same in a test as they do at 3am. */
  readonly today: string;
}

export interface MilestoneKpis {
  readonly done: number;
  readonly total: number;
  readonly remaining: number;
  /** `done / total`, and `0` for a milestone holding nothing. Feed straight to `<Progress>`. */
  readonly ratio: number;
  /** Whole days from today to the target, negative once it is past. Null without a target. */
  readonly daysRemaining: number | null;
  /** Days the milestone has been running, today included, so it is never below one. */
  readonly elapsedDays: number;
  /** Issues completed per elapsed day. `0` until something is completed. */
  readonly pace: number;
  /** The pace the rest of the work needs to hit the target. Null without a target. */
  readonly requiredPace: number | null;
  /**
   * The day the remaining work lands on at the current pace. Null when there is nothing to project
   * — either no pace yet or nothing left — and `remaining` says which.
   */
  readonly projectedFinish: string | null;
  readonly verdict: MilestonePaceVerdict;
}

/**
 * Every tile in one pass. The verdict compares the milestone's own pace against the pace the
 * target needs, which is the same comparison `projectedFinish` makes against `targetDate` — they
 * cannot disagree, so the tile that says "behind" and the tile that names a date agree too.
 *
 * A milestone with nothing completed yet gets `unknown` rather than `behind`: on its first morning
 * there is no evidence either way, and a KPI that opens on "behind" is a KPI nobody reads twice.
 */
export function milestoneKpis(input: MilestoneKpiInput): MilestoneKpis {
  const { milestone, progress, today } = input;
  const total = Math.max(0, progress.total);
  const done = Math.min(total, Math.max(0, progress.done));
  const remaining = total - done;
  const ratio = total === 0 ? 0 : done / total;

  const daysRemaining =
    milestone.targetDate === null ? null : daysBetween(today, milestone.targetDate);

  // No start date means the milestone has been running since somebody made it, which is the only
  // other date it carries.
  const startedOn = milestone.startDate ?? milestone.createdAt.slice(0, 10);
  const elapsedDays = Math.max(1, (daysBetween(startedOn, today) ?? 0) + 1);
  const pace = done / elapsedDays;

  // Today counts as a day of work, and a target already past leaves exactly today to do it in.
  const requiredPace = daysRemaining === null ? null : remaining / Math.max(1, daysRemaining + 1);
  const projectedFinish =
    remaining === 0 || pace === 0 ? null : addIssueDays(today, Math.ceil(remaining / pace) - 1);

  return {
    done,
    total,
    remaining,
    ratio,
    daysRemaining,
    elapsedDays,
    pace,
    requiredPace,
    projectedFinish,
    verdict: paceVerdict({ total, remaining, daysRemaining, pace, requiredPace }),
  };
}

function paceVerdict(input: {
  readonly total: number;
  readonly remaining: number;
  readonly daysRemaining: number | null;
  readonly pace: number;
  readonly requiredPace: number | null;
}): MilestonePaceVerdict {
  if (input.total === 0) return "unknown";
  if (input.remaining === 0) return "on-track";
  if (input.daysRemaining === null || input.requiredPace === null) return "unknown";
  if (input.daysRemaining < 0) return "behind";
  if (input.pace === 0) return "unknown";
  if (input.pace >= input.requiredPace) return "on-track";
  return input.pace >= input.requiredPace * MILESTONE_AT_RISK_PACE_RATIO ? "at-risk" : "behind";
}

export function milestoneVerdictPresentation(verdict: MilestonePaceVerdict): MilestoneToneLabel {
  switch (verdict) {
    case "on-track":
      return { label: "On track", tone: "success" };
    case "at-risk":
      return { label: "At risk", tone: "warning" };
    case "behind":
      return { label: "Behind", tone: "error" };
    case "unknown":
      return { label: "No pace yet", tone: "outline" };
  }
}

export function milestoneStatusPresentation(status: IssueMilestoneStatus): MilestoneToneLabel {
  switch (status) {
    case "completed":
      return { label: "Completed", tone: "success" };
    case "overdue":
      return { label: "Overdue", tone: "error" };
    case "in-progress":
      return { label: "In progress", tone: "info" };
    case "upcoming":
      return { label: "Upcoming", tone: "outline" };
  }
}

/** The days-to-target tile. An em-dash rather than a zero when the milestone has no target. */
export function formatMilestoneDaysRemaining(daysRemaining: number | null): string {
  if (daysRemaining === null) return "—";
  if (daysRemaining === 0) return "Due today";
  const days = Math.abs(daysRemaining);
  const unit = days === 1 ? "day" : "days";
  return daysRemaining > 0 ? `${days} ${unit}` : `${days} ${unit} ago`;
}

/**
 * Issues per day, to one decimal — a milestone finishing three issues a week paces at `0.4/day`,
 * and rounding that to `0` would report a moving milestone as a stalled one.
 */
export function formatMilestonePace(pace: number): string {
  if (!Number.isFinite(pace) || pace <= 0) return "—";
  return `${pace.toFixed(1)}/day`;
}
