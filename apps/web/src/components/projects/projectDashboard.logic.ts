/**
 * The numbers a project dashboard reports, derived without touching React.
 *
 * Everything here answers one of two questions: how much work is there, and are we behind. "Behind"
 * is deliberately conservative — it is a statement about a date that has been agreed, so it is only
 * ever claimed when a milestone carries a target date and that date has passed with work still open.
 * Guessing at velocity would produce a number nobody could defend.
 *
 * @module components/projects/projectDashboard.logic
 */
import type { IssueStatusCategory } from "@spiritdevs/contracts";

/** The issue fields a rollup reads. Kept structural so tests need no fixtures from the store. */
export interface DashboardIssue {
  readonly id: string;
  readonly projectId: string | null;
  readonly statusId: string | null;
  readonly milestoneId: string | null;
  readonly assignee: {
    readonly kind: string;
    readonly id?: string;
    readonly label?: string;
  } | null;
  readonly dueDate: string | null;
  readonly triage: boolean;
  readonly updatedAt: string;
}

export interface DashboardStatus {
  readonly id: string;
  readonly category: IssueStatusCategory;
}

export interface DashboardMilestone {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly targetDate: string | null;
}

export interface IssueRollup {
  readonly total: number;
  readonly done: number;
  readonly inProgress: number;
  readonly notStarted: number;
  /** Open issues whose own due date has passed. */
  readonly overdue: number;
  readonly byCategory: ReadonlyMap<IssueStatusCategory, number>;
}

/** Categories that mean the work is finished, either shipped or abandoned. */
const CLOSED_CATEGORIES: ReadonlySet<IssueStatusCategory> = new Set(["completed", "canceled"]);
/** Categories that mean somebody has picked the work up. */
const ACTIVE_CATEGORIES: ReadonlySet<IssueStatusCategory> = new Set(["started", "review"]);

export function isClosedCategory(category: IssueStatusCategory): boolean {
  return CLOSED_CATEGORIES.has(category);
}

/**
 * Counts a project's issues by where they sit in the workflow.
 *
 * Triage items are excluded throughout: they are outside the workflow by design, and counting them
 * would make a project look busier than the work anybody has actually agreed to do.
 */
export function summarizeProjectIssues(input: {
  readonly issues: ReadonlyArray<DashboardIssue>;
  readonly statuses: ReadonlyArray<DashboardStatus>;
  readonly today: string;
}): IssueRollup {
  const categoryByStatusId = new Map(input.statuses.map((status) => [status.id, status.category]));
  const byCategory = new Map<IssueStatusCategory, number>();
  let total = 0;
  let done = 0;
  let inProgress = 0;
  let notStarted = 0;
  let overdue = 0;

  for (const issue of input.issues) {
    if (issue.triage) continue;
    total += 1;
    const category = issue.statusId === null ? undefined : categoryByStatusId.get(issue.statusId);
    if (category !== undefined) {
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      if (CLOSED_CATEGORIES.has(category)) done += 1;
      else if (ACTIVE_CATEGORIES.has(category)) inProgress += 1;
      else notStarted += 1;
    } else {
      // An issue with no status, or one whose status was deleted from another client, is still
      // work somebody has to do. Counting it as not started beats dropping it from the total.
      notStarted += 1;
    }
    const open = category === undefined || !CLOSED_CATEGORIES.has(category);
    if (open && issue.dueDate !== null && issue.dueDate < input.today) overdue += 1;
  }

  return { total, done, inProgress, notStarted, overdue, byCategory };
}

export interface MilestoneProgress {
  readonly id: string;
  readonly name: string;
  readonly targetDate: string | null;
  readonly total: number;
  readonly done: number;
  /** True only when a target date has passed and work is still open against it. */
  readonly behind: boolean;
  /** Whole days until the target date; negative once it has passed. Null with no target. */
  readonly daysRemaining: number | null;
}

function wholeDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/** Progress and lateness per milestone, newest deadline first so what is urgent reads first. */
export function summarizeProjectMilestones(input: {
  readonly milestones: ReadonlyArray<DashboardMilestone>;
  readonly issues: ReadonlyArray<DashboardIssue>;
  readonly statuses: ReadonlyArray<DashboardStatus>;
  readonly today: string;
}): ReadonlyArray<MilestoneProgress> {
  const categoryByStatusId = new Map(input.statuses.map((status) => [status.id, status.category]));
  return input.milestones
    .map((milestone): MilestoneProgress => {
      const issues = input.issues.filter(
        (issue) => !issue.triage && issue.milestoneId === milestone.id,
      );
      const done = issues.filter((issue) => {
        const category =
          issue.statusId === null ? undefined : categoryByStatusId.get(issue.statusId);
        return category !== undefined && CLOSED_CATEGORIES.has(category);
      }).length;
      const daysRemaining =
        milestone.targetDate === null ? null : wholeDaysBetween(input.today, milestone.targetDate);
      return {
        id: milestone.id,
        name: milestone.name,
        targetDate: milestone.targetDate,
        total: issues.length,
        done,
        behind:
          milestone.targetDate !== null &&
          milestone.targetDate < input.today &&
          done < issues.length,
        daysRemaining,
      };
    })
    .toSorted((left, right) => {
      // A milestone with no date cannot be late, so it sorts after every dated one.
      if (left.targetDate === null && right.targetDate === null) {
        return left.name.localeCompare(right.name);
      }
      if (left.targetDate === null) return 1;
      if (right.targetDate === null) return -1;
      return left.targetDate.localeCompare(right.targetDate);
    });
}

export interface ContributorLoad {
  readonly key: string;
  readonly label: string;
  readonly open: number;
  readonly done: number;
}

/**
 * Who is carrying this project's work, busiest first.
 *
 * Unassigned issues are reported as their own row rather than omitted: a project where most work
 * has no owner is exactly the thing a dashboard should make obvious.
 */
export function summarizeProjectContributors(input: {
  readonly issues: ReadonlyArray<DashboardIssue>;
  readonly statuses: ReadonlyArray<DashboardStatus>;
}): ReadonlyArray<ContributorLoad> {
  const categoryByStatusId = new Map(input.statuses.map((status) => [status.id, status.category]));
  const loads = new Map<string, { label: string; open: number; done: number }>();

  for (const issue of input.issues) {
    if (issue.triage) continue;
    const key =
      issue.assignee === null
        ? "unassigned"
        : `${issue.assignee.kind}:${issue.assignee.id ?? issue.assignee.label ?? ""}`;
    const label =
      issue.assignee === null
        ? "Unassigned"
        : (issue.assignee.label ?? issue.assignee.id ?? issue.assignee.kind);
    const current = loads.get(key) ?? { label, open: 0, done: 0 };
    const category = issue.statusId === null ? undefined : categoryByStatusId.get(issue.statusId);
    if (category !== undefined && CLOSED_CATEGORIES.has(category)) current.done += 1;
    else current.open += 1;
    loads.set(key, current);
  }

  return [...loads.entries()]
    .map(([key, load]) => ({ key, ...load }))
    .toSorted((left, right) => right.open - left.open || right.done - left.done);
}
