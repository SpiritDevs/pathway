/**
 * Pure kanban decisions for `/issues` — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * The board is the list view read a second way: the same tab, the same chip bar, the same
 * comparator, narrowed to the one grouping the decision record allows a board to have. So the
 * columns are built from an {@link IssuesView} rather than from the store, and everything the
 * filter bar already decides is decided once.
 *
 * The other half of this file turns a `@dnd-kit` drop into the single `issues.setSortOrder` write
 * it becomes. That resolution is pure because it is the part that is easy to get wrong — which
 * column, which slot, and whether the drop moved anything at all — and impossible to test through
 * a drag.
 *
 * @module components/issues/issuesBoard.logic
 */
import type {
  Issue,
  IssueId,
  IssueStatus,
  IssueStatusId,
  IssueViewSortMode,
} from "@spiritdevs/contracts";

import { issueSortOrderForDrop } from "~/state/issues";
import type { IssuesView } from "./issuesList.logic";

// ── Columns ────────────────────────────────────────────────────────────

/**
 * One status column. Unlike an {@link IssuesView} group the status is never null: a board grouped
 * by anything else is not a board, so a column without a status is a column that cannot exist.
 */
export interface IssuesBoardColumn {
  readonly id: string;
  readonly status: IssueStatus;
  readonly issues: ReadonlyArray<Issue>;
}

export const EMPTY_ISSUES_BOARD_COLUMNS: ReadonlyArray<IssuesBoardColumn> = [];

/**
 * Empty columns survive, because a status column is a place you drop things into and a place the
 * `+` button creates into. The list drops empty groups under every grouping but status for the
 * same reason it keeps them under status: the groups *are* the tab.
 */
export function issuesBoardColumns(view: IssuesView): ReadonlyArray<IssuesBoardColumn> {
  const columns: Array<IssuesBoardColumn> = [];
  for (const group of view.groups) {
    if (group.status === null) continue;
    columns.push({ id: group.id, status: group.status, issues: group.issues });
  }
  return columns;
}

/**
 * Whether a drag can write anything on this board.
 *
 * A drop is turned into a fractional key by reading the keys of the cards it landed between, which
 * only names the slot the pointer chose while the column is *in* that key's order. Under any other
 * ordering the neighbours are two arbitrary keys: the midpoint between them either does not exist
 * (`issueSortOrderForDrop` refuses a descending pair, so the card silently snaps back) or it lands
 * the row somewhere in the manual order nobody pointed at — invisible until the next person opens
 * the board in manual order and finds it shuffled. Under `updated` it is worse than invisible: the
 * write bumps `updatedAt`, so the card jumps to the top of the column whatever slot it was given.
 *
 * So the gesture is withdrawn rather than approximated. {@link issueSortModeHint} says why.
 */
export function isIssuesBoardSortable(sortMode: IssueViewSortMode): boolean {
  return sortMode === "manual";
}

export function findIssuesBoardColumn(
  columns: ReadonlyArray<IssuesBoardColumn>,
  statusId: IssueStatusId,
): IssuesBoardColumn | null {
  return columns.find((column) => column.status.id === statusId) ?? null;
}

export function findIssuesBoardCard(
  columns: ReadonlyArray<IssuesBoardColumn>,
  issueId: IssueId,
): Issue | null {
  for (const column of columns) {
    const issue = column.issues.find((candidate) => candidate.id === issueId);
    if (issue !== undefined) return issue;
  }
  return null;
}

// ── Drag ids ───────────────────────────────────────────────────────────

/**
 * `@dnd-kit` keys every draggable and droppable in one namespace, so a card and the column it sits
 * in have to be told apart by their id rather than by which registry they came from. Prefixing is
 * also what makes an id parseable back into the thing it names, which is how the drop resolver
 * stays pure — it never touches a DOM node or a `data` bag.
 */
const CARD_DRAG_PREFIX = "issue-card:";
const COLUMN_DROP_PREFIX = "issue-column:";

export function issuesBoardCardDragId(issueId: IssueId): string {
  return `${CARD_DRAG_PREFIX}${issueId}`;
}

/**
 * The tail of a column rather than the column itself: the drop zone is the empty space under the
 * last card, so a closest-centre race against the cards is one the tail only wins where appending
 * is what the pointer meant.
 */
export function issuesBoardColumnDropId(statusId: IssueStatusId): string {
  return `${COLUMN_DROP_PREFIX}${statusId}`;
}

export type IssuesBoardDragId =
  | { readonly kind: "card"; readonly issueId: IssueId }
  | { readonly kind: "column"; readonly statusId: IssueStatusId };

export function parseIssuesBoardDragId(id: string): IssuesBoardDragId | null {
  if (id.startsWith(CARD_DRAG_PREFIX)) {
    const issueId = id.slice(CARD_DRAG_PREFIX.length);
    return issueId.length === 0 ? null : { kind: "card", issueId: issueId as IssueId };
  }
  if (id.startsWith(COLUMN_DROP_PREFIX)) {
    const statusId = id.slice(COLUMN_DROP_PREFIX.length);
    return statusId.length === 0 ? null : { kind: "column", statusId: statusId as IssueStatusId };
  }
  return null;
}

// ── Drop resolution ────────────────────────────────────────────────────

/** Which side of the hovered card the dragged one came to rest on. */
export type IssuesBoardDropEdge = "before" | "after";

/**
 * Read off the two rects `@dnd-kit` hands the drop event. A drag that never moved reports no
 * translated rect, in which case there is no edge to speak of and `before` is the harmless answer:
 * a drop that resolves to the slot the card already holds is refused below anyway.
 */
export function issuesBoardDropEdge(input: {
  readonly activeCenterY: number | null;
  readonly overTop: number;
  readonly overHeight: number;
}): IssuesBoardDropEdge {
  if (input.activeCenterY === null) return "before";
  return input.activeCenterY > input.overTop + input.overHeight / 2 ? "after" : "before";
}

/**
 * One `issues.setSortOrder` call. `statusId` is null when the card stayed in its own column, so
 * the write carries a status change only when there is one — a same-column reorder must not write
 * a status field and put a no-op row on the activity feed.
 */
export interface IssuesBoardDrop {
  readonly issueId: IssueId;
  readonly sortOrder: string;
  readonly statusId: IssueStatusId | null;
}

/**
 * Null means "do not write". That covers a board whose column order is not the manual key the drop
 * would write (see {@link isIssuesBoardSortable}), a drop outside every target, a drop on the card
 * being dragged, a drop that resolves to the slot the card already occupies, and a neighbouring
 * sort key so malformed that no key fits between — the same refusal
 * {@link issueSortOrderForDrop} makes.
 *
 * Within a column the slot follows `arrayMove` semantics, because that is what the sortable
 * strategy already animated while the drag was in flight and a drop that lands somewhere other
 * than where the preview showed is worse than a drop that lands one row off. Across columns
 * nothing animates, so the pointer's side of the hovered card decides instead.
 */
export function resolveIssuesBoardDrop(input: {
  readonly columns: ReadonlyArray<IssuesBoardColumn>;
  readonly activeId: string;
  readonly overId: string | null;
  readonly edge?: IssuesBoardDropEdge | undefined;
  /** The order the columns are rendered in; a drag only writes while that is the manual key. */
  readonly sortMode: IssueViewSortMode;
}): IssuesBoardDrop | null {
  const { columns, overId } = input;
  if (!isIssuesBoardSortable(input.sortMode)) return null;
  if (overId === null) return null;

  const active = parseIssuesBoardDragId(input.activeId);
  if (active === null || active.kind !== "card") return null;

  let source: IssuesBoardColumn | null = null;
  let sourceIndex = -1;
  for (const column of columns) {
    const index = column.issues.findIndex((issue) => issue.id === active.issueId);
    if (index !== -1) {
      source = column;
      sourceIndex = index;
      break;
    }
  }
  if (source === null) return null;

  const over = parseIssuesBoardDragId(overId);
  if (over === null) return null;

  const target =
    over.kind === "column"
      ? findIssuesBoardColumn(columns, over.statusId)
      : (columns.find((column) => column.issues.some((issue) => issue.id === over.issueId)) ??
        null);
  if (target === null) return null;

  const sameColumn = target.status.id === source.status.id;
  const siblings = sameColumn
    ? target.issues.filter((issue) => issue.id !== active.issueId)
    : target.issues;

  let index: number;
  if (over.kind === "column") {
    index = siblings.length;
  } else {
    if (over.issueId === active.issueId) return null;
    const overIndex = target.issues.findIndex((issue) => issue.id === over.issueId);
    if (overIndex === -1) return null;
    // Grouped by column the two indices differ: `arrayMove` measures the slot against the array
    // that still holds the dragged card, and `siblings` is that array with the card taken out.
    index = sameColumn ? overIndex : overIndex + (input.edge === "after" ? 1 : 0);
  }

  // Splicing the card back in where it came from is the definition of "nothing moved", and the
  // stream would answer a write like that with a row identical to the one already on screen.
  if (sameColumn && index === sourceIndex) return null;

  const sortOrder = issueSortOrderForDrop({ siblings, index });
  if (sortOrder === null) return null;
  return { issueId: active.issueId, sortOrder, statusId: sameColumn ? null : target.status.id };
}
