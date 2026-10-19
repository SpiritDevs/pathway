/**
 * Pure drag decisions for the grouped issue list.
 *
 * The list and board write the same fractional `sortOrder`, but they do not preview a move the
 * same way. Board cards use a sortable strategy; list rows stay fixed under a drag overlay, so the
 * pointer's side of the hovered row names the exact slot. Keeping that distinction here prevents
 * a downward list drag from landing one row farther than the user indicated.
 *
 * @module components/issues/issuesListDnd.logic
 */
import type { Issue, IssueId, IssueStatusId } from "@spiritdevs/contracts";

import { issueSortOrderForDrop } from "~/state/issues";
import type { IssuesView, IssuesViewGroup } from "./issuesList.logic";

const ROW_DRAG_PREFIX = "issue-row:";
const GROUP_DROP_PREFIX = "issue-group:";

export function issuesListRowDragId(issueId: IssueId): string {
  return `${ROW_DRAG_PREFIX}${issueId}`;
}

export function issuesListGroupDropId(statusId: IssueStatusId): string {
  return `${GROUP_DROP_PREFIX}${statusId}`;
}

type IssuesListDragId =
  | { readonly kind: "row"; readonly issueId: IssueId }
  | { readonly kind: "group"; readonly statusId: IssueStatusId };

export function parseIssuesListDragId(id: string): IssuesListDragId | null {
  if (id.startsWith(ROW_DRAG_PREFIX)) {
    const issueId = id.slice(ROW_DRAG_PREFIX.length);
    return issueId.length === 0 ? null : { kind: "row", issueId: issueId as IssueId };
  }
  if (id.startsWith(GROUP_DROP_PREFIX)) {
    const statusId = id.slice(GROUP_DROP_PREFIX.length);
    return statusId.length === 0 ? null : { kind: "group", statusId: statusId as IssueStatusId };
  }
  return null;
}

export type IssuesListDropEdge = "before" | "after";

export function issuesListDropEdge(input: {
  readonly activeCenterY: number | null;
  readonly overTop: number;
  readonly overHeight: number;
}): IssuesListDropEdge {
  if (input.activeCenterY === null) return "before";
  return input.activeCenterY > input.overTop + input.overHeight / 2 ? "after" : "before";
}

export interface IssuesListDrop {
  readonly issueId: IssueId;
  readonly sortOrder: string;
  readonly statusId: IssueStatusId | null;
}

export function isIssuesListSortable(view: IssuesView): boolean {
  return view.grouping === "status" && view.sortMode === "manual";
}

export function findIssuesListIssue(view: IssuesView, issueId: IssueId): Issue | null {
  for (const group of view.groups) {
    const issue = group.issues.find((candidate) => candidate.id === issueId);
    if (issue !== undefined) return issue;
  }
  return null;
}

function findSource(
  groups: ReadonlyArray<IssuesViewGroup>,
  issueId: IssueId,
): { readonly group: IssuesViewGroup; readonly index: number } | null {
  for (const group of groups) {
    const index = group.issues.findIndex((issue) => issue.id === issueId);
    if (index !== -1) return { group, index };
  }
  return null;
}

/**
 * Resolve one row gesture into the one atomic `issues.setSortOrder` write it needs.
 *
 * Group headers name the first slot in a status. This makes empty and collapsed status groups
 * useful targets without adding permanent drop zones to a dense table.
 */
export function resolveIssuesListDrop(input: {
  readonly view: IssuesView;
  readonly activeId: string;
  readonly overId: string | null;
  readonly edge?: IssuesListDropEdge | undefined;
}): IssuesListDrop | null {
  if (!isIssuesListSortable(input.view) || input.overId === null) return null;

  const active = parseIssuesListDragId(input.activeId);
  if (active === null || active.kind !== "row") return null;
  const source = findSource(input.view.groups, active.issueId);
  if (source === null || source.group.status === null) return null;

  const over = parseIssuesListDragId(input.overId);
  if (over === null) return null;

  const target =
    over.kind === "group"
      ? (input.view.groups.find((group) => group.status?.id === over.statusId) ?? null)
      : (input.view.groups.find((group) =>
          group.issues.some((issue) => issue.id === over.issueId),
        ) ?? null);
  if (target === null || target.status === null) return null;

  const sameGroup = target.status.id === source.group.status.id;
  const siblings = sameGroup
    ? target.issues.filter((issue) => issue.id !== active.issueId)
    : target.issues;

  let index: number;
  if (over.kind === "group") {
    index = 0;
  } else {
    if (over.issueId === active.issueId) return null;
    const overIndex = siblings.findIndex((issue) => issue.id === over.issueId);
    if (overIndex === -1) return null;
    index = overIndex + (input.edge === "after" ? 1 : 0);
  }

  if (sameGroup && index === source.index) return null;

  const sortOrder = issueSortOrderForDrop({ siblings, index });
  if (sortOrder === null) return null;
  return {
    issueId: active.issueId,
    sortOrder,
    statusId: sameGroup ? null : target.status.id,
  };
}
