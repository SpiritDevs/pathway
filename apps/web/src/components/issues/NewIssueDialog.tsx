/**
 * Create-issue modal. "Create more" keeps the dialog open with the pickers intact, which is the
 * shape of the only bulk entry path stage 1 has that is not a CSV.
 *
 * @module components/issues/NewIssueDialog
 */
import { ISSUE_COMMENT_ATTACHMENT_MAX_BYTES, ISSUE_MAX_PARENT_DEPTH } from "@spiritdevs/contracts";
import type {
  ChatAttachmentId,
  Issue,
  IssueAssignee,
  IssueCreateInput,
  IssueCycleId,
  IssueId,
  IssueLabel,
  IssueLabelId,
  IssueMilestoneId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CalendarRangeIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  EllipsisIcon,
  FlagIcon,
  FolderIcon,
  GitBranchIcon,
  PaperclipIcon,
  SignalHighIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { compressImageToByteLimit } from "~/lib/imageCompression";
import { cn, randomUUID } from "~/lib/utils";
import {
  useCreateIssue,
  useCreateIssueComment,
  useIssueCycles,
  useIssueMilestonesForProject,
  useIssuesStore,
  useUploadIssueCommentAttachment,
} from "~/state/issues";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { readFileAsDataUrl } from "../ChatView.logic";
import { QuickCreateProjectDialog } from "../projects/QuickCreateProjectDialog";
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import {
  IssueCyclePicker,
  IssueMilestonePicker,
  IssueSearchList,
  IssueStatusGlyphFor,
} from "./IssueSelectors";
import {
  buildIssueTreeIndex,
  issueAncestorDepth,
  issueAssigneeOptionValue,
  searchIssues,
} from "./issueDetail.logic";
import {
  ISSUE_PRIORITY_LABELS,
  ISSUE_PRIORITY_ORDER,
  toggleIssueLabelIds,
} from "./issuesList.logic";
import {
  newIssueAttachmentComment,
  newIssueAttachmentDataUrlRejection,
  newIssueAttachmentIntake,
  newIssueAttachmentTooLargeMessage,
} from "./newIssueAttachments";
import { useIssueAssigneeOptions } from "./useIssueAssigneeOptions";

const PICKER_CLASS =
  "flex min-h-7 items-center gap-1.5 rounded-full border border-input bg-input/30 px-2.5 text-xs text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:text-sm";
const PICKER_OPTION_CLASS =
  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";
const PICKER_VIEWPORT_CLASS = "p-1.5 [--viewport-inline-padding:--spacing(1.5)]";
function PickerPopover({
  title,
  trigger,
  children,
  className,
}: {
  title: string;
  trigger: React.ReactElement;
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        align="start"
        className={cn("w-60", className)}
        side="bottom"
        viewportClassName={PICKER_VIEWPORT_CLASS}
      >
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{title}</p>
        {children(() => setOpen(false))}
      </PopoverPopup>
    </Popover>
  );
}

function PickerOption({
  children,
  selected,
  onSelect,
}: {
  children: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={PICKER_OPTION_CLASS} onClick={onSelect} type="button">
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
    </button>
  );
}

interface NewIssueAttachmentDraft {
  readonly id: string;
  readonly name: string;
  readonly file: File;
  readonly previewUrl: string;
}

function PendingNewIssueAttachment({
  attachment,
  onRemove,
}: {
  attachment: NewIssueAttachmentDraft;
  onRemove: (id: string) => void;
}) {
  return (
    <li className="relative size-16 overflow-visible rounded-lg border border-border/60 bg-muted/30">
      <img
        alt={attachment.name}
        className="size-full rounded-[calc(var(--radius-lg)-1px)] object-cover"
        src={attachment.previewUrl}
      />
      <Button
        aria-label={`Remove ${attachment.name}`}
        className="absolute -end-1.5 -top-1.5 rounded-full border border-border/60 bg-background"
        onClick={() => onRemove(attachment.id)}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </li>
  );
}

/**
 * The parents a *new* issue may take. It is a leaf by construction, so the whole rule reduces to
 * "the candidate is not already at the cap" — no subtree to carry and nothing it can be an
 * ancestor of.
 */
function ParentPicker({
  issues,
  value,
  statusById,
  onSelect,
  trigger,
}: {
  issues: ReadonlyMap<IssueId, Issue>;
  value: Issue | null;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onSelect: (parentId: IssueId | null) => void;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const tree = buildIssueTreeIndex(issues.values());
    const allowed = [...tree.byId.values()].filter(
      (candidate) => issueAncestorDepth(tree, candidate.id) + 1 <= ISSUE_MAX_PARENT_DEPTH,
    );
    return searchIssues(allowed, { query });
  }, [issues, query]);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" className="w-72" viewportClassName={PICKER_VIEWPORT_CLASS}>
        <IssueSearchList
          emptyHint="No issue can take a sub-issue here."
          onPick={(picked) => {
            onSelect(picked.id);
            setOpen(false);
          }}
          onQueryChange={setQuery}
          placeholder="Search by key or title…"
          query={query}
          renderStatusGlyph={(candidate) => (
            <IssueStatusGlyphFor issue={candidate} statusById={statusById} />
          )}
          results={results}
        />
        {value === null ? null : (
          <button
            className="mt-1.5 w-full border-t border-border/60 px-1.5 pt-1.5 text-start text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            type="button"
          >
            No parent
          </button>
        )}
      </PopoverPopup>
    </Popover>
  );
}

export function NewIssueDialog({
  open,
  onOpenChange,
  statuses,
  labels,
  projects,
  defaultStatusId,
  defaultProjectId,
  defaultMilestoneId = null,
  defaultCycleId = null,
  defaultParentId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: ReadonlyArray<IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  projects: ReadonlyArray<EnvironmentProject>;
  /** The tab's first status, so a new issue lands where the user is looking. */
  defaultStatusId: IssueStatusId | null;
  defaultProjectId: ProjectId | null;
  defaultMilestoneId?: IssueMilestoneId | null;
  defaultCycleId?: IssueCycleId | null;
  /** Set by "Add sub-issue", which is the only path that opens this dialog with a parent. */
  defaultParentId?: IssueId | null;
}) {
  const ASSIGNEE_OPTIONS = useIssueAssigneeOptions();
  const createIssue = useCreateIssue();
  const createComment = useCreateIssueComment();
  const uploadAttachment = useUploadIssueCommentAttachment();
  const store = useIssuesStore();
  const cycles = useIssueCycles();
  const titleRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState<IssueStatusId | null>(defaultStatusId);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [assignee, setAssignee] = useState<IssueAssignee | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(defaultProjectId);
  const [milestoneId, setMilestoneId] = useState<IssueMilestoneId | null>(defaultMilestoneId);
  const [cycleId, setCycleId] = useState<IssueCycleId | null>(defaultCycleId);
  const [parentId, setParentId] = useState<IssueId | null>(defaultParentId);
  const [labelIds, setLabelIds] = useState<ReadonlyArray<IssueLabelId>>([]);
  const [showMore, setShowMore] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quickCreateProjectOpen, setQuickCreateProjectOpen] = useState(false);
  const [attachments, setAttachments] = useState<ReadonlyArray<NewIssueAttachmentDraft>>([]);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const milestones = useIssueMilestonesForProject(projectId);

  // Reopening starts from the current tab and filter rather than from whatever the last create
  // left behind. "More" opens expanded when something arrived in it — a sub-issue create, a
  // milestone-filtered list — so the field that is already set is visible.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatusId(defaultStatusId);
    setPriority("none");
    setAssignee(null);
    setProjectId(defaultProjectId);
    setMilestoneId(defaultMilestoneId);
    setCycleId(defaultCycleId);
    setParentId(defaultParentId);
    setLabelIds([]);
    for (const attachment of attachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
    setIsDropTarget(false);
    setShowMore(defaultMilestoneId !== null || defaultCycleId !== null || defaultParentId !== null);
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [
    defaultCycleId,
    defaultMilestoneId,
    defaultParentId,
    defaultProjectId,
    defaultStatusId,
    open,
  ]);

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const selectedStatus = statuses.find((status) => status.id === statusId) ?? null;
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedLabels = labels.filter((label) => labelIds.includes(label.id));
  const selectedMilestone = milestones.find((milestone) => milestone.id === milestoneId) ?? null;
  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId) ?? null;
  const selectedParent = parentId === null ? null : (store.issuesById.get(parentId) ?? null);
  const selectedAssignee = ASSIGNEE_OPTIONS.find(
    (option) => option.value === issueAssigneeOptionValue(assignee),
  );
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const canSubmit = title.trim().length > 0 && !submitting;

  const reportAttachmentRejection = useCallback((message: string) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Image not attached", description: message }),
    );
  }, []);

  const addFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const intake = newIssueAttachmentIntake({ files, currentCount: attachments.length });
      if (intake.rejection !== null) reportAttachmentRejection(intake.rejection);
      if (intake.accepted.length === 0) return;
      setAttachments((current) => [
        ...current,
        ...intake.accepted.map((file) => ({
          id: randomUUID(),
          name: file.name.trim().length === 0 ? "Pasted image" : file.name,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    },
    [attachments.length, reportAttachmentRejection],
  );

  const removeAttachment = useCallback((id: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const clearAttachments = () => {
    for (const attachment of attachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
  };

  const prepareAttachments = async () => {
    const prepared: Array<{ readonly name: string; readonly dataUrl: string }> = [];
    for (const attachment of attachments) {
      const compressed = await compressImageToByteLimit(
        attachment.file,
        ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
      );
      if (!compressed.ok) {
        reportAttachmentRejection(
          compressed.reason === "too-large"
            ? newIssueAttachmentTooLargeMessage(attachment.name)
            : `${attachment.name} could not be read as an image.`,
        );
        return null;
      }
      const dataUrl = await readFileAsDataUrl(compressed.file).catch(() => null);
      if (dataUrl === null) {
        reportAttachmentRejection(`${attachment.name} could not be read as an image.`);
        return null;
      }
      const rejection = newIssueAttachmentDataUrlRejection({ name: attachment.name, dataUrl });
      if (rejection !== null) {
        reportAttachmentRejection(rejection);
        return null;
      }
      prepared.push({ name: attachment.name, dataUrl });
    }
    return prepared;
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    const preparedAttachments = await prepareAttachments();
    if (preparedAttachments === null) {
      setSubmitting(false);
      return;
    }
    const input: IssueCreateInput = {
      title: trimmed,
      ...(description.length > 0 ? { description } : {}),
      ...(statusId === null ? {} : { statusId }),
      ...(priority === "none" ? {} : { priority }),
      ...(assignee === null ? {} : { assignee }),
      ...(projectId === null ? {} : { projectId }),
      // A milestone belongs to a project, so it only travels with one.
      ...(milestoneId === null || projectId === null ? {} : { milestoneId }),
      ...(cycleId === null ? {} : { cycleId }),
      ...(parentId === null ? {} : { parentId }),
      ...(labelIds.length > 0 ? { labelIds } : {}),
    };
    const result = await createIssue(input);
    // The dialog stays open on a refusal with the draft intact: the server can reject a create the
    // form cannot pre-empt (a status deleted from another tab, a tracker with no statuses at all).
    if (reportIssueWriteFailure("Failed to create the issue", result)) {
      setSubmitting(false);
      return;
    }
    if (!AsyncResult.isSuccess(result)) {
      setSubmitting(false);
      return;
    }

    if (preparedAttachments.length > 0) {
      const attachmentIds: ChatAttachmentId[] = [];
      for (const attachment of preparedAttachments) {
        const uploadResult = await uploadAttachment({
          issueId: result.value.issue.id,
          dataUrl: attachment.dataUrl,
        });
        if (!AsyncResult.isSuccess(uploadResult)) {
          reportIssueWriteFailure(
            `Issue ${result.value.issue.key} was created, but ${attachment.name} could not be attached`,
            uploadResult,
          );
          clearAttachments();
          setSubmitting(false);
          onOpenChange(false);
          return;
        }
        attachmentIds.push(uploadResult.value.attachmentId);
      }

      const commentResult = await createComment({
        issueId: result.value.issue.id,
        body: newIssueAttachmentComment(attachmentIds.length),
        attachmentIds,
      });
      if (!AsyncResult.isSuccess(commentResult)) {
        reportIssueWriteFailure(
          `Issue ${result.value.issue.key} was created, but its attachments could not be added`,
          commentResult,
        );
        clearAttachments();
        setSubmitting(false);
        onOpenChange(false);
        return;
      }
    }

    clearAttachments();
    setSubmitting(false);
    if (createMore) {
      setTitle("");
      setDescription("");
      titleRef.current?.focus();
      return;
    }
    onOpenChange(false);
  };

  return (
    <>
      {/* Sibling, not nested: a dialog inside a dialog's popup would close with it. */}
      <QuickCreateProjectDialog
        environmentId={primaryEnvironmentId}
        onCreated={(created) => {
          setProjectId(created.projectId);
          setMilestoneId(null);
        }}
        onOpenChange={setQuickCreateProjectOpen}
        open={quickCreateProjectOpen}
      />
      <Dialog
        onOpenChange={(nextOpen) => {
          if (submitting) return;
          if (!nextOpen) clearAttachments();
          onOpenChange(nextOpen);
        }}
        open={open}
      >
        <DialogPopup className="h-[min(16.25rem,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-[47rem] overflow-hidden max-sm:h-[calc(100vh-3rem)]">
          <DialogHeader className="flex-row items-center gap-1.5 px-4 py-2.5">
            <span className="inline-flex min-h-7 items-center rounded-full border border-border/70 bg-muted/70 px-2.5 font-medium text-xs text-muted-foreground">
              {store.config?.keyPrefix ?? "ISS"}
            </span>
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
            <DialogTitle className="font-sans text-base">New issue</DialogTitle>
            <DialogDescription className="sr-only">
              {selectedProject === null
                ? "Create an issue on this environment."
                : `Create an issue in ${selectedProject.title}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel
            className={cn(
              "flex h-full min-h-0 flex-col gap-2 px-4 pb-3 pt-2",
              isDropTarget && "bg-primary/[0.035] outline-2 outline-inset outline-ring",
            )}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDropTarget(false);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setIsDropTarget(false);
              addFiles([...event.dataTransfer.files]);
            }}
            scrollFade={false}
          >
            <input
              aria-label="Issue title"
              className="w-full bg-transparent font-semibold text-xl leading-tight text-foreground outline-none placeholder:text-muted-foreground/55"
              onChange={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submit();
              }}
              placeholder="Issue title"
              ref={titleRef}
              value={title}
            />
            <textarea
              aria-label="Issue description"
              className="min-h-10 w-full flex-1 resize-none bg-transparent text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/55"
              onChange={(event) => setDescription(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                void submit();
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length === 0) return;
                event.preventDefault();
                addFiles(files);
              }}
              placeholder="Add description…"
              value={description}
            />

            {attachments.length === 0 ? null : (
              <ul className="flex flex-wrap gap-2" aria-label="Issue attachments">
                {attachments.map((attachment) => (
                  <PendingNewIssueAttachment
                    attachment={attachment}
                    key={attachment.id}
                    onRemove={removeAttachment}
                  />
                ))}
              </ul>
            )}

            <div className="mt-auto flex flex-wrap items-center gap-2">
              <PickerPopover
                title="Status"
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {selectedStatus === null ? (
                      <CircleDotIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssueStatusDot status={selectedStatus} />
                    )}
                    {selectedStatus?.name ?? "Status"}
                  </button>
                }
              >
                {(close) =>
                  statuses.map((status) => (
                    <PickerOption
                      key={status.id}
                      onSelect={() => {
                        setStatusId(status.id);
                        close();
                      }}
                      selected={status.id === statusId}
                    >
                      <IssueStatusDot status={status} />
                      <span className="truncate">{status.name}</span>
                    </PickerOption>
                  ))
                }
              </PickerPopover>

              <PickerPopover
                title="Priority"
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {priority === "none" ? (
                      <SignalHighIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssuePriorityIcon priority={priority} />
                    )}
                    {priority === "none" ? "Priority" : ISSUE_PRIORITY_LABELS[priority]}
                  </button>
                }
              >
                {(close) =>
                  ISSUE_PRIORITY_ORDER.map((option) => (
                    <PickerOption
                      key={option}
                      onSelect={() => {
                        setPriority(option);
                        close();
                      }}
                      selected={option === priority}
                    >
                      <IssuePriorityIcon priority={option} />
                      {ISSUE_PRIORITY_LABELS[option]}
                    </PickerOption>
                  ))
                }
              </PickerPopover>

              <PickerPopover
                title="Assignee"
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <IssueAssigneeGlyph
                      assignee={assignee}
                      className="size-3.5"
                      label={selectedAssignee?.label}
                    />
                    {selectedAssignee?.label ?? "Assignee"}
                  </button>
                }
              >
                {(close) =>
                  ASSIGNEE_OPTIONS.map((option) => (
                    <PickerOption
                      key={option.value}
                      onSelect={() => {
                        setAssignee(option.assignee);
                        close();
                      }}
                      selected={option.value === issueAssigneeOptionValue(assignee)}
                    >
                      <IssueAssigneeGlyph
                        assignee={option.assignee}
                        className="size-4"
                        label={option.label}
                      />
                      {option.label}
                    </PickerOption>
                  ))
                }
              </PickerPopover>

              <PickerPopover
                title="Project"
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <FolderIcon className="size-3.5 text-muted-foreground" />
                    {selectedProject?.title ?? "Project"}
                  </button>
                }
              >
                {(close) => (
                  <>
                    <PickerOption
                      onSelect={() => {
                        setProjectId(null);
                        setMilestoneId(null);
                        close();
                      }}
                      selected={projectId === null}
                    >
                      <span className="text-muted-foreground">No project</span>
                    </PickerOption>
                    {projects.map((project) => (
                      <PickerOption
                        key={project.id}
                        onSelect={() => {
                          setProjectId(project.id);
                          setMilestoneId(null);
                          close();
                        }}
                        selected={project.id === projectId}
                      >
                        <FolderIcon className="size-4 text-muted-foreground" />
                        <span className="truncate">{project.title}</span>
                      </PickerOption>
                    ))}
                    <button
                      className="mt-1 min-h-8 w-full border-t border-border/60 px-2 pt-2 text-start text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                      onClick={() => {
                        close();
                        setQuickCreateProjectOpen(true);
                      }}
                      type="button"
                    >
                      Create project…
                    </button>
                  </>
                )}
              </PickerPopover>

              <PickerPopover
                title="Labels"
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <TagIcon className="size-3.5 text-muted-foreground" />
                    {selectedLabels.length === 0
                      ? "Labels"
                      : selectedLabels.length === 1
                        ? selectedLabels[0]?.name
                        : `${selectedLabels[0]?.name} +${selectedLabels.length - 1}`}
                  </button>
                }
              >
                {() =>
                  labels.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      No labels yet — add them in Settings → Labels.
                    </p>
                  ) : (
                    labels.map((label) => (
                      <PickerOption
                        key={label.id}
                        onSelect={() =>
                          setLabelIds((current) => toggleIssueLabelIds(current, label.id))
                        }
                        selected={labelIds.includes(label.id)}
                      >
                        <IssueLabelDot color={label.color} />
                        <span className="truncate">{label.name}</span>
                      </PickerOption>
                    ))
                  )
                }
              </PickerPopover>

              <button
                aria-label={showMore ? "Hide more issue properties" : "Show more issue properties"}
                className={cn(PICKER_CLASS, "size-7 justify-center px-0 pointer-coarse:size-11")}
                onClick={() => setShowMore((current) => !current)}
                type="button"
              >
                <EllipsisIcon className="size-4 text-muted-foreground" />
              </button>
            </div>

            {showMore ? (
              <div className="flex flex-wrap items-center gap-2">
                <IssueMilestonePicker
                  hasProject={projectId !== null}
                  milestones={milestones}
                  onSelect={setMilestoneId}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <FlagIcon className="size-3.5 text-muted-foreground" />
                      {selectedMilestone?.name ?? "Milestone"}
                    </button>
                  }
                  value={milestoneId}
                />
                <IssueCyclePicker
                  cycles={cycles}
                  onSelect={setCycleId}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <CalendarRangeIcon className="size-3.5 text-muted-foreground" />
                      {selectedCycle?.name ?? "Cycle"}
                    </button>
                  }
                  value={cycleId}
                />
                <ParentPicker
                  issues={store.issuesById}
                  onSelect={setParentId}
                  statusById={statusById}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <GitBranchIcon className="size-3.5 text-muted-foreground" />
                      <span className="max-w-40 truncate">
                        {selectedParent === null ? "Parent" : selectedParent.key}
                      </span>
                    </button>
                  }
                  value={selectedParent}
                />
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter
            className="flex-row items-center gap-3 border-t border-border/50 bg-transparent px-4 py-2.5"
            variant="bare"
          >
            <input
              accept="image/*"
              className="sr-only"
              multiple
              onChange={(event) => {
                addFiles([...(event.currentTarget.files ?? [])]);
                event.currentTarget.value = "";
              }}
              ref={attachmentInputRef}
              type="file"
            />
            <Button
              aria-label="Attach images"
              className="me-auto rounded-full"
              disabled={submitting}
              onClick={() => attachmentInputRef.current?.click()}
              size="icon-sm"
              variant="outline"
            >
              <PaperclipIcon />
            </Button>
            {attachments.length === 0 ? null : (
              <span className="text-xs text-muted-foreground max-sm:hidden">
                {attachments.length} {attachments.length === 1 ? "image" : "images"}
              </span>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={createMore} disabled={submitting} onCheckedChange={setCreateMore} />
              Create more
            </label>
            <Button
              className="rounded-full px-4"
              disabled={!canSubmit}
              onClick={() => void submit()}
              size="sm"
              type="button"
            >
              {submitting ? "Creating…" : "Create issue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
