/**
 * Saved views — the round trip between an `IssueViewConfig` and the `/issues` search params.
 *
 * A view is not a route and not a mode: it is a name for a set of params. Applying one is a
 * navigation, and recognising one is a comparison. Both directions live here so the sidebar's
 * highlight and the save affordance can never disagree about what "the same view" means.
 *
 * There is deliberately no `?view=<id>` param carrying "which saved view is applied". A view is
 * its params, so the URL a person copies out of the address bar carries the whole question and
 * the highlight follows from the params alone — a filter edited by one chip stops matching the
 * view it came from, which is exactly what the sidebar should show.
 *
 * @module components/issues/issuesViews.logic
 */
import { isProviderDriverKind } from "@t3tools/contracts";
import { MembershipId } from "@t3tools/contracts/company";
import type {
  IssueAssignee,
  IssueCycleId,
  IssueLabelId,
  IssueMilestoneId,
  IssuePriority,
  IssueStatusId,
  IssueView,
  IssueViewConfig,
  IssueViewId,
  IssueViewTab,
  ProjectId,
} from "@t3tools/contracts";

import {
  DEFAULT_ISSUES_GROUPING,
  DEFAULT_ISSUES_SORT_MODE,
  DEFAULT_ISSUES_TAB,
  DEFAULT_ISSUES_VIEW_MODE,
  ISSUE_ASSIGNEE_AGENT_PREFIX,
  ISSUE_ASSIGNEE_MEMBER_PREFIX,
  ISSUE_ASSIGNEE_USER_VALUE,
  ISSUE_GROUPING_LABELS,
  ISSUE_SORT_MODE_LABELS,
  activeIssuesFilterFields,
  issueAssigneeValue,
  issuesFilterSearchPatch,
  issuesSearchFilter,
  issuesSearchGrouping,
  issuesSearchSortMode,
  issuesSearchViewMode,
  type IssuesListFilter,
  type IssuesSearch,
  type IssuesSearchPatch,
} from "./issuesList.logic";

/** What the three tabs are called; the same words the header row uses. */
export const ISSUE_VIEW_TAB_LABELS: Readonly<Record<IssueViewTab, string>> = {
  active: "Active",
  backlog: "Backlog",
  all: "All",
};

/**
 * The params a bare `/issues` means. A view saved from these would be a view of everything, so
 * this is also the thing {@link isIssueViewConfigDirty} measures against.
 */
export const DEFAULT_ISSUE_VIEW_CONFIG: IssueViewConfig = {
  tab: DEFAULT_ISSUES_TAB,
  grouping: DEFAULT_ISSUES_GROUPING,
  sortMode: DEFAULT_ISSUES_SORT_MODE,
  viewMode: DEFAULT_ISSUES_VIEW_MODE,
};

/**
 * The inverse of {@link issueAssigneeValue}. An unknown provider spelling is dropped rather than
 * cast: `IssueViewConfig.assignees` holds real assignees, and the server would refuse a slug that
 * is not one, taking the whole save down with it. A membership is opaque, so the only thing to
 * check is that the token carries one at all — an empty or padded id would fail the same way.
 */
export function parseIssueAssigneeValue(value: string): IssueAssignee | null {
  if (value === ISSUE_ASSIGNEE_USER_VALUE) return { kind: "user" };
  if (value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)) {
    const membershipId = value.slice(ISSUE_ASSIGNEE_MEMBER_PREFIX.length);
    if (membershipId.length === 0 || membershipId !== membershipId.trim()) return null;
    return { kind: "member", membershipId: MembershipId.make(membershipId) };
  }
  if (!value.startsWith(ISSUE_ASSIGNEE_AGENT_PREFIX)) return null;
  const provider = value.slice(ISSUE_ASSIGNEE_AGENT_PREFIX.length);
  return isProviderDriverKind(provider) ? { kind: "agent", provider } : null;
}

/**
 * The params as a saveable view. Every filter is optional in the contract, so an empty chip is an
 * absent key rather than an empty array — an empty array would round-trip as a chip that is on the
 * bar and matches nothing.
 */
export function issuesSearchViewConfig(search: IssuesSearch): IssueViewConfig {
  const filter = issuesSearchFilter(search);
  const assignees = filter.assignees.flatMap((value) => {
    const assignee = parseIssueAssigneeValue(value);
    return assignee === null ? [] : [assignee];
  });
  return {
    tab: search.tab ?? DEFAULT_ISSUES_TAB,
    ...(filter.statusIds.length === 0
      ? {}
      : { statusIds: filter.statusIds as ReadonlyArray<IssueStatusId> }),
    ...(filter.projectIds.length === 0
      ? {}
      : { projectIds: filter.projectIds as ReadonlyArray<ProjectId> }),
    ...(filter.labelIds.length === 0
      ? {}
      : { labelIds: filter.labelIds as ReadonlyArray<IssueLabelId> }),
    ...(filter.milestoneIds.length === 0
      ? {}
      : { milestoneIds: filter.milestoneIds as ReadonlyArray<IssueMilestoneId> }),
    ...(filter.cycleIds.length === 0
      ? {}
      : { cycleIds: filter.cycleIds as ReadonlyArray<IssueCycleId> }),
    ...(assignees.length === 0 ? {} : { assignees }),
    ...(filter.priorities.length === 0 ? {} : { priorities: filter.priorities }),
    ...(filter.dueFilter === null ? {} : { dueFilter: filter.dueFilter }),
    grouping: issuesSearchGrouping(search),
    sortMode: issuesSearchSortMode(search),
    viewMode: issuesSearchViewMode(search),
  };
}

/** A saved view's chips, in the shape the chip bar and the matcher already speak. */
export function issueViewConfigFilter(config: IssueViewConfig): IssuesListFilter {
  return {
    statusIds: config.statusIds ?? [],
    projectIds: config.projectIds ?? [],
    labelIds: config.labelIds ?? [],
    milestoneIds: config.milestoneIds ?? [],
    cycleIds: config.cycleIds ?? [],
    assignees: (config.assignees ?? []).flatMap((assignee) => {
      const value = issueAssigneeValue(assignee);
      return value === null ? [] : [value];
    }),
    priorities: (config.priorities ?? []) as ReadonlyArray<IssuePriority>,
    dueFilter: config.dueFilter ?? null,
  };
}

/**
 * Applying a view. Every key is present so a param the view does not set is *cleared* rather than
 * inherited from wherever the list happened to be, and the three defaults are written as absent
 * params — a view of everything leaves the URL as bare as `/issues`.
 *
 * `?issue=` is not in the patch: the open detail sheet is a place in the app, not part of the
 * question the view asks.
 */
export function issueViewSearchPatch(config: IssueViewConfig): IssuesSearchPatch {
  return {
    tab: config.tab === DEFAULT_ISSUES_TAB ? undefined : config.tab,
    ...issuesFilterSearchPatch(issueViewConfigFilter(config)),
    group: config.grouping === DEFAULT_ISSUES_GROUPING ? undefined : config.grouping,
    sort: config.sortMode === DEFAULT_ISSUES_SORT_MODE ? undefined : config.sortMode,
    view: config.viewMode === DEFAULT_ISSUES_VIEW_MODE ? undefined : config.viewMode,
  };
}

/** Order inside a chip is an accident of the clicks that built it, so it is not part of identity. */
function sameValues(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

/**
 * Two configs ask the same question. Compared through the filter shape rather than field by field,
 * so an absent chip and an empty one are the same thing and an assignee is compared as the value
 * the URL spells rather than as an object identity.
 */
export function sameIssueViewConfig(left: IssueViewConfig, right: IssueViewConfig): boolean {
  if (
    left.tab !== right.tab ||
    left.grouping !== right.grouping ||
    left.sortMode !== right.sortMode ||
    left.viewMode !== right.viewMode
  ) {
    return false;
  }
  const leftFilter = issueViewConfigFilter(left);
  const rightFilter = issueViewConfigFilter(right);
  return (
    leftFilter.dueFilter === rightFilter.dueFilter &&
    sameValues(leftFilter.statusIds, rightFilter.statusIds) &&
    sameValues(leftFilter.projectIds, rightFilter.projectIds) &&
    sameValues(leftFilter.labelIds, rightFilter.labelIds) &&
    sameValues(leftFilter.milestoneIds, rightFilter.milestoneIds) &&
    sameValues(leftFilter.cycleIds, rightFilter.cycleIds) &&
    sameValues(leftFilter.assignees, rightFilter.assignees) &&
    sameValues(leftFilter.priorities, rightFilter.priorities)
  );
}

/**
 * Whether there is anything here worth naming. The tab counts: "Backlog, grouped by project" is a
 * view somebody would save, and the tab is part of the config either way.
 */
export function isIssueViewConfigDirty(config: IssueViewConfig): boolean {
  return !sameIssueViewConfig(config, DEFAULT_ISSUE_VIEW_CONFIG);
}

/** The view the current params *are*, if one of them is. Position order, so the first wins. */
export function findIssueViewForConfig(
  views: ReadonlyArray<IssueView>,
  config: IssueViewConfig,
): IssueView | null {
  return views.find((view) => sameIssueViewConfig(view.config, config)) ?? null;
}

/** Case-insensitively, the way the server's conflict check reads it. */
export function findIssueViewByName(
  views: ReadonlyArray<IssueView>,
  name: string,
): IssueView | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;
  return views.find((view) => view.name.toLowerCase() === needle) ?? null;
}

/**
 * The complete order after moving one view a place, or null at the end it is already at.
 * `issues.viewsReorder` takes the whole list rather than a move, as statuses do.
 */
export function moveIssueViewOrder(
  views: ReadonlyArray<IssueView>,
  viewId: IssueViewId,
  direction: "up" | "down",
): ReadonlyArray<IssueViewId> | null {
  const index = views.findIndex((view) => view.id === viewId);
  if (index === -1) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= views.length) return null;
  const ids = views.map((view) => view.id);
  const moved = ids[index];
  const displaced = ids[target];
  if (moved === undefined || displaced === undefined) return null;
  ids[index] = displaced;
  ids[target] = moved;
  return ids;
}

/** `Active · 2 filters · Grouped by project`. The row's tooltip, and the popover's subtitle. */
export function summarizeIssueViewConfig(config: IssueViewConfig): string {
  const parts: Array<string> = [ISSUE_VIEW_TAB_LABELS[config.tab]];
  const chips = activeIssuesFilterFields(issueViewConfigFilter(config)).length;
  if (chips > 0) parts.push(`${chips} ${chips === 1 ? "filter" : "filters"}`);
  // The board is grouped by status and nothing else, so naming a grouping beside it would name
  // something the layout ignores.
  if (config.viewMode === "board") parts.push("Board");
  else if (config.grouping !== DEFAULT_ISSUES_GROUPING) {
    parts.push(`Grouped by ${ISSUE_GROUPING_LABELS[config.grouping].toLowerCase()}`);
  }
  if (config.sortMode !== DEFAULT_ISSUES_SORT_MODE) {
    parts.push(`${ISSUE_SORT_MODE_LABELS[config.sortMode].toLowerCase()} order`);
  }
  return parts.join(" · ");
}
