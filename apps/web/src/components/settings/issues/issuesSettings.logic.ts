/**
 * Pure helpers behind the three Issues settings pages.
 *
 * Everything the panels decide — whether a status may be deleted, what a prefix has to look like,
 * how many issues wear a label — lives here so it can be tested without a connection.
 *
 * @module components/settings/issues/issuesSettings.logic
 */
import type { IssueLabelId, IssueStatus, IssueStatusCategory } from "@t3tools/contracts";
import type { IssueCsvColumnName } from "@t3tools/shared/issuesCsv";

import type { IssuesStore } from "../../../state/issues";

/**
 * The six workflow categories, in workflow order. The description is one line because it sits
 * under a select in a table row: the category is what drives the Active/Backlog tabs and every
 * rollup, so picking the wrong one is worth a sentence and not worth a paragraph.
 */
export const ISSUE_STATUS_CATEGORY_OPTIONS: ReadonlyArray<{
  readonly category: IssueStatusCategory;
  readonly label: string;
  readonly description: string;
}> = [
  {
    category: "backlog",
    label: "Backlog",
    description: "Not planned yet. Shows on the Backlog tab only.",
  },
  {
    category: "unstarted",
    label: "Unstarted",
    description: "Planned but not begun. New issues land in the first of these.",
  },
  { category: "started", label: "Started", description: "In flight. Counts as work in progress." },
  {
    category: "review",
    label: "Review",
    description: "Pre-completion checks. Active, but not counted as done.",
  },
  {
    category: "completed",
    label: "Completed",
    description: "Done. This is what an agent means by complete.",
  },
  {
    category: "canceled",
    label: "Canceled",
    description: "Dropped or duplicated. Closed without being done.",
  },
];

const CATEGORY_LABELS: Readonly<Record<IssueStatusCategory, string>> = Object.fromEntries(
  ISSUE_STATUS_CATEGORY_OPTIONS.map((option) => [option.category, option.label]),
) as Readonly<Record<IssueStatusCategory, string>>;

export function issueStatusCategoryLabel(category: IssueStatusCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Status and label colours. Hex rather than the theme tokens `ColorSelector` also accepts: these
 * are stored on the row and rendered by every client, so they cannot depend on the palette of
 * whichever theme was active when somebody picked one. Same set the importer assigns.
 */
export const ISSUE_COLOR_OPTIONS: ReadonlyArray<string> = [
  "#eb5757",
  "#f2994a",
  "#f2c94c",
  "#4cb782",
  "#26b5ce",
  "#5e6ad2",
  "#bb87fc",
  "#95a2b3",
];

export const DEFAULT_ISSUE_COLOR = "#95a2b3";

/** `IssueKeyPrefix` in the contracts: a letter, then up to nine more letters or digits. */
export const ISSUE_KEY_PREFIX_MAX_CHARS = 10;

/** What the field shows while it is being typed in: the stored value is always upper case. */
export function normalizeIssueKeyPrefix(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Null when `raw` would be accepted. The message is the field's error text, so it says what to do
 * rather than restating the pattern.
 */
export function issueKeyPrefixError(raw: string): string | null {
  const prefix = normalizeIssueKeyPrefix(raw);
  if (prefix.length === 0) return "Enter a prefix.";
  if (prefix.length > ISSUE_KEY_PREFIX_MAX_CHARS) {
    return `Use at most ${ISSUE_KEY_PREFIX_MAX_CHARS} characters.`;
  }
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) return "Start with a letter, then letters or digits only.";
  return null;
}

/** How many live issues sit in each status, keyed by status id. Deleted rows do not count. */
export function countIssuesByStatus(store: IssuesStore): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const issue of store.issuesById.values()) {
    if (issue.deletedAt !== null) continue;
    counts.set(issue.statusId, (counts.get(issue.statusId) ?? 0) + 1);
  }
  return counts;
}

/** How many live issues wear each label. Cheap enough to recompute from the store on render. */
export function countIssuesByLabel(store: IssuesStore): ReadonlyMap<IssueLabelId, number> {
  const counts = new Map<IssueLabelId, number>();
  for (const issue of store.issuesById.values()) {
    if (issue.deletedAt !== null) continue;
    for (const labelId of issue.labelIds) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
  }
  return counts;
}

export type IssueStatusDeletability =
  | { readonly canDelete: true }
  | { readonly canDelete: false; readonly reason: string };

/**
 * Mirrors what the server refuses, so the row is disabled rather than the dialog failing: a
 * tracker with no unstarted column has nowhere to put a new issue, and a status cannot be
 * reassigned to itself, so the only status left is undeletable too.
 */
export function issueStatusDeletability(
  statuses: ReadonlyArray<IssueStatus>,
  statusId: string,
): IssueStatusDeletability {
  const status = statuses.find((candidate) => candidate.id === statusId);
  if (status === undefined) return { canDelete: false, reason: "This status no longer exists." };
  if (statuses.length <= 1) {
    return { canDelete: false, reason: "A tracker needs at least one status." };
  }
  if (
    status.category === "unstarted" &&
    statuses.filter((candidate) => candidate.category === "unstarted").length === 1
  ) {
    return {
      canDelete: false,
      reason: "This is the only Unstarted status, and new issues need one to land in.",
    };
  }
  return { canDelete: true };
}

/** Where the deleted status's issues may be sent: every status but the one going away. */
export function issueStatusReassignmentOptions(
  statuses: ReadonlyArray<IssueStatus>,
  statusId: string,
): ReadonlyArray<IssueStatus> {
  return statuses.filter((candidate) => candidate.id !== statusId);
}

/**
 * The order a drag produces, as the complete list the reorder RPC wants. Null when the drop
 * changed nothing, which is the common case of picking a row up and putting it back.
 */
export function reorderedIssueStatusIds(input: {
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly activeId: string;
  readonly overId: string;
}): ReadonlyArray<string> | null {
  const ids: ReadonlyArray<string> = input.statuses.map((status) => status.id);
  const from = ids.indexOf(input.activeId);
  const to = ids.indexOf(input.overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}

/** What an import maps a recognised CSV column onto, for the preview's column chips. */
const ISSUE_CSV_COLUMN_LABELS: Readonly<Record<IssueCsvColumnName, string>> = {
  key: "Issue key",
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  labels: "Labels",
  created: "Created",
  updated: "Updated",
  dueDate: "Due date",
  parent: "Parent issue",
};

export function issueCsvColumnLabel(column: IssueCsvColumnName): string {
  return ISSUE_CSV_COLUMN_LABELS[column];
}

/** Rejects a name already taken, case-insensitively, the way the server does. */
export function duplicateNameError(
  existing: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  name: string,
  exceptId?: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  const clash = existing.some(
    (candidate) =>
      candidate.id !== exceptId && candidate.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? `${trimmed} already exists.` : null;
}
