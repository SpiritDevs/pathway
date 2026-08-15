/**
 * Pure list-view decisions for `/issues` — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * The view is virtualized, so grouping has to collapse into one flat row array (headers and issues
 * interleaved) before it reaches `LegendList`. Selection and keyboard navigation then work off the
 * *displayed* order of that array rather than the store, which is why the range and cursor helpers
 * all take the id list rather than the grouping.
 *
 * The filter is the `IssueViewConfig` the contract defines, one field short of a saved view: OR
 * inside a field, AND across fields, no nesting and no negation.
 *
 * @module components/issues/issuesList.logic
 */
import { ISSUE_VIEW_FILTER_MAX_VALUES } from "@spiritdevs/contracts";
import type {
  Issue,
  IssueAssignee,
  IssueCycleId,
  IssueId,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
  IssueStatus,
  IssueViewDueFilter,
  IssueViewGrouping,
  IssueViewMode,
  IssueViewSortMode,
} from "@spiritdevs/contracts";

import type { IssuesGrouping, IssuesStore, IssuesTab } from "~/state/issues";

// ── Vocabulary ─────────────────────────────────────────────────────────

/** Most urgent first. Menus, the priority chip, and the priority grouping all read this order. */
export const ISSUE_PRIORITY_ORDER: ReadonlyArray<IssuePriority> = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export const ISSUE_PRIORITY_LABELS: Readonly<Record<IssuePriority, string>> = {
  none: "No priority",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const ISSUE_PRIORITY_RANK = new Map<string, number>(
  ISSUE_PRIORITY_ORDER.map((priority, index) => [priority, index]),
);

export const ISSUE_VIEW_GROUPINGS: ReadonlyArray<IssueViewGrouping> = [
  "status",
  "project",
  "priority",
  "assignee",
  "none",
];

export const ISSUE_GROUPING_LABELS: Readonly<Record<IssueViewGrouping, string>> = {
  status: "Status",
  project: "Project",
  priority: "Priority",
  assignee: "Assignee",
  none: "No grouping",
};

export const ISSUE_VIEW_SORT_MODES: ReadonlyArray<IssueViewSortMode> = [
  "manual",
  "priority",
  "updated",
  "created",
];

export const ISSUE_SORT_MODE_LABELS: Readonly<Record<IssueViewSortMode, string>> = {
  manual: "Manual",
  priority: "Priority",
  updated: "Last updated",
  created: "Created",
};

/**
 * The board is grouped by status and nothing else, so it carries no grouping of its own — the
 * mode is a layout, not a second grouping axis.
 */
export const ISSUE_VIEW_MODES: ReadonlyArray<IssueViewMode> = ["list", "board"];

export const ISSUE_VIEW_DUE_FILTERS: ReadonlyArray<IssueViewDueFilter> = [
  "overdue",
  "week",
  "month",
  "none",
];

/**
 * `week` and `month` are forward windows that start today: overdue is its own bucket, and folding
 * it into both of the others would leave no way to ask "due soon, nothing late".
 */
export const ISSUE_DUE_FILTER_LABELS: Readonly<Record<IssueViewDueFilter, string>> = {
  overdue: "Overdue",
  week: "Next 7 days",
  month: "Next 30 days",
  none: "No due date",
};

/**
 * How an assignee is named in a query param, which is the same spelling the change log stores.
 * There is no token for "unassigned": `IssueViewConfig.assignees` is a list of real assignees, and
 * a filter the chip bar can express but a saved view cannot would be a trap.
 */
export const ISSUE_ASSIGNEE_USER_VALUE = "user";
export const ISSUE_ASSIGNEE_AGENT_PREFIX = "agent:";
/**
 * A company member carries their membership, unlike `user`, which is the sole human on an
 * environment-scoped tracker and needs no id. Every token has to name one person: without the
 * membership, filtering on one teammate would return the whole company's work.
 */
export const ISSUE_ASSIGNEE_MEMBER_PREFIX = "member:";

export function issueAssigneeValue(assignee: IssueAssignee | null): string | null {
  if (assignee === null) return null;
  switch (assignee.kind) {
    case "user":
      return ISSUE_ASSIGNEE_USER_VALUE;
    case "member":
      return `${ISSUE_ASSIGNEE_MEMBER_PREFIX}${assignee.membershipId}`;
    case "agent":
      return `${ISSUE_ASSIGNEE_AGENT_PREFIX}${assignee.provider}`;
  }
}

/** Legacy `user` means the current person once a company-scoped replica supplies their membership. */
export function resolveIssuesFilterUserAssignee(
  filter: IssuesListFilter,
  currentMembershipId: string | null,
): IssuesListFilter {
  if (currentMembershipId === null || !filter.assignees.includes(ISSUE_ASSIGNEE_USER_VALUE)) {
    return filter;
  }
  return {
    ...filter,
    assignees: filter.assignees.map((value) =>
      value === ISSUE_ASSIGNEE_USER_VALUE
        ? `${ISSUE_ASSIGNEE_MEMBER_PREFIX}${currentMembershipId}`
        : value,
    ),
  };
}

/** The token without its prefix: a provider slug, a membership, or `user` as it stands. */
export function issueAssigneeValueId(value: string): string {
  if (value.startsWith(ISSUE_ASSIGNEE_AGENT_PREFIX)) {
    return value.slice(ISSUE_ASSIGNEE_AGENT_PREFIX.length);
  }
  if (value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)) {
    return value.slice(ISSUE_ASSIGNEE_MEMBER_PREFIX.length);
  }
  return value;
}

function isAssigneeValue(value: string): boolean {
  if (value === ISSUE_ASSIGNEE_USER_VALUE) return true;
  for (const prefix of [ISSUE_ASSIGNEE_AGENT_PREFIX, ISSUE_ASSIGNEE_MEMBER_PREFIX]) {
    if (value.startsWith(prefix) && value.length > prefix.length) return true;
  }
  return false;
}

/** Past this many chips a row starts eating the title, so the rest collapse into `+N`. */
export const ISSUE_ROW_MAX_LABEL_CHIPS = 3;

// ── Search params ──────────────────────────────────────────────────────

/**
 * Every field is optional so a bare `/issues` carries no query string and `navigate({ to })` needs
 * no search object, and every field also admits an explicit `undefined` so a patch can *clear* one
 * under `exactOptionalPropertyTypes`.
 *
 * The multi-value filters ride as one comma-joined param each (`?label=bug,chore`) rather than as
 * a repeated key or a JSON blob: the URL stays something a person can read and edit, and TanStack
 * Router serialises a plain string without inventing an encoding.
 */
export interface IssuesSearch {
  readonly tab?: IssuesTab | undefined;
  /**
   * The triage queue instead of the list. A boolean rather than a fourth tab: triage items have no
   * status, so they appear in no tab, no board, and no count — and a mode with none of the list's
   * filters, groupings, or layouts is not a tab of it.
   */
  readonly triage?: boolean | undefined;
  /** The issue *key* (`PAT-221`), which is what a link a human pastes will carry. */
  readonly issue?: string | undefined;
  readonly status?: string | undefined;
  readonly project?: string | undefined;
  /** A milestone belongs to a project, but the filter does not: the id already names one. */
  readonly milestone?: string | undefined;
  readonly cycle?: string | undefined;
  readonly label?: string | undefined;
  /** `user` or `agent:<driver>`, comma-joined. */
  readonly assignee?: string | undefined;
  readonly priority?: string | undefined;
  /** One of {@link ISSUE_VIEW_DUE_FILTERS}; a predicate rather than a set, so it holds one value. */
  readonly due?: string | undefined;
  readonly group?: IssueViewGrouping | undefined;
  readonly sort?: IssueViewSortMode | undefined;
  /**
   * `board` or absent. The default is written as an absent param rather than `view=list`, so the
   * one thing this param ever says is "not the default".
   */
  readonly view?: IssueViewMode | undefined;
}

export type IssuesSearchPatch = Partial<IssuesSearch>;

export const DEFAULT_ISSUES_TAB: IssuesTab = "active";
export const DEFAULT_ISSUES_GROUPING: IssueViewGrouping = "status";
export const DEFAULT_ISSUES_SORT_MODE: IssueViewSortMode = "manual";
export const DEFAULT_ISSUES_VIEW_MODE: IssueViewMode = "list";

const MAX_PARAM_LENGTH = 200;

/** Keys are opaque ids on the wire, so the only validation possible is shape and a length cap. */
function optionalParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_PARAM_LENGTH)
    : undefined;
}

function literalParam<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Deduplicated and capped at the same ceiling the contract puts on a saved view's chip, so a URL
 * somebody hand-edited cannot hand the list a filter the server would refuse to store.
 */
function parseListParam(
  value: unknown,
  accept?: (entry: string) => boolean,
): ReadonlyArray<string> {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const values: Array<string> = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_PARAM_LENGTH);
    if (trimmed.length === 0) continue;
    if (accept !== undefined && !accept(trimmed)) continue;
    if (values.includes(trimmed)) continue;
    values.push(trimmed);
    if (values.length === ISSUE_VIEW_FILTER_MAX_VALUES) break;
  }
  return values;
}

function serializeListParam(values: ReadonlyArray<string>): string | undefined {
  return values.length === 0 ? undefined : values.join(",");
}

function isPriorityValue(value: string): value is IssuePriority {
  return ISSUE_PRIORITY_RANK.has(value);
}

export function parseIssuesSearch(raw: Record<string, unknown>): IssuesSearch {
  const tab = raw.tab;
  const assignees = parseListParam(raw.assignee, isAssigneeValue);
  return {
    tab: tab === "active" || tab === "backlog" || tab === "all" ? tab : undefined,
    // Absent rather than `false` for the default, the way `view` is: the one thing this param ever
    // says is "not the list".
    triage: raw.triage === true || raw.triage === "true" ? true : undefined,
    issue: optionalParam(raw.issue),
    status: serializeListParam(parseListParam(raw.status)),
    project: serializeListParam(parseListParam(raw.project)),
    milestone: serializeListParam(parseListParam(raw.milestone)),
    cycle: serializeListParam(parseListParam(raw.cycle)),
    label: serializeListParam(parseListParam(raw.label)),
    // `?mine=true` was stage 2's spelling of the sidebar's "My issues"; a bookmark from then still
    // means the same thing, and it costs one line to keep honouring it.
    assignee:
      serializeListParam(assignees) ??
      (raw.mine === true || raw.mine === "true" ? ISSUE_ASSIGNEE_USER_VALUE : undefined),
    priority: serializeListParam(parseListParam(raw.priority, isPriorityValue)),
    due: literalParam(raw.due, ISSUE_VIEW_DUE_FILTERS),
    group: literalParam(raw.group, ISSUE_VIEW_GROUPINGS),
    sort: literalParam(raw.sort, ISSUE_VIEW_SORT_MODES),
    view: literalParam(raw.view, ISSUE_VIEW_MODES),
  };
}

export function issuesSearchGrouping(search: IssuesSearch): IssueViewGrouping {
  return search.group ?? DEFAULT_ISSUES_GROUPING;
}

export function issuesSearchSortMode(search: IssuesSearch): IssueViewSortMode {
  return search.sort ?? DEFAULT_ISSUES_SORT_MODE;
}

export function issuesSearchViewMode(search: IssuesSearch): IssueViewMode {
  return search.view ?? DEFAULT_ISSUES_VIEW_MODE;
}

/**
 * What the view is actually grouped by. The board's columns are statuses and nothing else — the
 * decision record is explicit that grouping is a list-view read concern — so a `?group=project`
 * left over from the list is carried in the URL and ignored while the board is up.
 */
export function effectiveIssuesGrouping(
  grouping: IssueViewGrouping,
  viewMode: IssueViewMode,
): IssueViewGrouping {
  return viewMode === "board" ? "status" : grouping;
}

// ── Filter model ───────────────────────────────────────────────────────

/**
 * One field per chip. Named for the query param rather than for the struct key so the menu, the
 * chip, and the URL all say the same word.
 */
export type IssuesFilterField =
  | "status"
  | "project"
  | "label"
  | "milestone"
  | "cycle"
  | "assignee"
  | "priority"
  | "due";

/** Chip order in the bar, and the order the "+ Filter" menu offers the fields in. */
export const ISSUES_FILTER_FIELDS: ReadonlyArray<IssuesFilterField> = [
  "status",
  "project",
  "label",
  "milestone",
  "cycle",
  "assignee",
  "priority",
  "due",
];

export const ISSUES_FILTER_FIELD_LABELS: Readonly<Record<IssuesFilterField, string>> = {
  status: "Status",
  project: "Project",
  label: "Label",
  milestone: "Milestone",
  cycle: "Cycle",
  assignee: "Assignee",
  priority: "Priority",
  due: "Due date",
};

/**
 * The `IssueViewConfig` filter fields, minus the tab, grouping, and sort that live beside them on
 * a saved view. An empty array is a chip that is not on the bar; there is no such thing as a chip
 * that matches nothing.
 */
export interface IssuesListFilter {
  readonly statusIds: ReadonlyArray<string>;
  readonly projectIds: ReadonlyArray<string>;
  readonly labelIds: ReadonlyArray<string>;
  readonly milestoneIds: ReadonlyArray<string>;
  readonly cycleIds: ReadonlyArray<string>;
  /** {@link issueAssigneeValue} spellings: `user`, `member:<membershipId>`, `agent:codex`. */
  readonly assignees: ReadonlyArray<string>;
  readonly priorities: ReadonlyArray<IssuePriority>;
  readonly dueFilter: IssueViewDueFilter | null;
}

export const NO_ISSUES_LIST_FILTER: IssuesListFilter = {
  statusIds: [],
  projectIds: [],
  labelIds: [],
  milestoneIds: [],
  cycleIds: [],
  assignees: [],
  priorities: [],
  dueFilter: null,
};

export function issuesFilterValues(
  filter: IssuesListFilter,
  field: IssuesFilterField,
): ReadonlyArray<string> {
  switch (field) {
    case "status":
      return filter.statusIds;
    case "project":
      return filter.projectIds;
    case "label":
      return filter.labelIds;
    case "milestone":
      return filter.milestoneIds;
    case "cycle":
      return filter.cycleIds;
    case "assignee":
      return filter.assignees;
    case "priority":
      return filter.priorities;
    case "due":
      return filter.dueFilter === null ? [] : [filter.dueFilter];
  }
}

function normalizeValues(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen: Array<string> = [];
  for (const value of values) {
    if (value.length === 0 || seen.includes(value)) continue;
    seen.push(value);
    if (seen.length === ISSUE_VIEW_FILTER_MAX_VALUES) break;
  }
  return seen;
}

/** Replaces one field wholesale. Every other write below is expressed through this one. */
export function withIssuesFilterValues(
  filter: IssuesListFilter,
  field: IssuesFilterField,
  values: ReadonlyArray<string>,
): IssuesListFilter {
  const next = normalizeValues(values);
  switch (field) {
    case "status":
      return { ...filter, statusIds: next };
    case "project":
      return { ...filter, projectIds: next };
    case "label":
      return { ...filter, labelIds: next };
    case "milestone":
      return { ...filter, milestoneIds: next };
    case "cycle":
      return { ...filter, cycleIds: next };
    case "assignee":
      return { ...filter, assignees: next.filter(isAssigneeValue) };
    case "priority":
      return { ...filter, priorities: next.filter(isPriorityValue) };
    case "due": {
      // A predicate, not a set: the last value wins and everything else is dropped.
      const [first] = next;
      const due = literalParam(first, ISSUE_VIEW_DUE_FILTERS);
      return { ...filter, dueFilter: due ?? null };
    }
  }
}

export function issuesFilterHasValue(
  filter: IssuesListFilter,
  field: IssuesFilterField,
  value: string,
): boolean {
  return issuesFilterValues(filter, field).includes(value);
}

/** The checkbox in a chip's popover: OR inside the field, so a second value widens the chip. */
export function toggleIssuesFilterValue(
  filter: IssuesListFilter,
  field: IssuesFilterField,
  value: string,
): IssuesListFilter {
  const values = issuesFilterValues(filter, field);
  return withIssuesFilterValues(
    filter,
    field,
    values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value],
  );
}

/**
 * A sidebar click. It sets its own field to exactly the row that was pressed and leaves every
 * other chip alone — stage 2 cleared the others instead, because intersecting two sidebar rows
 * looked like a bug before there was a chip bar to show what was intersecting.
 */
export function applyIssuesFilter(
  filter: IssuesListFilter,
  field: IssuesFilterField,
  value: string | null,
): IssuesListFilter {
  return withIssuesFilterValues(filter, field, value === null ? [] : [value]);
}

export function activeIssuesFilterFields(
  filter: IssuesListFilter,
): ReadonlyArray<IssuesFilterField> {
  return ISSUES_FILTER_FIELDS.filter((field) => issuesFilterValues(filter, field).length > 0);
}

export function isIssuesListFilterActive(filter: IssuesListFilter): boolean {
  return ISSUES_FILTER_FIELDS.some((field) => issuesFilterValues(filter, field).length > 0);
}

/**
 * The one value a field holds, or null when it holds none or several. What the new-issue dialog
 * seeds itself from: a list filtered to one project should create into that project, and a list
 * filtered to three should not guess.
 */
export function soleIssuesFilterValue(
  filter: IssuesListFilter,
  field: IssuesFilterField,
): string | null {
  const values = issuesFilterValues(filter, field);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function issuesSearchFilter(search: IssuesSearch): IssuesListFilter {
  return {
    statusIds: parseListParam(search.status),
    projectIds: parseListParam(search.project),
    labelIds: parseListParam(search.label),
    milestoneIds: parseListParam(search.milestone),
    cycleIds: parseListParam(search.cycle),
    assignees: parseListParam(search.assignee, isAssigneeValue),
    priorities: parseListParam(search.priority, isPriorityValue) as ReadonlyArray<IssuePriority>,
    dueFilter: literalParam(search.due, ISSUE_VIEW_DUE_FILTERS) ?? null,
  };
}

/** Every filter key, so a patch that drops a chip actually clears the param. */
export function issuesFilterSearchPatch(filter: IssuesListFilter): IssuesSearchPatch {
  return {
    status: serializeListParam(filter.statusIds),
    project: serializeListParam(filter.projectIds),
    label: serializeListParam(filter.labelIds),
    milestone: serializeListParam(filter.milestoneIds),
    cycle: serializeListParam(filter.cycleIds),
    assignee: serializeListParam(filter.assignees),
    priority: serializeListParam(filter.priorities),
    due: filter.dueFilter ?? undefined,
  };
}

// ── Chip presentation ──────────────────────────────────────────────────

export interface IssuesFilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A value whose entity is gone still renders — as its raw id. The stream can delete a label while
 * a chip names it, and dropping it silently would turn a filter that shows nothing into a filter
 * that looks like it is off.
 */
export function issuesFilterValueLabels(
  values: ReadonlyArray<string>,
  options: ReadonlyArray<IssuesFilterOption>,
): ReadonlyArray<string> {
  return values.map(
    (value) =>
      options.find((option) => option.value === value)?.label ??
      (value === ISSUE_ASSIGNEE_USER_VALUE
        ? "You"
        : value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)
          ? "Unknown member"
          : value),
  );
}

/** `Bug`, or `Bug +2`. The chip is one line in a header row, so only the first name fits. */
export function summarizeIssuesFilterValues(labels: ReadonlyArray<string>): string {
  const [first] = labels;
  if (first === undefined) return "Any";
  return labels.length === 1 ? first : `${first} +${labels.length - 1}`;
}

/** Case-insensitive substring, which is all a list of a few dozen names needs. */
export function filterIssuesFilterOptions<T extends IssuesFilterOption>(
  options: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

// ── Matching ───────────────────────────────────────────────────────────

/** `YYYY-MM-DD` plus whole days, in UTC — a calendar day has no time zone to shift under it. */
export function addIssueDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const at = Date.UTC(year, month - 1, day) + days * 86_400_000;
  if (Number.isNaN(at)) return date;
  return new Date(at).toISOString().slice(0, 10);
}

export function issueMatchesDueFilter(
  issue: Issue,
  dueFilter: IssueViewDueFilter,
  today: string,
): boolean {
  if (dueFilter === "none") return issue.dueDate === null;
  if (issue.dueDate === null) return false;
  if (dueFilter === "overdue") return issue.dueDate < today;
  if (issue.dueDate < today) return false;
  return issue.dueDate <= addIssueDays(today, dueFilter === "week" ? 7 : 30);
}

/** OR inside a field, AND across fields. `today` is passed in so the predicate stays pure. */
export function matchesIssuesFilter(
  issue: Issue,
  filter: IssuesListFilter,
  today: string,
): boolean {
  if (filter.statusIds.length > 0 && !filter.statusIds.includes(issue.statusId)) return false;
  if (
    filter.projectIds.length > 0 &&
    (issue.projectId === null || !filter.projectIds.includes(issue.projectId))
  ) {
    return false;
  }
  if (
    filter.milestoneIds.length > 0 &&
    (issue.milestoneId === null || !filter.milestoneIds.includes(issue.milestoneId))
  ) {
    return false;
  }
  if (
    filter.cycleIds.length > 0 &&
    (issue.cycleId === null || !filter.cycleIds.includes(issue.cycleId))
  ) {
    return false;
  }
  // OR across the chip's labels rather than AND: a label chip asks "carries any of these".
  if (
    filter.labelIds.length > 0 &&
    !issue.labelIds.some((labelId) => filter.labelIds.includes(labelId))
  ) {
    return false;
  }
  if (filter.assignees.length > 0) {
    const assignee = issueAssigneeValue(issue.assignee);
    if (assignee === null || !filter.assignees.includes(assignee)) return false;
  }
  if (filter.priorities.length > 0 && !filter.priorities.includes(issue.priority)) return false;
  if (filter.dueFilter !== null && !issueMatchesDueFilter(issue, filter.dueFilter, today)) {
    return false;
  }
  return true;
}

// ── Grouping and sorting ───────────────────────────────────────────────

/**
 * One rendered column. `status` and `priority` are the two groupings whose header draws a glyph;
 * the rest carry a name and nothing else.
 */
export interface IssuesViewGroup {
  readonly id: string;
  readonly label: string;
  readonly status: IssueStatus | null;
  readonly priority: IssuePriority | null;
  readonly issues: ReadonlyArray<Issue>;
}

export interface IssuesView {
  readonly grouping: IssueViewGrouping;
  /** The sort actually applied, which is not the one asked for when manual cannot be honoured. */
  readonly sortMode: IssueViewSortMode;
  readonly groups: ReadonlyArray<IssuesViewGroup>;
  readonly total: number;
}

export const EMPTY_ISSUES_VIEW: IssuesView = {
  grouping: DEFAULT_ISSUES_GROUPING,
  sortMode: DEFAULT_ISSUES_SORT_MODE,
  groups: [],
  total: 0,
};

/**
 * The manual key is written by a drag inside a status group, so it only orders a list grouped by
 * status. Anywhere else it would render an order nobody can see the rule of, so priority stands in.
 */
export function effectiveIssueSortMode(
  sortMode: IssueViewSortMode,
  grouping: IssueViewGrouping,
): IssueViewSortMode {
  return sortMode === "manual" && grouping !== "status" ? "priority" : sortMode;
}

/**
 * Why the order on screen is not the order that was asked for, or why the board's drag is off.
 *
 * The two cases are converses of each other. In the list, manual order and row dragging need a
 * status grouping to mean anything, so they stand aside. On the board the grouping is always
 * status, so manual order always applies — but the *drag that writes it* is only honest while
 * manual is what orders the column: under any other mode the slot the card was dropped into is not
 * a slot in the stored order, so the write would land somewhere nobody pointed at.
 */
export function issueSortModeHint(
  sortMode: IssueViewSortMode,
  grouping: IssueViewGrouping,
  viewMode: IssueViewMode = DEFAULT_ISSUES_VIEW_MODE,
): string | null {
  if (viewMode === "board") {
    return sortMode === "manual"
      ? null
      : "Cards drag to reorder in manual order only — this board is read-only to a drag.";
  }
  return effectiveIssueSortMode(sortMode, grouping) === sortMode
    ? null
    : "Manual order only applies grouped by status — sorting by priority instead.";
}

function comparePriority(left: Issue, right: Issue): number {
  return (
    (ISSUE_PRIORITY_RANK.get(left.priority) ?? ISSUE_PRIORITY_ORDER.length) -
    (ISSUE_PRIORITY_RANK.get(right.priority) ?? ISSUE_PRIORITY_ORDER.length)
  );
}

function compareManual(left: Issue, right: Issue): number {
  return left.sortOrder < right.sortOrder ? -1 : left.sortOrder > right.sortOrder ? 1 : 0;
}

/** Every comparator ends on the id so the order is total and a re-sort never reshuffles ties. */
export function issueComparator(
  sortMode: IssueViewSortMode,
): (left: Issue, right: Issue) => number {
  switch (sortMode) {
    case "manual":
      return (left, right) => compareManual(left, right) || left.id.localeCompare(right.id);
    case "priority":
      return (left, right) =>
        comparePriority(left, right) ||
        compareManual(left, right) ||
        left.id.localeCompare(right.id);
    case "updated":
      return (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    case "created":
      return (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  }
}

export interface IssuesViewInput {
  /** The tab's status grouping, straight from the store: triage and soft deletes are already out. */
  readonly grouping: IssuesGrouping;
  readonly filter: IssuesListFilter;
  readonly today: string;
  readonly groupBy: IssueViewGrouping;
  readonly sortMode: IssueViewSortMode;
  readonly projectTitles?: ReadonlyMap<string, string> | undefined;
  /** `user` → "You", `agent:codex` → whatever that driver is called. */
  readonly assigneeLabels?: ReadonlyMap<string, string> | undefined;
}

const UNASSIGNED_LABEL = "Unassigned";
const NO_PROJECT_LABEL = "No project";

/**
 * Grouped by status the empty groups survive, because those groups *are* the tab: a column whose
 * last issue was filtered out should show an empty header rather than vanish. Every other grouping
 * is derived from the issues that are left, so an empty group there is a group that does not exist.
 */
export function buildIssuesView(input: IssuesViewInput): IssuesView {
  const { filter, grouping, groupBy, today } = input;
  const sortMode = effectiveIssueSortMode(input.sortMode, groupBy);
  const compare = issueComparator(sortMode);

  if (groupBy === "status") {
    let total = 0;
    const groups = grouping.groups.map((group) => {
      const issues = group.issues.filter((issue) => matchesIssuesFilter(issue, filter, today));
      total += issues.length;
      return {
        id: `status:${group.status.id}`,
        label: group.status.name,
        status: group.status,
        priority: null,
        issues: [...issues].sort(compare),
      };
    });
    return { grouping: groupBy, sortMode, groups, total };
  }

  const matched: Array<Issue> = [];
  for (const group of grouping.groups) {
    for (const issue of group.issues) {
      if (matchesIssuesFilter(issue, filter, today)) matched.push(issue);
    }
  }

  const groups =
    groupBy === "none"
      ? matched.length === 0
        ? []
        : [
            {
              id: "all",
              label: "All issues",
              status: null,
              priority: null,
              issues: [...matched].sort(compare),
            },
          ]
      : groupBy === "priority"
        ? priorityGroups(matched, compare)
        : groupBy === "project"
          ? projectGroups(matched, compare, input.projectTitles)
          : assigneeGroups(matched, compare, input.assigneeLabels);

  return { grouping: groupBy, sortMode, groups, total: matched.length };
}

type IssueComparator = (left: Issue, right: Issue) => number;

function priorityGroups(
  issues: ReadonlyArray<Issue>,
  compare: IssueComparator,
): ReadonlyArray<IssuesViewGroup> {
  const buckets = new Map<IssuePriority, Array<Issue>>();
  for (const issue of issues) {
    const bucket = buckets.get(issue.priority);
    if (bucket === undefined) buckets.set(issue.priority, [issue]);
    else bucket.push(issue);
  }
  const groups: Array<IssuesViewGroup> = [];
  for (const priority of ISSUE_PRIORITY_ORDER) {
    const bucket = buckets.get(priority);
    if (bucket === undefined) continue;
    groups.push({
      id: `priority:${priority}`,
      label: ISSUE_PRIORITY_LABELS[priority],
      status: null,
      priority,
      issues: bucket.sort(compare),
    });
  }
  return groups;
}

function projectGroups(
  issues: ReadonlyArray<Issue>,
  compare: IssueComparator,
  projectTitles: ReadonlyMap<string, string> | undefined,
): ReadonlyArray<IssuesViewGroup> {
  const buckets = new Map<string | null, Array<Issue>>();
  for (const issue of issues) {
    const key = issue.projectId;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [issue]);
    else bucket.push(issue);
  }
  const groups: Array<IssuesViewGroup> = [];
  for (const [projectId, bucket] of buckets) {
    if (projectId === null) continue;
    groups.push({
      id: `project:${projectId}`,
      label: projectTitles?.get(projectId) ?? projectId,
      status: null,
      priority: null,
      issues: bucket.sort(compare),
    });
  }
  groups.sort((left, right) => left.label.localeCompare(right.label));
  // Last rather than first: "no project" is the leftovers, not the headline.
  const none = buckets.get(null);
  if (none !== undefined) {
    groups.push({
      id: "project:none",
      label: NO_PROJECT_LABEL,
      status: null,
      priority: null,
      issues: none.sort(compare),
    });
  }
  return groups;
}

/**
 * You first, then the rest of the people by name, then the agents by name, then whatever nobody
 * has picked up. People before agents because a teammate's row is somebody to talk to.
 */
function assigneeGroups(
  issues: ReadonlyArray<Issue>,
  compare: IssueComparator,
  assigneeLabels: ReadonlyMap<string, string> | undefined,
): ReadonlyArray<IssuesViewGroup> {
  const buckets = new Map<string | null, Array<Issue>>();
  for (const issue of issues) {
    const key = issueAssigneeValue(issue.assignee);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [issue]);
    else bucket.push(issue);
  }
  const members: Array<IssuesViewGroup> = [];
  const agents: Array<IssuesViewGroup> = [];
  for (const [value, bucket] of buckets) {
    if (value === null || value === ISSUE_ASSIGNEE_USER_VALUE) continue;
    // The token carries the membership, so one row per teammate rather than one row per company.
    // Until the member directory lands, keep the opaque membership identifier out of the UI.
    const group: IssuesViewGroup = {
      id: `assignee:${value}`,
      label:
        assigneeLabels?.get(value) ??
        (value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)
          ? "Unknown member"
          : issueAssigneeValueId(value)),
      status: null,
      priority: null,
      issues: bucket.sort(compare),
    };
    if (value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)) members.push(group);
    else agents.push(group);
  }
  const byLabel = (left: IssuesViewGroup, right: IssuesViewGroup) =>
    left.label.localeCompare(right.label);
  members.sort(byLabel);
  agents.sort(byLabel);

  const groups: Array<IssuesViewGroup> = [];
  const user = buckets.get(ISSUE_ASSIGNEE_USER_VALUE);
  if (user !== undefined) {
    groups.push({
      id: `assignee:${ISSUE_ASSIGNEE_USER_VALUE}`,
      label: assigneeLabels?.get(ISSUE_ASSIGNEE_USER_VALUE) ?? "You",
      status: null,
      priority: null,
      issues: user.sort(compare),
    });
  }
  groups.push(...members);
  groups.push(...agents);
  const none = buckets.get(null);
  if (none !== undefined) {
    groups.push({
      id: "assignee:none",
      label: UNASSIGNED_LABEL,
      status: null,
      priority: null,
      issues: none.sort(compare),
    });
  }
  return groups;
}

// ── Flattening ─────────────────────────────────────────────────────────

export interface IssuesListHeaderRow {
  readonly kind: "header";
  readonly id: string;
  readonly group: IssuesViewGroup;
  readonly count: number;
  readonly collapsed: boolean;
}

export interface IssuesListIssueRow {
  readonly kind: "issue";
  readonly id: string;
  readonly issue: Issue;
}

export type IssuesListRow = IssuesListHeaderRow | IssuesListIssueRow;

/**
 * Header ids are prefixed because `LegendList` keys off one namespace: a group id and an issue id
 * are both opaque strings and nothing stops a tracker from holding the same value twice. Ungrouped
 * emits no headers at all rather than one header named after the whole list.
 */
export function buildIssuesListRows(
  view: IssuesView,
  collapsedGroupIds: ReadonlySet<string>,
): ReadonlyArray<IssuesListRow> {
  const rows: Array<IssuesListRow> = [];
  const headers = view.grouping !== "none";
  for (const group of view.groups) {
    const collapsed = headers && collapsedGroupIds.has(group.id);
    if (headers) {
      rows.push({
        kind: "header",
        id: `group:${group.id}`,
        group,
        count: group.issues.length,
        collapsed,
      });
    }
    if (collapsed) continue;
    for (const issue of group.issues) rows.push({ kind: "issue", id: `issue:${issue.id}`, issue });
  }
  return rows;
}

/** Display order, collapsed groups excluded — a cursor must not land on a row nobody can see. */
export function issueIdsInRows(rows: ReadonlyArray<IssuesListRow>): ReadonlyArray<IssueId> {
  const ids: Array<IssueId> = [];
  for (const row of rows) if (row.kind === "issue") ids.push(row.issue.id);
  return ids;
}

export function findIssueRowIndex(
  rows: ReadonlyArray<IssuesListRow>,
  issueId: IssueId | null,
): number {
  if (issueId === null) return -1;
  return rows.findIndex((row) => row.kind === "issue" && row.issue.id === issueId);
}

// ── Selection ──────────────────────────────────────────────────────────

export interface IssuesSelection {
  readonly ids: ReadonlySet<IssueId>;
  /** Where a shift-click measures from; the last row picked without shift. */
  readonly anchorId: IssueId | null;
  /** The cursor `j`/`k` moves and Enter opens. Independent from checkbox selection. */
  readonly activeId: IssueId | null;
}

const EMPTY_SELECTED_IDS: ReadonlySet<IssueId> = new Set();

export const EMPTY_ISSUES_SELECTION: IssuesSelection = {
  ids: EMPTY_SELECTED_IDS,
  anchorId: null,
  activeId: null,
};

/** A click's meaning, already resolved from the modifier keys by the caller. */
export type IssueSelectMode = "replace" | "toggle" | "range";

/** Moves the list cursor without changing the rows selected for bulk actions. */
export function activateIssueRow(selection: IssuesSelection, issueId: IssueId): IssuesSelection {
  return selection.activeId === issueId ? selection : { ...selection, activeId: issueId };
}

export function issueSelectModeForModifiers(input: {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): IssueSelectMode {
  if (input.shiftKey) return "range";
  if (input.metaKey || input.ctrlKey) return "toggle";
  return "replace";
}

/** Inclusive slice of the display order between two rows, in display order either way round. */
export function issueRangeIds(
  ids: ReadonlyArray<IssueId>,
  fromId: IssueId,
  toId: IssueId,
): ReadonlyArray<IssueId> {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1) return to === -1 ? [] : [toId];
  return from <= to ? ids.slice(from, to + 1) : ids.slice(to, from + 1);
}

/**
 * A range extends from the anchor and *replaces* the rest of the selection rather than adding to
 * it, which is what a file list does: shift-click twice in a row should give the second range, not
 * the union of both.
 */
export function selectIssueRow(
  selection: IssuesSelection,
  input: {
    readonly ids: ReadonlyArray<IssueId>;
    readonly issueId: IssueId;
    readonly mode: IssueSelectMode;
  },
): IssuesSelection {
  const { ids, issueId, mode } = input;
  if (mode === "range" && selection.anchorId !== null) {
    return {
      ids: new Set(issueRangeIds(ids, selection.anchorId, issueId)),
      anchorId: selection.anchorId,
      activeId: issueId,
    };
  }
  if (mode === "toggle") {
    const next = new Set(selection.ids);
    if (next.has(issueId)) {
      next.delete(issueId);
      // Dropping the cursor's own row moves the cursor to whatever is left rather than clearing
      // it, so the next `j` continues from the selection instead of the top of the list.
      const activeId =
        selection.activeId === issueId ? (nextSelectedId(ids, next) ?? null) : selection.activeId;
      return { ids: next, anchorId: issueId, activeId };
    }
    next.add(issueId);
    return { ids: next, anchorId: issueId, activeId: issueId };
  }
  return { ids: new Set([issueId]), anchorId: issueId, activeId: issueId };
}

function nextSelectedId(
  ids: ReadonlyArray<IssueId>,
  selected: ReadonlySet<IssueId>,
): IssueId | undefined {
  return ids.find((id) => selected.has(id));
}

/**
 * Drops ids the list no longer shows. The stream can delete a row or a filter can hide one while
 * it is selected, and a bulk write against an invisible selection is the worst kind of surprise.
 */
export function pruneIssuesSelection(
  selection: IssuesSelection,
  ids: ReadonlyArray<IssueId>,
): IssuesSelection {
  const visible = new Set(ids);
  let changed = false;
  const next = new Set<IssueId>();
  for (const id of selection.ids) {
    if (visible.has(id)) next.add(id);
    else changed = true;
  }
  const anchorId =
    selection.anchorId !== null && visible.has(selection.anchorId) ? selection.anchorId : null;
  const activeId =
    selection.activeId !== null && visible.has(selection.activeId) ? selection.activeId : null;
  if (!changed && anchorId === selection.anchorId && activeId === selection.activeId) {
    return selection;
  }
  return { ids: next, anchorId, activeId };
}

// ── Keyboard ───────────────────────────────────────────────────────────

export type IssuesListKeyAction =
  /** Show the create-issue dialog. */
  | { readonly _tag: "new" }
  /** Move the cursor and make it the whole selection. */
  | { readonly _tag: "select"; readonly issueId: IssueId }
  /** Open the detail sheet — the caller writes `?issue=`. */
  | { readonly _tag: "open"; readonly issueId: IssueId }
  | { readonly _tag: "clear" };

/**
 * Null means "not ours": the caller must not `preventDefault` a key this view does not handle, or
 * typing into the page becomes impossible the moment focus lands on the list.
 */
export function resolveIssuesListKeyAction(input: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly ids: ReadonlyArray<IssueId>;
  readonly activeId: IssueId | null;
  readonly hasSelection: boolean;
}): IssuesListKeyAction | null {
  const { key, ids, activeId } = input;
  if (
    key.toLowerCase() === "n" &&
    input.metaKey !== input.ctrlKey &&
    !input.altKey &&
    !input.shiftKey
  ) {
    return { _tag: "new" };
  }
  if (input.metaKey || input.ctrlKey || input.altKey) return null;

  if (key === "Escape") return input.hasSelection ? { _tag: "clear" } : null;
  if (input.shiftKey) return null;

  if (key === "Enter") {
    return activeId === null ? null : { _tag: "open", issueId: activeId };
  }

  const step = key === "j" || key === "ArrowDown" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0;
  if (step === 0) return null;
  if (ids.length === 0) return null;

  const current = activeId === null ? -1 : ids.indexOf(activeId);
  // A cursor that fell off the list (its row was filtered away) restarts from the end it came
  // from rather than refusing to move.
  const nextIndex =
    current === -1
      ? step === 1
        ? 0
        : ids.length - 1
      : Math.min(ids.length - 1, Math.max(0, current + step));
  const issueId = ids[nextIndex];
  if (issueId === undefined) return null;
  if (issueId === activeId) return null;
  return { _tag: "select", issueId };
}

// ── Row presentation ───────────────────────────────────────────────────

/** `YYYY-MM-DD` compared as text: both sides are calendar days, so no `Date` is involved. */
export function isIssueDueDatePast(dueDate: string, today: string): boolean {
  return dueDate < today;
}

const MONTH_NAMES = [
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

/** `Aug 12`, or `Aug 12, 2025` once the year stops being the obvious one. */
export function formatIssueDueDate(dueDate: string, today: string): string {
  const [year, month, day] = dueDate.split("-");
  if (year === undefined || month === undefined || day === undefined) return dueDate;
  const monthName = MONTH_NAMES[Number(month) - 1];
  if (monthName === undefined) return dueDate;
  const dayLabel = String(Number(day));
  return year === today.slice(0, 4)
    ? `${monthName} ${dayLabel}`
    : `${monthName} ${dayLabel}, ${year}`;
}

/**
 * A cycle's span, `Aug 12 – Aug 25`. A range inside one year prints its year once, at the end, and
 * only when that year is not the obvious one — which is what passing `startDate` as its own
 * "today" buys: {@link formatIssueDueDate} drops the year when the two agree.
 */
export function formatIssueDateRange(startDate: string, endDate: string, today: string): string {
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  const start = formatIssueDueDate(startDate, sameYear ? startDate : today);
  return `${start} – ${formatIssueDueDate(endDate, today)}`;
}

/**
 * How many issues each cycle holds, for the sidebar's counts. Soft-deleted and triage rows are
 * excluded for the same reason they are excluded from a tab: neither is work in the cycle yet.
 */
export function countIssuesByCycle(store: IssuesStore): ReadonlyMap<IssueCycleId, number> {
  const counts = new Map<IssueCycleId, number>();
  for (const issue of store.issuesById.values()) {
    if (issue.cycleId === null || issue.deletedAt !== null || issue.triage) continue;
    counts.set(issue.cycleId, (counts.get(issue.cycleId) ?? 0) + 1);
  }
  return counts;
}

export interface IssueRowLabels {
  readonly shown: ReadonlyArray<IssueLabel>;
  readonly overflow: number;
}

const NO_ROW_LABELS: IssueRowLabels = { shown: [], overflow: 0 };

/**
 * Unknown label ids are dropped rather than rendered as blanks: the stream can carry an issue
 * whose label was deleted in the same batch, and the delete arrives as its own event.
 */
export function resolveIssueRowLabels(
  labelIds: ReadonlyArray<IssueLabelId>,
  labelsById: ReadonlyMap<IssueLabelId, IssueLabel>,
  maxChips: number = ISSUE_ROW_MAX_LABEL_CHIPS,
): IssueRowLabels {
  if (labelIds.length === 0) return NO_ROW_LABELS;
  const resolved: Array<IssueLabel> = [];
  for (const labelId of labelIds) {
    const label = labelsById.get(labelId);
    if (label !== undefined) resolved.push(label);
  }
  if (resolved.length === 0) return NO_ROW_LABELS;
  if (resolved.length <= maxChips) return { shown: resolved, overflow: 0 };
  return { shown: resolved.slice(0, maxChips), overflow: resolved.length - maxChips };
}

export function indexIssueLabels(
  labels: ReadonlyArray<IssueLabel>,
): ReadonlyMap<IssueLabelId, IssueLabel> {
  return new Map(labels.map((label) => [label.id, label]));
}

/**
 * What a bulk label menu shows against each label: `all` when every selected issue carries it,
 * `some` when only part of the selection does. `none` is the plain unchecked state.
 */
export type IssueLabelSelectionState = "none" | "some" | "all";

export function issueLabelSelectionState(
  issues: ReadonlyArray<Issue>,
  labelId: IssueLabelId,
): IssueLabelSelectionState {
  if (issues.length === 0) return "none";
  let carrying = 0;
  for (const issue of issues) if (issue.labelIds.includes(labelId)) carrying += 1;
  if (carrying === 0) return "none";
  return carrying === issues.length ? "all" : "some";
}

/** Toggling a label across a selection adds it unless everyone already has it. */
export function toggleIssueLabelIds(
  labelIds: ReadonlyArray<IssueLabelId>,
  labelId: IssueLabelId,
): ReadonlyArray<IssueLabelId> {
  return labelIds.includes(labelId)
    ? labelIds.filter((id) => id !== labelId)
    : [...labelIds, labelId];
}
