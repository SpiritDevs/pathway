/**
 * The `/issues` secondary sidebar: triage count, My issues, cycles, projects (expanding to
 * milestones), saved views, labels.
 *
 * Navigation is filter state, not routes — every row writes the same `/issues` search params the
 * list reads, so the tab and the open detail sheet survive a filter change. A saved view is the
 * same idea with a name on it: applying one writes the params its config spells out, and the row
 * lights up again whenever the params say what it says.
 *
 * Milestones are the exception: they have pages of their own, so those rows are links, and what
 * lights one up is the path rather than the params.
 *
 * @module components/issues/IssuesSidebar
 */
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import type { IssueCycleId, IssueMilestoneId, IssueView } from "@spiritdevs/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  ChevronRightIcon,
  FlagIcon,
  FolderIcon,
  InboxIcon,
  MilestoneIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  issueCyclesByStatus,
  todayIssueDate,
  useDeleteIssueView,
  useIssueCycles,
  useIssueLabels,
  useIssueMilestoneProgress,
  useIssueMilestones,
  useIssueViews,
  useIssuesStore,
  useReorderIssueViews,
  useTriageCount,
  useUpdateIssueView,
} from "~/state/issues";
import { duplicateNameError } from "../settings/issues/issuesSettings.logic";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";
import { IssueLabelDot, IssueProgressRing } from "./IssueGlyphs";
import { NewCycleDialog } from "./NewCycleDialog";
import {
  ISSUE_ASSIGNEE_MEMBER_PREFIX,
  ISSUE_ASSIGNEE_USER_VALUE,
  NO_ISSUES_LIST_FILTER,
  applyIssuesFilter,
  countIssuesByCycle,
  formatIssueDateRange,
  isIssuesListFilterActive,
  issuesFilterHasValue,
  issuesFilterSearchPatch,
  issuesSearchFilter,
  parseIssuesSearch,
  type IssuesFilterField,
  type IssuesSearchPatch,
} from "./issuesList.logic";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  findIssueViewForConfig,
  issueViewSearchPatch,
  issuesSearchViewConfig,
  moveIssueViewOrder,
  summarizeIssueViewConfig,
} from "./issuesViews.logic";
import { isMilestonesPathname, milestoneIdInPathname } from "./milestonesOverview.logic";
import { useIssueMemberDirectory } from "./issueMemberDirectory";

/** A stable empty array: the milestone rows are memo-free, but a fresh `[]` per render is noise. */
const NO_MILESTONE_IDS: ReadonlyArray<string> = [];

export function IssuesSidebar() {
  const memberDirectory = useIssueMemberDirectory();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const rawSearch = useLocation({ select: (location) => location.search });
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = parseIssuesSearch(rawSearch as Record<string, unknown>);
  const onIssues = pathname === "/issues";
  const triageCount = useTriageCount();
  const projects = useProjects();
  const labels = useIssueLabels();
  const store = useIssuesStore();
  const cycles = useIssueCycles();
  const milestones = useIssueMilestones();
  const milestoneProgress = useIssueMilestoneProgress();
  const views = useIssueViews();
  const deleteView = useDeleteIssueView();
  const reorderViews = useReorderIssueViews();

  const [newCycleOpen, setNewCycleOpen] = useState(false);
  const [showEndedCycles, setShowEndedCycles] = useState(false);
  const [renamingView, setRenamingView] = useState<IssueView | null>(null);
  const [pendingDeleteView, setPendingDeleteView] = useState<IssueView | null>(null);

  // Today is read when the cycles change rather than tracked: nothing in a sidebar is worth a
  // midnight timer, and a reconnect or any diff re-reads it.
  const byStatus = useMemo(() => issueCyclesByStatus(cycles, todayIssueDate()), [cycles]);
  const cycleCounts = useMemo(() => countIssuesByCycle(store), [store]);
  const today = useMemo(() => todayIssueDate(), []);

  const filter = issuesSearchFilter(search);
  const currentMemberAssigneeValue =
    memberDirectory.currentMembershipId === null
      ? null
      : `${ISSUE_ASSIGNEE_MEMBER_PREFIX}${memberDirectory.currentMembershipId}`;

  /**
   * `triage` is cleared unless the patch names it: every row here is a lens on the *list*, and
   * landing on one while the triage queue is up should leave the queue rather than filter it —
   * triage items match no status, project, or cycle chip by construction.
   */
  const navigateWith = (patch: IssuesSearchPatch) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/issues",
      replace: true,
      search: { ...search, triage: undefined, ...patch },
    });
  };

  /** A milestone page is its own route, so leaving the list is a navigation rather than a patch. */
  const navigateToMilestone = (milestoneId: IssueMilestoneId | null) => {
    if (isMobile) setOpenMobile(false);
    void (milestoneId === null
      ? navigate({ to: "/issues/milestones" })
      : navigate({ to: "/issues/milestones/$milestoneId", params: { milestoneId } }));
  };

  const onMilestones = isMilestonesPathname(pathname);
  const openMilestoneId = milestoneIdInPathname(pathname);
  const openMilestoneIds = useMemo(
    () => (openMilestoneId === null ? NO_MILESTONE_IDS : [openMilestoneId]),
    [openMilestoneId],
  );

  const onTriage = onIssues && search.triage === true;

  /**
   * A row sets its own field to the one value it names and leaves every other chip alone. Stage 2
   * cleared the others instead — intersecting two sidebar rows looked like a bug before the chip
   * bar existed to show what was intersecting.
   */
  const applyFilter = (field: IssuesFilterField, value: string) => {
    navigateWith(issuesFilterSearchPatch(applyIssuesFilter(filter, field, value)));
  };

  const clearFilters = () => navigateWith(issuesFilterSearchPatch(NO_ISSUES_LIST_FILTER));

  const noFilter = !isIssuesListFilterActive(filter);

  // Which row lights up is a question about the params, not about what was last pressed: edit one
  // chip on an applied view and it stops being that view, which is what the sidebar should say.
  const activeView =
    onIssues && !onTriage
      ? findIssueViewForConfig(
          views,
          issuesSearchViewConfig(search, memberDirectory.currentMembershipId),
          memberDirectory.currentMembershipId,
        )
      : null;

  const writeView = (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    void (async () => {
      reportIssueWriteFailure(title, await run());
    })();
  };

  const moveView = (view: IssueView, direction: "up" | "down") => {
    const viewIds = moveIssueViewOrder(views, view.id, direction);
    if (viewIds === null) return;
    writeView("Failed to reorder the views", () => reorderViews({ viewIds }));
  };

  const cycleRow = (cycleId: IssueCycleId, name: string, range: string) => (
    <SidebarMenuItem key={cycleId}>
      <SidebarMenuButton
        isActive={onIssues && issuesFilterHasValue(filter, "cycle", cycleId)}
        onClick={() => applyFilter("cycle", cycleId)}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{name}</span>
          <span className="truncate text-[11px] tabular-nums text-sidebar-muted-foreground">
            {range}
          </span>
        </span>
        {(cycleCounts.get(cycleId) ?? 0) > 0 ? (
          <SidebarMenuBadge>{cycleCounts.get(cycleId)}</SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <>
      <ContextualSidebarHeader title="Issues" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={onIssues && !onTriage && noFilter}
                onClick={clearFilters}
              >
                <InboxIcon />
                <span>All issues</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  onIssues &&
                  !onTriage &&
                  (issuesFilterHasValue(filter, "assignee", ISSUE_ASSIGNEE_USER_VALUE) ||
                    (currentMemberAssigneeValue !== null &&
                      issuesFilterHasValue(filter, "assignee", currentMemberAssigneeValue)))
                }
                onClick={() => applyFilter("assignee", ISSUE_ASSIGNEE_USER_VALUE)}
              >
                <UserIcon />
                <span>My issues</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* Triage is state outside the workflow, so it is a mode rather than a tab: it takes
                none of the filters the rows above it set, which is why it clears them. */}
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={onTriage}
                onClick={() =>
                  navigateWith({
                    ...issuesFilterSearchPatch(NO_ISSUES_LIST_FILTER),
                    triage: true,
                    tab: undefined,
                    view: undefined,
                  })
                }
              >
                <InboxIcon />
                <span>Triage</span>
                {triageCount > 0 ? <SidebarMenuBadge>{triageCount}</SidebarMenuBadge> : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* A page rather than a filter: milestones are planning, and the thing you do with a
                plan is look at all of it at once. */}
            <SidebarMenuItem>
              <SidebarMenuButton isActive={onMilestones} onClick={() => navigateToMilestone(null)}>
                <MilestoneIcon />
                <span>Milestones</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Cycles</SidebarGroupLabel>
          <SidebarGroupAction
            aria-label="New cycle"
            onClick={() => setNewCycleOpen(true)}
            title="New cycle"
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarMenu>
            {cycles.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">
                No cycles yet. A cycle is a named date range spanning every project.
              </p>
            ) : (
              <>
                {byStatus.active.map((cycle) =>
                  cycleRow(
                    cycle.id,
                    cycle.name,
                    formatIssueDateRange(cycle.startDate, cycle.endDate, today),
                  ),
                )}
                {byStatus.upcoming.map((cycle) =>
                  cycleRow(
                    cycle.id,
                    cycle.name,
                    formatIssueDateRange(cycle.startDate, cycle.endDate, today),
                  ),
                )}
                {byStatus.ended.length === 0 ? null : showEndedCycles ? (
                  byStatus.ended.map((cycle) =>
                    cycleRow(
                      cycle.id,
                      cycle.name,
                      formatIssueDateRange(cycle.startDate, cycle.endDate, today),
                    ),
                  )
                ) : (
                  <SidebarMenuItem>
                    <button
                      className="w-full rounded-md px-2 py-1 text-start text-xs text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setShowEndedCycles(true)}
                      type="button"
                    >
                      Show {byStatus.ended.length} ended
                    </button>
                  </SidebarMenuItem>
                )}
              </>
            )}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarMenu>
            {projects.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">
                No projects yet.
              </p>
            ) : (
              projects.map((project) => (
                <ProjectRow
                  isActive={onIssues && issuesFilterHasValue(filter, "project", project.id)}
                  key={project.id}
                  milestones={milestones.filter((milestone) => milestone.projectId === project.id)}
                  milestoneProgress={milestoneProgress}
                  onSelectMilestone={navigateToMilestone}
                  onSelectProject={() => applyFilter("project", project.id)}
                  selectedMilestoneIds={openMilestoneIds}
                  title={project.title}
                />
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>

        {/* No empty state: a view is made from the chip bar, so a section here with nothing in it
            would be a heading pointing at a control on another screen. */}
        {views.length === 0 ? null : (
          <SidebarGroup>
            <SidebarGroupLabel>Views</SidebarGroupLabel>
            <SidebarMenu>
              {views.map((view, index) => (
                <IssueViewRow
                  canMoveDown={index < views.length - 1}
                  canMoveUp={index > 0}
                  isActive={activeView?.id === view.id}
                  key={view.id}
                  onApply={() => navigateWith(issueViewSearchPatch(view.config))}
                  onDelete={() => setPendingDeleteView(view)}
                  onMove={(direction) => moveView(view, direction)}
                  onRename={() => setRenamingView(view)}
                  view={view}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Labels</SidebarGroupLabel>
          <SidebarMenu>
            {labels.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">
                Labels appear here once you create one in Settings.
              </p>
            ) : (
              labels.map((label) => (
                <SidebarMenuItem key={label.id}>
                  <SidebarMenuButton
                    isActive={onIssues && issuesFilterHasValue(filter, "label", label.id)}
                    onClick={() => applyFilter("label", label.id)}
                  >
                    <IssueLabelDot color={label.color} />
                    <span className="truncate">{label.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <NewCycleDialog onOpenChange={setNewCycleOpen} open={newCycleOpen} />

      <RenameIssueViewDialog
        onOpenChange={(open) => {
          if (!open) setRenamingView(null);
        }}
        view={renamingView}
        views={views}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingDeleteView(null);
        }}
        open={pendingDeleteView !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDeleteView?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A view is a name for a set of filters, so this deletes the name. No issue is touched,
              and there is nothing to undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (pendingDeleteView === null) return;
                writeView("Failed to delete the view", () =>
                  deleteView({ viewId: pendingDeleteView.id }),
                );
                setPendingDeleteView(null);
              }}
              variant="destructive"
            >
              Delete view
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * A saved view. The row applies it; the menu beside it is where the row's own management lives,
 * because the row itself has one click and applying is what that click is for.
 */
function IssueViewRow({
  view,
  isActive,
  canMoveUp,
  canMoveDown,
  onApply,
  onRename,
  onMove,
  onDelete,
}: {
  view: IssueView;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onApply: () => void;
  onRename: () => void;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onApply}
        title={summarizeIssueViewConfig(view.config)}
      >
        <BookmarkIcon />
        <span className="truncate">{view.name}</span>
      </SidebarMenuButton>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuAction aria-label={`Manage the ${view.name} view`} showOnHover>
              <MoreHorizontalIcon />
            </SidebarMenuAction>
          }
        />
        <MenuPopup align="start" className="min-w-40" side="bottom">
          <MenuItem closeOnClick onClick={onRename}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuItem closeOnClick disabled={!canMoveUp} onClick={() => onMove("up")}>
            <ArrowUpIcon />
            Move up
          </MenuItem>
          <MenuItem closeOnClick disabled={!canMoveDown} onClick={() => onMove("down")}>
            <ArrowDownIcon />
            Move down
          </MenuItem>
          <MenuSeparator />
          <MenuItem closeOnClick onClick={onDelete} variant="destructive">
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

/** Rename only: the filters a view holds are edited by applying it and saving over it. */
function RenameIssueViewDialog({
  view,
  views,
  onOpenChange,
}: {
  view: IssueView | null;
  views: ReadonlyArray<IssueView>;
  onOpenChange: (open: boolean) => void;
}) {
  const updateView = useUpdateIssueView();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (view === null) return;
    setName(view.name);
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => nameRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  const error = view === null ? null : duplicateNameError(views, name, view.id);

  const submit = () => {
    if (view === null || error !== null || submitting) return;
    const next = name.trim();
    if (next === view.name) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    void (async () => {
      const renamed = await updateView({ viewId: view.id, patch: { name: next } });
      setSubmitting(false);
      if (reportIssueWriteFailure("Failed to rename the view", renamed)) return;
      if (!AsyncResult.isSuccess(renamed)) return;
      onOpenChange(false);
    })();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!submitting) onOpenChange(open);
      }}
      open={view !== null}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename view</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            aria-label="View name"
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            ref={nameRef}
            value={name}
          />
          {error === null ? null : <p className="text-xs text-destructive-foreground">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={error !== null || submitting} onClick={submit} size="sm" type="button">
            Rename
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A project row that expands into its milestones. Expansion is local: a project with no milestones
 * shows no chevron, and one holding the open milestone starts expanded.
 *
 * The row itself filters the list by project; a milestone under it opens that milestone's page.
 */
function ProjectRow({
  title,
  isActive,
  milestones,
  milestoneProgress,
  selectedMilestoneIds,
  onSelectProject,
  onSelectMilestone,
}: {
  title: string;
  isActive: boolean;
  milestones: ReadonlyArray<{ readonly id: IssueMilestoneId; readonly name: string }>;
  milestoneProgress: ReadonlyMap<
    IssueMilestoneId,
    { readonly done: number; readonly total: number }
  >;
  selectedMilestoneIds: ReadonlyArray<string>;
  onSelectProject: () => void;
  onSelectMilestone: (milestoneId: IssueMilestoneId) => void;
}) {
  const holdsSelection = milestones.some((milestone) =>
    selectedMilestoneIds.includes(milestone.id),
  );
  const [expanded, setExpanded] = useState(holdsSelection);
  const open = expanded || holdsSelection;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} onClick={onSelectProject}>
        <FolderIcon />
        <span className="truncate">{title}</span>
      </SidebarMenuButton>
      {/* A sibling button rather than something nested inside the row: the row filters by project,
          the chevron expands, and only one of the two can be the row's own click target. */}
      {milestones.length === 0 ? null : (
        <SidebarMenuAction
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} the milestones of ${title}`}
          onClick={() => setExpanded(!open)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </SidebarMenuAction>
      )}
      {!open || milestones.length === 0 ? null : (
        <SidebarMenuSub>
          {milestones.map((milestone) => {
            const progress = milestoneProgress.get(milestone.id);
            return (
              <SidebarMenuSubItem key={milestone.id}>
                <SidebarMenuSubButton
                  isActive={selectedMilestoneIds.includes(milestone.id)}
                  onClick={() => onSelectMilestone(milestone.id)}
                  render={<button type="button" />}
                  size="sm"
                >
                  {progress === undefined || progress.total === 0 ? (
                    <FlagIcon />
                  ) : (
                    <IssueProgressRing done={progress.done} total={progress.total} />
                  )}
                  <span className="truncate">{milestone.name}</span>
                  {progress === undefined || progress.total === 0 ? null : (
                    <span className="ms-auto shrink-0 text-[11px] tabular-nums text-sidebar-muted-foreground">
                      {progress.done}/{progress.total}
                    </span>
                  )}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}
