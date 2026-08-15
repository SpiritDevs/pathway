/**
 * `/issues/milestones` — every milestone in the tracker, grouped by project, in one of two modes.
 *
 * The list is the plain one: a row per milestone with its derived status, its meter, and its dates,
 * and a menu holding the management that used to only exist inside the issue detail sheet. The
 * timeline is the same data on a scale, and mounts in the one element the `timeline` branch below
 * renders.
 *
 * Everything the page decides without the DOM is in `milestonesOverview.logic.ts`; this file is the
 * wiring — atoms in, mutations out.
 *
 * @module components/issues/MilestonesOverviewPage
 */
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import {
  issueMilestoneStatusOn,
  type IssueMilestone,
  type IssueMilestoneId,
} from "@spiritdevs/contracts";
import type { IssueDate, IssueStatusCategory, ProjectId } from "@spiritdevs/contracts";
import { Link } from "@tanstack/react-router";
import {
  CalendarRangeIcon,
  FlagIcon,
  FolderIcon,
  GanttChartIcon,
  MoreHorizontalIcon,
  MoveRightIcon,
  PencilIcon,
  PlusIcon,
  Rows3Icon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  todayIssueDate,
  useCreateIssueMilestone,
  useDeleteIssueMilestone,
  useIssueMilestoneCategoryCounts,
  useIssueMilestoneProgress,
  useIssueMilestones,
  useIssuesStoreStatus,
  useUpdateIssueMilestone,
  type IssueProgress,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { duplicateNameError } from "../settings/issues/issuesSettings.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Progress } from "../ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  MILESTONE_STATUS_LABELS,
  formatMilestoneDateRange,
  milestoneIssueCount,
  milestoneProgressRatio,
  milestoneTally,
  milestonesOverviewGroups,
  milestonesOverviewView,
  type MilestonesOverviewSearch,
  type MilestonesOverviewSearchPatch,
} from "./milestonesOverview.logic";
import { MilestonesTimeline } from "./MilestonesTimeline";

/** Re-exported so the route can take its `validateSearch` and its component from one module. */
export { parseMilestonesOverviewSearch } from "./milestonesOverview.logic";

/** Native date entry, the same control the cycle dialog uses. */
const DATE_INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

/** The filter's "no filter" option. A `Select` needs a value for it; the URL says it with nothing. */
const ALL_PROJECTS = "all";

const EMPTY_CATEGORY_COUNTS: ReadonlyMap<IssueStatusCategory, number> = new Map();
const EMPTY_PROGRESS: IssueProgress = { done: 0, total: 0 };

const STATUS_BADGE_VARIANTS = {
  upcoming: "outline",
  "in-progress": "info",
  completed: "success",
  overdue: "error",
} as const;

export function MilestonesOverviewPage({
  search,
  onSearch,
}: {
  search: MilestonesOverviewSearch;
  onSearch: (patch: MilestonesOverviewSearchPatch) => void;
}) {
  const projects = useProjects();
  const milestones = useIssueMilestones();
  const progressByMilestone = useIssueMilestoneProgress();
  const categoryCounts = useIssueMilestoneCategoryCounts();
  const storeStatus = useIssuesStoreStatus();
  const createMilestone = useCreateIssueMilestone();
  const updateMilestone = useUpdateIssueMilestone();
  const deleteMilestone = useDeleteIssueMilestone();

  const [renamingId, setRenamingId] = useState<IssueMilestoneId | null>(null);
  const [datesMilestone, setDatesMilestone] = useState<IssueMilestone | null>(null);
  const [pendingDelete, setPendingDelete] = useState<IssueMilestone | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    readonly milestone: IssueMilestone;
    readonly projectId: ProjectId;
  } | null>(null);

  // Read once per mount rather than tracked: a page left open past midnight re-reads this on the
  // next diff, and nothing here is worth a timer.
  const today = useMemo(() => todayIssueDate(), []);
  const view = milestonesOverviewView(search);
  const groups = useMemo(
    () => milestonesOverviewGroups(projects, milestones, search.project),
    [milestones, projects, search.project],
  );
  const shown = useMemo(
    () => groups.reduce((count, group) => count + group.milestones.length, 0),
    [groups],
  );

  const write = (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    void (async () => {
      reportIssueWriteFailure(title, await run());
    })();
  };

  /** Every issue the milestone holds — what a delete unassigns, and what a move leaves behind. */
  const heldIssues = (milestone: IssueMilestone) =>
    milestoneIssueCount(categoryCounts.get(milestone.id) ?? EMPTY_CATEGORY_COUNTS);
  const moveCount = pendingMove === null ? 0 : heldIssues(pendingMove.milestone);

  /** A clash is refused here as well as on the server, so the row never flickers through it. */
  const rejectDuplicate = (
    title: string,
    projectId: ProjectId,
    name: string,
    exceptId?: string,
  ) => {
    const error = duplicateNameError(
      milestones.filter((milestone) => milestone.projectId === projectId),
      name,
      exceptId,
    );
    if (error === null) return false;
    toastManager.add(stackedThreadToast({ type: "error", title, description: error }));
    return true;
  };

  const renameMilestone = (milestone: IssueMilestone, raw: string) => {
    setRenamingId(null);
    const name = raw.trim();
    if (name === milestone.name) return;
    if (rejectDuplicate("Rename milestone", milestone.projectId, name, milestone.id)) return;
    write("Failed to rename the milestone", () =>
      updateMilestone({ milestoneId: milestone.id, patch: { name } }),
    );
  };

  const addMilestone = (projectId: ProjectId, raw: string) => {
    const name = raw.trim();
    if (name.length === 0) return;
    if (rejectDuplicate("New milestone", projectId, name)) return;
    write("Failed to create the milestone", () => createMilestone({ projectId, name }));
  };

  /**
   * An issue never changes project, so a milestone that moves leaves every one of its issues
   * behind, unassigned. That edits more records than a delete does, so it asks first whenever the
   * milestone holds anything.
   */
  const moveMilestone = (milestone: IssueMilestone, projectId: ProjectId) => {
    if (projectId === milestone.projectId) return;
    if (rejectDuplicate("Move milestone", projectId, milestone.name, milestone.id)) return;
    if (heldIssues(milestone) > 0) {
      setPendingMove({ milestone, projectId });
      return;
    }
    write("Failed to move the milestone", () =>
      updateMilestone({ milestoneId: milestone.id, patch: { projectId } }),
    );
  };

  const setMilestoneDates = (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => {
    setDatesMilestone(null);
    write("Failed to change the dates", () =>
      updateMilestone({ milestoneId: milestone.id, patch: { startDate, targetDate } }),
    );
  };

  /** Straight through when the milestone is empty; through the dialog when it holds work. */
  const removeMilestone = (milestone: IssueMilestone) => {
    if (heldIssues(milestone) > 0) {
      setPendingDelete(milestone);
      return;
    }
    write("Failed to delete the milestone", () => deleteMilestone({ milestoneId: milestone.id }));
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Milestones breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link
                className="outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                to="/issues"
              >
                Issues
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>Milestones</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>

        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
          <h1 className="text-sm font-medium">Milestones</h1>
          <span className="text-xs tabular-nums text-muted-foreground/70">
            {shown} {shown === 1 ? "milestone" : "milestones"}
          </span>

          <div className="ms-auto flex items-center gap-1.5">
            <Select
              onValueChange={(value) => {
                onSearch({
                  project: typeof value !== "string" || value === ALL_PROJECTS ? undefined : value,
                });
              }}
              value={search.project ?? ALL_PROJECTS}
            >
              <SelectTrigger aria-label="Filter by project" size="sm" variant="ghost">
                <SelectValue>
                  {search.project === undefined
                    ? "All projects"
                    : (projects.find((project) => project.id === search.project)?.title ??
                      "All projects")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            {/* The mode rides in the URL, and the default is written as an absent param rather
                than `view=list` — same rule the issues list follows. */}
            <ToggleGroup
              aria-label="Milestone view"
              onValueChange={(next) => {
                const value = next[0];
                if (value === "list") onSearch({ view: undefined });
                if (value === "timeline") onSearch({ view: "timeline" });
              }}
              size="xs"
              value={[view]}
              variant="outline"
            >
              <ToggleGroupItem aria-label="List view" value="list">
                <Rows3Icon />
              </ToggleGroupItem>
              <ToggleGroupItem aria-label="Timeline view" value="timeline">
                <GanttChartIcon />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {storeStatus === "disconnected" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FlagIcon />
                </EmptyMedia>
                <EmptyTitle>No environment connected</EmptyTitle>
                <EmptyDescription>
                  The tracker lives on the machine you are connected to. Connect one to see its
                  milestones.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : storeStatus === "loading" && milestones.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : projects.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  A milestone is a checkpoint inside a project, so there is nowhere to put one until
                  a project exists.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : groups.length === 0 ? (
            // The filter names a project this environment does not have — a stale link or a
            // deleted project. Say so, and give back the way out.
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>No such project</EmptyTitle>
                <EmptyDescription>
                  This page is filtered to a project that is not on this environment.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  onClick={() => onSearch({ project: undefined })}
                  size="sm"
                  variant="outline"
                >
                  Show all projects
                </Button>
              </EmptyContent>
            </Empty>
          ) : view === "timeline" ? (
            <div className="h-full" data-testid="milestones-timeline">
              <MilestonesTimeline
                groups={groups}
                onDates={setMilestoneDates}
                progressByMilestone={progressByMilestone}
                today={today}
              />
            </div>
          ) : (
            <div className="h-full overflow-y-auto px-3 py-4 sm:px-5">
              <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
                {groups.map((group) => (
                  <section className="flex min-w-0 flex-col gap-0.5" key={group.projectId}>
                    <h2 className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground">
                      <FolderIcon className="size-3.5" />
                      <span className="truncate">{group.title}</span>
                    </h2>
                    {group.milestones.map((milestone) => (
                      <MilestoneRow
                        counts={categoryCounts.get(milestone.id) ?? EMPTY_CATEGORY_COUNTS}
                        key={milestone.id}
                        milestone={milestone}
                        onDelete={() => removeMilestone(milestone)}
                        onEditDates={() => setDatesMilestone(milestone)}
                        onMove={(projectId) => moveMilestone(milestone, projectId)}
                        onRename={(name) => renameMilestone(milestone, name)}
                        onStartRename={() => setRenamingId(milestone.id)}
                        onStopRename={() => setRenamingId(null)}
                        progress={progressByMilestone.get(milestone.id) ?? EMPTY_PROGRESS}
                        projects={projects}
                        renaming={renamingId === milestone.id}
                        today={today}
                      />
                    ))}
                    <NewMilestoneRow
                      onCreate={(name) => addMilestone(group.projectId, name)}
                      projectTitle={group.title}
                    />
                  </section>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <MilestoneDatesDialog
        milestone={datesMilestone}
        onOpenChange={(open) => {
          if (!open) setDatesMilestone(null);
        }}
        onSave={setMilestoneDates}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its issues stay in the project and land unassigned. Nothing else about them changes,
              and there is nothing to undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (pendingDelete === null) return;
                write("Failed to delete the milestone", () =>
                  deleteMilestone({ milestoneId: pendingDelete.id }),
                );
                setPendingDelete(null);
              }}
              variant="destructive"
            >
              Delete milestone
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        open={pendingMove !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {pendingMove?.milestone.name} to{" "}
              {projects.find((project) => project.id === pendingMove?.projectId)?.title ??
                "another project"}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {moveCount === 1
                ? "Its issue does not come along: an issue belongs to its project, so it stays where it is and lands unassigned. There is nothing to undo."
                : `Its ${moveCount} issues do not come along: an issue belongs to its project, so they stay where they are and land unassigned. There is nothing to undo.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (pendingMove === null) return;
                write("Failed to move the milestone", () =>
                  updateMilestone({
                    milestoneId: pendingMove.milestone.id,
                    patch: { projectId: pendingMove.projectId },
                  }),
                );
                setPendingMove(null);
              }}
              variant="destructive"
            >
              Move milestone
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
  );
}

/**
 * One milestone. The row itself opens it — that is the one click a row has — and everything that
 * manages it sits in the menu beside it, the way a saved view's row does in the issues sidebar.
 */
function MilestoneRow({
  milestone,
  progress,
  counts,
  projects,
  today,
  renaming,
  onStartRename,
  onStopRename,
  onRename,
  onEditDates,
  onMove,
  onDelete,
}: {
  milestone: IssueMilestone;
  progress: IssueProgress;
  counts: ReadonlyMap<IssueStatusCategory, number>;
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  today: IssueDate;
  renaming: boolean;
  onStartRename: () => void;
  onStopRename: () => void;
  onRename: (name: string) => void;
  onEditDates: () => void;
  onMove: (projectId: ProjectId) => void;
  onDelete: () => void;
}) {
  const status = issueMilestoneStatusOn(milestone, milestoneTally(progress, counts), today);
  const dates = formatMilestoneDateRange(milestone.startDate, milestone.targetDate, today);

  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg pe-1 hover:bg-accent/40">
      {renaming ? (
        <RenameMilestoneInput name={milestone.name} onCancel={onStopRename} onSubmit={onRename} />
      ) : (
        <Link
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          params={{ milestoneId: milestone.id }}
          to="/issues/milestones/$milestoneId"
        >
          <Badge className="shrink-0" size="sm" variant={STATUS_BADGE_VARIANTS[status]}>
            {MILESTONE_STATUS_LABELS[status]}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm">{milestone.name}</span>
          <span className="hidden shrink-0 items-center gap-2 sm:flex">
            <Progress
              aria-label={`${milestone.name} progress`}
              className="w-20"
              value={milestoneProgressRatio(progress)}
            />
            <span className="w-10 text-[11px] tabular-nums text-muted-foreground">
              {progress.done}/{progress.total}
            </span>
          </span>
          <span className="hidden w-32 shrink-0 text-end text-xs tabular-nums text-muted-foreground sm:block">
            {dates ?? "No dates"}
          </span>
        </Link>
      )}

      <Menu>
        <MenuTrigger
          render={
            <Button aria-label={`Manage ${milestone.name}`} size="icon-xs" variant="ghost">
              <MoreHorizontalIcon />
            </Button>
          }
        />
        <MenuPopup align="end" className="min-w-44" side="bottom">
          <MenuItem closeOnClick onClick={onStartRename}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuItem closeOnClick onClick={onEditDates}>
            <CalendarRangeIcon />
            Edit dates
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger>
              <MoveRightIcon />
              Move to project
            </MenuSubTrigger>
            {/* The milestone moves on its own: issues never change project, so the server
                unassigns every one it leaves behind — which is what the dialog asks about. */}
            <MenuSubPopup className="min-w-44">
              <MenuRadioGroup
                onValueChange={(value) => onMove(value as ProjectId)}
                value={milestone.projectId}
              >
                {projects.map((project) => (
                  <MenuRadioItem key={project.id} value={project.id}>
                    {project.title}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem closeOnClick onClick={onDelete} variant="destructive">
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Rename in place: Enter and blur commit, Escape leaves the name as it was. */
function RenameMilestoneInput({
  name,
  onSubmit,
  onCancel,
}: {
  name: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  const canceled = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <Input
      aria-label="Milestone name"
      className="h-8 min-w-0 flex-1"
      onBlur={() => {
        if (canceled.current) return;
        onSubmit(value);
      }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value);
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        canceled.current = true;
        onCancel();
      }}
      ref={inputRef}
      value={value}
    />
  );
}

/** The trailing row of every project group: the way in, next to what it makes. */
function NewMilestoneRow({
  projectTitle,
  onCreate,
}: {
  projectTitle: string;
  onCreate: (name: string) => void;
}) {
  const [drafting, setDrafting] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!drafting) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [drafting]);

  const submit = () => {
    onCreate(name);
    setName("");
    setDrafting(false);
  };

  if (!drafting) {
    return (
      <button
        className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-start text-xs text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setDrafting(true)}
        type="button"
      >
        <PlusIcon className="size-3.5" />
        New milestone
      </button>
    );
  }

  return (
    <Input
      aria-label={`New milestone in ${projectTitle}`}
      className="h-8"
      onBlur={submit}
      onChange={(event) => setName(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        setName("");
        setDrafting(false);
      }}
      placeholder="Milestone name"
      ref={inputRef}
      value={name}
    />
  );
}

/**
 * Both ends of a milestone, and the way to clear either. An empty input is a cleared date rather
 * than an untouched one, which is what makes a bar a point again.
 */
function MilestoneDatesDialog({
  milestone,
  onOpenChange,
  onSave,
}: {
  milestone: IssueMilestone | null;
  onOpenChange: (open: boolean) => void;
  onSave: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");

  useEffect(() => {
    if (milestone === null) return;
    setStartDate(milestone.startDate ?? "");
    setTargetDate(milestone.targetDate ?? "");
  }, [milestone]);

  const backwards =
    startDate.length > 0 && targetDate.length > 0 && startDate > targetDate
      ? "A milestone cannot start after its target date."
      : null;

  return (
    <Dialog onOpenChange={onOpenChange} open={milestone !== null}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Milestone dates</DialogTitle>
          <DialogDescription>
            Both are optional. A milestone with neither is a point on the timeline rather than a
            bar.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex items-center gap-2">
            <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Starts
              <input
                aria-label="Milestone start date"
                className={DATE_INPUT_CLASS}
                onChange={(event) => setStartDate(event.currentTarget.value)}
                type="date"
                value={startDate}
              />
            </Label>
            <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Target
              <input
                aria-label="Milestone target date"
                className={DATE_INPUT_CLASS}
                onChange={(event) => setTargetDate(event.currentTarget.value)}
                type="date"
                value={targetDate}
              />
            </Label>
          </div>
          {backwards === null ? null : (
            <p className="text-xs text-destructive-foreground">{backwards}</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={backwards !== null}
            onClick={() => {
              if (milestone === null || backwards !== null) return;
              onSave(
                milestone,
                startDate.length === 0 ? null : (startDate as IssueDate),
                targetDate.length === 0 ? null : (targetDate as IssueDate),
              );
            }}
            size="sm"
            type="button"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
