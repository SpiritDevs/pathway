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
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import { IssueStatusId, type IssueStatus, type IssueStatusCategory } from "@spiritdevs/contracts";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../../../lib/utils";
import { reportIssueWriteFailure as reportFailure } from "../../issues/issueWriteFeedback";
import {
  useCreateIssueStatus,
  useDeleteIssueStatus,
  useIssueStatuses,
  useIssueTrackerConfig,
  useIssuesStore,
  useIssuesStoreStatus,
  useReorderIssueStatuses,
  useSetIssueKeyPrefix,
  useUpdateIssueStatus,
} from "../../../state/issues";
import { ColorSelector } from "../../color-selector";
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
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import {
  countIssuesByStatus,
  DEFAULT_ISSUE_COLOR,
  duplicateNameError,
  ISSUE_COLOR_OPTIONS,
  ISSUE_KEY_PREFIX_MAX_CHARS,
  ISSUE_STATUS_CATEGORY_OPTIONS,
  issueKeyPrefixError,
  issueStatusCategoryLabel,
  issueStatusDeletability,
  issueStatusReassignmentOptions,
  normalizeIssueKeyPrefix,
  reorderedIssueStatusIds,
} from "./issuesSettings.logic";

function ColorSwatchPicker({
  value,
  label,
  disabled = false,
  onSelect,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            className="size-5 shrink-0 rounded-full border border-black/8 disabled:opacity-50 dark:border-white/12"
            style={{ backgroundColor: value }}
          />
        }
      />
      <PopoverPopup align="start" className="w-auto p-2">
        <ColorSelector
          // Uncontrolled inside; remount when the stored colour changes so the ring follows it.
          key={value}
          colors={[...ISSUE_COLOR_OPTIONS]}
          defaultValue={value}
          size="lg"
          className="gap-1.5"
          onColorSelect={(color) => {
            setOpen(false);
            onSelect(color);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

function CategorySelect({
  value,
  label,
  disabled = false,
  onValueChange,
}: {
  value: IssueStatusCategory;
  label: string;
  disabled?: boolean;
  onValueChange: (category: IssueStatusCategory) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next as IssueStatusCategory)}
    >
      <SelectTrigger className="w-36 shrink-0" aria-label={label}>
        <SelectValue>{issueStatusCategoryLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
        {ISSUE_STATUS_CATEGORY_OPTIONS.map((option) => (
          <SelectItem key={option.category} value={option.category} className="items-start py-1.5">
            <span className="block max-w-72">
              <span className="block font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function StatusRow({
  status,
  statuses,
  issueCount,
  busy,
  onRename,
  onRecolor,
  onRecategorize,
  onRequestDelete,
}: {
  status: IssueStatus;
  statuses: ReadonlyArray<IssueStatus>;
  issueCount: number;
  busy: boolean;
  onRename: (status: IssueStatus, name: string) => void;
  onRecolor: (status: IssueStatus, color: string) => void;
  onRecategorize: (status: IssueStatus, category: IssueStatusCategory) => void;
  onRequestDelete: (status: IssueStatus) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id });
  const deletability = issueStatusDeletability(statuses, status.id);

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
        aria-label={`Reorder ${status.name}`}
        className="-ms-1 cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <ColorSwatchPicker
        value={status.color}
        label={`Change the colour of ${status.name}`}
        disabled={busy}
        onSelect={(color) => onRecolor(status, color)}
      />
      <Input
        key={status.name}
        className="min-w-0 flex-1"
        size="sm"
        aria-label={`${status.name} name`}
        defaultValue={status.name}
        disabled={busy}
        onBlur={(event) => onRename(status, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = status.name;
            event.currentTarget.blur();
          }
        }}
      />
      <CategorySelect
        value={status.category}
        label={`${status.name} category`}
        disabled={busy}
        onValueChange={(category) => onRecategorize(status, category)}
      />
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {issueCount === 1 ? "1 issue" : `${issueCount} issues`}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete ${status.name}`}
        title={deletability.canDelete ? undefined : deletability.reason}
        disabled={busy || !deletability.canDelete}
        className="text-muted-foreground hover:text-destructive-foreground"
        onClick={() => onRequestDelete(status)}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

export function StatusesSettingsPanel() {
  const storeStatus = useIssuesStoreStatus();
  const store = useIssuesStore();
  const statuses = useIssueStatuses();
  const config = useIssueTrackerConfig();

  const createStatus = useCreateIssueStatus();
  const updateStatus = useUpdateIssueStatus();
  const deleteStatus = useDeleteIssueStatus();
  const reorderStatuses = useReorderIssueStatuses();
  const setKeyPrefix = useSetIssueKeyPrefix();

  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_ISSUE_COLOR);
  const [draftCategory, setDraftCategory] = useState<IssueStatusCategory>("unstarted");
  const [pendingDelete, setPendingDelete] = useState<IssueStatus | null>(null);
  const [reassignToId, setReassignToId] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  const issueCounts = useMemo(() => countIssuesByStatus(store), [store]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const run = useCallback(
    async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      setBusy(true);
      try {
        return !reportFailure(title, await action());
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleRename = useCallback(
    (status: IssueStatus, raw: string) => {
      const name = raw.trim();
      if (name === status.name) return;
      const error = duplicateNameError(statuses, name, status.id);
      if (error !== null) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Rename status", description: error }),
        );
        return;
      }
      void run("Failed to rename the status", () =>
        updateStatus({ statusId: status.id, patch: { name } }),
      );
    },
    [run, statuses, updateStatus],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over === null ? null : String(event.over.id);
      if (overId === null) return;
      const statusIds = reorderedIssueStatusIds({
        statuses,
        activeId: String(event.active.id),
        overId,
      });
      if (statusIds === null) return;
      // The whole order, not a move: the server rewrites every position from this list.
      void run("Failed to reorder the statuses", () =>
        reorderStatuses({ statusIds: statusIds.map((id) => IssueStatusId.make(id)) }),
      );
    },
    [reorderStatuses, run, statuses],
  );

  const handleAdd = useCallback(() => {
    const name = draftName.trim();
    const error = duplicateNameError(statuses, name);
    if (error !== null) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Add status", description: error }),
      );
      return;
    }
    void (async () => {
      const added = await run("Failed to add the status", () =>
        createStatus({ name, color: draftColor, category: draftCategory }),
      );
      if (added) {
        setDraftName("");
        setDraftColor(DEFAULT_ISSUE_COLOR);
      }
    })();
  }, [createStatus, draftCategory, draftColor, draftName, run, statuses]);

  const handleConfirmDelete = useCallback(() => {
    if (pendingDelete === null || reassignToId === null) return;
    void (async () => {
      const deleted = await run("Failed to delete the status", () =>
        deleteStatus({
          statusId: pendingDelete.id,
          reassignToStatusId: IssueStatusId.make(reassignToId),
        }),
      );
      if (deleted) {
        setPendingDelete(null);
        setReassignToId(null);
      }
    })();
  }, [deleteStatus, pendingDelete, reassignToId, run]);

  const handlePrefixBlur = useCallback(
    (raw: string) => {
      const error = issueKeyPrefixError(raw);
      setPrefixError(error);
      if (error !== null) return;
      const keyPrefix = normalizeIssueKeyPrefix(raw);
      if (keyPrefix === config?.keyPrefix) return;
      void run("Failed to rename the issue key prefix", () => setKeyPrefix({ keyPrefix }));
    },
    [config?.keyPrefix, run, setKeyPrefix],
  );

  const reassignOptions =
    pendingDelete === null ? [] : issueStatusReassignmentOptions(statuses, pendingDelete.id);
  const movingCount = pendingDelete === null ? 0 : (issueCounts.get(pendingDelete.id) ?? 0);

  if (storeStatus === "disconnected") {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-statuses")}>
          <SettingsRow
            title="No environment connected"
            description="The issue tracker belongs to the environment you are connected to. Connect one to configure its statuses."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-statuses")}>
          <SettingsRow
            title="Workflow statuses"
            description="Drag to reorder. A status's category — not its name — drives the Active and Backlog tabs, progress rollups, and what an agent means by complete."
          />
          {storeStatus === "loading" && statuses.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
              <Spinner className="size-3.5" />
              Loading statuses…
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={statuses.map((status) => status.id)}
                strategy={verticalListSortingStrategy}
              >
                {statuses.map((status) => (
                  <StatusRow
                    key={status.id}
                    status={status}
                    statuses={statuses}
                    issueCount={issueCounts.get(status.id) ?? 0}
                    busy={busy}
                    onRename={handleRename}
                    onRecolor={(target, color) =>
                      void run("Failed to recolour the status", () =>
                        updateStatus({ statusId: target.id, patch: { color } }),
                      )
                    }
                    onRecategorize={(target, category) =>
                      void run("Failed to change the status category", () =>
                        updateStatus({ statusId: target.id, patch: { category } }),
                      )
                    }
                    onRequestDelete={(target) => {
                      setPendingDelete(target);
                      setReassignToId(null);
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
            <span className="size-4 shrink-0" aria-hidden />
            <ColorSwatchPicker
              value={draftColor}
              label="Colour for the new status"
              disabled={busy}
              onSelect={setDraftColor}
            />
            <Input
              className="min-w-0 flex-1"
              size="sm"
              aria-label="New status name"
              placeholder="Add a status…"
              value={draftName}
              disabled={busy}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draftName.trim() !== "") handleAdd();
              }}
            />
            <CategorySelect
              value={draftCategory}
              label="Category for the new status"
              disabled={busy}
              onValueChange={setDraftCategory}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-16 shrink-0"
              disabled={busy || draftName.trim() === ""}
              onClick={handleAdd}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
            <span className="size-6 shrink-0" aria-hidden />
          </div>
        </SettingsSection>

        <SettingsSection {...searchableSetting("issue-key-prefix")}>
          <SettingsRow
            title="Prefix"
            description="The letters in front of every issue number. New issues take this prefix; keys already handed out keep the one they were minted with."
            status={
              prefixError !== null ? (
                <span className="text-destructive-foreground">{prefixError}</span>
              ) : config === null ? null : (
                `Next issue: ${config.keyPrefix}-${config.nextNumber}`
              )
            }
            control={
              <Input
                key={config?.keyPrefix ?? "loading"}
                className="w-full font-mono sm:w-32"
                aria-label="Issue key prefix"
                aria-invalid={prefixError !== null}
                maxLength={ISSUE_KEY_PREFIX_MAX_CHARS}
                spellCheck={false}
                autoCapitalize="characters"
                defaultValue={config?.keyPrefix ?? ""}
                disabled={busy || config === null}
                onBlur={(event) => handlePrefixBlur(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape" && config !== null) {
                    event.currentTarget.value = config.keyPrefix;
                    setPrefixError(null);
                    event.currentTarget.blur();
                  }
                }}
              />
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) {
            setPendingDelete(null);
            setReassignToId(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {movingCount === 0
                ? "No issues sit in this status, but one still has to be named for anything that lands there mid-delete."
                : `${movingCount === 1 ? "1 issue moves" : `${movingCount} issues move`} to the status you pick. The move is recorded on each issue's activity feed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-4 pb-1">
            <Select
              value={reassignToId}
              onValueChange={(value) => setReassignToId(value as string)}
            >
              <SelectTrigger className="w-full" aria-label="Reassign issues to">
                <SelectValue>
                  {reassignOptions.find((option) => option.id === reassignToId)?.name ??
                    "Choose a status…"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {reassignOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: option.color }}
                      />
                      {option.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || reassignToId === null}
              onClick={handleConfirmDelete}
            >
              {busy ? <Spinner className="size-3.5" /> : null}
              Delete status
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
