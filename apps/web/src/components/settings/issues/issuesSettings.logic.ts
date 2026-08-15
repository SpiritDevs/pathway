/**
 * Pure helpers behind the three Issues settings pages.
 *
 * Everything the panels decide — whether a status may be deleted, what a prefix has to look like,
 * how many issues wear a label — lives here so it can be tested without a connection.
 *
 * @module components/settings/issues/issuesSettings.logic
 */
import type {
  IssueDate,
  IssueLabelId,
  IssueMilestone,
  IssueMilestoneCreateInput,
  IssueMilestoneId,
  IssueMilestonePatch,
  IssueStatus,
  IssueStatusCategory,
  ProjectId,
} from "@spiritdevs/contracts";
import type { IssueCsvColumnName } from "@spiritdevs/shared/issuesCsv";

import type { IssuesStore } from "../../../state/issues";
import { isCompleteIssueDate } from "../../issues/issueDetail.logic";

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

// ── Milestones ─────────────────────────────────────────────────────────

/**
 * The order a drag produces inside one project, as the complete list the reorder RPC wants.
 * Milestones are positioned per project, so `milestones` is that project's alone. Null when the
 * drop changed nothing, which is the common case of picking a row up and putting it back.
 */
export function reorderedIssueMilestoneIds(input: {
  readonly milestones: ReadonlyArray<IssueMilestone>;
  readonly activeId: string;
  readonly overId: string;
}): ReadonlyArray<IssueMilestoneId> | null {
  const ids: ReadonlyArray<IssueMilestoneId> = input.milestones.map((milestone) => milestone.id);
  const from = ids.findIndex((id) => id === input.activeId);
  const to = ids.findIndex((id) => id === input.overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}

/** The sentence the server refuses with, so the field and the round trip say the same thing. */
const BACKWARDS_MILESTONE_DATES = "A milestone cannot start after its target date.";

/** Null when the pair is orderable. `YYYY-MM-DD` compares as text, so no date parsing is needed. */
export function issueMilestoneDatesError(
  startDate: IssueDate | null,
  targetDate: IssueDate | null,
): string | null {
  if (startDate === null || targetDate === null) return null;
  return targetDate < startDate ? BACKWARDS_MILESTONE_DATES : null;
}

export type IssueMilestoneDateEdit =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "patch"; readonly patch: IssueMilestonePatch };

/** A patch touching one end of the range and nothing else. Null clears that end. */
function milestoneDatePatch(
  field: "startDate" | "targetDate",
  date: IssueDate | null,
): IssueMilestonePatch {
  return field === "startDate" ? { startDate: date } : { targetDate: date };
}

/**
 * What one of a milestone's two date fields should do when it is committed. An empty field clears
 * the date, a half-typed one is left alone rather than sent, and a pair that runs backwards is
 * caught here so the row can say so instead of waiting for the server to refuse it.
 */
export function issueMilestoneDateEdit(
  milestone: Pick<IssueMilestone, "startDate" | "targetDate">,
  field: "startDate" | "targetDate",
  raw: string,
): IssueMilestoneDateEdit {
  const value = raw.trim();
  const current = milestone[field];
  if (value.length === 0) {
    if (current === null) return { kind: "unchanged" };
    return { kind: "patch", patch: milestoneDatePatch(field, null) };
  }
  if (!isCompleteIssueDate(value)) return { kind: "unchanged" };
  const next = value as IssueDate;
  if (next === current) return { kind: "unchanged" };
  const error = issueMilestoneDatesError(
    field === "startDate" ? next : milestone.startDate,
    field === "targetDate" ? next : milestone.targetDate,
  );
  if (error !== null) return { kind: "invalid", error };
  return { kind: "patch", patch: milestoneDatePatch(field, next) };
}

/** The add row's three fields, exactly as they are typed in. */
export interface IssueMilestoneDraft {
  readonly name: string;
  readonly startDate: string;
  readonly targetDate: string;
}

/**
 * Null when the add row may be submitted. Milestone names collide within a project, not across the
 * tracker, so `existing` is the one project's milestones.
 */
export function issueMilestoneDraftError(
  draft: IssueMilestoneDraft,
  existing: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string | null {
  const duplicate = duplicateNameError(existing, draft.name);
  if (duplicate !== null) return duplicate;
  if (draft.startDate.trim().length > 0 && !isCompleteIssueDate(draft.startDate)) {
    return "Pick a whole start date.";
  }
  if (draft.targetDate.trim().length > 0 && !isCompleteIssueDate(draft.targetDate)) {
    return "Pick a whole target date.";
  }
  return issueMilestoneDatesError(
    draftIssueDate(draft.startDate),
    draftIssueDate(draft.targetDate),
  );
}

function draftIssueDate(raw: string): IssueDate | null {
  const value = raw.trim();
  return isCompleteIssueDate(value) ? (value as IssueDate) : null;
}

/**
 * The create input behind the add row. Dates are omitted rather than sent as null, because the
 * create input has no cleared state — a milestone with no dates is simply one with neither field.
 */
export function issueMilestoneCreateInput(
  projectId: ProjectId,
  draft: IssueMilestoneDraft,
): IssueMilestoneCreateInput {
  const startDate = draftIssueDate(draft.startDate);
  const targetDate = draftIssueDate(draft.targetDate);
  return {
    projectId,
    name: draft.name.trim(),
    ...(startDate === null ? {} : { startDate }),
    ...(targetDate === null ? {} : { targetDate }),
  };
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
