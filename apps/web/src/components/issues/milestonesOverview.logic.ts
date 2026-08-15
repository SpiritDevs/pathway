/**
 * What `/issues/milestones` decides without the DOM: the view mode and project filter the URL
 * carries, the per-project grouping the list renders, and the two derivations each row needs — the
 * tally {@link issueMilestoneStatusOn} reads, and the date range that sits beside the meter.
 *
 * The sidebar shares the path helpers: a milestone row lights up because the URL says so, the same
 * way every other row in that sidebar does.
 *
 * @module components/issues/milestonesOverview.logic
 */
import type {
  IssueMilestone,
  IssueMilestoneId,
  IssueMilestoneStatus,
  IssueStatusCategory,
  ProjectId,
} from "@spiritdevs/contracts";

import type { IssueProgress } from "~/state/issues";
import { formatIssueDateRange, formatIssueDueDate } from "./issuesList.logic";

// ── Search params ──────────────────────────────────────────────────────

export const MILESTONES_OVERVIEW_VIEWS = ["list", "timeline"] as const;
export type MilestonesOverviewView = (typeof MILESTONES_OVERVIEW_VIEWS)[number];

export const DEFAULT_MILESTONES_OVERVIEW_VIEW: MilestonesOverviewView = "list";

export interface MilestonesOverviewSearch {
  /** Absent is the list, so a link to the page carries no params at all. */
  readonly view?: MilestonesOverviewView | undefined;
  /** A `ProjectId` as the URL spells it — unvalidated, because the project may not have loaded. */
  readonly project?: string | undefined;
}

export type MilestonesOverviewSearchPatch = Partial<MilestonesOverviewSearch>;

/**
 * Tolerant like {@link parseIssuesSearch}: a hand-edited or stale param falls back to the default
 * rather than failing the route, and the default rides as an absent param so `?view=list` and a
 * bare URL are the same screen.
 */
export function parseMilestonesOverviewSearch(
  raw: Record<string, unknown>,
): MilestonesOverviewSearch {
  const view = raw.view;
  const project = raw.project;
  return {
    view: view === "list" || view === "timeline" ? view : undefined,
    project: typeof project === "string" && project.trim().length > 0 ? project : undefined,
  };
}

export function milestonesOverviewView(search: MilestonesOverviewSearch): MilestonesOverviewView {
  return search.view ?? DEFAULT_MILESTONES_OVERVIEW_VIEW;
}

// ── Paths ──────────────────────────────────────────────────────────────

const MILESTONES_PATH = "/issues/milestones";

/** True on the overview and on any one milestone — both are "Milestones" as far as a nav row cares. */
export function isMilestonesPathname(pathname: string): boolean {
  return pathname === MILESTONES_PATH || pathname.startsWith(`${MILESTONES_PATH}/`);
}

/**
 * The milestone whose detail page is open, or null anywhere else. This is what a sidebar row reads
 * to know it is the current one, now that pressing it navigates instead of filtering the list.
 */
export function milestoneIdInPathname(pathname: string): IssueMilestoneId | null {
  if (!pathname.startsWith(`${MILESTONES_PATH}/`)) return null;
  const segment = pathname.slice(MILESTONES_PATH.length + 1);
  if (segment.length === 0 || segment.includes("/")) return null;
  return decodeURIComponent(segment) as IssueMilestoneId;
}

// ── Grouping ───────────────────────────────────────────────────────────

export interface MilestonesOverviewGroup {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly milestones: ReadonlyArray<IssueMilestone>;
}

/** Ascending `position`, `id` breaking ties — the total order the contract promises. */
function compareMilestoneOrder(left: IssueMilestone, right: IssueMilestone): number {
  if (left.position !== right.position) return left.position - right.position;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * One group per project, in the order the project list is in. A project with no milestones keeps
 * its group: the empty group is where its "New milestone" row lives, and hiding it would hide the
 * only way to make the first one.
 *
 * A milestone naming a project that is not in the list is dropped rather than given a group of its
 * own — `projectId` is required, so the only way to hold one is a project the client has yet to
 * read, and it comes back as soon as that read lands.
 */
export function milestonesOverviewGroups(
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
  milestones: ReadonlyArray<IssueMilestone>,
  projectFilter: string | undefined,
): ReadonlyArray<MilestonesOverviewGroup> {
  const byProject = new Map<ProjectId, Array<IssueMilestone>>();
  for (const milestone of milestones) {
    const bucket = byProject.get(milestone.projectId);
    if (bucket === undefined) byProject.set(milestone.projectId, [milestone]);
    else bucket.push(milestone);
  }

  const groups: Array<MilestonesOverviewGroup> = [];
  for (const project of projects) {
    if (projectFilter !== undefined && project.id !== projectFilter) continue;
    groups.push({
      projectId: project.id,
      title: project.title,
      milestones: (byProject.get(project.id) ?? []).sort(compareMilestoneOrder),
    });
  }
  return groups;
}

// ── Row derivations ────────────────────────────────────────────────────

/**
 * Categories holding work nobody has begun. Everything short of `completed` and outside this set
 * counts as started — `review` included, and so is whatever a later migration adds, which is the
 * whole reason the exclusions are named here rather than the inclusions.
 */
const NOT_YET_STARTED_CATEGORIES: ReadonlySet<IssueStatusCategory> = new Set([
  "backlog",
  "unstarted",
]);

export interface MilestoneTally extends IssueProgress {
  readonly started: number;
}

/**
 * What {@link issueMilestoneStatusOn} reads. `done` and `total` come from the same rollup the
 * sidebar shows, so a row and its sidebar entry never disagree; `started` is counted off the
 * category breakdown, which is the only place work sitting in review is visible.
 */
export function milestoneTally(
  progress: IssueProgress,
  counts: ReadonlyMap<IssueStatusCategory, number>,
): MilestoneTally {
  let started = 0;
  for (const [category, count] of counts) {
    if (category === "completed" || category === "canceled") continue;
    if (NOT_YET_STARTED_CATEGORIES.has(category)) continue;
    started += count;
  }
  return { done: progress.done, total: progress.total, started };
}

/**
 * Every issue the milestone holds, canceled ones included — unlike the rollup's `total`. A delete
 * confirm asks about all of them, because all of them are what the delete unassigns.
 */
export function milestoneIssueCount(counts: ReadonlyMap<IssueStatusCategory, number>): number {
  let held = 0;
  for (const count of counts.values()) held += count;
  return held;
}

/** The share of the meter that is filled. An empty milestone reads as zero, not as finished. */
export function milestoneProgressRatio(progress: IssueProgress): number {
  return progress.total === 0 ? 0 : progress.done / progress.total;
}

/**
 * `Aug 12 – Aug 25` when a milestone is a bar, one end of it when it is only dated one way, and
 * null when it is still an undated point — which every milestone made before dates existed is.
 */
export function formatMilestoneDateRange(
  startDate: string | null,
  targetDate: string | null,
  today: string,
): string | null {
  if (startDate !== null && targetDate !== null) {
    return formatIssueDateRange(startDate, targetDate, today);
  }
  if (targetDate !== null) return `Due ${formatIssueDueDate(targetDate, today)}`;
  if (startDate !== null) return `From ${formatIssueDueDate(startDate, today)}`;
  return null;
}

export const MILESTONE_STATUS_LABELS: Readonly<Record<IssueMilestoneStatus, string>> = {
  upcoming: "Upcoming",
  "in-progress": "In progress",
  completed: "Completed",
  overdue: "Overdue",
};
