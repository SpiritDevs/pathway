/**
 * The `/issues` list view — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Grouped by status, virtualized, keyboard-driven. Everything the view decides that does not need
 * the DOM lives in `issuesList.logic.ts`; this file is the wiring: atoms in, mutations out, one
 * `LegendList` in the middle.
 *
 * @module components/issues/IssuesListPage
 */
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { threadIsVisibleAt } from "@t3tools/contracts";
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
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ColumnsIcon, ListTodoIcon, PanelRightIcon, PlusIcon, Rows3Icon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useProjects, useThreadShells } from "~/state/entities";
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
import { Toggle } from "../ui/toggle";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { IssueContextMenu, type IssueContextMenuTarget } from "./IssueContextMenu";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { DraggableIssueListRow, IssueGroupHeader, IssueListRow } from "./IssueListRow";
import { IssuesBoard } from "./IssuesBoard";
import { IssuesBulkBar } from "./IssuesBulkBar";
import { IssuesAssistantPanel, type IssuesAssistantTab } from "./IssuesAssistantPanel";
import { upsertIssuesAssistantIssueTab } from "./issuesAssistantPanel.logic";
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
import { issueAssigneeOptions } from "./issueDetail.logic";
import { ISSUE_INVESTIGATE_BLOCK_REASONS, issueInvestigateBlock } from "./issueEnrichment.logic";
import { buildIssuesTalkContexts, issueTalkHostProjectId } from "./issueStartWork.logic";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  EMPTY_ISSUES_BOARD_COLUMNS,
  issuesBoardColumns,
  type IssuesBoardDrop,
} from "./issuesBoard.logic";
import {
  DEFAULT_ISSUES_TAB,
  EMPTY_ISSUES_SELECTION,
  activateIssueRow,
  buildIssuesListRows,
  buildIssuesView,
  effectiveIssuesGrouping,
  findIssueRowIndex,
  indexIssueLabels,
  NO_ISSUES_LIST_FILTER,
  isIssuesListFilterActive,
  issueIdsInRows,
  issuesFilterSearchPatch,
  issuesSearchFilter,
  issuesSearchGrouping,
  issuesSearchSortMode,
  issuesSearchViewMode,
  pruneIssuesSelection,
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
import {
  findIssuesListIssue,
  isIssuesListSortable,
  issuesListDropEdge,
  issuesListRowDragId,
  parseIssuesListDragId,
  resolveIssuesListDrop,
  type IssuesListDrop,
} from "./issuesListDnd.logic";

const TABS: ReadonlyArray<{ readonly value: IssuesTab; readonly label: string }> = [
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
  { value: "all", label: "All" },
];

/** A header is 32px and a row 36px; the list is dense enough that one estimate covers both. */
const ESTIMATED_ROW_HEIGHT = 36;

/**
 * The driver list is a module constant, so the options built from it can be one too. Unassigned is
 * dropped: it is a real value for the assignee *editor* and not a value a filter chip can hold.
 */
const ASSIGNEE_FILTER_OPTIONS = issueAssigneeOptions(PROVIDER_CLIENT_DEFINITIONS).flatMap(
  (option) =>
    option.assignee === null
      ? []
      : [{ value: option.value, label: option.label, assignee: option.assignee }],
);

const ASSIGNEE_GROUP_LABELS = new Map(
  ASSIGNEE_FILTER_OPTIONS.map((option) => [option.value, option.label]),
);

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
  const tab = search.tab ?? DEFAULT_ISSUES_TAB;
  const store = useIssuesStore();
  const storeStatus = useIssuesStoreStatus();
  const statuses = useIssueStatuses();
  const labels = useIssueLabels();
  const projects = useProjects();
  const threads = useThreadShells();
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
  const openNewThread = useNewThreadHandler();

  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<IssuesSelection>(EMPTY_ISSUES_SELECTION);
  const [bulkSelectionActive, setBulkSelectionActive] = useState(false);
  /** The right-click menu's target, or null while it is shut. One menu for every row and card. */
  const [contextMenu, setContextMenu] = useState<IssueContextMenuTarget | null>(null);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [assistantTabs, setAssistantTabs] = useState<ReadonlyArray<IssuesAssistantTab>>([]);
  const [closedAssistantThreadIds, setClosedAssistantThreadIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const [activeAssistantTabId, setActiveAssistantTabId] = useState<string | null>(null);
  const [assistantPanelOpen, setAssistantPanelOpen] = useState(false);
  const [issuesPreviewThreadId] = useState<ThreadId>(newThreadId);
  const [assistantDraftPending, setAssistantDraftPending] = useState(false);
  /** Set by a column's `+`, which is the only path that names a status the filter did not. */
  const [newIssueStatusId, setNewIssueStatusId] = useState<IssueStatusId | null>(null);
  const [activeListIssueId, setActiveListIssueId] = useState<IssueId | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const scrollToActiveRef = useRef(false);
  const listDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const issuesPreviewThreadRef = useMemo(
    () =>
      primaryEnvironmentId === null
        ? null
        : scopeThreadRef(primaryEnvironmentId, issuesPreviewThreadId),
    [issuesPreviewThreadId, primaryEnvironmentId],
  );
  useEffect(() => {
    const issueThreads = threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        threadIsVisibleAt(thread, "issues") &&
        !closedAssistantThreadIds.has(thread.id),
    );
    setAssistantTabs((current) => {
      const eligibleThreadIds = new Set(issueThreads.map((thread) => thread.id));
      let changed = current.some(
        (tab) => tab.kind === "thread" && !eligibleThreadIds.has(tab.threadId),
      );
      const next = current.filter(
        (tab) => tab.kind !== "thread" || eligibleThreadIds.has(tab.threadId),
      );
      for (const thread of issueThreads) {
        const id = `thread:${thread.id}` as const;
        const index = next.findIndex((tab) => tab.id === id);
        const tab = {
          id,
          kind: "thread",
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title,
        } as const satisfies IssuesAssistantTab;
        if (index < 0) {
          next.push(tab);
          changed = true;
        } else if (
          next[index]?.kind === "draft" ||
          (next[index]?.kind === "thread" &&
            (next[index].title !== tab.title || next[index].environmentId !== tab.environmentId))
        ) {
          next[index] = tab;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [closedAssistantThreadIds, threads]);
  const filter = useMemo(() => issuesSearchFilter(search), [search]);
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
        filter,
        today,
        groupBy,
        sortMode,
        projectTitles,
        assigneeLabels: ASSIGNEE_GROUP_LABELS,
      }),
    [filter, groupBy, grouping, projectTitles, sortMode, today],
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
  const listSortable = viewMode === "list" && isIssuesListSortable(view);
  const listExtraData = useMemo(
    () => ({ selectionIds: selection.ids, sortable: listSortable }),
    [listSortable, selection.ids],
  );
  const listDragItems = useMemo(
    () => rows.flatMap((row) => (row.kind === "issue" ? [issuesListRowDragId(row.issue.id)] : [])),
    [rows],
  );
  const activeListIssue =
    activeListIssueId === null ? null : findIssuesListIssue(view, activeListIssueId);
  const ids = useMemo(() => issueIdsInRows(rows), [rows]);
  const filterActive = isIssuesListFilterActive(filter);
  const setFilter = (next: IssuesListFilter) => onSearch(issuesFilterSearchPatch(next));
  // One pass over the tracker rather than one per row: a parent's `3/9` is a scan of every issue's
  // `parentId`, and doing that inside `renderItem` would make the virtualized list quadratic.
  const childRollups = useMemo(() => issueChildRollups(store), [store]);
  // One subscription for the whole list. The set only changes identity when its membership does,
  // so a transcript arriving four times a second re-renders nothing.
  const investigatingIssueIds = useInvestigatingIssueIds();
  const investigationProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.environmentId === primaryEnvironmentId && project.workspaceRoot != null,
      ),
    [primaryEnvironmentId, projects],
  );

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
      current.activeId === null ? activateIssueRow(current, detailIssue.id) : current,
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
    if (action._tag === "new") {
      setNewIssueStatusId(null);
      setNewIssueOpen(true);
      return;
    }
    if (action._tag === "clear") {
      setSelection(EMPTY_ISSUES_SELECTION);
      setBulkSelectionActive(false);
      return;
    }
    if (action._tag === "open") {
      const issue = store.issuesById.get(action.issueId);
      if (issue !== undefined) openIssue(issue);
      return;
    }
    scrollToActiveRef.current = true;
    setSelection((current) => activateIssueRow(current, action.issueId));
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

  const handleRowClick = (issue: Issue, _event: MouseEvent) => {
    setSelection((current) => activateIssueRow(current, issue.id));
    openIssue(issue);
  };

  const handleRowSelected = (issue: Issue, selected: boolean) => {
    setBulkSelectionActive(true);
    setSelection((current) => {
      if (current.ids.has(issue.id) === selected) return current;
      return selectIssueRow(current, { ids, issueId: issue.id, mode: "toggle" });
    });
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
    setBulkSelectionActive(false);
  };

  const bulkInvestigateDisabledReason =
    storeStatus === "disconnected"
      ? ISSUE_INVESTIGATE_BLOCK_REASONS.disconnected
      : investigationProjects.length === 0
        ? "Connect a workspace to a project before investigating."
        : selectedIssues.every(
              (issue) => issue.deletedAt !== null || investigatingIssueIds.has(issue.id),
            )
          ? "Every selected issue is deleted or already being investigated."
          : null;

  const bulkInvestigate = (projectId: ProjectId) => {
    void (async () => {
      for (const issue of selectedIssues) {
        if (issue.deletedAt !== null || investigatingIssueIds.has(issue.id)) continue;
        if (issue.projectId !== projectId) {
          const assignmentFailed = reportIssueWriteFailure(
            `Failed to assign ${issue.key} to the project`,
            await updateIssue({ issueId: issue.id, patch: { projectId } }),
          );
          if (assignmentFailed) continue;
        }
        reportIssueWriteFailure(
          `Failed to investigate ${issue.key}`,
          await startEnrichment({ issueId: issue.id }),
        );
      }
    })();
  };

  const bulkAskDisabledReason =
    storeStatus === "disconnected"
      ? ISSUE_INVESTIGATE_BLOCK_REASONS.disconnected
      : investigationProjects.length === 0
        ? "Connect a workspace to a project before asking AI about these issues."
        : assistantDraftPending
          ? "The discussion is being prepared."
          : null;

  const bulkAsk = () => {
    if (assistantDraftPending || primaryEnvironmentId === null) return;
    const issues = [...selectedIssues];
    if (issues.length === 0) return;
    const hostProjectId = issueTalkHostProjectId(
      issues,
      investigationProjects.map((project) => project.id),
    );
    const project = investigationProjects.find((candidate) => candidate.id === hostProjectId);
    if (project === undefined) return;
    setAssistantDraftPending(true);
    void (async () => {
      try {
        const opened = await openNewThread(scopeProjectRef(project.environmentId, project.id), {
          branch: null,
          envMode: "local",
          forceNew: true,
          locations: ["issues"],
          navigate: false,
          startFromOrigin: false,
          worktreePath: null,
        });
        if (opened === null) throw new Error("The issue discussion draft could not be created.");
        useComposerDraftStore
          .getState()
          .setIssueContexts(
            opened.draftId,
            buildIssuesTalkContexts(issues, window.location.origin),
          );
        const title =
          issues.length === 1
            ? (issues[0]?.key ?? "Issue discussion")
            : issues.length === 2
              ? issues.map((issue) => issue.key).join(" + ")
              : `${issues.length} issues`;
        const assistantTab = {
          id: `thread:${opened.threadId}`,
          kind: "draft",
          draftId: opened.draftId,
          environmentId: project.environmentId,
          threadId: opened.threadId,
          title,
        } as const satisfies IssuesAssistantTab;
        setClosedAssistantThreadIds((current) => {
          if (!current.has(opened.threadId)) return current;
          const next = new Set(current);
          next.delete(opened.threadId);
          return next;
        });
        setAssistantTabs((current) => [...current, assistantTab]);
        setActiveAssistantTabId(assistantTab.id);
        setAssistantPanelOpen(true);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to start the issue discussion",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setAssistantDraftPending(false);
      }
    })();
  };

  const addAssistantSideChat = async (): Promise<string | null> => {
    if (assistantDraftPending) return null;
    const project = investigationProjects[0];
    if (project === undefined) return null;
    setAssistantDraftPending(true);
    try {
      const opened = await openNewThread(scopeProjectRef(project.environmentId, project.id), {
        branch: null,
        envMode: "local",
        forceNew: true,
        locations: ["issues"],
        navigate: false,
        startFromOrigin: false,
        worktreePath: null,
      });
      if (opened === null) throw new Error("The issue side chat draft could not be created.");
      const tab = {
        id: `thread:${opened.threadId}`,
        kind: "draft",
        draftId: opened.draftId,
        environmentId: project.environmentId,
        threadId: opened.threadId,
        title: "Side chat",
      } as const satisfies IssuesAssistantTab;
      setClosedAssistantThreadIds((current) => {
        if (!current.has(opened.threadId)) return current;
        const next = new Set(current);
        next.delete(opened.threadId);
        return next;
      });
      setAssistantTabs((current) => [...current, tab]);
      setActiveAssistantTabId(tab.id);
      setAssistantPanelOpen(true);
      return tab.id;
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to start the issue side chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return null;
    } finally {
      setAssistantDraftPending(false);
    }
  };

  const closeAssistantTab = (tabId: string) => {
    setAssistantTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      const closing = current[index];
      if (closing?.kind === "draft" || closing?.kind === "thread") {
        setClosedAssistantThreadIds((closed) => new Set([...closed, closing.threadId]));
      }
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveAssistantTabId((active) =>
        active !== tabId ? active : (next[Math.min(index, next.length - 1)]?.id ?? null),
      );
      return next;
    });
  };

  const openAssistantIssue = (issueKey: string, contextTitle?: string) => {
    const liveIssue = Array.from(store.issuesById.values()).find((issue) => issue.key === issueKey);
    const title = contextTitle?.trim() || liveIssue?.title || issueKey;
    const id = `issue:${issueKey}` as const;
    setAssistantTabs((current) => upsertIssuesAssistantIssueTab(current, issueKey, title));
    setActiveAssistantTabId(id);
    setAssistantPanelOpen(true);
  };

  // One write for both halves of a manual-order drag: the contract carries `statusId` alongside
  // the key so a row never renders in the new group with the old neighbours, or the other way round.
  const moveIssueByDrop = (drop: IssuesBoardDrop | IssuesListDrop) => {
    write("Failed to move the issue", () =>
      setIssueSortOrder({
        issueId: drop.issueId,
        sortOrder: drop.sortOrder,
        ...(drop.statusId === null ? {} : { statusId: drop.statusId }),
      }),
    );
  };

  const handleListDragStart = (event: DragStartEvent) => {
    const active = parseIssuesListDragId(String(event.active.id));
    setActiveListIssueId(active !== null && active.kind === "row" ? active.issueId : null);
  };

  const handleListDragEnd = (event: DragEndEvent) => {
    setActiveListIssueId(null);
    const over = event.over;
    if (over === null) return;
    const translated = event.active.rect.current.translated ?? null;
    const drop = resolveIssuesListDrop({
      view,
      activeId: String(event.active.id),
      overId: String(over.id),
      edge: issuesListDropEdge({
        activeCenterY: translated === null ? null : translated.top + translated.height / 2,
        overTop: over.rect.top,
        overHeight: over.rect.height,
      }),
    });
    if (drop !== null) moveIssueByDrop(drop);
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
      setBulkSelectionActive(false);
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
      <IssueGroupHeader onToggle={toggleGroup} row={item} sortable={listSortable} />
    ) : (
      <DraggableIssueListRow
        active={selection.activeId === item.issue.id}
        childRollup={childRollups.get(item.issue.id) ?? null}
        investigating={investigatingIssueIds.has(item.issue.id)}
        issue={item.issue}
        labels={labels}
        labelsById={labelsById}
        onContextMenu={handleRowContextMenu}
        onOpen={openIssue}
        onPriority={setIssuePriority}
        onRowClick={handleRowClick}
        onSelectedChange={handleRowSelected}
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
        sortable={listSortable}
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
            <Toggle
              aria-label="Toggle issues sidebar"
              onPressedChange={setAssistantPanelOpen}
              pressed={assistantPanelOpen}
              size="sm"
              variant="ghost"
            >
              <PanelRightIcon className="size-3.5" />
            </Toggle>
            <Button onClick={() => openNewIssue(null)} size="xs" variant="outline">
              <PlusIcon />
              New issue
            </Button>
          </div>
        </div>

        <IssuesFilterBar
          actions={<SaveIssueViewControl search={search} />}
          assigneeOptions={ASSIGNEE_FILTER_OPTIONS}
          className="border-b border-border/50 px-3 py-1.5 sm:px-5"
          cycles={cycles}
          filter={filter}
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
              childRollups={childRollups}
              columns={boardColumns}
              investigatingIssueIds={investigatingIssueIds}
              labelsById={labelsById}
              onContextMenuIssue={handleCardContextMenu}
              onMove={moveIssueByDrop}
              onNewIssue={openNewIssue}
              onOpenIssue={openIssue}
              // The order the columns were actually built in, which is the only order a drag can
              // write a key into.
              sortMode={view.sortMode}
              today={today}
            />
          ) : (
            <DndContext
              collisionDetection={closestCenter}
              onDragCancel={() => setActiveListIssueId(null)}
              onDragEnd={handleListDragEnd}
              onDragStart={handleListDragStart}
              sensors={listDragSensors}
            >
              <SortableContext items={listDragItems} strategy={verticalListSortingStrategy}>
                <LegendList<IssuesListRowModel>
                  aria-label="Issues"
                  className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
                  data={rows}
                  estimatedItemSize={ESTIMATED_ROW_HEIGHT}
                  extraData={listExtraData}
                  getItemType={getItemType}
                  keyExtractor={keyExtractor}
                  ref={listRef}
                  renderItem={renderItem}
                  role="listbox"
                />
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeListIssue === null ? null : (
                  <IssueListRow
                    active={false}
                    childRollup={childRollups.get(activeListIssue.id) ?? null}
                    dragging
                    investigating={investigatingIssueIds.has(activeListIssue.id)}
                    issue={activeListIssue}
                    labels={labels}
                    labelsById={labelsById}
                    onOpen={() => {}}
                    onPriority={() => {}}
                    onRowClick={() => {}}
                    onStatus={() => {}}
                    onToggleLabel={() => {}}
                    parentTitle={
                      activeListIssue.parentId === null
                        ? null
                        : (store.issuesById.get(activeListIssue.parentId)?.title ?? null)
                    }
                    projectTitle={
                      activeListIssue.projectId === null
                        ? null
                        : (projectTitles.get(activeListIssue.projectId) ?? null)
                    }
                    selected={false}
                    status={statusById.get(activeListIssue.statusId) ?? null}
                    statuses={statuses}
                    today={today}
                  />
                )}
              </DragOverlay>
            </DndContext>
          )}

          {bulkSelectionActive && selectedIssues.length > 0 ? (
            <IssuesBulkBar
              askDisabledReason={bulkAskDisabledReason}
              issues={selectedIssues}
              labels={labels}
              onAsk={bulkAsk}
              onClear={() => {
                setSelection(EMPTY_ISSUES_SELECTION);
                setBulkSelectionActive(false);
              }}
              onDelete={bulkDelete}
              onInvestigate={bulkInvestigate}
              onPriority={bulkPriority}
              onStatus={bulkStatus}
              onToggleLabel={bulkToggleLabel}
              investigateDisabledReason={bulkInvestigateDisabledReason}
              projects={investigationProjects}
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

      <IssuesAssistantPanel
        activeTabId={activeAssistantTabId}
        onAddSideChat={addAssistantSideChat}
        tabs={assistantTabs}
        open={assistantPanelOpen}
        panelThreadRef={issuesPreviewThreadRef}
        sideChatAvailable={investigationProjects.length > 0 && !assistantDraftPending}
        onActivate={setActiveAssistantTabId}
        onClose={closeAssistantTab}
        onCloseAll={() => {
          setClosedAssistantThreadIds(
            (closed) =>
              new Set([
                ...closed,
                ...assistantTabs.flatMap((tab) =>
                  tab.kind === "draft" || tab.kind === "thread" ? [tab.threadId] : [],
                ),
              ]),
          );
          setAssistantTabs([]);
          setActiveAssistantTabId(null);
        }}
        onCloseOthers={(tabId) => {
          setClosedAssistantThreadIds(
            (closed) =>
              new Set([
                ...closed,
                ...assistantTabs.flatMap((tab) =>
                  tab.id !== tabId && (tab.kind === "draft" || tab.kind === "thread")
                    ? [tab.threadId]
                    : [],
                ),
              ]),
          );
          setAssistantTabs((current) => current.filter((tab) => tab.id === tabId));
          setActiveAssistantTabId(tabId);
        }}
        onCloseToRight={(tabId) => {
          setAssistantTabs((current) => {
            const index = current.findIndex((tab) => tab.id === tabId);
            if (index >= 0) {
              setClosedAssistantThreadIds(
                (closed) =>
                  new Set([
                    ...closed,
                    ...current
                      .slice(index + 1)
                      .flatMap((tab) =>
                        tab.kind === "draft" || tab.kind === "thread" ? [tab.threadId] : [],
                      ),
                  ]),
              );
            }
            return index < 0 ? current : current.slice(0, index + 1);
          });
          setActiveAssistantTabId(tabId);
        }}
        onOpenChange={setAssistantPanelOpen}
        onOpenIssue={openAssistantIssue}
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
