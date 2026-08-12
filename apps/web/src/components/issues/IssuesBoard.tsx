/**
 * The `/issues` kanban — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Columns are statuses in position order and nothing else. The board renders the *filtered* set,
 * so the chip bar and the tab mean the same thing here as they do in the list; only the layout and
 * the one gesture the list does not have — drag to restatus — are new.
 *
 * Every column is a plain `overflow-y` scroller rather than a `LegendList`. `@dnd-kit` resolves a
 * drop by measuring the rect of every registered droppable, and a virtualized column unmounts the
 * cards it has scrolled past: a card that is not in the DOM is not a drop target, and the sortable
 * strategy cannot animate a gap for it either. A board is also a fundamentally shallower surface
 * than the list — a status column holding a thousand cards is a status that needs splitting, not a
 * column that needs windowing — so the cards carry `content-visibility` and skip their own layout
 * while off-screen, which is the same trade the PR timeline makes.
 *
 * @module components/issues/IssuesBoard
 */
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  Issue,
  IssueId,
  IssueLabel,
  IssueLabelId,
  IssueStatusId,
  IssueViewSortMode,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { memo, useState, type CSSProperties, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import type { IssueChildRollup } from "~/state/issues";
import { Button } from "../ui/button";
import {
  IssueAssigneeGlyph,
  IssueInvestigatingChip,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueProgressRing,
  IssueStatusDot,
} from "./IssueGlyphs";
import {
  findIssuesBoardCard,
  isIssuesBoardSortable,
  issuesBoardCardDragId,
  issuesBoardColumnDropId,
  issuesBoardDropEdge,
  parseIssuesBoardDragId,
  resolveIssuesBoardDrop,
  type IssuesBoardColumn,
  type IssuesBoardDrop,
} from "./issuesBoard.logic";
import { formatIssueDueDate, isIssueDueDatePast, resolveIssueRowLabels } from "./issuesList.logic";

/** Below this a card's title wraps to three lines and the board stops reading as columns. */
const COLUMN_WIDTH_CLASS = "w-72";

export interface IssuesBoardProps {
  readonly columns: ReadonlyArray<IssuesBoardColumn>;
  readonly labelsById: ReadonlyMap<IssueLabelId, IssueLabel>;
  readonly childRollups: ReadonlyMap<IssueId, IssueChildRollup>;
  /** Issues with an investigation in flight, read once for the board rather than once per card. */
  readonly investigatingIssueIds: ReadonlySet<IssueId>;
  /** `YYYY-MM-DD`; passed in so every card agrees on what "today" is. */
  readonly today: string;
  /**
   * What orders the columns. Anything but `manual` and the cards stop being draggable: the drop
   * would write a key read off neighbours that are not in key order. See
   * {@link isIssuesBoardSortable}.
   */
  readonly sortMode: IssueViewSortMode;
  readonly onOpenIssue: (issue: Issue) => void;
  readonly onNewIssue: (statusId: IssueStatusId) => void;
  readonly onMove: (drop: IssuesBoardDrop) => void;
}

export function IssuesBoard({
  columns,
  labelsById,
  childRollups,
  investigatingIssueIds,
  today,
  sortMode,
  onOpenIssue,
  onNewIssue,
  onMove,
}: IssuesBoardProps) {
  const [activeIssueId, setActiveIssueId] = useState<IssueId | null>(null);
  const sortable = isIssuesBoardSortable(sortMode);
  // The same 6px the statuses panel uses, and the reason a press that never moves is a click that
  // opens the sheet rather than a drag that goes nowhere.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragStart = (event: DragStartEvent) => {
    const active = parseIssuesBoardDragId(String(event.active.id));
    setActiveIssueId(active !== null && active.kind === "card" ? active.issueId : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveIssueId(null);
    const over = event.over;
    if (over === null) return;
    const translated = event.active.rect.current.translated ?? null;
    const drop = resolveIssuesBoardDrop({
      columns,
      activeId: String(event.active.id),
      overId: String(over.id),
      edge: issuesBoardDropEdge({
        activeCenterY: translated === null ? null : translated.top + translated.height / 2,
        overTop: over.rect.top,
        overHeight: over.rect.height,
      }),
      sortMode,
    });
    if (drop === null) return;
    // Nothing optimistic: the overlay is the whole illusion, and the row settles when the stream
    // echoes the write back. A refusal therefore leaves the card exactly where it started.
    onMove(drop);
  };

  const activeIssue = activeIssueId === null ? null : findIssuesBoardCard(columns, activeIssueId);

  return (
    <DndContext
      collisionDetection={closestCenter}
      // Columns scroll under the pointer mid-drag, so a rect measured once at drag start is a rect
      // that stops being true the moment the user reaches the bottom of a column.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragCancel={() => setActiveIssueId(null)}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        aria-label="Issue board"
        className="flex h-full min-h-0 items-stretch gap-3 overflow-x-auto overflow-y-hidden px-3 pb-3 sm:px-5"
      >
        {columns.map((column) => (
          <BoardColumn
            childRollups={childRollups}
            column={column}
            investigatingIssueIds={investigatingIssueIds}
            key={column.id}
            labelsById={labelsById}
            onNewIssue={onNewIssue}
            onOpenIssue={onOpenIssue}
            sortable={sortable}
            today={today}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIssue === null ? null : (
          <IssueBoardCard
            childRollup={childRollups.get(activeIssue.id) ?? null}
            dragging
            investigating={investigatingIssueIds.has(activeIssue.id)}
            issue={activeIssue}
            labelsById={labelsById}
            today={today}
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  column,
  labelsById,
  childRollups,
  investigatingIssueIds,
  today,
  sortable,
  onOpenIssue,
  onNewIssue,
}: {
  column: IssuesBoardColumn;
  labelsById: ReadonlyMap<IssueLabelId, IssueLabel>;
  childRollups: ReadonlyMap<IssueId, IssueChildRollup>;
  investigatingIssueIds: ReadonlySet<IssueId>;
  today: string;
  sortable: boolean;
  onOpenIssue: (issue: Issue) => void;
  onNewIssue: (statusId: IssueStatusId) => void;
}) {
  // The tail, not the column: a droppable wrapped around the cards would sit dead centre of the
  // whole column and beat every card to the closest-centre test.
  const { setNodeRef, isOver } = useDroppable({ id: issuesBoardColumnDropId(column.status.id) });

  return (
    <section
      aria-label={`${column.status.name}, ${column.issues.length} issues`}
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col rounded-xl border border-border/50 bg-muted/16",
        COLUMN_WIDTH_CLASS,
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <IssueStatusDot status={column.status} />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {column.status.name}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{column.issues.length}</span>
        <Button
          aria-label={`New issue in ${column.status.name}`}
          className="ms-auto"
          onClick={() => onNewIssue(column.status.id)}
          size="icon-xs"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
        <SortableContext
          items={column.issues.map((issue) => issuesBoardCardDragId(issue.id))}
          strategy={verticalListSortingStrategy}
        >
          {column.issues.map((issue) => (
            <SortableBoardCard
              childRollup={childRollups.get(issue.id) ?? null}
              investigating={investigatingIssueIds.has(issue.id)}
              issue={issue}
              key={issue.id}
              labelsById={labelsById}
              onOpen={onOpenIssue}
              sortable={sortable}
              today={today}
            />
          ))}
        </SortableContext>
        <div
          className={cn(
            "min-h-14 flex-1 rounded-lg border border-dashed transition-colors motion-reduce:transition-none",
            isOver ? "border-primary/40 bg-primary/10" : "border-transparent",
          )}
          ref={setNodeRef}
        >
          {column.issues.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground/70">Nothing in {column.status.name}.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SortableBoardCard({
  issue,
  labelsById,
  childRollup,
  investigating,
  today,
  sortable,
  onOpen,
}: {
  issue: Issue;
  labelsById: ReadonlyMap<IssueLabelId, IssueLabel>;
  childRollup: IssueChildRollup | null;
  investigating: boolean;
  today: string;
  sortable: boolean;
  onOpen: (issue: Issue) => void;
}) {
  // Disabled takes the card out of both registries, so under a non-manual order there is no drag
  // to start and no target to land on — the drop resolver's refusal is never even reached.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    disabled: !sortable,
    id: issuesBoardCardDragId(issue.id),
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onOpen(issue);
  };

  return (
    <IssueBoardCard
      childRollup={childRollup}
      investigating={investigating}
      // `attributes` already carries the tabIndex and the button role, so the card is reachable by
      // Tab and Enter opens it — the board's whole keyboard story, since j/k and multi-select stay
      // in the list where triage happens.
      dragAttributes={attributes}
      dragListeners={listeners}
      issue={issue}
      labelsById={labelsById}
      onClick={() => onOpen(issue)}
      onKeyDown={handleKeyDown}
      // The original stays in place as a hole; the overlay is what follows the pointer.
      placeholder={isDragging}
      setNodeRef={setNodeRef}
      sortable={sortable}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      today={today}
    />
  );
}

/** The two bags `useSortable` hands back, so the overlay copy can render without either. */
type SortableBindings = ReturnType<typeof useSortable>;

function IssueBoardCardImpl({
  issue,
  labelsById,
  childRollup,
  investigating,
  today,
  dragging = false,
  placeholder = false,
  sortable = true,
  dragAttributes,
  dragListeners,
  setNodeRef,
  style,
  onClick,
  onKeyDown,
}: {
  issue: Issue;
  labelsById: ReadonlyMap<IssueLabelId, IssueLabel>;
  childRollup: IssueChildRollup | null;
  investigating: boolean;
  today: string;
  dragging?: boolean;
  placeholder?: boolean;
  /** False only draws the difference: the card is already out of the drag registries. */
  sortable?: boolean;
  dragAttributes?: SortableBindings["attributes"];
  dragListeners?: SortableBindings["listeners"];
  setNodeRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const rowLabels = resolveIssueRowLabels(issue.labelIds, labelsById);
  const overdue = issue.dueDate !== null && isIssueDueDatePast(issue.dueDate, today);

  return (
    <div
      {...dragAttributes}
      {...dragListeners}
      className={cn(
        "flex shrink-0 touch-none flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-2 text-left shadow-xs outline-none [contain-intrinsic-block-size:84px] [content-visibility:auto] hover:border-border focus-visible:ring-2 focus-visible:ring-ring",
        sortable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        placeholder && "opacity-32",
        dragging && "cursor-grabbing rotate-1 shadow-lg",
      )}
      data-issue-key={issue.key}
      onClick={onClick}
      onKeyDown={onKeyDown}
      ref={setNodeRef}
      style={style}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
          {issue.key}
        </span>
        {investigating ? <IssueInvestigatingChip compact /> : null}
        <IssueAssigneeGlyph assignee={issue.assignee} className="ms-auto shrink-0" />
      </div>

      <span className="line-clamp-2 text-[13px] leading-snug text-foreground">{issue.title}</span>

      <div className="flex items-center gap-1.5">
        <IssuePriorityIcon priority={issue.priority} />
        {rowLabels.shown.length === 0 ? null : (
          <span
            className="flex shrink-0 items-center gap-1"
            title={rowLabels.shown.map((label) => label.name).join(", ")}
          >
            {rowLabels.shown.map((label) => (
              <IssueLabelDot color={label.color} key={label.id} />
            ))}
            {rowLabels.overflow > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                +{rowLabels.overflow}
              </span>
            ) : null}
          </span>
        )}
        {childRollup === null ? null : (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
            title={`${childRollup.done} of ${childRollup.total} sub-issues done`}
          >
            <IssueProgressRing
              className="size-3"
              done={childRollup.done}
              total={childRollup.total}
            />
            {childRollup.done}/{childRollup.total}
          </span>
        )}
        {issue.dueDate === null ? null : (
          <span
            className={cn(
              "ms-auto shrink-0 text-[11px] tabular-nums",
              overdue ? "text-destructive-foreground" : "text-muted-foreground",
            )}
            title={issue.dueDate}
          >
            {formatIssueDueDate(issue.dueDate, today)}
          </span>
        )}
      </div>
    </div>
  );
}

const IssueBoardCard = memo(IssueBoardCardImpl);
