/**
 * The issue detail sheet — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * It shares `RightPanelSheet`'s geometry (the same `useResizableWidth`, the same max-width clamp,
 * the same popup classes) but not its `Sheet`, because it is deliberately **non-modal**: the
 * decision record puts the detail in a sheet rather than a page so the list stays visible for
 * triage, and a modal one would blur the list behind a backdrop, trap focus away from `j`/`k`, and
 * close itself the moment somebody clicked the next row. So: no backdrop, a click-through
 * viewport, no focus steal, and dismissal only through the close button, Escape, or the URL.
 *
 * @module components/issues/IssueDetailSheet
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
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
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  PencilIcon,
  SearchXIcon,
  Trash2Icon,
  UnplugIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
} from "~/rightPanelLayout";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProjects, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
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
  useIssueMilestonesForProject,
  useIssueStatuses,
  useIssueThreadLinks,
  useIssuesStore,
  useIssuesStoreStatus,
  useReorderIssueTodos,
  useRestoreIssue,
  useStartIssueEnrichment,
  useUnlinkIssueThread,
  useUpdateIssue,
  useUpdateIssueComment,
  useUpdateIssueTodo,
} from "~/state/issues";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { useRightPanelSheetMaxWidth } from "../RightPanelSheet";
import { PREVIEW_PANEL_MIN_WIDTH } from "../preview/PreviewPanelShell";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Textarea } from "../ui/textarea";
import { IssueActivityFeed } from "./IssueActivityFeed";
import { IssueAgentSection } from "./IssueAgentSection";
import { IssueComments } from "./IssueComments";
import { IssueDetailProperties } from "./IssueDetailProperties";
import { IssueEnrichmentPanel } from "./IssueEnrichmentPanel";
import { IssueInvestigatingChip } from "./IssueGlyphs";
import { IssueRelationsSection } from "./IssueRelationsSection";
import { IssueSubIssues } from "./IssueSubIssues";
import { IssueTodoList } from "./IssueTodoList";
import { NewIssueDialog } from "./NewIssueDialog";
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
  issueApplyLabelPatch,
  issueApplyPriorityPatch,
  issueInvestigateBlock,
  latestIssueEnrichmentRun,
} from "./issueEnrichment.logic";
import {
  buildIssueStartWorkPrompt,
  issueDetailUrl,
  issueStartWorkTodos,
  rememberPendingIssueThreadLink,
  type IssueStartWorkRelation,
} from "./issueStartWork.logic";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";

export const ISSUE_DETAIL_SHEET_WIDTH_STORAGE_KEY = "pathway:issue-detail-sheet-width";
/** Wide enough that the properties rail sits beside the body at the width it first opens. */
export const ISSUE_DETAIL_SHEET_DEFAULT_WIDTH = 640;

/**
 * How long a `?issue=` that has not resolved is given before it is called a bad link. The stream
 * has no snapshot variant, so the store reports `ready` on the first chunk of its opening replay
 * and a deep link can outrun the row it names.
 */
const NOT_FOUND_GRACE_MS = 600;

/** Stable empties so an unloaded tail does not remount the checklist and the thread on every read. */
const EMPTY_TODOS: ReadonlyArray<IssueTodo> = Object.freeze([]);
const EMPTY_COMMENTS: ReadonlyArray<IssueComment> = Object.freeze([]);

export function IssueDetailSheet({
  issueKey,
  onClose,
  onOpenIssueKey,
}: {
  /** The `?issue=` value: an issue key such as `PAT-221`, or null when the sheet is shut. */
  issueKey: string | null;
  onClose: () => void;
  /** Reopens the sheet on an undone delete, which arrives after the sheet has already closed. */
  onOpenIssueKey: (key: string) => void;
}) {
  const maxWidth = useRightPanelSheetMaxWidth();
  const { width, handlers } = useResizableWidth({
    storageKey: ISSUE_DETAIL_SHEET_WIDTH_STORAGE_KEY,
    defaultWidth: ISSUE_DETAIL_SHEET_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
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
    "--right-panel-sheet-width": `${width}px`,
    "--right-panel-sheet-max-width": `${maxWidth}px`,
  } as CSSProperties;

  return (
    <Sheet
      disablePointerDismissal
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
        <RightPanelResizeHandle className="max-sm:hidden" handlers={handlers} />
        <SheetTitle className="sr-only">{issue?.title ?? issueKey ?? "Issue"}</SheetTitle>
        {issue === null ? (
          <IssueDetailPlaceholder issueKey={issueKey} onClose={onClose} state={state} />
        ) : (
          <IssueDetailBody
            issue={issue}
            key={issue.id}
            onClose={onClose}
            onOpenIssueKey={onOpenIssueKey}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function SheetHeaderBar({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/50 px-2 ps-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {title}
      </span>
      {children}
      <Button aria-label="Close issue" onClick={onClose} size="icon-xs" variant="ghost">
        <XIcon />
      </Button>
    </div>
  );
}

function IssueDetailPlaceholder({
  issueKey,
  state,
  onClose,
}: {
  issueKey: string | null;
  state: ReturnType<typeof resolveIssueDetailState>;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeaderBar onClose={onClose} title={issueKey ?? ""} />
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
}: {
  issue: Issue;
  onClose: () => void;
  onOpenIssueKey: (key: string) => void;
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
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
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

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(issue.description);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editingDescription) descriptionRef.current?.focus();
  }, [editingDescription]);

  const startEditingDescription = () => {
    setDescriptionDraft(issue.description);
    setEditingDescription(true);
  };
  const saveDescription = () => {
    setEditingDescription(false);
    write(issueDescriptionPatch(issue, descriptionDraft));
  };

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

  const openIssue = useCallback((target: Issue) => onOpenIssueKey(target.key), [onOpenIssueKey]);

  const [subIssueOpen, setSubIssueOpen] = useState(false);

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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadShells = useThreadShells();
  const openNewThread = useNewThreadHandler();
  const [panelOpen, setPanelOpen] = useState(false);
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

  const activeRun = activeIssueEnrichmentRun(enrichmentRuns);
  const latestRun = latestIssueEnrichmentRun(enrichmentRuns);
  const investigateBlock = issueInvestigateBlock({
    connected: storeStatus !== "disconnected",
    deleted: issue.deletedAt !== null,
    projectId: issue.projectId,
    workspaceRoot: project?.workspaceRoot,
    hasRunInFlight: activeRun !== null,
  });

  /**
   * A finished run appends its Investigation block to the description through the server, which
   * logs the write — and the change log is the one read with no diff on the stream. The
   * description itself arrives on `IssueUpserted`; only the feed needs telling.
   */
  const settledRunIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const settled = new Set<string>();
    let landed = false;
    for (const run of enrichmentRuns) {
      if (run.state !== "done" && run.state !== "failed") continue;
      settled.add(run.id);
      if (!settledRunIdsRef.current.has(run.id)) landed = true;
    }
    const first = settledRunIdsRef.current.size === 0 && enrichmentRuns.length > 0;
    settledRunIdsRef.current = settled;
    // The read that seeded the panel already carries every finished run; only a transition seen
    // while the sheet was open means a feed row this client has not read yet.
    if (landed && !first) refreshEvents();
  }, [enrichmentRuns, refreshEvents]);

  const handleInvestigate = useCallback(() => {
    setPanelOpen(true);
    void (async () => {
      reportFailure(
        "Failed to start the investigation",
        await startEnrichment({ issueId: issue.id }),
      );
    })();
  }, [issue.id, startEnrichment]);

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

  /**
   * Opens a draft holding the issue and nothing else. The link is not written here: the thread id
   * the draft carries is minted client-side and only becomes real when the composer is sent, so
   * the intent is parked against the draft and the draft route writes the link once the thread
   * exists. See `issueStartWork.logic.ts`.
   */
  const handleStartWork = useCallback(() => {
    if (project === null || startingWork) return;
    setStartingWork(true);
    void (async () => {
      try {
        const opened = await openNewThread(scopeProjectRef(project.environmentId, project.id));
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
          projectTitle,
          priorityLabel: issue.priority === "none" ? null : ISSUE_PRIORITY_LABELS[issue.priority],
          todos: issueStartWorkTodos(detail?.todos ?? EMPTY_TODOS),
          relations,
          issueUrl: issueDetailUrl(window.location.origin, issue.key),
        });
        useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
        rememberPendingIssueThreadLink(window.sessionStorage, opened.draftId, issue.id);
      } finally {
        setStartingWork(false);
      }
    })();
  }, [
    detail,
    issue,
    openNewThread,
    parent,
    project,
    projectTitle,
    relationDisplays,
    startingWork,
    status,
    store,
  ]);

  const issuesByKey = useMemo(() => {
    const byKey = new Map<string, Issue>();
    for (const candidate of store.issuesById.values()) byKey.set(candidate.key, candidate);
    return byKey;
  }, [store]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeaderBar onClose={onClose} title={issue.key}>
        {activeRun !== null ? (
          <button
            aria-label="Open the running investigation"
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setPanelOpen(true)}
            type="button"
          >
            <IssueInvestigatingChip />
          </button>
        ) : latestRun !== null ? (
          <Button
            className="text-muted-foreground"
            onClick={() => setPanelOpen(true)}
            size="xs"
            variant="ghost"
          >
            <WandSparklesIcon />
            Investigation
          </Button>
        ) : null}
        <Button
          className="text-muted-foreground"
          disabled={investigateBlock !== null}
          onClick={handleInvestigate}
          size="xs"
          title={
            investigateBlock === null
              ? "Run a read-only investigation of this issue's repository."
              : ISSUE_INVESTIGATE_BLOCK_REASONS[investigateBlock]
          }
          variant="ghost"
        >
          <WandSparklesIcon />
          Investigate
        </Button>
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
                className="border-transparent bg-transparent text-[15px] font-medium shadow-none before:hidden hover:border-input dark:bg-transparent"
                rows={1}
                {...titleProps}
              />

              <section className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Description</h3>
                  {editingDescription ? null : (
                    <Button
                      className="text-muted-foreground"
                      onClick={startEditingDescription}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <PencilIcon />
                      <span className="sr-only">Edit description</span>
                    </Button>
                  )}
                </div>
                {editingDescription ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      aria-label="Issue description"
                      className="min-h-40"
                      onChange={(event) => setDescriptionDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingDescription(false);
                          return;
                        }
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          saveDescription();
                        }
                      }}
                      placeholder="Describe the problem. Markdown works; a Lexical composer lands in stage 2."
                      ref={descriptionRef}
                      value={descriptionDraft}
                    />
                    <div className="flex items-center gap-2">
                      <Button onClick={saveDescription} size="xs">
                        Save
                      </Button>
                      <Button
                        onClick={() => setEditingDescription(false)}
                        size="xs"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : issue.description.trim().length === 0 ? (
                  <button
                    className="rounded-md px-1.5 py-1 text-start text-[13px] text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={startEditingDescription}
                    type="button"
                  >
                    Add a description…
                  </button>
                ) : (
                  <ChatMarkdown className="text-[13px]" cwd={undefined} text={issue.description} />
                )}
              </section>

              <IssueSubIssues
                onAdd={() => setSubIssueOpen(true)}
                onOpenIssue={openIssue}
                rollup={childRollup}
                statusById={statusById}
                subIssues={childIssues}
              />

              <IssueTodoList
                onCreate={(text) =>
                  runWrite("Failed to add the todo", () => createTodo({ issueId: issue.id, text }))
                }
                onDelete={(todoId: IssueTodoId) =>
                  runWrite("Failed to delete the todo", () => deleteTodo({ todoId }))
                }
                onReorder={(todoIds: ReadonlyArray<IssueTodoId>) =>
                  runWrite("Failed to reorder the todos", () =>
                    reorderTodos({ issueId: issue.id, todoIds }),
                  )
                }
                onUpdate={(todoId: IssueTodoId, patch: IssueTodoPatch) =>
                  runWrite("Failed to update the todo", () => updateTodo({ todoId, patch }))
                }
                todos={detail?.todos ?? EMPTY_TODOS}
              />

              <IssueRelationsSection
                displays={relationDisplays}
                issue={issue}
                issuesById={store.issuesById}
                onCreate={(input: IssueRelationCreateInput) =>
                  runWrite("Failed to link the issues", () => createRelation(input))
                }
                onDelete={handleDeleteRelation}
                onOpenIssue={openIssue}
                statusById={statusById}
              />

              <section className="flex flex-col gap-2 border-t border-border/50 pt-3">
                <h3 className="text-xs font-medium text-muted-foreground">Activity</h3>
                <IssueActivityFeed
                  events={events}
                  issueKeys={issueKeys}
                  projectTitles={projectTitles}
                />
              </section>

              <IssueComments
                comments={detail?.comments ?? EMPTY_COMMENTS}
                isPending={detailPending}
                issueId={issue.id}
                onCreate={(body, attachmentIds) =>
                  runWrite("Failed to post the comment", () =>
                    createComment({
                      issueId: issue.id,
                      body,
                      ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
                    }),
                  )
                }
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

            <aside className="flex shrink-0 flex-col gap-3 border-t border-border/50 pt-3 @xl/issue-detail:w-56 @xl/issue-detail:border-t-0 @xl/issue-detail:border-s @xl/issue-detail:pt-0 @xl/issue-detail:ps-4">
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
                issue={issue}
                links={threadLinks}
                onOpenThread={handleOpenThread}
                onStartWork={handleStartWork}
                onUnlinkThread={handleUnlinkThread}
                starting={startingWork}
                startWorkBlockReason={
                  project === null
                    ? ISSUE_INVESTIGATE_BLOCK_REASONS["no-project"]
                    : storeStatus === "disconnected"
                      ? ISSUE_INVESTIGATE_BLOCK_REASONS.disconnected
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
            </aside>
          </div>
        </ScrollArea>

        {/* Inside the sheet, over its body: an enrichment run belongs to the issue it was fired
            from, and a right-panel tab or a route would let it escape into surfaces that know
            nothing about it. */}
        {panelOpen ? (
          <div className="absolute inset-0 z-10 flex translate-x-0 flex-col bg-background opacity-100 transition-[translate,opacity] duration-150 ease-out starting:translate-x-3 starting:opacity-0 motion-reduce:transition-none">
            <IssueEnrichmentPanel
              error={runsError}
              isPending={runsPending}
              issue={issue}
              issuesByKey={issuesByKey}
              labels={labels}
              onApplyLabel={(labelId) => write(issueApplyLabelPatch(issue, labelId))}
              onApplyPriority={(priority) => write(issueApplyPriorityPatch(issue, priority))}
              onCancel={handleCancelRun}
              onClose={() => setPanelOpen(false)}
              onOpenIssueKey={onOpenIssueKey}
              runs={enrichmentRuns}
            />
          </div>
        ) : null}
      </div>

      {/* Its own instance rather than the list page's: a sub-issue is created *from* this issue,
          so the dialog opens prefilled with it as the parent and with its project. */}
      <NewIssueDialog
        defaultParentId={issue.id}
        defaultProjectId={issue.projectId}
        defaultStatusId={statuses[0]?.id ?? null}
        labels={labels}
        onOpenChange={setSubIssueOpen}
        open={subIssueOpen}
        projects={projects}
        statuses={statuses}
      />
    </div>
  );
}
