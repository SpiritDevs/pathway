/**
 * What the issues context menu offers, and which rows it offers it for.
 *
 * A right-click on a list row or a board card acts on that one issue, unless the row is already
 * part of a multi-row selection — then it acts on the whole selection, which is the rule the bulk
 * bar follows too. Everything here is pure: the menu renders it, the page writes the patches.
 *
 * @module components/issues/issueContextMenu.logic
 */
import type { Issue, IssueMilestone, IssuePatch, ProjectId } from "@t3tools/contracts";

import { issueDetailUrl } from "./issueStartWork.logic";
import { addIssueDays } from "./issuesList.logic";

/**
 * The rows a menu press writes to. A right-click inside a multi-row selection means the selection;
 * anywhere else it means the one row under the pointer, even when other rows are selected.
 */
export function issueContextMenuIssues(
  issue: Issue,
  selected: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> {
  return selected.length > 1 && selected.some((candidate) => candidate.id === issue.id)
    ? selected
    : [issue];
}

/** `PAT-221` for one row, `3 issues` for several — the menu's own heading. */
export function issueContextMenuLabel(issues: ReadonlyArray<Issue>): string {
  const first = issues[0];
  if (first === undefined) return "No issue";
  return issues.length === 1 ? first.key : `${issues.length} issues`;
}

/**
 * No radio item carries this value, so a selection whose rows disagree renders with nothing
 * checked rather than claiming the first row speaks for the rest. It is deliberately not `""`:
 * that is a real value here, meaning "no project", "no cycle", "unassigned". No id, priority, or
 * date is spelled this way either, which is the whole requirement.
 */
export const ISSUE_MENU_MIXED_VALUE = "__mixed__";

/** The one value every row shares, or {@link ISSUE_MENU_MIXED_VALUE} when they disagree. */
export function sharedIssueMenuValue(values: ReadonlyArray<string>): string {
  const first = values[0];
  if (first === undefined) return ISSUE_MENU_MIXED_VALUE;
  return values.every((value) => value === first) ? first : ISSUE_MENU_MIXED_VALUE;
}

/**
 * The project every target sits in, or null when they disagree or have none. Milestones belong to
 * a project, so this is what decides whether the milestone submenu has anything to offer.
 */
export function issueContextMenuProjectId(issues: ReadonlyArray<Issue>): ProjectId | null {
  const shared = sharedIssueMenuValue(issues.map((issue) => issue.projectId ?? ""));
  return shared === ISSUE_MENU_MIXED_VALUE || shared === "" ? null : (shared as ProjectId);
}

export function issueContextMenuMilestones(
  milestones: ReadonlyArray<IssueMilestone>,
  projectId: ProjectId | null,
): ReadonlyArray<IssueMilestone> {
  if (projectId === null) return [];
  return milestones.filter((milestone) => milestone.projectId === projectId);
}

// ── Due date ───────────────────────────────────────────────────────────

export interface IssueDueDateOption {
  readonly label: string;
  /** `YYYY-MM-DD`, the shape the contract stores. */
  readonly value: string;
}

/**
 * The four dates worth one press. Anything else is a calendar, which is the detail sheet's job —
 * a menu that hosts a date field is a menu that closes on the first keystroke.
 */
export function issueDueDateQuickOptions(today: string): ReadonlyArray<IssueDueDateOption> {
  return [
    { label: "Today", value: today },
    { label: "Tomorrow", value: addIssueDays(today, 1) },
    { label: "In a week", value: addIssueDays(today, 7) },
    { label: "In a month", value: addIssueDays(today, 30) },
  ];
}

// ── Copy ───────────────────────────────────────────────────────────────

export type IssueContextMenuCopyField = "key" | "title" | "url" | "markdown";

export const ISSUE_CONTEXT_MENU_COPY_FIELDS: ReadonlyArray<IssueContextMenuCopyField> = [
  "key",
  "title",
  "url",
  "markdown",
];

export const ISSUE_CONTEXT_MENU_COPY_LABELS: Readonly<Record<IssueContextMenuCopyField, string>> = {
  key: "Issue ID",
  title: "Issue title",
  url: "Issue link",
  markdown: "Markdown link",
};

/** One line per issue, so a copy off a multi-row selection pastes as a list. */
export function issueContextMenuCopyValue(
  issues: ReadonlyArray<Issue>,
  field: IssueContextMenuCopyField,
  origin: string,
): string {
  return issues
    .map((issue) => {
      switch (field) {
        case "key":
          return issue.key;
        case "title":
          return issue.title;
        case "url":
          return issueDetailUrl(origin, issue.key);
        case "markdown":
          return `[${issue.key} ${issue.title}](${issueDetailUrl(origin, issue.key)})`;
      }
    })
    .join("\n");
}

// ── Remove ─────────────────────────────────────────────────────────────

export type IssueContextMenuRemoveField =
  | "assignee"
  | "labels"
  | "project"
  | "milestone"
  | "cycle"
  | "dueDate"
  | "parent";

export const ISSUE_CONTEXT_MENU_REMOVE_FIELDS: ReadonlyArray<IssueContextMenuRemoveField> = [
  "assignee",
  "labels",
  "project",
  "milestone",
  "cycle",
  "dueDate",
  "parent",
];

export const ISSUE_CONTEXT_MENU_REMOVE_LABELS: Readonly<
  Record<IssueContextMenuRemoveField, string>
> = {
  assignee: "Assignee",
  labels: "Labels",
  project: "Project",
  milestone: "Milestone",
  cycle: "Cycle",
  dueDate: "Due date",
  parent: "Parent",
};

/** Offered only while at least one target still carries the property. */
export function issueContextMenuRemovable(
  issues: ReadonlyArray<Issue>,
  field: IssueContextMenuRemoveField,
): boolean {
  return issues.some((issue) => {
    switch (field) {
      case "assignee":
        return issue.assignee !== null;
      case "labels":
        return issue.labelIds.length > 0;
      case "project":
        return issue.projectId !== null;
      case "milestone":
        return issue.milestoneId !== null;
      case "cycle":
        return issue.cycleId !== null;
      case "dueDate":
        return issue.dueDate !== null;
      case "parent":
        return issue.parentId !== null;
    }
  });
}

export function issueContextMenuRemovePatch(field: IssueContextMenuRemoveField): IssuePatch {
  switch (field) {
    case "assignee":
      return { assignee: null };
    case "labels":
      return { labelIds: [] };
    case "project":
      // The server clears the milestone with it: a milestone the issue no longer shares a project
      // with is not a milestone it can be on.
      return { projectId: null };
    case "milestone":
      return { milestoneId: null };
    case "cycle":
      return { cycleId: null };
    case "dueDate":
      return { dueDate: null };
    case "parent":
      return { parentId: null };
  }
}
