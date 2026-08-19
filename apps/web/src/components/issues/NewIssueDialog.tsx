/**
 * Create-issue modal. "Create more" keeps the dialog open with the pickers intact, which is the
 * shape of the only bulk entry path stage 1 has that is not a CSV.
 *
 * @module components/issues/NewIssueDialog
 */
import { useAtomValue } from "@effect/atom-react";
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_MAX_PARENT_DEPTH,
  ProjectId,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
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
} from "@spiritdevs/contracts";
import { ISSUE_KEY_DRAFT_PLACEHOLDER } from "@spiritdevs/contracts/cloudSync";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CalendarRangeIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  EllipsisIcon,
  FlagIcon,
  FolderIcon,
  GitBranchIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaperclipIcon,
  SignalHighIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { compressImageToByteLimit } from "~/lib/imageCompression";
import { cn, randomUUID } from "~/lib/utils";
import {
  activeCompanyIdAtom,
  companyListAtom,
  scopedCompanyRegistryReplicasAtom,
} from "~/cloud/activeCompany";
import { useReplicaIssueAttachmentCloud } from "~/cloud/issueAttachmentClient";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useSyncIssueOperations } from "~/cloud/issueDomainMutations";
import {
  useCompanyIssuesStore,
  useCreateIssue,
  useCreateIssueComment,
  useCreateIssueLabel,
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
import { IssueAssigneeGlyph, IssuePriorityIcon, IssueStatusDot } from "./IssueGlyphs";
import {
  IssueCyclePicker,
  IssueMilestonePicker,
  IssueSearchList,
  IssueStatusGlyphFor,
} from "./IssueSelectors";
import { IssueLabelsPicker } from "./IssueLabelsPicker";
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
import {
  canResizeNewIssueDialog,
  groupIssueProjectsByCompany,
  issueProjectsForCompany,
  resolveIssueProjectOptionId,
} from "./newIssueDialog.logic";
import type { IssueProjectOption } from "./useIssueProjectOptions";

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
  statuses: statusesProp,
  labels: labelsProp,
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
  projects: ReadonlyArray<IssueProjectOption>;
  /** The tab's first status, so a new issue lands where the user is looking. */
  defaultStatusId: IssueStatusId | null;
  defaultProjectId: ProjectId | null;
  defaultMilestoneId?: IssueMilestoneId | null;
  defaultCycleId?: IssueCycleId | null;
  /** Set by "Add sub-issue", which is the only path that opens this dialog with a parent. */
  defaultParentId?: IssueId | null;
}) {
  const ASSIGNEE_OPTIONS = useIssueAssigneeOptions();
  const uploadAttachment = useUploadIssueCommentAttachment();
  const syncIssueOperations = useSyncIssueOperations();
  const store = useIssuesStore();
  const globalCycles = useIssueCycles();
  const activeCompanyId = useAtomValue(activeCompanyIdAtom);
  const companies = useAtomValue(companyListAtom);
  const replicaRouted = useAtomValue(scopedCompanyRegistryReplicasAtom).size > 0;

  // The dialog owns its own destination. The app-wide scope only seeds it: All companies has no
  // single target, and until now that simply refused the create. Choosing here files the issue
  // somewhere without moving the workspace the user is looking at.
  const [companyId, setCompanyId] = useState<CompanyId | null>(activeCompanyId);
  const companyRequired = replicaRouted && companyId === null;
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;

  // Statuses, labels, cycles, and parents all belong to exactly one company, and the props carry
  // whatever the app-wide scope holds. Once this dialog aims somewhere else, they have to come
  // from that company's replica or the create enqueues a cross-company reference the mutation
  // router rejects. When the two agree the props are already right, so nothing is substituted.
  const retargeted = replicaRouted && companyId !== null && companyId !== activeCompanyId;
  const retargetedStore = useCompanyIssuesStore(retargeted ? companyId : null).store;
  const statuses = retargeted ? retargetedStore.statuses : statusesProp;
  const labels = retargeted ? retargetedStore.labels : labelsProp;
  const cycles = retargeted ? retargetedStore.cycles : globalCycles;
  const issuesById = retargeted ? retargetedStore.issuesById : store.issuesById;
  const keyPrefix = selectedCompany?.issueKeyPrefix ?? store.config?.keyPrefix ?? "ISS";

  const createIssue = useCreateIssue(companyId);
  const createComment = useCreateIssueComment(companyId);
  const createLabel = useCreateIssueLabel(companyId);
  const attachmentCloud = useReplicaIssueAttachmentCloud(companyId);
  const environmentControl = useEnvironmentControl();
  const availableProjects = useMemo(
    () => issueProjectsForCompany(projects, companyId),
    [companyId, projects],
  );
  const projectGroups = useMemo(
    () => (companyId === null ? groupIssueProjectsByCompany(projects, companies) : []),
    [companies, companyId, projects],
  );
  // Deliberately resolved against the unfiltered list: narrowing it by company would make this
  // change whenever the destination does, and the reset effect below keys off it — a company
  // switch would wipe the title the user had already typed. A default the chosen company does
  // not own is dropped by the pruning effect instead.
  const availableDefaultProjectId = resolveIssueProjectOptionId(defaultProjectId, projects);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState<IssueStatusId | null>(defaultStatusId);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [assignee, setAssignee] = useState<IssueAssignee | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(availableDefaultProjectId);
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
  const [isMaximized, setIsMaximized] = useState(false);
  const [canResize, setCanResize] = useState(true);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const milestones = useIssueMilestonesForProject(projectId);

  // Reopening starts from the current tab and filter rather than from whatever the last create
  // left behind. "More" opens expanded when something arrived in it — a sub-issue create, a
  // milestone-filtered list — so the field that is already set is visible.
  useEffect(() => {
    if (!open) {
      setIsMaximized(false);
      setCanResize(true);
      return;
    }
    setTitle("");
    setDescription("");
    setCompanyId(activeCompanyId);
    setStatusId(defaultStatusId);
    setPriority("none");
    setAssignee(null);
    setProjectId(availableDefaultProjectId);
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
    activeCompanyId,
    defaultCycleId,
    defaultMilestoneId,
    defaultParentId,
    availableDefaultProjectId,
    defaultStatusId,
    open,
  ]);

  // Changing the destination invalidates every field that names a company-owned entity. Prune
  // rather than clear on the switch itself: the retargeted replica arrives asynchronously, so the
  // check has to re-run whenever the scoped data does.
  useEffect(() => {
    if (statusId !== null && !statuses.some((status) => status.id === statusId)) {
      setStatusId(statuses[0]?.id ?? null);
    }
    setLabelIds((current) =>
      current.every((id) => labels.some((label) => label.id === id))
        ? current
        : current.filter((id) => labels.some((label) => label.id === id)),
    );
    if (cycleId !== null && !cycles.some((cycle) => cycle.id === cycleId)) setCycleId(null);
    if (parentId !== null && !issuesById.has(parentId)) setParentId(null);
    if (projectId !== null && !availableProjects.some((project) => project.id === projectId)) {
      setProjectId(null);
      setMilestoneId(null);
    }
  }, [
    availableProjects,
    cycleId,
    cycles,
    issuesById,
    labels,
    parentId,
    projectId,
    statusId,
    statuses,
  ]);

  useLayoutEffect(() => {
    if (!open || isMaximized) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const nextCanResize = canResizeNewIssueDialog({
      dialogHeight: dialog.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    });
    setCanResize((current) => (current === nextCanResize ? current : nextCanResize));
  }, [attachments.length, isMaximized, open, showMore]);

  useEffect(() => {
    if (!open || isMaximized) return;
    const measure = () => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const nextCanResize = canResizeNewIssueDialog({
        dialogHeight: dialog.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      });
      setCanResize((current) => (current === nextCanResize ? current : nextCanResize));
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isMaximized, open]);

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const selectedStatus = statuses.find((status) => status.id === statusId) ?? null;
  const selectedProject = availableProjects.find((project) => project.id === projectId) ?? null;
  const selectedLabels = labels.filter((label) => labelIds.includes(label.id));
  const selectedMilestone = milestones.find((milestone) => milestone.id === milestoneId) ?? null;
  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId) ?? null;
  const selectedParent = parentId === null ? null : (issuesById.get(parentId) ?? null);
  const selectedAssignee = ASSIGNEE_OPTIONS.find(
    (option) => option.value === issueAssigneeOptionValue(assignee),
  );
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const canSubmit = title.trim().length > 0 && !submitting && !companyRequired;

  const handleCreateLabel = useCallback(
    async (input: { readonly name: string; readonly color: string }) => {
      if (companyRequired) {
        toastManager.add({
          type: "error",
          title: "Choose a company",
          description: "Labels belong to one company and cannot be created in All companies.",
        });
        return false;
      }
      const created = await createLabel(input);
      if (reportIssueWriteFailure("Failed to create the label", created)) return false;
      if (!AsyncResult.isSuccess(created)) return false;
      setLabelIds((current) => [...current, created.value.label.id]);
      return true;
    },
    [companyRequired, createLabel],
  );

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
    const prepared: Array<{
      readonly name: string;
      readonly file: File;
      readonly dataUrl: string | null;
    }> = [];
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
      let dataUrl: string | null = null;
      if (attachmentCloud === null) {
        dataUrl = await readFileAsDataUrl(compressed.file).catch(() => null);
        if (dataUrl === null) {
          reportAttachmentRejection(`${attachment.name} could not be read as an image.`);
          return null;
        }
        const rejection = newIssueAttachmentDataUrlRejection({ name: attachment.name, dataUrl });
        if (rejection !== null) {
          reportAttachmentRejection(rejection);
          return null;
        }
      }
      prepared.push({ name: attachment.name, file: compressed.file, dataUrl });
    }
    return prepared;
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    if (companyRequired) {
      toastManager.add({
        type: "error",
        title: "Choose a company",
        description: "New issues belong to one company. Select a company before creating one.",
      });
      return;
    }
    setSubmitting(true);
    const preparedAttachments = await prepareAttachments();
    if (preparedAttachments === null) {
      setSubmitting(false);
      return;
    }
    if (preparedAttachments.length > 0 && attachmentCloud !== null && !attachmentCloud.isOnline) {
      reportAttachmentRejection(
        "Attachments need an internet connection on cloud-synced issues. You can still create the issue without the image.",
      );
      setSubmitting(false);
      return;
    }
    const submittedProjectId = resolveIssueProjectOptionId(projectId, availableProjects);
    if (
      companyId !== null &&
      submittedProjectId !== null &&
      selectedProject !== null &&
      !selectedProject.isCompanyProject
    ) {
      const localProject = selectedProject.localProject;
      if (localProject === null || environmentControl === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Project is not available in the cloud",
            description: "Sign in and register this environment before assigning its projects.",
          }),
        );
        setSubmitting(false);
        return;
      }
      try {
        await environmentControl.ensureEnvironmentProject({
          companyId,
          project: localProject,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add the project to the company",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        setSubmitting(false);
        return;
      }
    }
    const input: IssueCreateInput = {
      title: trimmed,
      ...(description.length > 0 ? { description } : {}),
      ...(statusId === null ? {} : { statusId }),
      ...(priority === "none" ? {} : { priority }),
      ...(assignee === null ? {} : { assignee }),
      ...(submittedProjectId === null ? {} : { projectId: submittedProjectId }),
      // A milestone belongs to a project, so it only travels with one.
      ...(milestoneId === null || submittedProjectId === null ? {} : { milestoneId }),
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
    const createdIssueLabel =
      result.value.issue.key === ISSUE_KEY_DRAFT_PLACEHOLDER
        ? "Issue"
        : `Issue ${result.value.issue.key}`;

    if (preparedAttachments.length > 0) {
      if (attachmentCloud !== null && companyId !== null) {
        const syncResult = await syncIssueOperations(companyId);
        if (!AsyncResult.isSuccess(syncResult)) {
          reportIssueWriteFailure(
            `${createdIssueLabel} was created, but could not be synced before attaching ${preparedAttachments[0]?.name ?? "the image"}`,
            syncResult,
          );
          clearAttachments();
          setSubmitting(false);
          onOpenChange(false);
          return;
        }
        if (
          syncResult.value.rejectedOperations > 0 ||
          syncResult.value.outcome === "offline" ||
          syncResult.value.outcome === "failed" ||
          syncResult.value.outcome === "disabled"
        ) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `${createdIssueLabel} could not be synced before attaching the image`,
              description:
                syncResult.value.error?.message ??
                "The issue is still pending sync. Try attaching the image from the issue after reconnecting.",
            }),
          );
          clearAttachments();
          setSubmitting(false);
          onOpenChange(false);
          return;
        }
      }
      const attachmentIds: ChatAttachmentId[] = [];
      for (const attachment of preparedAttachments) {
        if (attachmentCloud !== null) {
          try {
            attachmentIds.push(
              await attachmentCloud.client.upload({
                companyId: attachmentCloud.companyId,
                issueId: result.value.issue.id,
                clientRequestId: randomUUID(),
                fileName: attachment.name,
                file: attachment.file,
              }),
            );
          } catch (error) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `${createdIssueLabel} was created, but ${attachment.name} could not be attached`,
                description:
                  error instanceof Error ? error.message : "The attachment upload failed.",
              }),
            );
            clearAttachments();
            setSubmitting(false);
            onOpenChange(false);
            return;
          }
        } else {
          if (attachment.dataUrl === null) {
            reportAttachmentRejection(`${attachment.name} could not be read as an image.`);
            clearAttachments();
            setSubmitting(false);
            onOpenChange(false);
            return;
          }
          const uploadResult = await uploadAttachment({
            issueId: result.value.issue.id,
            dataUrl: attachment.dataUrl,
          });
          if (!AsyncResult.isSuccess(uploadResult)) {
            reportIssueWriteFailure(
              `${createdIssueLabel} was created, but ${attachment.name} could not be attached`,
              uploadResult,
            );
            clearAttachments();
            setSubmitting(false);
            onOpenChange(false);
            return;
          }
          attachmentIds.push(uploadResult.value.attachmentId);
        }
      }

      const commentResult = await createComment({
        issueId: result.value.issue.id,
        body: newIssueAttachmentComment(attachmentIds.length),
        attachmentIds,
      });
      if (!AsyncResult.isSuccess(commentResult)) {
        reportIssueWriteFailure(
          `${createdIssueLabel} was created, but its attachments could not be added`,
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
          if (!nextOpen) {
            clearAttachments();
            setIsMaximized(false);
            setCanResize(true);
          }
          onOpenChange(nextOpen);
        }}
        open={open}
      >
        <DialogPopup
          className={cn(
            "min-h-[min(16.25rem,90dvh)] w-[calc(100vw-2rem)] max-w-[47rem] overflow-hidden max-h-[90dvh] max-sm:h-[90dvh]",
            isMaximized && "h-[90dvh]",
          )}
          ref={dialogRef}
        >
          {canResize ? (
            <Button
              aria-label={isMaximized ? "Minimize new issue dialog" : "Maximize new issue dialog"}
              className="absolute end-12 top-2"
              onClick={() => setIsMaximized((current) => !current)}
              size="icon"
              title={isMaximized ? "Minimize" : "Maximize"}
              type="button"
              variant="ghost"
            >
              {isMaximized ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          ) : null}
          <DialogHeader className="flex-row items-center gap-1.5 px-4 py-2.5">
            {companies.length > 1 ? (
              <PickerPopover
                title="Company"
                trigger={
                  <button
                    aria-label={
                      selectedCompany === null
                        ? "Choose a company for this issue"
                        : `Company: ${selectedCompany.name}`
                    }
                    className={cn(
                      "inline-flex min-h-7 items-center gap-1 rounded-full border border-border/70 bg-muted/70 ps-2.5 pe-1.5 font-medium text-xs outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                      // Unset is the one state that blocks the create, so it is the one state
                      // that asks to be pressed.
                      companyRequired ? "text-foreground" : "text-muted-foreground",
                    )}
                    type="button"
                  >
                    {companyRequired ? "Company" : keyPrefix}
                    <ChevronDownIcon className="size-3 opacity-70" />
                  </button>
                }
              >
                {(close) =>
                  companies.map((company) => (
                    <PickerOption
                      key={company.id}
                      onSelect={() => {
                        setCompanyId(company.id);
                        close();
                      }}
                      selected={company.id === companyId}
                    >
                      <span className="inline-flex min-w-9 shrink-0 justify-center rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {company.issueKeyPrefix}
                      </span>
                      <span className="truncate">{company.name}</span>
                    </PickerOption>
                  ))
                }
              </PickerPopover>
            ) : (
              <span className="inline-flex min-h-7 items-center rounded-full border border-border/70 bg-muted/70 px-2.5 font-medium text-xs text-muted-foreground">
                {keyPrefix}
              </span>
            )}
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
                    {companyId === null
                      ? // No destination yet, so the flat list would mix workspaces. Grouping
                        // names the owner of every project, and picking one commits the issue to
                        // that company — the same choice the header chip makes, from the other end.
                        projectGroups.map((group) => (
                          <Fragment key={group.companyId ?? "no-company"}>
                            {group.heading === null ? null : (
                              <p className="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground/70">
                                {group.heading}
                              </p>
                            )}
                            {group.projects.map((project) => (
                              <PickerOption
                                key={`${group.companyId ?? "no-company"}:${project.id}`}
                                onSelect={() => {
                                  if (group.companyId !== null) {
                                    setCompanyId(CompanyId.make(group.companyId));
                                  }
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
                          </Fragment>
                        ))
                      : availableProjects.map((project) => (
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

              <IssueLabelsPicker
                labels={labels}
                onCreate={handleCreateLabel}
                onToggle={(labelId) =>
                  setLabelIds((current) => toggleIssueLabelIds(current, labelId))
                }
                selectedLabelIds={labelIds}
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
              />

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
                  issues={issuesById}
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
            {companyRequired ? (
              <span className="me-auto text-xs text-muted-foreground">
                Choose a company to create an issue.
              </span>
            ) : null}
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
