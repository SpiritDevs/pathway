/**
 * The `/issues` list view — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Grouped by status, virtualized, keyboard-driven. Everything the view decides that does not need
 * the DOM lives in `issuesList.logic.ts`; this file is the wiring: atoms in, mutations out, one
 * `LegendList` in the middle.
 *
 * @module components/issues/IssuesListPage
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import type {
  Issue,
  IssueCycleId,
  IssueLabelId,
  IssueId,
  IssueMilestoneId,
  IssuePatch,
  IssuePriority,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import { MembershipId } from "@spiritdevs/contracts/company";
import { Link } from "@tanstack/react-router";
import { ColumnsIcon, ListTodoIcon, PlusIcon, Rows3Icon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  issueChildRollups,
  useBulkUpdateIssues,
  useDeleteIssue,
  useInvestigatingIssueIds,
  useIssue,
  useIssueCycles,
  useIssueLabels,
  useIssueMilestones,
  useIssueStatuses,
  useIssuesGrouped,
  useIssuesStore,
  useIssuesStoreStatus,
  useRestoreIssue,
  useSetIssueSortOrder,
  useStartIssueEnrichment,
  useUpdateIssue,
  type IssuesTab,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { IssueContextMenu, type IssueContextMenuTarget } from "./IssueContextMenu";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { IssueGroupHeader, IssueListRow } from "./IssueListRow";
import { IssuesBoard } from "./IssuesBoard";
import { IssuesBulkBar } from "./IssuesBulkBar";
import { IssuesFilterBar } from "./IssuesFilterBar";
import { IssuesTriageView } from "./IssuesTriageView";
import { IssuesViewOptions } from "./IssuesViewOptions";
import { NewIssueDialog } from "./NewIssueDialog";
import { SaveIssueViewControl } from "./SaveIssueViewControl";
import {
  ISSUE_CONTEXT_MENU_COPY_LABELS,
  issueContextMenuCopyValue,
  issueContextMenuIssues,
  type IssueContextMenuCopyField,
} from "./issueContextMenu.logic";
import { issueAssigneeDisplayName, useIssueMemberDirectory } from "./issueMemberDirectory";
import { useIssueAssigneeOptions } from "./useIssueAssigneeOptions";
import { ISSUE_INVESTIGATE_BLOCK_REASONS, issueInvestigateBlock } from "./issueEnrichment.logic";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  EMPTY_ISSUES_BOARD_COLUMNS,
  issuesBoardColumns,
  type IssuesBoardDrop,
} from "./issuesBoard.logic";
import {
  DEFAULT_ISSUES_TAB,
  EMPTY_ISSUES_SELECTION,
  buildIssuesListRows,
  buildIssuesView,
  effectiveIssuesGrouping,
  findIssueRowIndex,
  indexIssueLabels,
  NO_ISSUES_LIST_FILTER,
  isIssuesListFilterActive,
  issueIdsInRows,
  issueSelectModeForModifiers,
  issuesFilterSearchPatch,
  issuesSearchFilter,
  issuesSearchGrouping,
  issuesSearchSortMode,
  issuesSearchViewMode,
  pruneIssuesSelection,
  resolveIssuesFilterUserAssignee,
  resolveIssuesListKeyAction,
  selectIssueRow,
  soleIssuesFilterValue,
  toggleIssueLabelIds,
  type IssuesListFilter,
  type IssuesListRow as IssuesListRowModel,
  type IssuesSearch,
  type IssuesSearchPatch,
  type IssuesSelection,
} from "./issuesList.logic";

const TABS: ReadonlyArray<{ readonly value: IssuesTab; readonly label: string }> = [
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
  { value: "all", label: "All" },
];

/** A header is 32px and a row 36px; the list is dense enough that one estimate covers both. */
const ESTIMATED_ROW_HEIGHT = 36;

/** The board draws its own cards, so the flat row array is dead weight while it is up. */
const NO_ISSUES_LIST_ROWS: ReadonlyArray<IssuesListRowModel> = [];

/** A stable empty array for the shut context menu, so its handlers never see a fresh one. */
const NO_CONTEXT_ISSUES: ReadonlyArray<Issue> = [];

/**
 * `/issues`, in one of its two modes. Triage is branched at the top rather than folded into the
 * list: it shares the URL and the detail sheet, and nothing else — no tabs, no filters, no board,
 * and no status grouping, because a triage item has no status to group by.
 */
export function IssuesListPage({
  search,
  onSearch,
}: {
  search: IssuesSearch;
  onSearch: (patch: IssuesSearchPatch) => void;
}) {
  return search.triage === true ? (
    <IssuesTriageView onSearch={onSearch} search={search} />
  ) : (
    <IssuesListView onSearch={onSearch} search={search} />
  );
}

function IssuesListView({
  search,
  onSearch,
}: {
  search: IssuesSearch;
  onSearch: (patch: IssuesSearchPatch) => void;
}) {
  const memberDirectory = useIssueMemberDirectory();
  const assigneeOptions = useIssueAssigneeOptions();
  const assigneeFilterOptions = useMemo(() => {
    const active = assigneeOptions.flatMap((option) =>
      option.assignee === null
        ? []
        : [{ value: option.value, label: option.label, assignee: option.assignee }],
    );
    const known = new Set(active.map((option) => option.value));
    const historical = [...memberDirectory.names].flatMap(([membershipId, label]) => {
      const value = `member:${membershipId}`;
      return known.has(value)
        ? []
        : [
            {
              value,
              label,
              assignee: { kind: "member" as const, membershipId: MembershipId.make(membershipId) },
            },
          ];
    });
    return [...active, ...historical];
  }, [assigneeOptions, memberDirectory.names]);
  const assigneeGroupLabels = useMemo(
    () => new Map(assigneeFilterOptions.map((option) => [option.value, option.label])),
    [assigneeFilterOptions],
  );
  const tab = search.tab ?? DEFAULT_ISSUES_TAB;
  const store = useIssuesStore();
  const storeStatus = useIssuesStoreStatus();
  const statuses = useIssueStatuses();
  const labels = useIssueLabels();
  const projects = useProjects();
  const milestones = useIssueMilestones();
  const cycles = useIssueCycles();
  const grouping = useIssuesGrouped(tab);
  const updateIssue = useUpdateIssue();
  const bulkUpdateIssues = useBulkUpdateIssues();
  const deleteIssue = useDeleteIssue();
  const restoreIssue = useRestoreIssue();
  const startEnrichment = useStartIssueEnrichment();
  const setIssueSortOrder = useSetIssueSortOrder();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<IssuesSelection>(EMPTY_ISSUES_SELECTION);
  /** The right-click menu's target, or null while it is shut. One menu for every row and card. */
  const [contextMenu, setContextMenu] = useState<IssueContextMenuTarget | null>(null);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  /** Set by a column's `+`, which is the only path that names a status the filter did not. */
  const [newIssueStatusId, setNewIssueStatusId] = useState<IssueStatusId | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const scrollToActiveRef = useRef(false);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const filter = useMemo(() => issuesSearchFilter(search), [search]);
  const effectiveFilter = useMemo(
    () => resolveIssuesFilterUserAssignee(filter, memberDirectory.currentMembershipId),
    [filter, memberDirectory.currentMembershipId],
  );
  const viewMode = issuesSearchViewMode(search);
  const groupBy = effectiveIssuesGrouping(issuesSearchGrouping(search), viewMode);
  const sortMode = issuesSearchSortMode(search);
  const labelsById = useMemo(() => indexIssueLabels(labels), [labels]);
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const view = useMemo(
    () =>
      buildIssuesView({
        grouping,
        filter: effectiveFilter,
        today,
        groupBy,
        sortMode,
        projectTitles,
        assigneeLabels: assigneeGroupLabels,
      }),
    [assigneeGroupLabels, effectiveFilter, groupBy, grouping, projectTitles, sortMode, today],
  );
  // Both are narrowings of the one view, so the filter, the comparator, and the group order are
  // computed once no matter which layout is up.
  const rows = useMemo(
    () =>
      viewMode === "board" ? NO_ISSUES_LIST_ROWS : buildIssuesListRows(view, collapsedGroupIds),
    [collapsedGroupIds, view, viewMode],
  );
  const boardColumns = useMemo(
    () => (viewMode === "board" ? issuesBoardColumns(view) : EMPTY_ISSUES_BOARD_COLUMNS),
    [view, viewMode],
  );
  const ids = useMemo(() => issueIdsInRows(rows), [rows]);
  const filterActive = isIssuesListFilterActive(filter);
  const setFilter = (next: IssuesListFilter) => onSearch(issuesFilterSearchPatch(next));
  // One pass over the tracker rather than one per row: a parent's `3/9` is a scan of every issue's
  // `parentId`, and doing that inside `renderItem` would make the virtualized list quadratic.
  const childRollups = useMemo(() => issueChildRollups(store), [store]);
  // One subscription for the whole list. The set only changes identity when its membership does,
  // so a transcript arriving four times a second re-renders nothing.
  const investigatingIssueIds = useInvestigatingIssueIds();

  // A row can leave the list under a live stream or a filter change; a bulk write against rows
  // nobody can see is the one outcome the selection must never allow.
  useEffect(() => {
    setSelection((current) => pruneIssuesSelection(current, ids));
  }, [ids]);

  const selectedIssues = useMemo(() => {
    if (selection.ids.size === 0) return [];
    const found: Array<Issue> = [];
    for (const row of rows) {
      if (row.kind === "issue" && selection.ids.has(row.issue.id)) found.push(row.issue);
    }
    return found;
  }, [rows, selection.ids]);

  const detailIssueKey = search.issue ?? null;
  const detailIssue = useIssue(detailIssueKey);
  const openIssue = (issue: Issue) => onSearch({ issue: issue.key });
  const closeDetail = () => onSearch({ issue: undefined });

  // A deep link arrives with no selection; the cursor moves to the row the URL names so the very
  // next `j` continues from it rather than from the top of the list.
  useEffect(() => {
    // A soft-deleted row is still in the store (the depth cap counts it) but is in no list, so
    // there is no row for the cursor to land on — and neither is anything while the board is up,
    // which renders no rows at all.
    if (ids.length === 0 || detailIssue === null || detailIssue.deletedAt !== null) return;
    setSelection((current) =>
      current.activeId === null
        ? selectIssueRow(current, { ids, issueId: detailIssue.id, mode: "replace" })
        : current,
    );
  }, [detailIssue, ids]);

  const handleKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
    ) {
      return;
    }
    // Escape shuts the sheet before it clears the selection: the sheet is the thing in front, and
    // it is non-modal, so base-ui is not listening for the key on the list's behalf.
    if (event.key === "Escape" && detailIssueKey !== null) {
      event.preventDefault();
      closeDetail();
      return;
    }
    const action = resolveIssuesListKeyAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      ids,
      activeId: selection.activeId,
      hasSelection: selection.ids.size > 0,
    });
    if (action === null) return;
    event.preventDefault();
    if (action._tag === "clear") {
      setSelection(EMPTY_ISSUES_SELECTION);
      return;
    }
    if (action._tag === "open") {
      const issue = store.issuesById.get(action.issueId);
      if (issue !== undefined) openIssue(issue);
      return;
    }
    scrollToActiveRef.current = true;
    setSelection((current) =>
      selectIssueRow(current, { ids, issueId: action.issueId, mode: "replace" }),
    );
    // An open sheet follows the cursor rather than staying on the row it was opened from, which is
    // what makes `j`/`k` a triage pass rather than a way to lose your place.
    if (detailIssueKey !== null) {
      const issue = store.issuesById.get(action.issueId);
      if (issue !== undefined) openIssue(issue);
    }
  });

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Only the keyboard scrolls: a click already happened on a visible row, and yanking it to the
  // top of the viewport under the pointer is disorienting.
  useEffect(() => {
    if (!scrollToActiveRef.current) return;
    scrollToActiveRef.current = false;
    const index = findIssueRowIndex(rows, selection.activeId);
    if (index === -1) return;
    listRef.current?.scrollToIndex({ index, viewOffset: 48 });
  }, [rows, selection.activeId]);

  const handleRowClick = (issue: Issue, event: MouseEvent) => {
    const mode = issueSelectModeForModifiers(event);
    setSelection((current) => selectIssueRow(current, { ids, issueId: issue.id, mode }));
    if (mode === "replace") openIssue(issue);
  };

  // Nothing here is optimistic: a refused write leaves the row exactly as it was, which reads as a
  // press that never registered unless it says so.
  const write = (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    void (async () => {
      reportIssueWriteFailure(title, await run());
    })();
  };

  const setIssueStatus = (issue: Issue, statusId: IssueStatusId) => {
    write("Failed to change the status", () =>
      updateIssue({ issueId: issue.id, patch: { statusId } }),
    );
  };
  const setIssuePriority = (issue: Issue, priority: IssuePriority) => {
    write("Failed to change the priority", () =>
      updateIssue({ issueId: issue.id, patch: { priority } }),
    );
  };
  const toggleIssueLabel = (issue: Issue, labelId: IssueLabelId) => {
    write("Failed to change the labels", () =>
      updateIssue({
        issueId: issue.id,
        patch: { labelIds: toggleIssueLabelIds(issue.labelIds, labelId) },
      }),
    );
  };

  const bulkIssueIds = selectedIssues.map((issue) => issue.id);
  const bulkStatus = (statusId: IssueStatusId) => {
    if (bulkIssueIds.length === 0) return;
    write("Failed to change the status", () =>
      bulkUpdateIssues({ issueIds: bulkIssueIds, patch: { statusId } }),
    );
  };
  const bulkPriority = (priority: IssuePriority) => {
    if (bulkIssueIds.length === 0) return;
    write("Failed to change the priority", () =>
      bulkUpdateIssues({ issueIds: bulkIssueIds, patch: { priority } }),
    );
  };
  // Per issue rather than one bulk patch: `patch.labelIds` replaces the array, so a single write
  // would give every selected issue whichever label set was computed first.
  const toggleLabelOn = (issues: ReadonlyArray<Issue>, labelId: IssueLabelId, add: boolean) => {
    for (const issue of issues) {
      const has = issue.labelIds.includes(labelId);
      if (has === add) continue;
      write("Failed to change the labels", () =>
        updateIssue({
          issueId: issue.id,
          patch: { labelIds: toggleIssueLabelIds(issue.labelIds, labelId) },
        }),
      );
    }
  };
  const bulkToggleLabel = (labelId: IssueLabelId, add: boolean) => {
    toggleLabelOn(selectedIssues, labelId, add);
  };

  /**
   * Soft deletes, so the toast can offer them back. The undo restores every issue the delete
   * actually took: a batch that half failed would otherwise resurrect rows that never left.
   */
  const deleteIssues = (issues: ReadonlyArray<Issue>) => {
    if (issues.length === 0) return;
    const first = issues[0];
    if (first === undefined) return;
    const title = issues.length === 1 ? `${first.key} deleted` : `${issues.length} issues deleted`;
    void (async () => {
      const deleted: Array<IssueId> = [];
      for (const issue of issues) {
        if (
          !reportIssueWriteFailure(
            "Failed to delete the issue",
            await deleteIssue({ issueId: issue.id }),
          )
        ) {
          deleted.push(issue.id);
        }
      }
      if (deleted.length === 0) return;
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title,
          description: "The change log keeps them, so this can be undone.",
          actionProps: {
            children: "Undo",
            onClick: () => {
              void (async () => {
                toastManager.close(toastId);
                for (const issueId of deleted) {
                  reportIssueWriteFailure(
                    "Failed to restore the issue",
                    await restoreIssue({ issueId }),
                  );
                }
              })();
            },
          },
        }),
      );
    })();
  };

  const bulkDelete = () => {
    deleteIssues(selectedIssues);
    setSelection(EMPTY_ISSUES_SELECTION);
  };

  // One write for both halves of a kanban drag: the contract carries `statusId` alongside the key
  // so a card never renders in the new column with the old neighbours, or the other way round.
  const moveBoardCard = (drop: IssuesBoardDrop) => {
    write("Failed to move the issue", () =>
      setIssueSortOrder({
        issueId: drop.issueId,
        sortOrder: drop.sortOrder,
        ...(drop.statusId === null ? {} : { statusId: drop.statusId }),
      }),
    );
  };

  // ── Right-click menu ─────────────────────────────────────────────────

  const contextIssues = contextMenu?.issues ?? NO_CONTEXT_ISSUES;
  const contextIssue = contextIssues.length === 1 ? (contextIssues[0] ?? null) : null;
  // Investigate needs a directory to read, so it is only offered for one issue at a time and only
  // once that issue's project has one. The reason is the tooltip on the disabled item.
  const investigateBlockReason = useMemo(() => {
    if (contextIssue === null) return null;
    const project =
      contextIssue.projectId === null
        ? null
        : (projects.find(
            (candidate) =>
              candidate.id === contextIssue.projectId &&
              candidate.environmentId === primaryEnvironmentId,
          ) ?? null);
    const block = issueInvestigateBlock({
      connected: storeStatus !== "disconnected",
      deleted: contextIssue.deletedAt !== null,
      projectId: contextIssue.projectId,
      workspaceRoot: project?.workspaceRoot,
      hasRunInFlight: investigatingIssueIds.has(contextIssue.id),
    });
    return block === null ? null : ISSUE_INVESTIGATE_BLOCK_REASONS[block];
  }, [contextIssue, investigatingIssueIds, primaryEnvironmentId, projects, storeStatus]);

  const { copyToClipboard: copyIssueField } = useCopyToClipboard<IssueContextMenuCopyField>({
    target: "issue",
    onCopy: (field) => {
      toastManager.add({
        type: "success",
        title: `${ISSUE_CONTEXT_MENU_COPY_LABELS[field]} copied`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Failed to copy", description: error.message }),
      );
    },
  });

  const handleRowContextMenu = (issue: Issue, event: MouseEvent) => {
    event.preventDefault();
    const targets = issueContextMenuIssues(issue, selectedIssues);
    // A right-click outside the selection moves the cursor onto the row under the pointer, so what
    // is highlighted and what the menu is about are the same rows. Inside it, the selection stands.
    if (targets.length === 1) {
      setSelection((current) =>
        selectIssueRow(current, { ids, issueId: issue.id, mode: "replace" }),
      );
    }
    setContextMenu({ issues: targets, x: event.clientX, y: event.clientY });
  };

  // The board has no selection model, so a card is always its own target.
  const handleCardContextMenu = (issue: Issue, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({ issues: [issue], x: event.clientX, y: event.clientY });
  };

  const applyContextPatch = (patch: IssuePatch, label: string) => {
    if (contextIssues.length === 0) return;
    const title = `Failed to change the ${label}`;
    if (contextIssue !== null) {
      write(title, () => updateIssue({ issueId: contextIssue.id, patch }));
      return;
    }
    const issueIds = contextIssues.map((issue) => issue.id);
    write(title, () => bulkUpdateIssues({ issueIds, patch }));
  };

  const copyContextField = (field: IssueContextMenuCopyField) => {
    if (contextIssues.length === 0) return;
    copyIssueField(issueContextMenuCopyValue(contextIssues, field, window.location.origin), field);
  };

  // The run reports into the sheet's investigation tab, so the sheet is what a press opens.
  const investigateContextIssue = (issue: Issue) => {
    openIssue(issue);
    write("Failed to start the investigation", () => startEnrichment({ issueId: issue.id }));
  };

  const openNewIssue = (statusId: IssueStatusId | null) => {
    setNewIssueStatusId(statusId);
    setNewIssueOpen(true);
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  };

  // Only a chip holding exactly one value seeds a create: a list filtered to three projects has no
  // opinion about which one a new issue belongs to.
  const soleProjectId = soleIssuesFilterValue(filter, "project") as ProjectId | null;
  const soleMilestoneId = soleIssuesFilterValue(filter, "milestone") as IssueMilestoneId | null;
  const soleCycleId = soleIssuesFilterValue(filter, "cycle") as IssueCycleId | null;
  // A milestone names its project, so a create started from a milestone-filtered list lands in
  // both — without which the create would drop the milestone as belonging to no project.
  const filteredMilestone =
    soleMilestoneId === null
      ? null
      : (milestones.find((milestone) => milestone.id === soleMilestoneId) ?? null);

  const clearFilter = () => setFilter(NO_ISSUES_LIST_FILTER);

  const renderItem = ({ item }: { item: IssuesListRowModel }) =>
    item.kind === "header" ? (
      <IssueGroupHeader onToggle={toggleGroup} row={item} />
    ) : (
      <IssueListRow
        active={selection.activeId === item.issue.id}
        childRollup={childRollups.get(item.issue.id) ?? null}
        investigating={investigatingIssueIds.has(item.issue.id)}
        issue={item.issue}
        assigneeLabel={issueAssigneeDisplayName(memberDirectory, item.issue.assignee)}
        labels={labels}
        labelsById={labelsById}
        onContextMenu={handleRowContextMenu}
        onOpen={openIssue}
        onPriority={setIssuePriority}
        onRowClick={handleRowClick}
        onStatus={setIssueStatus}
        onToggleLabel={toggleIssueLabel}
        parentTitle={
          item.issue.parentId === null
            ? null
            : (store.issuesById.get(item.issue.parentId)?.title ?? null)
        }
        projectTitle={
          item.issue.projectId === null ? null : (projectTitles.get(item.issue.projectId) ?? null)
        }
        selected={selection.ids.has(item.issue.id)}
        status={statusById.get(item.issue.statusId) ?? null}
        statuses={statuses}
        today={today}
      />
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
            <WorkspaceBreadcrumbItem current>Issues</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>

        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
          <div
            aria-label="Issue tabs"
            className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5"
            role="tablist"
          >
            {TABS.map((option) => {
              const active = option.value === tab;
              return (
                <button
                  aria-selected={active}
                  className={cn(
                    "h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={option.value}
                  onClick={() => onSearch({ tab: option.value })}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <span className="text-xs tabular-nums text-muted-foreground/70">
            {view.total} {view.total === 1 ? "issue" : "issues"}
          </span>

          <div className="ms-auto flex items-center gap-1">
            <IssuesViewOptions
              grouping={groupBy}
              onGrouping={(next) => onSearch({ group: next })}
              onSortMode={(next) => onSearch({ sort: next })}
              sortMode={sortMode}
              viewMode={viewMode}
            />
            {/* The mode rides in the URL so a saved view can capture it, and the default is
                written as an absent param rather than `view=list`. */}
            <div
              aria-label="View mode"
              className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5"
              role="group"
            >
              <Button
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                className={cn(viewMode === "list" && "bg-accent")}
                onClick={() => onSearch({ view: undefined })}
                size="icon-xs"
                variant="ghost"
              >
                <Rows3Icon />
              </Button>
              <Button
                aria-label="Board view"
                aria-pressed={viewMode === "board"}
                className={cn(viewMode === "board" && "bg-accent")}
                onClick={() => onSearch({ view: "board" })}
                size="icon-xs"
                variant="ghost"
              >
                <ColumnsIcon />
              </Button>
            </div>
            <Button onClick={() => openNewIssue(null)} size="xs" variant="outline">
              <PlusIcon />
              New issue
            </Button>
          </div>
        </div>

        <IssuesFilterBar
          actions={
            <SaveIssueViewControl
              currentMembershipId={memberDirectory.currentMembershipId}
              search={search}
            />
          }
          assigneeOptions={assigneeFilterOptions}
          className="border-b border-border/50 px-3 py-1.5 sm:px-5"
          cycles={cycles}
          filter={effectiveFilter}
          labels={labels}
          milestones={milestones}
          onChange={setFilter}
          projects={projects}
          statuses={statuses}
        />

        <div className="relative min-h-0 flex-1">
          {storeStatus === "disconnected" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListTodoIcon />
                </EmptyMedia>
                <EmptyTitle>No environment connected</EmptyTitle>
                <EmptyDescription>
                  The tracker lives on the machine you are connected to. Connect one to see its
                  issues.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : storeStatus === "loading" && statuses.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : store.issuesById.size === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListTodoIcon />
                </EmptyMedia>
                <EmptyTitle>No issues yet</EmptyTitle>
                <EmptyDescription>
                  Create the first one, or bring a whole tracker across with a CSV.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <div className="flex items-center gap-2">
                  <Button onClick={() => openNewIssue(null)} size="sm">
                    <PlusIcon />
                    New issue
                  </Button>
                  <Button
                    render={<Link to="/settings/issues-import" />}
                    size="sm"
                    variant="outline"
                  >
                    Import from CSV
                  </Button>
                </div>
              </EmptyContent>
            </Empty>
          ) : view.total === 0 || (viewMode === "list" && rows.length === 0) ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>Nothing here</EmptyTitle>
                <EmptyDescription>
                  {filterActive
                    ? "No issue in this tab matches every filter."
                    : tab === "active"
                      ? "Nothing is started or waiting to start."
                      : "This tab is empty."}
                </EmptyDescription>
              </EmptyHeader>
              {!filterActive ? null : (
                <EmptyContent>
                  <Button onClick={clearFilter} size="sm" variant="outline">
                    Clear filters
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : viewMode === "board" ? (
            <IssuesBoard
              assigneeNames={memberDirectory.names}
              childRollups={childRollups}
              columns={boardColumns}
              investigatingIssueIds={investigatingIssueIds}
              labelsById={labelsById}
              onContextMenuIssue={handleCardContextMenu}
              onMove={moveBoardCard}
              onNewIssue={openNewIssue}
              onOpenIssue={openIssue}
              // The order the columns were actually built in, which is the only order a drag can
              // write a key into.
              sortMode={view.sortMode}
              today={today}
            />
          ) : (
            <LegendList<IssuesListRowModel>
              aria-label="Issues"
              className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
              data={rows}
              estimatedItemSize={ESTIMATED_ROW_HEIGHT}
              getItemType={getItemType}
              keyExtractor={keyExtractor}
              ref={listRef}
              renderItem={renderItem}
              role="listbox"
            />
          )}

          {selectedIssues.length > 1 ? (
            <IssuesBulkBar
              issues={selectedIssues}
              labels={labels}
              onClear={() => setSelection(EMPTY_ISSUES_SELECTION)}
              onDelete={bulkDelete}
              onPriority={bulkPriority}
              onStatus={bulkStatus}
              onToggleLabel={bulkToggleLabel}
              statuses={statuses}
            />
          ) : null}
        </div>
      </div>

      <NewIssueDialog
        defaultCycleId={soleCycleId}
        defaultMilestoneId={soleMilestoneId}
        defaultProjectId={soleProjectId ?? filteredMilestone?.projectId ?? null}
        // A board column's `+` names its own status. Otherwise: grouped by anything but status the
        // first group names no status, so the tab's first status stands in — which is what it was
        // before any grouping existed.
        defaultStatusId={newIssueStatusId ?? view.groups[0]?.status?.id ?? statuses[0]?.id ?? null}
        labels={labels}
        onOpenChange={(open) => {
          setNewIssueOpen(open);
          if (!open) setNewIssueStatusId(null);
        }}
        open={newIssueOpen}
        projects={projects}
        statuses={statuses}
      />

      <IssueContextMenu
        cycles={cycles}
        investigateBlockReason={investigateBlockReason}
        labels={labels}
        milestones={milestones}
        onClose={() => setContextMenu(null)}
        onCopy={copyContextField}
        onDelete={() => deleteIssues(contextIssues)}
        onInvestigate={investigateContextIssue}
        onOpen={openIssue}
        onPatch={applyContextPatch}
        onToggleLabel={(labelId, add) => toggleLabelOn(contextIssues, labelId, add)}
        projects={projects}
        statuses={statuses}
        target={contextMenu}
        today={today}
      />

      <IssueDetailSheet
        issueKey={detailIssueKey}
        onClose={closeDetail}
        onOpenIssueKey={(key) => onSearch({ issue: key })}
      />
    </SidebarInset>
  );
}

function keyExtractor(item: IssuesListRowModel) {
  return item.id;
}

function getItemType(item: IssuesListRowModel) {
  return item.kind;
}
