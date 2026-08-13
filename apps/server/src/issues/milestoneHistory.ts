/**
 * Daily burn-up for one milestone, reconstructed from the issue change log.
 *
 * Nothing stores a milestone's past, so this rebuilds it. The replay runs **backwards** from the
 * state we know is true — today's members and today's statuses — undoing `issue_events` rows
 * newest first. Forwards would be wrong: an issue created already assigned to a milestone writes
 * a `created` row with no milestone field, so a forward replay would never see it join.
 *
 * Two things the change log cannot tell us, both stated rather than papered over:
 *
 * - It stores display names, not ids. A status renamed or deleted since is unmappable, counts as
 *   unstarted, and sets `approximate` — the chart says the series is a best guess rather than
 *   quietly drawing a number nobody can stand behind. A renamed *milestone* trips the same flag.
 * - It only sees the milestone's current members. An issue moved *out* of the milestone is not
 *   among them and so vanishes from its own history. Catching those needs a second, unindexed
 *   scan of `issue_events.before` across the whole table; not worth it until somebody misses it.
 *
 * @module issues/milestoneHistory
 */
import * as DateTime from "effect/DateTime";

import type {
  IssueDate,
  IssueMilestone,
  IssueMilestoneHistoryPoint,
  IssueMilestoneHistoryResult,
  IssueStatusCategory,
} from "@t3tools/contracts";

/**
 * Categories holding work nobody has begun, plus the one nobody ever will. Named as an exclusion
 * so the burn-up counts anything else as started: `review` is work in flight and counts the day it
 * lands, `completed` stays counted because the started line is cumulative, and whatever category a
 * later migration adds counts too rather than silently dropping out of the series.
 */
const NOT_YET_STARTED_CATEGORIES: ReadonlySet<IssueStatusCategory> = new Set([
  "backlog",
  "unstarted",
  "canceled",
]);

/** Cumulative: work that has begun, whether or not it has since finished. */
const hasStarted = (category: IssueStatusCategory): boolean =>
  !NOT_YET_STARTED_CATEGORIES.has(category);

/**
 * The longest series this will draw, ending at the last day in range.
 *
 * A milestone holding an issue filed three years ago would otherwise ship a thousand points over
 * the websocket to render in a few hundred pixels. Backward replay computes each day from the
 * present rather than from the previous point, so cutting the series short costs only the days
 * that were cut, never the accuracy of the days that remain.
 */
export const MILESTONE_HISTORY_MAX_DAYS = 366;

/**
 * The calendar day an ISO timestamp falls on, read in the same zone `today` was. The log stores
 * UTC, so bucketing it in UTC would push this evening's work onto tomorrow's point anywhere west
 * of Greenwich — and tomorrow is off the end of the series, so the last point would disagree with
 * the KPI tile sitting beside it.
 */
const dayIn = (zone: DateTime.TimeZone, isoDateTime: string): IssueDate =>
  DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(isoDateTime), zone));

/** Whole days in UTC, where every day is the same length — no zone, so no daylight saving. */
const shiftDay = (date: IssueDate, days: number): IssueDate =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${date}T00:00:00Z`), { days }));

/** A current member of the milestone: the known-true state the replay walks back from. */
export interface MilestoneHistoryMember {
  readonly id: string;
  readonly statusId: string;
  readonly createdAt: string;
}

/** One `field_changed` row, narrowed to the fields that move an issue in or out of a count. */
export interface MilestoneHistoryEvent {
  readonly issueId: string;
  /** Null on the kinds that are not field changes; those are ignored. */
  readonly field: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly createdAt: string;
}

/** The live statuses, which are the only thing a logged status name can be matched against. */
export interface MilestoneHistoryStatus {
  readonly id: string;
  readonly name: string;
  readonly category: IssueStatusCategory;
}

export interface MilestoneHistoryInput {
  readonly milestone: Pick<IssueMilestone, "name" | "startDate" | "targetDate">;
  /** Already filtered to the rollup set: assigned to this milestone, not deleted, not triage. */
  readonly members: ReadonlyArray<MilestoneHistoryMember>;
  /** The members' `status` and `milestone` rows. Order does not matter; ties keep input order. */
  readonly events: ReadonlyArray<MilestoneHistoryEvent>;
  readonly statuses: ReadonlyArray<MilestoneHistoryStatus>;
  /** The server's local calendar day, which is where the series ends. */
  readonly today: IssueDate;
  /** The zone `today` was read in, so the log's UTC timestamps land on the same days it does. */
  readonly zone: DateTime.TimeZone;
}

interface MemberState {
  inMilestone: boolean;
  category: IssueStatusCategory;
  readonly createdOn: IssueDate;
}

/**
 * Build the burn-up series, ascending by date.
 *
 * The range runs from the earlier of the milestone's start date and its oldest member's creation
 * day through today. It never stops at the target date: an overdue milestone is the one somebody
 * opens this chart for, and cutting the series at its target would hide every issue finished since
 * — including, for a target that passed before the work was filed, all of them.
 */
export function milestoneHistory(input: MilestoneHistoryInput): IssueMilestoneHistoryResult {
  const { milestone, today, zone } = input;
  let approximate = false;

  const categoryByName = new Map(
    input.statuses.map((status) => [status.name, status.category] as const),
  );
  const categoryById = new Map(
    input.statuses.map((status) => [status.id, status.category] as const),
  );

  /** An unmatched name is unstarted, and says so through `approximate`. */
  const categoryOfName = (name: string | null): IssueStatusCategory => {
    const category = name === null ? undefined : categoryByName.get(name);
    if (category === undefined) {
      approximate = true;
      return "unstarted";
    }
    return category;
  };

  const byId = new Map<string, MemberState>();
  for (const member of input.members) {
    const category = categoryById.get(member.statusId);
    if (category === undefined) approximate = true;
    byId.set(member.id, {
      inMilestone: true,
      category: category ?? "unstarted",
      createdOn: dayIn(zone, member.createdAt),
    });
  }

  const end = today;
  let start: IssueDate | null = milestone.startDate;
  for (const state of byId.values()) {
    if (start === null || state.createdOn < start) start = state.createdOn;
  }
  if (start === null || start > end) return { points: [], approximate };
  const earliest = shiftDay(end, 1 - MILESTONE_HISTORY_MAX_DAYS);
  if (start < earliest) start = earliest;

  // Stable, so rows written by one edit on one timestamp keep the order the repository read them
  // in — which is insertion order, and the only tiebreak the log has. The day comes along because
  // the replay asks for it once per day per event otherwise.
  const ordered = input.events
    .toSorted((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
    )
    .map((event) => ({ event, day: dayIn(zone, event.createdAt) }));

  const undo = (event: MilestoneHistoryEvent) => {
    const state = byId.get(event.issueId);
    if (state === undefined) return;
    if (event.field === "status") {
      state.category = categoryOfName(event.before);
      return;
    }
    if (event.field !== "milestone") return;
    // Whatever put the issue where it is now must name this milestone; if it does not, the
    // milestone was renamed and every name comparison below it is unreliable.
    if (state.inMilestone && event.after !== milestone.name) approximate = true;
    state.inMilestone = event.before === milestone.name;
  };

  const points: Array<IssueMilestoneHistoryPoint> = [];
  let cursor = ordered.length - 1;
  for (let date = end; date >= start; date = shiftDay(date, -1)) {
    while (cursor >= 0) {
      const entry = ordered[cursor];
      if (entry === undefined || entry.day <= date) break;
      undo(entry.event);
      cursor -= 1;
    }
    let scope = 0;
    let started = 0;
    let completed = 0;
    for (const state of byId.values()) {
      // Before an issue existed it was in no milestone, whatever the replay says about it.
      if (!state.inMilestone || state.createdOn > date) continue;
      scope += 1;
      if (hasStarted(state.category)) started += 1;
      if (state.category === "completed") completed += 1;
    }
    points.push({ date, scope, started, completed });
  }
  points.reverse();

  return { points, approximate };
}
