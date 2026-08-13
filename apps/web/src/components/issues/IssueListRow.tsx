/**
 * One issue row and one group header.
 *
 * The row is a click target that opens the detail sheet, and it also carries three inline
 * editors. Those editors sit behind `IssuePropertyGuard`, so a press on the priority glyph edits
 * the priority instead of opening the sheet underneath it.
 *
 * @module components/issues/IssueListRow
 */
import type {
  Issue,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import type { IssueChildRollup } from "~/state/issues";
import {
  IssueAssigneeGlyph,
  IssueInvestigatingChip,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueProgressRing,
  IssueStatusDot,
} from "./IssueGlyphs";
import { IssueLabelsMenu, IssuePriorityMenu, IssueStatusMenu } from "./IssuePropertyMenus";
import {
  formatIssueDueDate,
  isIssueDueDatePast,
  resolveIssueRowLabels,
  type IssuesListHeaderRow,
} from "./issuesList.logic";

const PROPERTY_BUTTON_CLASS =
  "flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export function IssueGroupHeader({
  row,
  onToggle,
}: {
  row: IssuesListHeaderRow;
  onToggle: (groupId: string) => void;
}) {
  const { group } = row;
  return (
    <button
      aria-expanded={!row.collapsed}
      className="flex h-8 w-full items-center gap-2 border-b border-border/40 bg-muted/24 px-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
      onClick={() => onToggle(group.id)}
      type="button"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
          !row.collapsed && "rotate-90",
        )}
      />
      {/* Only two groupings have a glyph to draw; the rest are a name, and a stand-in icon for
          "project" or "assignee" would say less than the extra 20px costs. */}
      {group.status !== null ? <IssueStatusDot status={group.status} /> : null}
      {group.priority !== null ? <IssuePriorityIcon priority={group.priority} /> : null}
      <span className="truncate text-xs font-medium text-foreground">{group.label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{row.count}</span>
    </button>
  );
}

export interface IssueListRowProps {
  readonly issue: Issue;
  readonly status: IssueStatus | null;
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly labelsById: ReadonlyMap<IssueLabelId, IssueLabel>;
  readonly projectTitle: string | null;
  /** The parent's title, when the row has one — the `Parent ›` crumb in front of the title. */
  readonly parentTitle: string | null;
  /** Null when the issue has no children; the `3/9` ring is only meaningful for a parent. */
  readonly childRollup: IssueChildRollup | null;
  /**
   * An investigation is queued or running on this issue. Passed in from one set the page reads
   * once, rather than subscribed to per row: a running run republishes four times a second.
   */
  readonly investigating: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  /** `YYYY-MM-DD`; passed in so every row agrees on what "today" is and stays pure. */
  readonly today: string;
  readonly onRowClick: (issue: Issue, event: MouseEvent) => void;
  readonly onOpen: (issue: Issue) => void;
  /**
   * The right-click. It fires from anywhere in the row, inline property buttons included: the guard
   * those sit behind stops clicks and keys, not `contextmenu`, so the row menu wins over the
   * browser's — which is the behaviour a right-click on a row is asking for either way. Absent on
   * the pages that host no menu, which leaves the browser's own where it was.
   */
  readonly onContextMenu?: (issue: Issue, event: MouseEvent) => void;
  readonly onStatus: (issue: Issue, statusId: IssueStatusId) => void;
  readonly onPriority: (issue: Issue, priority: IssuePriority) => void;
  readonly onToggleLabel: (issue: Issue, labelId: IssueLabelId, add: boolean) => void;
}

function IssueListRowImpl({
  issue,
  status,
  statuses,
  labels,
  labelsById,
  projectTitle,
  parentTitle,
  childRollup,
  investigating,
  selected,
  active,
  today,
  onRowClick,
  onOpen,
  onContextMenu,
  onStatus,
  onPriority,
  onToggleLabel,
}: IssueListRowProps) {
  const rowLabels = resolveIssueRowLabels(issue.labelIds, labelsById);
  const overdue = issue.dueDate !== null && isIssueDueDatePast(issue.dueDate, today);

  return (
    <div
      aria-selected={selected}
      className={cn(
        "group flex h-9 w-full items-center gap-2 border-b border-border/25 px-3 text-sm outline-none sm:px-5",
        selected ? "bg-accent/60" : "hover:bg-accent/30",
        active && "ring-1 ring-inset ring-ring/60",
      )}
      data-issue-key={issue.key}
      onClick={(event) => onRowClick(issue, event)}
      onContextMenu={
        onContextMenu === undefined ? undefined : (event) => onContextMenu(issue, event)
      }
      onDoubleClick={() => onOpen(issue)}
      role="option"
    >
      <IssuePriorityMenu
        onSelect={(priority) => onPriority(issue, priority)}
        trigger={
          <button
            aria-label={`Priority of ${issue.key}`}
            className={PROPERTY_BUTTON_CLASS}
            type="button"
          >
            <IssuePriorityIcon priority={issue.priority} />
          </button>
        }
        value={issue.priority}
      />

      <span className="w-16 shrink-0 truncate font-mono text-xs text-muted-foreground/80">
        {issue.key}
      </span>

      <IssueStatusMenu
        onSelect={(statusId) => onStatus(issue, statusId)}
        statuses={statuses}
        trigger={
          <button
            aria-label={`Status of ${issue.key}`}
            className={PROPERTY_BUTTON_CLASS}
            type="button"
          >
            {status === null ? (
              <span className="size-3 rounded-full border border-dashed border-border" />
            ) : (
              <IssueStatusDot status={status} />
            )}
          </button>
        }
        value={status?.id ?? null}
      />

      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        {parentTitle === null ? null : (
          // Not a link: the row it names is one press away in the sheet, and a nested click target
          // inside the row's own click target is how a triage pass loses its place.
          <span className="hidden max-w-40 shrink truncate text-xs text-muted-foreground/70 sm:inline">
            {parentTitle} ›
          </span>
        )}
        <span className="min-w-0 truncate text-foreground">{issue.title}</span>
      </span>

      {childRollup === null ? null : (
        <span
          className="hidden shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] tabular-nums text-muted-foreground sm:flex"
          title={`${childRollup.done} of ${childRollup.total} sub-issues done`}
        >
          <IssueProgressRing className="size-3" done={childRollup.done} total={childRollup.total} />
          {childRollup.done}/{childRollup.total}
        </span>
      )}

      {rowLabels.shown.length > 0 || labels.length > 0 ? (
        <IssueLabelsMenu
          issues={[issue]}
          labels={labels}
          onToggle={(labelId, add) => onToggleLabel(issue, labelId, add)}
          trigger={
            <button
              aria-label={`Labels of ${issue.key}`}
              className={cn(
                "hidden shrink-0 items-center gap-1 rounded-sm px-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:flex",
                rowLabels.shown.length === 0 && "opacity-0 group-hover:opacity-100",
              )}
              type="button"
            >
              {rowLabels.shown.map((label) => (
                <span
                  className="flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground"
                  key={label.id}
                >
                  <IssueLabelDot className="size-1.5" color={label.color} />
                  <span className="max-w-24 truncate">{label.name}</span>
                </span>
              ))}
              {rowLabels.overflow > 0 ? (
                <span className="rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
                  +{rowLabels.overflow}
                </span>
              ) : null}
              {rowLabels.shown.length === 0 ? (
                <span className="rounded-full border border-dashed border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
                  Label
                </span>
              ) : null}
            </button>
          }
        />
      ) : null}

      {investigating ? <IssueInvestigatingChip /> : null}

      {projectTitle === null ? null : (
        <span className="hidden max-w-32 shrink-0 truncate text-xs text-muted-foreground lg:block">
          {projectTitle}
        </span>
      )}

      {issue.dueDate === null ? null : (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            overdue ? "text-destructive-foreground" : "text-muted-foreground",
          )}
          title={issue.dueDate}
        >
          {formatIssueDueDate(issue.dueDate, today)}
        </span>
      )}

      <IssueAssigneeGlyph assignee={issue.assignee} className="shrink-0" />
    </div>
  );
}

export const IssueListRow = memo(IssueListRowImpl);
