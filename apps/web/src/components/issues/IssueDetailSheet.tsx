/**
 * The issue detail sheet — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * It shares `RightPanelSheet`'s geometry (the same `useResizableWidth`, the same max-width clamp,
 * the same popup classes) but not its `Sheet`, because it is deliberately **non-modal**: the
 * decision record puts the detail in a sheet rather than a page so the list stays visible for
 * triage, and a modal one would blur the list behind a backdrop and trap focus away from `j`/`k`.
 * The viewport stays click-through so clicking another row can replace the open issue; any outside
 * press also dismisses the current sheet.
 *
 * @module components/issues/IssueDetailSheet
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatAttachmentId,
  Issue,
  IssueAssignee,
  IssueComment,
  IssueCommentId,
  IssueCycleId,
  IssueDate,
  IssueEnrichmentRunId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssuePatch,
  IssuePriority,
  IssueRelationCreateInput,
  IssueRelationId,
  IssueStatusId,
  IssueTodo,
  IssueTodoId,
  IssueTodoPatch,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { SearchXIcon, Trash2Icon, UnplugIcon, WandSparklesIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn, newMessageId } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
} from "~/rightPanelLayout";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProjects, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerProvidersAtom } from "~/state/server";
import {
  issueRelationDisplays,
  useCancelIssueEnrichment,
  useCreateIssueComment,
  useCreateIssueLabel,
  useCreateIssueMilestone,
  useCreateIssueRelation,
  useCreateIssueTodo,
  useDeleteIssue,
  useDeleteIssueComment,
  useDeleteIssueRelation,
  useDeleteIssueTodo,
  useIssue,
  useIssueChildRollup,
  useIssueCycles,
  useIssueDetail,
  useIssueEnrichmentRuns,
  useIssueEvents,
  useIssueLabels,
  useLinkIssueThread,
  useIssueMilestonesForProject,
  useIssueStatuses,
  useIssueThreadLinks,
  useIssuesStore,
  useIssuesStoreStatus,
  useReorderIssueTodos,
  useRestoreIssue,
  useStartIssueEnrichment,
  useTriageAccept,
  useUnlinkIssueThread,
  useUpdateIssue,
  useUpdateIssueComment,
  useUpdateIssueTodo,
} from "~/state/issues";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import { useRightPanelSheetMaxWidth } from "../RightPanelSheet";
import { PREVIEW_PANEL_MIN_WIDTH } from "../preview/PreviewPanelShell";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Textarea } from "../ui/textarea";
import { IssueActivityFeed } from "./IssueActivityFeed";
import { readFileAsDataUrl } from "../ChatView.logic";
import { IssueActionPanel } from "./IssueActionPanel";
import { IssueAgentSection } from "./IssueAgentSection";
import { IssueAttachments } from "./IssueAttachments";
import { IssueComments } from "./IssueComments";
import { IssueDescriptionEditor } from "./IssueDescriptionEditor";
import { IssueDetailProperties } from "./IssueDetailProperties";
import { IssueDetailTabs, type IssueDetailTab } from "./IssueDetailTabs";
import { IssueEnrichmentPanel } from "./IssueEnrichmentPanel";
import { IssueRelationsSection } from "./IssueRelationsSection";
import { IssueSubIssues } from "./IssueSubIssues";
import { IssueTodoList } from "./IssueTodoList";
import { IssueDeleteMenu } from "./IssuePropertyMenus";
import { reportIssueWriteFailure as reportFailure } from "./issueWriteFeedback";
import {
  issueAssigneePatch,
  issueCommentUpdatePatch,
  issueCyclePatch,
  issueDescriptionPatch,
  issueDueDatePatch,
  issueLabelTogglePatch,
  issueMilestonePatch,
  issueParentPatch,
  issuePriorityPatch,
  issueProjectPatch,
  issueStatusPatch,
  issueTitlePatch,
  resolveIssueDetailState,
} from "./issueDetail.logic";
import {
  ISSUE_INVESTIGATE_BLOCK_REASONS,
  activeIssueEnrichmentRun,
  issueApplyDescriptionPatch,
  issueApplyLabelPatch,
  issueApplyPriorityPatch,
  issueApplyTitlePatch,
  issueInvestigateBlock,
} from "./issueEnrichment.logic";
import {
  buildIssueStartWorkPrompt,
  issueDetailUrl,
  issueStartWorkAttachmentIds,
  issueStartWorkTodos,
  resolveIssueStartWorkModelSelection,
  resolveIssueStartWorkStatusId,
  resolveIssueStartWorkWorkspacePlan,
  type IssueStartWorkRelation,
  type IssueStartWorkWorkspaceMode,
} from "./issueStartWork.logic";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";

export const ISSUE_DETAIL_SHEET_WIDTH_STORAGE_KEY = "pathway:issue-detail-sheet-width";
/** Wide enough that the properties rail sits beside the body at the width it first opens. */
export const ISSUE_DETAIL_SHEET_DEFAULT_WIDTH = 640;
const ISSUE_DETAIL_PROPERTIES_WIDTH_STORAGE_KEY = "pathway:issue-detail-properties-width";
const ISSUE_DETAIL_PROPERTIES_DEFAULT_WIDTH = 224;
const ISSUE_DETAIL_PROPERTIES_MIN_WIDTH = 192;
const ISSUE_DETAIL_PROPERTIES_MAX_WIDTH = 480;
const ISSUE_DETAIL_PROPERTIES_KEYBOARD_STEP = 16;
/** Main-column width plus the sheet padding and split-column gap. */
const ISSUE_DETAIL_MAIN_COLUMN_RESERVE = 372;

/**
 * How long a `?issue=` that has not resolved is given before it is called a bad link. The stream
 * has no snapshot variant, so the store reports `ready` on the first chunk of its opening replay
 * and a deep link can outrun the row it names.
 */
const NOT_FOUND_GRACE_MS = 600;

/** Stable empties so an unloaded tail does not remount the checklist and the thread on every read. */
const EMPTY_TODOS: ReadonlyArray<IssueTodo> = Object.freeze([]);
const EMPTY_COMMENTS: ReadonlyArray<IssueComment> = Object.freeze([]);
const GROWING_TEXTAREA_CLASS_NAME =
  "border-transparent bg-transparent shadow-none before:hidden hover:border-input [&_[data-slot=textarea]]:min-h-9 [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:overflow-hidden max-sm:[&_[data-slot=textarea]]:min-h-9 dark:bg-transparent";

export function IssueDetailSheet({
  issueKey,
  onClose,
  onOpenIssueKey,
  startWorkRequestProvider = null,
  startWorkRequestProjectId = null,
  onStartWorkRequestHandled,
}: {
  /** The `?issue=` value: an issue key such as `PAT-221`, or null when the sheet is shut. */
  issueKey: string | null;
  onClose: () => void;
  /** Reopens the sheet on an undone delete, which arrives after the sheet has already closed. */
  onOpenIssueKey: (key: string) => void;
  /** A triage Start Task press waiting for the accepted assignment to reach this sheet. */
  startWorkRequestProvider?: ProviderDriverKind | null;
  startWorkRequestProjectId?: ProjectId | null;
  onStartWorkRequestHandled?: () => void;
}) {
  const maxWidth = useRightPanelSheetMaxWidth();
  const sheetSize = useResizableWidth({
    storageKey: ISSUE_DETAIL_SHEET_WIDTH_STORAGE_KEY,
    defaultWidth: ISSUE_DETAIL_SHEET_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  const propertiesMaxWidth = Math.max(
    ISSUE_DETAIL_PROPERTIES_MIN_WIDTH,
    Math.min(ISSUE_DETAIL_PROPERTIES_MAX_WIDTH, sheetSize.width - ISSUE_DETAIL_MAIN_COLUMN_RESERVE),
  );
  const propertiesSize = useResizableWidth({
    storageKey: ISSUE_DETAIL_PROPERTIES_WIDTH_STORAGE_KEY,
    defaultWidth: ISSUE_DETAIL_PROPERTIES_DEFAULT_WIDTH,
    minWidth: ISSUE_DETAIL_PROPERTIES_MIN_WIDTH,
    maxWidth: propertiesMaxWidth,
    edge: "left",
  });

  const storeStatus = useIssuesStoreStatus();
  const issue = useIssue(issueKey);

  // The grace period restarts on every key, so walking the list with `j` never trips it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (issueKey === null) return;
    const timer = window.setTimeout(() => setSettled(true), NOT_FOUND_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [issueKey]);

  const state = resolveIssueDetailState({ storeStatus, issue, settled });

  const sheetStyle = {
    "--issue-detail-properties-width": `${propertiesSize.width}px`,
    "--right-panel-sheet-width": `${sheetSize.width}px`,
    "--right-panel-sheet-max-width": `${maxWidth}px`,
  } as CSSProperties;

  return (
    <Sheet
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={issueKey !== null}
    >
      <SheetPopup
        className={cn(RIGHT_PANEL_SHEET_CLASS_NAME, "pointer-events-auto @container/issue-detail")}
        // Focus stays where it was so the list keeps `j`/`k`; the sheet follows the cursor rather
        // than capturing it.
        finalFocus={false}
        initialFocus={false}
        keepMounted
        showBackdrop={false}
        showCloseButton={false}
        side="right"
        style={sheetStyle}
        viewportClassName={cn(RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME, "pointer-events-none")}
      >
        <RightPanelResizeHandle className="max-sm:hidden" handlers={sheetSize.handlers} />
        <SheetTitle className="sr-only">{issue?.title ?? issueKey ?? "Issue"}</SheetTitle>
        {issue === null ? (
          <IssueDetailPlaceholder issueKey={issueKey} state={state} />
        ) : (
          <IssueDetailBody
            issue={issue}
            key={issue.id}
            onClose={onClose}
            onOpenIssueKey={onOpenIssueKey}
            onStartWorkRequestHandled={onStartWorkRequestHandled}
            propertiesMaxWidth={propertiesMaxWidth}
            propertiesSize={propertiesSize}
            startWorkRequestProvider={startWorkRequestProvider}
            startWorkRequestProjectId={startWorkRequestProjectId}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function SheetHeaderBar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pointer-events-auto flex h-11 shrink-0 items-center gap-1 border-b border-border/50 px-2 ps-3 [-webkit-app-region:no-drag]">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {title}
      </span>
      {children}
      <SheetClose
        aria-label="Close issue"
        className="[-webkit-app-region:no-drag]"
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <XIcon />
      </SheetClose>
    </div>
  );
}

function IssueDetailPlaceholder({
  issueKey,
  state,
}: {
  issueKey: string | null;
  state: ReturnType<typeof resolveIssueDetailState>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeaderBar title={issueKey ?? ""} />
      {state === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {state === "disconnected" ? <UnplugIcon /> : <SearchXIcon />}
            </EmptyMedia>
            <EmptyTitle>
              {state === "disconnected" ? "No environment connected" : `${issueKey} not found`}
            </EmptyTitle>
            <EmptyDescription>
              {state === "disconnected"
                ? "The tracker lives on the machine you are connected to."
                : "No issue here carries that key. It may have been deleted, or the link may come from another machine's tracker."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function IssueDetailBody({
  issue,
  onClose,
  onOpenIssueKey,
  propertiesMaxWidth,
  propertiesSize,
  startWorkRequestProvider,
  startWorkRequestProjectId,
  onStartWorkRequestHandled,
}: {
  issue: Issue;
  onClose: () => void;
  onOpenIssueKey: (key: string) => void;
  propertiesMaxWidth: number;
  propertiesSize: ReturnType<typeof useResizableWidth>;
  startWorkRequestProvider: ProviderDriverKind | null;
  startWorkRequestProjectId: ProjectId | null;
  onStartWorkRequestHandled: (() => void) | undefined;
}) {
  const store = useIssuesStore();
  const storeStatus = useIssuesStoreStatus();
  const statuses = useIssueStatuses();
  const labels = useIssueLabels();
  const projects = useProjects();
  const cycles = useIssueCycles();
  const milestones = useIssueMilestonesForProject(issue.projectId);
  const { events, refresh: refreshEvents } = useIssueEvents(issue.id);
  const { detail, isPending: detailPending } = useIssueDetail(issue.id);
  const childRollup = useIssueChildRollup(issue.id);
  const settings = usePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const timestampFormat = settings.timestampFormat;
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  // Both agent tails are read whenever a sheet opens, like the change log and the detail beside
  // them: the header has to know whether an investigation has ever run, and the rail has to list
  // the threads. Two small reads on a local socket, patched live by the stream afterwards.
  const {
    runs: enrichmentRuns,
    isPending: runsPending,
    error: runsError,
  } = useIssueEnrichmentRuns(issue.id);
  const { links: threadLinks } = useIssueThreadLinks(issue.id);

  const updateIssue = useUpdateIssue();
  const deleteIssue = useDeleteIssue();
  const restoreIssue = useRestoreIssue();
  const createLabel = useCreateIssueLabel();
  const createMilestone = useCreateIssueMilestone();
  const createTodo = useCreateIssueTodo();
  const updateTodo = useUpdateIssueTodo();
  const deleteTodo = useDeleteIssueTodo();
  const reorderTodos = useReorderIssueTodos();
  const createRelation = useCreateIssueRelation();
  const deleteRelation = useDeleteIssueRelation();
  const createComment = useCreateIssueComment();
  const updateComment = useUpdateIssueComment();
  const deleteComment = useDeleteIssueComment();
  const startEnrichment = useStartIssueEnrichment();
  const cancelEnrichment = useCancelIssueEnrichment();
  const acceptTriage = useTriageAccept();
  const linkThread = useLinkIssueThread();
  const unlinkThread = useUnlinkIssueThread();

  const write = useCallback(
    (patch: IssuePatch | null) => {
      if (patch === null) return;
      void (async () => {
        reportFailure(
          "Failed to update the issue",
          await updateIssue({ issueId: issue.id, patch }),
        );
      })();
    },
    [issue.id, updateIssue],
  );

  const commitTitle = useCallback(
    (next: string) => write(issueTitlePatch(issue, next)),
    [issue, write],
  );
  const titleProps = useCommitOnBlur<HTMLTextAreaElement>(issue.title, commitTitle);

  const projectTitles = useMemo(
    () => new Map<string, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const issueKeys = useMemo(() => {
    const keys = new Map<string, string>();
    for (const candidate of store.issuesById.values()) keys.set(candidate.id, candidate.key);
    return keys;
  }, [store]);

  const status = statuses.find((candidate) => candidate.id === issue.statusId) ?? null;
  const projectTitle =
    issue.projectId === null ? null : (projectTitles.get(issue.projectId) ?? null);

  const statusById = useMemo(
    () => new Map(statuses.map((candidate) => [candidate.id, candidate])),
    [statuses],
  );
  const parent = issue.parentId === null ? null : (store.issuesById.get(issue.parentId) ?? null);
  const childIssues = useMemo(() => {
    const found: Array<Issue> = [];
    for (const childId of childRollup.childIds) {
      const child = store.issuesById.get(childId);
      if (child !== undefined) found.push(child);
    }
    return found;
  }, [childRollup, store]);
  const relationDisplays = useMemo(
    () => (detail === null ? [] : issueRelationDisplays(detail.relations)),
    [detail],
  );
  const startWorkAttachmentIds = useMemo(
    () => issueStartWorkAttachmentIds(detail?.comments ?? EMPTY_COMMENTS),
    [detail?.comments],
  );
  const startWorkAttachmentResources = useMemo(
    () =>
      startWorkAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [startWorkAttachmentIds],
  );
  const startWorkAttachmentUrls = useAssetUrls(primaryEnvironmentId, startWorkAttachmentResources);
  const startWorkAttachmentsReady = startWorkAttachmentUrls.every((url) => url !== null);

  const openIssue = useCallback((target: Issue) => onOpenIssueKey(target.key), [onOpenIssueKey]);

  const [subIssueOpen, setSubIssueOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<IssueDetailTab>("details");
  const [showTodos, setShowTodos] = useState(false);
  const [todoFocusRequest, setTodoFocusRequest] = useState(0);
  const [showRelations, setShowRelations] = useState(false);
  const [relationOpenRequest, setRelationOpenRequest] = useState(0);

  /**
   * Every tail write reports the same way, and none of them is optimistic: the stream echo is what
   * moves the checklist, so a refused press has to say so or it reads as a press that never landed.
   */
  const runWrite = useCallback(
    (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      void (async () => {
        reportFailure(title, await run());
      })();
    },
    [],
  );

  /**
   * Not `runWrite`: unlinking appends a change-log row to both ends (`logRelation`, with
   * `removed: true`), but `issues.relationDelete` names only the relation, so the shared
   * input-keyed refresh in `state/issues.ts` has no issue id to invalidate. Creating does — its
   * input carries both — which is why only this side needs saying. This sheet is one of the two
   * feeds that just gained a row, and it is the only one on screen.
   */
  const handleDeleteRelation = useCallback(
    (relationId: IssueRelationId) => {
      void (async () => {
        const failed = reportFailure(
          "Failed to unlink the issues",
          await deleteRelation({ relationId }),
        );
        if (failed) return;
        refreshEvents();
      })();
    },
    [deleteRelation, refreshEvents],
  );

  const handleCreateMilestone = useCallback(
    async (input: { readonly name: string; readonly targetDate: IssueDate | null }) => {
      if (issue.projectId === null) return null;
      const created = await createMilestone({
        projectId: issue.projectId,
        name: input.name,
        ...(input.targetDate === null ? {} : { targetDate: input.targetDate }),
      });
      if (reportFailure("Failed to create the milestone", created)) return null;
      if (!AsyncResult.isSuccess(created)) return null;
      return created.value.milestone.id;
    },
    [createMilestone, issue.projectId],
  );

  const handleCreateLabel = useCallback(
    async (input: { readonly name: string; readonly color: string }) => {
      const created = await createLabel(input);
      if (reportFailure("Failed to create the label", created)) return false;
      if (!AsyncResult.isSuccess(created)) return false;
      // Newly created labels are not applied implicitly — the same press that made one should not
      // silently edit the issue too — except here, where making one from inside the issue is the
      // only reason to be in this popover.
      const labelId = created.value.label.id;
      reportFailure(
        "Failed to apply the label",
        await updateIssue({
          issueId: issue.id,
          patch: { labelIds: [...issue.labelIds, labelId] },
        }),
      );
      return true;
    },
    [createLabel, issue.id, issue.labelIds, updateIssue],
  );

  const handleDelete = useCallback(() => {
    const issueId: IssueId = issue.id;
    const key = issue.key;
    void (async () => {
      const result = await deleteIssue({ issueId });
      if (reportFailure("Failed to delete the issue", result)) return;
      // The row survives the delete as a tombstone, but the sheet reads a soft-deleted issue as
      // not-found: closing is what it would otherwise be sitting in front of.
      onClose();
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${key} deleted`,
          description: "The change log keeps it, so this can be undone.",
          actionProps: {
            children: "Undo",
            onClick: () => {
              void (async () => {
                toastManager.close(toastId);
                const restored = await restoreIssue({ issueId });
                if (reportFailure("Failed to restore the issue", restored)) return;
                onOpenIssueKey(key);
              })();
            },
          },
        }),
      );
    })();
  }, [deleteIssue, issue.id, issue.key, onClose, onOpenIssueKey, restoreIssue]);

  // ── Agents ───────────────────────────────────────────────────────────

  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const openNewThread = useNewThreadHandler();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [startingWork, setStartingWork] = useState(false);

  const project = useMemo(
    () =>
      issue.projectId === null
        ? null
        : (projects.find(
            (candidate) =>
              candidate.id === issue.projectId && candidate.environmentId === primaryEnvironmentId,
          ) ?? null),
    [issue.projectId, primaryEnvironmentId, projects],
  );
  const startWorkGitStatus = useEnvironmentQuery(
    project?.workspaceRoot
      ? vcsEnvironment.status({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const currentProjectBranch =
    startWorkGitStatus.data?.isRepo === true ? startWorkGitStatus.data.refName : null;
  const newWorktreeBlockReason =
    project?.workspaceRoot == null
      ? "Choose a project with a connected workspace before creating a branch."
      : startWorkGitStatus.isPending
        ? "Checking the project's Git branch."
        : startWorkGitStatus.error !== null
          ? "The project's Git status is unavailable."
          : startWorkGitStatus.data?.isRepo !== true
            ? "This project is not a Git repository."
            : currentProjectBranch === null
              ? "Check out a branch before creating a worktree."
              : null;

  const startWorkProvider = issue.assignee?.kind === "agent" ? issue.assignee.provider : null;
  const startWorkInstanceEntries = useMemo(() => {
    if (startWorkProvider === null) return [];
    return sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
    ).filter((entry) => entry.driverKind === startWorkProvider);
  }, [serverProviders, settings, startWorkProvider]);
  const startWorkModelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const initialStartWorkModelSelection = useMemo<ModelSelection | null>(() => {
    return resolveIssueStartWorkModelSelection({
      provider: startWorkProvider,
      projectDefault: issue.workModelSelection ?? project?.defaultModelSelection ?? null,
      instanceEntries: startWorkInstanceEntries,
      modelOptionsByInstance: startWorkModelOptionsByInstance,
    });
  }, [
    project?.defaultModelSelection,
    issue.workModelSelection,
    startWorkInstanceEntries,
    startWorkModelOptionsByInstance,
    startWorkProvider,
  ]);

  const activeRun = activeIssueEnrichmentRun(enrichmentRuns);
  const investigateBlock = issueInvestigateBlock({
    connected: storeStatus !== "disconnected",
    deleted: issue.deletedAt !== null,
    projectId: issue.projectId,
    workspaceRoot: project?.workspaceRoot,
    hasRunInFlight: activeRun !== null,
  });

  const handleInvestigate = useCallback(() => {
    setActiveTab("investigation");
    void (async () => {
      reportFailure(
        "Failed to start the investigation",
        await startEnrichment({ issueId: issue.id }),
      );
    })();
  }, [issue.id, startEnrichment]);

  const handleAddTodo = useCallback(() => {
    setActiveTab("details");
    setShowTodos(true);
    setTodoFocusRequest((current) => current + 1);
  }, []);

  const handleAddSubIssue = useCallback(() => {
    setActiveTab("details");
    setSubIssueOpen(true);
  }, []);

  const handleAddRelation = useCallback(() => {
    setActiveTab("details");
    setShowRelations(true);
    setRelationOpenRequest((current) => current + 1);
  }, []);

  const handleCreateComment = useCallback(
    (body: string, attachmentIds: ReadonlyArray<ChatAttachmentId>) =>
      runWrite("Failed to post the comment", () =>
        createComment({
          issueId: issue.id,
          body,
          ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        }),
      ),
    [createComment, issue.id, runWrite],
  );

  const handleCancelRun = useCallback(
    (runId: IssueEnrichmentRunId) => {
      void (async () => {
        reportFailure("Failed to cancel the investigation", await cancelEnrichment({ runId }));
      })();
    },
    [cancelEnrichment],
  );

  const threadsById = useMemo(() => {
    const byId = new Map<ThreadId, (typeof threadShells)[number]>();
    for (const shell of threadShells) {
      if (shell.environmentId !== primaryEnvironmentId) continue;
      byId.set(shell.id, shell);
    }
    return byId;
  }, [primaryEnvironmentId, threadShells]);

  const handleOpenThread = useCallback(
    (threadId: ThreadId) => {
      if (primaryEnvironmentId === null) return;
      void navigate({
        to: "/threads/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: primaryEnvironmentId, threadId }),
      });
    },
    [navigate, primaryEnvironmentId],
  );

  const handleUnlinkThread = useCallback(
    (threadId: ThreadId) => {
      void (async () => {
        reportFailure(
          "Failed to unlink the thread",
          await unlinkThread({ issueId: issue.id, threadId }),
        );
      })();
    },
    [issue.id, unlinkThread],
  );

  /** The explicit press creates and dispatches the thread before changing the issue workflow. */
  const handleStartWork = useCallback(
    (
      modelSelection: ModelSelection,
      workspaceMode: IssueStartWorkWorkspaceMode = "current_checkout",
    ) => {
      if (
        project === null ||
        project.workspaceRoot === null ||
        startingWork ||
        !startWorkAttachmentsReady
      ) {
        return;
      }
      const projectWorkspaceRoot = project.workspaceRoot;
      setStartingWork(true);
      void (async () => {
        try {
          const workspacePlan = resolveIssueStartWorkWorkspacePlan(
            workspaceMode,
            currentProjectBranch,
          );
          if (workspacePlan === null) {
            throw new Error(newWorktreeBlockReason ?? "A base branch is required.");
          }
          const opened = await openNewThread(scopeProjectRef(project.environmentId, project.id), {
            branch: workspacePlan.branch,
            worktreePath: null,
            envMode: workspacePlan.envMode,
            // An issue launch is a task boundary. It must never consume an unrelated empty draft.
            forceNew: true,
          });
          if (opened === null) return;
          const relations: Array<IssueStartWorkRelation> = [];
          if (parent !== null) {
            relations.push({ label: "Sub-issue of", key: parent.key, title: parent.title });
          }
          for (const display of relationDisplays) {
            const counterpart = store.issuesById.get(display.issueId);
            if (counterpart === undefined) continue;
            relations.push({
              label: display.label,
              key: counterpart.key,
              title: counterpart.title,
            });
          }
          const prompt = buildIssueStartWorkPrompt({
            issue,
            statusName: status?.name ?? null,
            completionStatusName:
              statuses.find(
                (candidate) =>
                  candidate.id === settings.issueAutomation.statusTransitions.workFinishedStatusId,
              )?.name ?? null,
            projectTitle,
            priorityLabel: issue.priority === "none" ? null : ISSUE_PRIORITY_LABELS[issue.priority],
            todos: issueStartWorkTodos(detail?.todos ?? EMPTY_TODOS),
            relations,
            issueUrl: issueDetailUrl(window.location.origin, issue.key),
          });
          const draftStore = useComposerDraftStore.getState();
          const session = draftStore.getDraftSession(opened.draftId);
          if (session === null) throw new Error("The new thread draft could not be prepared.");

          const attachments: Array<UploadChatAttachment> = [];
          for (const [index, url] of startWorkAttachmentUrls.entries()) {
            if (url === null) throw new Error("The issue images are still loading. Try again.");
            const response = await fetch(url);
            if (!response.ok) throw new Error("An issue image could not be loaded.");
            const blob = await response.blob();
            if (!blob.type.startsWith("image/")) {
              throw new Error("An issue attachment is not an image.");
            }
            const name = `${issue.key}-attachment-${index + 1}`;
            const file = new File([blob], name, { type: blob.type });
            attachments.push({
              type: "image",
              name,
              mimeType: blob.type,
              sizeBytes: blob.size,
              dataUrl: await readFileAsDataUrl(file),
            });
          }

          const createdAt = new Date().toISOString();
          const started = await startThreadTurn({
            environmentId: session.environmentId,
            input: {
              threadId: session.threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: prompt,
                attachments,
              },
              modelSelection,
              titleSeed: issue.title,
              runtimeMode: session.runtimeMode,
              interactionMode: session.interactionMode,
              bootstrap: {
                createThread: {
                  projectId: session.projectId,
                  title: issue.title,
                  modelSelection,
                  runtimeMode: session.runtimeMode,
                  interactionMode: session.interactionMode,
                  branch: session.branch,
                  worktreePath: session.worktreePath,
                  createdAt: session.createdAt,
                },
                ...(workspacePlan.prepareWorktreeBaseBranch === null
                  ? {}
                  : {
                      prepareWorktree: {
                        projectCwd: projectWorkspaceRoot,
                        baseBranch: workspacePlan.prepareWorktreeBaseBranch,
                        ...(session.startFromOrigin ? { startFromOrigin: true } : {}),
                      },
                      runSetupScript: true,
                    }),
              },
              createdAt,
            },
          });
          if (reportFailure("Failed to start work", started)) return;

          const targetStatusId = resolveIssueStartWorkStatusId({
            configuredStatusId: settings.issueAutomation.statusTransitions.workStartedStatusId,
            statuses,
          });
          if (targetStatusId !== null && (issue.triage || issue.statusId !== targetStatusId)) {
            const transitioned = issue.triage
              ? await acceptTriage({
                  issueId: issue.id,
                  statusId: targetStatusId,
                  projectId: issue.projectId,
                  priority: issue.priority,
                  runEnrichment: false,
                })
              : await updateIssue({
                  issueId: issue.id,
                  patch: { statusId: targetStatusId },
                });
            reportFailure("Work started, but the issue status could not be updated", transitioned);
          }

          reportFailure(
            "Work started, but the thread could not be linked to its issue",
            await linkThread({
              issueId: issue.id,
              threadId: session.threadId,
              origin: "start-work",
            }),
          );
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to start work",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        } finally {
          setStartingWork(false);
        }
      })();
    },
    [
      detail,
      acceptTriage,
      issue,
      linkThread,
      currentProjectBranch,
      newWorktreeBlockReason,
      openNewThread,
      parent,
      project,
      projectTitle,
      relationDisplays,
      startingWork,
      status,
      statuses,
      store,
      settings.issueAutomation.statusTransitions.workFinishedStatusId,
      settings.issueAutomation.statusTransitions.workStartedStatusId,
      startThreadTurn,
      startWorkAttachmentsReady,
      startWorkAttachmentUrls,
      updateIssue,
    ],
  );

  useEffect(() => {
    if (
      startWorkRequestProvider === null ||
      detailPending ||
      startingWork ||
      !startWorkAttachmentsReady
    ) {
      return;
    }
    if (
      issue.triage ||
      issue.assignee?.kind !== "agent" ||
      issue.assignee.provider !== startWorkRequestProvider ||
      issue.projectId !== startWorkRequestProjectId
    ) {
      // The accept result and its stream echo can arrive on adjacent ticks. Wait until the issue
      // reflects the assignment the Start Task press just committed.
      return;
    }
    onStartWorkRequestHandled?.();
    if (project === null || initialStartWorkModelSelection === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Task accepted, but work could not start",
          description:
            project === null
              ? "The selected project has no connected workspace."
              : `No available ${startWorkRequestProvider} model can start this work.`,
        }),
      );
      return;
    }
    handleStartWork(initialStartWorkModelSelection);
  }, [
    detailPending,
    handleStartWork,
    initialStartWorkModelSelection,
    issue.assignee,
    issue.triage,
    onStartWorkRequestHandled,
    project,
    startWorkAttachmentsReady,
    startWorkRequestProvider,
    startWorkRequestProjectId,
    startingWork,
  ]);

  const issuesByKey = useMemo(() => {
    const byKey = new Map<string, Issue>();
    for (const candidate of store.issuesById.values()) byKey.set(candidate.key, candidate);
    return byKey;
  }, [store]);
  const todos = detail?.todos ?? EMPTY_TODOS;
  const comments = detail?.comments ?? EMPTY_COMMENTS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeaderBar title={issue.key}>
        <IssueDeleteMenu
          count={1}
          onConfirm={handleDelete}
          trigger={
            <Button
              aria-label={`Delete ${issue.key}`}
              className="text-muted-foreground hover:text-destructive-foreground"
              size="icon-xs"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          }
        />
      </SheetHeaderBar>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <div className="flex flex-col gap-4 p-4 @xl/issue-detail:flex-row @xl/issue-detail:gap-5">
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <Textarea
                aria-label="Issue title"
                className={cn(GROWING_TEXTAREA_CLASS_NAME, "text-[15px] font-medium")}
                rows={1}
                {...titleProps}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.shiftKey) return;
                  titleProps.onKeyDown(event);
                }}
              />

              <IssueDescriptionEditor
                onCommit={(description) => write(issueDescriptionPatch(issue, description))}
                value={issue.description}
              />

              <IssueAttachments
                comments={comments}
                issueId={issue.id}
                onCreateComment={handleCreateComment}
              />

              <IssueDetailTabs
                activityCount={events.length + comments.length}
                investigating={activeRun !== null}
                investigationCount={enrichmentRuns.length}
                onChange={setActiveTab}
                value={activeTab}
              />

              {activeTab === "details" ? (
                <div
                  aria-labelledby="issue-details-tab"
                  className="flex flex-col gap-4"
                  id="issue-details-panel"
                  role="tabpanel"
                >
                  <IssueSubIssues
                    composerOpen={subIssueOpen}
                    labels={labels}
                    onComposerOpenChange={setSubIssueOpen}
                    onOpenIssue={openIssue}
                    parent={issue}
                    rollup={childRollup}
                    statusById={statusById}
                    statuses={statuses}
                    subIssues={childIssues}
                  />

                  {todos.length > 0 || showTodos ? (
                    <IssueTodoList
                      focusRequest={todoFocusRequest}
                      onCreate={(text) =>
                        runWrite("Failed to add the todo", () =>
                          createTodo({ issueId: issue.id, text }),
                        )
                      }
                      onDelete={(todoId: IssueTodoId) =>
                        runWrite("Failed to delete the todo", () => deleteTodo({ todoId }))
                      }
                      onDismiss={todos.length === 0 ? () => setShowTodos(false) : undefined}
                      onReorder={(todoIds: ReadonlyArray<IssueTodoId>) =>
                        runWrite("Failed to reorder the todos", () =>
                          reorderTodos({ issueId: issue.id, todoIds }),
                        )
                      }
                      onUpdate={(todoId: IssueTodoId, patch: IssueTodoPatch) =>
                        runWrite("Failed to update the todo", () => updateTodo({ todoId, patch }))
                      }
                      todos={todos}
                    />
                  ) : null}

                  {relationDisplays.length > 0 || showRelations ? (
                    <IssueRelationsSection
                      displays={relationDisplays}
                      issue={issue}
                      issuesById={store.issuesById}
                      onCreate={(input: IssueRelationCreateInput) =>
                        runWrite("Failed to link the issues", () => createRelation(input))
                      }
                      onDelete={handleDeleteRelation}
                      onDismiss={
                        relationDisplays.length === 0 ? () => setShowRelations(false) : undefined
                      }
                      onOpenIssue={openIssue}
                      openRequest={relationOpenRequest}
                      statusById={statusById}
                    />
                  ) : null}
                </div>
              ) : activeTab === "activity" ? (
                <div
                  aria-labelledby="issue-activity-tab"
                  className="flex flex-col gap-4"
                  id="issue-activity-panel"
                  role="tabpanel"
                >
                  <IssueActivityFeed
                    events={events}
                    issueKeys={issueKeys}
                    projectTitles={projectTitles}
                  />
                  <IssueComments
                    comments={comments}
                    isPending={detailPending}
                    issueId={issue.id}
                    onCreate={handleCreateComment}
                    onDelete={(commentId: IssueCommentId) =>
                      runWrite("Failed to delete the comment", () => deleteComment({ commentId }))
                    }
                    onEdit={(comment, body) => {
                      const patch = issueCommentUpdatePatch(comment, body);
                      if (patch === null) return;
                      runWrite("Failed to edit the comment", () =>
                        updateComment({ commentId: comment.id, patch }),
                      );
                    }}
                  />
                </div>
              ) : (
                <div
                  aria-labelledby="issue-investigation-tab"
                  className="flex min-h-64 flex-col"
                  id="issue-investigation-panel"
                  role="tabpanel"
                >
                  <div className="flex items-start gap-3 border-b border-border/50 pb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-foreground">
                        Repository investigation
                      </h3>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                        Read-only analysis. Finished runs are also left as agent comments in
                        Activity.
                      </p>
                    </div>
                    <Button
                      disabled={investigateBlock !== null}
                      onClick={handleInvestigate}
                      size="xs"
                      title={
                        investigateBlock === null
                          ? "Run a read-only investigation of this issue's repository."
                          : ISSUE_INVESTIGATE_BLOCK_REASONS[investigateBlock]
                      }
                      variant="outline"
                    >
                      {activeRun === null ? <WandSparklesIcon /> : <Spinner className="size-3.5" />}
                      {activeRun === null
                        ? enrichmentRuns.length === 0
                          ? "Investigate"
                          : "Investigate again"
                        : "Investigating"}
                    </Button>
                  </div>
                  <IssueEnrichmentPanel
                    error={runsError}
                    isPending={runsPending}
                    issue={issue}
                    issuesByKey={issuesByKey}
                    labels={labels}
                    onApplyDescription={(description) =>
                      write(issueApplyDescriptionPatch(issue, description))
                    }
                    onApplyLabel={(labelId) => write(issueApplyLabelPatch(issue, labelId))}
                    onApplyPriority={(priority) => write(issueApplyPriorityPatch(issue, priority))}
                    onApplyTitle={(title) => write(issueApplyTitlePatch(issue, title))}
                    onCancel={handleCancelRun}
                    onOpenIssueKey={onOpenIssueKey}
                    runs={enrichmentRuns}
                  />
                </div>
              )}
            </div>

            <aside className="relative flex shrink-0 flex-col gap-3 border-t border-border/50 pt-3 @xl/issue-detail:w-[var(--issue-detail-properties-width)] @xl/issue-detail:border-t-0 @xl/issue-detail:border-s @xl/issue-detail:pt-0 @xl/issue-detail:ps-4">
              <IssuePropertiesResizeHandle maxWidth={propertiesMaxWidth} size={propertiesSize} />
              <IssueDetailProperties
                cycles={cycles}
                issue={issue}
                issues={store.issuesById}
                labels={labels}
                milestones={milestones}
                onAssignee={(assignee: IssueAssignee | null) =>
                  write(issueAssigneePatch(issue, assignee))
                }
                onCreateLabel={handleCreateLabel}
                onCreateMilestone={handleCreateMilestone}
                onCycle={(cycleId: IssueCycleId | null) => write(issueCyclePatch(issue, cycleId))}
                onDueDate={(value: string) => write(issueDueDatePatch(issue, value))}
                onMilestone={(milestoneId: IssueMilestoneId | null) =>
                  write(issueMilestonePatch(issue, milestoneId))
                }
                onParent={(parentId: IssueId | null) => write(issueParentPatch(issue, parentId))}
                onPriority={(priority: IssuePriority) => write(issuePriorityPatch(issue, priority))}
                onProject={(projectId: ProjectId | null) =>
                  write(issueProjectPatch(issue, projectId))
                }
                onStatus={(statusId: IssueStatusId) => write(issueStatusPatch(issue, statusId))}
                onToggleLabel={(labelId: IssueLabelId) =>
                  write(issueLabelTogglePatch(issue, labelId))
                }
                parent={parent}
                projects={projects}
                projectTitle={projectTitle}
                status={status}
                statusById={statusById}
                statuses={statuses}
              />

              <IssueAgentSection
                initialModelSelection={initialStartWorkModelSelection}
                instanceEntries={startWorkInstanceEntries}
                issue={issue}
                links={threadLinks}
                modelOptionsByInstance={startWorkModelOptionsByInstance}
                currentBranch={currentProjectBranch}
                newWorktreeBlockReason={newWorktreeBlockReason}
                onOpenThread={handleOpenThread}
                onStartWork={handleStartWork}
                onUnlinkThread={handleUnlinkThread}
                starting={startingWork}
                startWorkBlockReason={
                  project?.workspaceRoot == null
                    ? ISSUE_INVESTIGATE_BLOCK_REASONS["no-project"]
                    : storeStatus === "disconnected"
                      ? ISSUE_INVESTIGATE_BLOCK_REASONS.disconnected
                      : !startWorkAttachmentsReady
                        ? "Issue images are still loading."
                        : null
                }
                threadsById={threadsById}
              />

              <dl className="flex flex-col gap-1 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <dt className="w-14 shrink-0">Key</dt>
                  <dd className="font-mono">{issue.key}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="w-14 shrink-0">Created</dt>
                  <dd title={formatChatTimestampTooltip(issue.createdAt, timestampFormat)}>
                    {formatRelativeTimeLabel(issue.createdAt)}
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="w-14 shrink-0">Updated</dt>
                  <dd title={formatChatTimestampTooltip(issue.updatedAt, timestampFormat)}>
                    {formatRelativeTimeLabel(issue.updatedAt)}
                  </dd>
                </div>
              </dl>

              <IssueActionPanel
                onAddRelation={handleAddRelation}
                onAddSubIssue={handleAddSubIssue}
                onAddTodo={handleAddTodo}
              />
            </aside>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function IssuePropertiesResizeHandle({
  maxWidth,
  size,
}: {
  maxWidth: number;
  size: ReturnType<typeof useResizableWidth>;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidth =
      event.key === "ArrowLeft"
        ? size.width + ISSUE_DETAIL_PROPERTIES_KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? size.width - ISSUE_DETAIL_PROPERTIES_KEYBOARD_STEP
          : event.key === "Home"
            ? ISSUE_DETAIL_PROPERTIES_MIN_WIDTH
            : event.key === "End"
              ? maxWidth
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    size.resizeTo(nextWidth);
  };

  return (
    <div
      aria-label="Resize issue properties"
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={ISSUE_DETAIL_PROPERTIES_MIN_WIDTH}
      aria-valuenow={size.width}
      className="group absolute inset-y-0 -left-2 z-20 hidden w-4 cursor-col-resize touch-none select-none outline-none @xl/issue-detail:block focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onDoubleClick={() => size.resizeTo(ISSUE_DETAIL_PROPERTIES_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      title="Drag to resize issue properties"
      {...size.handlers}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}
