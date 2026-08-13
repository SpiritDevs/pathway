import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { IssueMilestone, IssueMilestonePatch, IssueStatusCategory } from "@t3tools/contracts";
import { FolderIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "../../../lib/utils";
import { useProjects } from "../../../state/entities";
import {
  useCreateIssueMilestone,
  useDeleteIssueMilestone,
  useIssueMilestoneCategoryCounts,
  useIssueMilestoneProgress,
  useIssueMilestonesForProject,
  useIssuesStoreStatus,
  useReorderIssueMilestones,
  useUpdateIssueMilestone,
} from "../../../state/issues";
import { reportIssueWriteFailure as reportFailure } from "../../issues/issueWriteFeedback";
import { milestoneIssueCount } from "../../issues/milestonesOverview.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Progress } from "../../ui/progress";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import {
  duplicateNameError,
  issueMilestoneCreateInput,
  issueMilestoneDateEdit,
  issueMilestoneDraftError,
  reorderedIssueMilestoneIds,
  type IssueMilestoneDraft,
} from "./issuesSettings.logic";

/** Matches the cycle dialog's date fields, down to the per-scheme picker colouring. */
const DATE_INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

const EMPTY_DRAFT: IssueMilestoneDraft = { name: "", startDate: "", targetDate: "" };

const EMPTY_COUNTS: ReadonlyMap<IssueStatusCategory, number> = new Map();

/** Runs a write, surfaces its failure, and answers whether it landed. */
type RunWrite = (
  title: string,
  action: () => Promise<AtomCommandResult<unknown, unknown>>,
) => Promise<boolean>;

interface MilestoneProgress {
  readonly done: number;
  readonly total: number;
}

function MilestoneProgressCell({ name, progress }: { name: string; progress: MilestoneProgress }) {
  if (progress.total === 0) {
    return (
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground/70">No issues</span>
    );
  }
  return (
    <div className="flex w-20 shrink-0 flex-col items-end gap-1">
      <span className="text-xs tabular-nums text-muted-foreground">
        {progress.done}/{progress.total}
      </span>
      <Progress
        aria-label={`${name} progress`}
        className="h-1"
        value={progress.done / progress.total}
      />
    </div>
  );
}

function MilestoneRow({
  milestone,
  siblings,
  progress,
  busy,
  onRename,
  onEditDate,
  onRequestDelete,
}: {
  milestone: IssueMilestone;
  siblings: ReadonlyArray<IssueMilestone>;
  progress: MilestoneProgress;
  busy: boolean;
  onRename: (milestone: IssueMilestone, name: string) => void;
  /** False when the date was refused, which is the row's cue to put the stored one back. */
  onEditDate: (
    milestone: IssueMilestone,
    field: "startDate" | "targetDate",
    raw: string,
  ) => boolean;
  onRequestDelete: (milestone: IssueMilestone) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: milestone.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-1.5 sm:px-4",
        isDragging ? "z-10 bg-accent/50 shadow-xs" : "hover:bg-accent/30",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${milestone.name}`}
        disabled={siblings.length < 2}
        className="-ms-1 cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <Input
        key={milestone.name}
        className="min-w-0 flex-1"
        size="sm"
        aria-label={`${milestone.name} name`}
        defaultValue={milestone.name}
        disabled={busy}
        onBlur={(event) => onRename(milestone, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = milestone.name;
            event.currentTarget.blur();
          }
        }}
      />
      <input
        key={`start-${milestone.startDate ?? ""}`}
        aria-label={`${milestone.name} start date`}
        className={cn(DATE_INPUT_CLASS, "w-36 shrink-0")}
        defaultValue={milestone.startDate ?? ""}
        disabled={busy}
        onBlur={(event) => {
          if (onEditDate(milestone, "startDate", event.currentTarget.value)) return;
          event.currentTarget.value = milestone.startDate ?? "";
        }}
        type="date"
      />
      <input
        key={`target-${milestone.targetDate ?? ""}`}
        aria-label={`${milestone.name} target date`}
        className={cn(DATE_INPUT_CLASS, "w-36 shrink-0")}
        defaultValue={milestone.targetDate ?? ""}
        disabled={busy}
        onBlur={(event) => {
          if (onEditDate(milestone, "targetDate", event.currentTarget.value)) return;
          event.currentTarget.value = milestone.targetDate ?? "";
        }}
        type="date"
      />
      <MilestoneProgressCell name={milestone.name} progress={progress} />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete ${milestone.name}`}
        disabled={busy}
        className="text-muted-foreground hover:text-destructive-foreground"
        onClick={() => onRequestDelete(milestone)}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * One project's checkpoints. Milestones are positioned per project, so each group owns its own
 * drag context and its own add row — a drag never crosses a project boundary, and neither does a
 * name clash.
 */
function ProjectMilestoneGroup({
  project,
  progress,
  busy,
  run,
  onRequestDelete,
}: {
  project: EnvironmentProject;
  progress: ReadonlyMap<string, MilestoneProgress>;
  busy: boolean;
  run: RunWrite;
  onRequestDelete: (milestone: IssueMilestone) => void;
}) {
  const milestones = useIssueMilestonesForProject(project.id);
  const createMilestone = useCreateIssueMilestone();
  const updateMilestone = useUpdateIssueMilestone();
  const reorderMilestones = useReorderIssueMilestones();

  const [draft, setDraft] = useState<IssueMilestoneDraft>(EMPTY_DRAFT);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const patch = useCallback(
    (milestone: IssueMilestone, next: IssueMilestonePatch, title: string) =>
      void run(title, () => updateMilestone({ milestoneId: milestone.id, patch: next })),
    [run, updateMilestone],
  );

  const handleRename = useCallback(
    (milestone: IssueMilestone, raw: string) => {
      const name = raw.trim();
      if (name === milestone.name) return;
      const error = duplicateNameError(milestones, name, milestone.id);
      if (error !== null) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Rename milestone", description: error }),
        );
        return;
      }
      patch(milestone, { name }, "Failed to rename the milestone");
    },
    [milestones, patch],
  );

  const handleEditDate = useCallback(
    (milestone: IssueMilestone, field: "startDate" | "targetDate", raw: string) => {
      const edit = issueMilestoneDateEdit(milestone, field, raw);
      if (edit.kind === "unchanged") return true;
      if (edit.kind === "invalid") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Reschedule milestone",
            description: edit.error,
          }),
        );
        return false;
      }
      patch(milestone, edit.patch, "Failed to reschedule the milestone");
      return true;
    },
    [patch],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over === null ? null : String(event.over.id);
      if (overId === null) return;
      const milestoneIds = reorderedIssueMilestoneIds({
        milestones,
        activeId: String(event.active.id),
        overId,
      });
      if (milestoneIds === null) return;
      // The whole order within this project, not a move: the server rewrites every position.
      void run("Failed to reorder the milestones", () =>
        reorderMilestones({ projectId: project.id, milestoneIds }),
      );
    },
    [milestones, project.id, reorderMilestones, run],
  );

  const handleAdd = useCallback(() => {
    const error = issueMilestoneDraftError(draft, milestones);
    if (error !== null) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Add milestone", description: error }),
      );
      return;
    }
    void (async () => {
      const added = await run("Failed to add the milestone", () =>
        createMilestone(issueMilestoneCreateInput(project.id, draft)),
      );
      if (added) setDraft(EMPTY_DRAFT);
    })();
  }, [createMilestone, draft, milestones, project.id, run]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-3 pt-2 text-xs font-medium text-muted-foreground sm:px-4">
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">{project.title}</span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={milestones.map((milestone) => milestone.id)}
          strategy={verticalListSortingStrategy}
        >
          {milestones.map((milestone) => (
            <MilestoneRow
              key={milestone.id}
              milestone={milestone}
              siblings={milestones}
              progress={progress.get(milestone.id) ?? { done: 0, total: 0 }}
              busy={busy}
              onRename={handleRename}
              onEditDate={handleEditDate}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </SortableContext>
      </DndContext>

      <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
        <span className="size-4 shrink-0" aria-hidden />
        <Input
          className="min-w-0 flex-1"
          size="sm"
          aria-label={`New milestone in ${project.title}`}
          placeholder="Add a milestone…"
          value={draft.name}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.name.trim() !== "") handleAdd();
          }}
        />
        <input
          aria-label={`Start date for the new milestone in ${project.title}`}
          className={cn(DATE_INPUT_CLASS, "w-36 shrink-0")}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, startDate: event.currentTarget.value })}
          type="date"
          value={draft.startDate}
        />
        <input
          aria-label={`Target date for the new milestone in ${project.title}`}
          className={cn(DATE_INPUT_CLASS, "w-36 shrink-0")}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, targetDate: event.currentTarget.value })}
          type="date"
          value={draft.targetDate}
        />
        <Button
          size="sm"
          variant="outline"
          className="w-20 shrink-0"
          disabled={busy || draft.name.trim() === ""}
          onClick={handleAdd}
        >
          <PlusIcon className="size-3.5" />
          Add
        </Button>
        <span className="size-6 shrink-0" aria-hidden />
      </div>
    </div>
  );
}

export function MilestonesSettingsPanel() {
  const storeStatus = useIssuesStoreStatus();
  const projects = useProjects();
  const progress = useIssueMilestoneProgress();
  const categoryCounts = useIssueMilestoneCategoryCounts();
  const deleteMilestone = useDeleteIssueMilestone();

  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<IssueMilestone | null>(null);

  const run = useCallback<RunWrite>(async (title, action) => {
    setBusy(true);
    try {
      return !reportFailure(title, await action());
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDelete = useCallback(
    (milestone: IssueMilestone) => {
      void (async () => {
        const deleted = await run("Failed to delete the milestone", () =>
          deleteMilestone({ milestoneId: milestone.id }),
        );
        if (deleted) setPendingDelete(null);
      })();
    },
    [deleteMilestone, run],
  );

  /**
   * Everything the delete would unassign, canceled work included — the rollup's `total` leaves
   * canceled issues out, and they are unassigned just the same.
   */
  const heldIssues = useCallback(
    (milestone: IssueMilestone) =>
      milestoneIssueCount(categoryCounts.get(milestone.id) ?? EMPTY_COUNTS),
    [categoryCounts],
  );
  const pendingCount = pendingDelete === null ? 0 : heldIssues(pendingDelete);

  if (storeStatus === "disconnected") {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-milestones")}>
          <SettingsRow
            title="No environment connected"
            description="The issue tracker belongs to the environment you are connected to. Connect one to plan its milestones."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-milestones")}>
          <SettingsRow
            title="Milestones"
            description="Checkpoints inside a project. Drag to reorder within a project; the dates are what the timeline draws a bar between, and either one may be left empty."
          />
          {storeStatus === "loading" && projects.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
              <Spinner className="size-3.5" />
              Loading milestones…
            </div>
          ) : projects.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">
              A milestone belongs to a project, and this environment has none yet.
            </p>
          ) : (
            projects.map((project) => (
              <ProjectMilestoneGroup
                key={project.id}
                project={project}
                progress={progress}
                busy={busy}
                run={run}
                onRequestDelete={(milestone) => {
                  // A milestone nothing points at is trivially retyped, so only one holding issues
                  // is worth a dialog: deleting that one edits every issue assigned to it.
                  if (heldIssues(milestone) === 0) handleDelete(milestone);
                  else setPendingDelete(milestone);
                }}
              />
            ))
          )}
        </SettingsSection>
      </SettingsPageContainer>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCount === 1
                ? "1 issue is assigned to this milestone and will be left unassigned. It stays in the project, and nothing else about it changes."
                : `${pendingCount} issues are assigned to this milestone and will be left unassigned. They stay in the project, and nothing else about them changes.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pendingDelete !== null) handleDelete(pendingDelete);
              }}
            >
              {busy ? <Spinner className="size-3.5" /> : null}
              Delete milestone
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
