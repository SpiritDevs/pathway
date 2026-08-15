/**
 * The triage queue at `/issues?triage=true`.
 *
 * A flat list, not the status-grouped one: a triage item has no meaningful status, so grouping by
 * status would put the whole queue in one bogus column. What a row shows instead is where the item
 * came from and how long it has been waiting, which is what somebody deciding accept-or-reject
 * actually reads.
 *
 * Everything pure is in `triage.logic.ts`; selection and `j`/`k` are the list view's own helpers,
 * which already work off a flat id array.
 *
 * @module components/issues/IssuesTriageView
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { Issue, IssueId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import { CheckIcon, InboxIcon, XIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  useIssue,
  useIssueLabels,
  useIssueStatuses,
  useIssuesStoreStatus,
  useRestoreIssue,
  useSlackChannelNames,
  useTriageIssues,
  useTriageReject,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { IssueSlackSourceChip } from "./IssueSlackSourceChip";
import { NewIssueDialog } from "./NewIssueDialog";
import { TriageAcceptDialog } from "./TriageAcceptDialog";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  EMPTY_ISSUES_SELECTION,
  issueSelectModeForModifiers,
  pruneIssuesSelection,
  resolveIssuesListKeyAction,
  selectIssueRow,
  type IssuesSearch,
  type IssuesSearchPatch,
  type IssuesSelection,
} from "./issuesList.logic";
import { triageRowPresentation, type TriageRowPresentation } from "./triage.logic";

/** Two lines of chips under a title; taller than a list row and still one estimate for all of them. */
const ESTIMATED_TRIAGE_ROW_HEIGHT = 52;

function TriageRowImpl({
  row,
  issue,
  selected,
  active,
  onRowClick,
  onOpen,
  onAccept,
  onReject,
}: {
  row: TriageRowPresentation;
  issue: Issue;
  selected: boolean;
  active: boolean;
  onRowClick: (issue: Issue, event: MouseEvent) => void;
  onOpen: (issue: Issue) => void;
  onAccept: (issue: Issue) => void;
  onReject: (issue: Issue) => void;
}) {
  return (
    <div
      aria-selected={selected}
      className={cn(
        "group flex w-full items-center gap-3 border-b border-border/25 px-3 py-2 text-sm outline-none sm:px-5",
        selected ? "bg-accent/60" : "hover:bg-accent/30",
        active && "ring-1 ring-inset ring-ring/60",
      )}
      data-issue-key={row.issueKey}
      onClick={(event) => onRowClick(issue, event)}
      onDoubleClick={() => onOpen(issue)}
      role="option"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-foreground">{row.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono text-muted-foreground/70">{row.issueKey}</span>
          {row.source === null ? null : <IssueSlackSourceChip chip={row.source} />}
          {row.projectTitle === null ? null : (
            <span className="max-w-32 truncate rounded-full border border-border/60 px-1.5 py-px">
              {row.projectTitle}
            </span>
          )}
          <span className="tabular-nums text-muted-foreground/70" title={issue.createdAt}>
            {row.ageLabel}
          </span>
        </span>
      </div>

      {/* Both stop the bubble: a press here is a decision about the row, not a request to open it. */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Button
          aria-label={`Reject ${row.issueKey}`}
          className="text-muted-foreground hover:text-destructive-foreground"
          onClick={() => onReject(issue)}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
        <Button onClick={() => onAccept(issue)} size="xs" variant="outline">
          <CheckIcon />
          Accept
        </Button>
      </div>
    </div>
  );
}

const TriageRow = memo(TriageRowImpl);

export function IssuesTriageView({
  search,
  onSearch,
}: {
  search: IssuesSearch;
  onSearch: (patch: IssuesSearchPatch) => void;
}) {
  const triageIssues = useTriageIssues();
  const statuses = useIssueStatuses();
  const labels = useIssueLabels();
  const projects = useProjects();
  const storeStatus = useIssuesStoreStatus();
  const channelNames = useSlackChannelNames();
  const rejectTriage = useTriageReject();
  const restoreIssue = useRestoreIssue();

  const [selection, setSelection] = useState<IssuesSelection>(EMPTY_ISSUES_SELECTION);
  const [acceptIssues, setAcceptIssues] = useState<ReadonlyArray<Issue>>([]);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [startWorkRequest, setStartWorkRequest] = useState<{
    readonly issueKey: string;
    readonly provider: ProviderDriverKind;
    readonly projectId: ProjectId | null;
  } | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const scrollToActiveRef = useRef(false);

  // Read once for the whole list rather than per row, so every row agrees on what "3h ago" means
  // and a re-render for an unrelated reason does not shuffle the ages.
  const nowMs = useMemo(() => Date.now(), [triageIssues]);
  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const rows = useMemo(
    () =>
      triageIssues.map((issue) =>
        triageRowPresentation({ issue, channelNames, projectTitles, nowMs }),
      ),
    [channelNames, nowMs, projectTitles, triageIssues],
  );
  const ids = useMemo(() => triageIssues.map((issue) => issue.id), [triageIssues]);
  // `renderItem` runs per visible row, so the row's issue is a map lookup rather than a scan.
  const issuesById = useMemo(
    () => new Map(triageIssues.map((issue) => [issue.id, issue])),
    [triageIssues],
  );

  // Accepting or rejecting takes a row out of the queue on the stream echo; a selection holding
  // rows nobody can see any more is the one thing a bulk action must never do.
  useEffect(() => {
    setSelection((current) => pruneIssuesSelection(current, ids));
  }, [ids]);

  const selectedIssues = useMemo(
    () => triageIssues.filter((issue) => selection.ids.has(issue.id)),
    [selection.ids, triageIssues],
  );

  const detailIssueKey = search.issue ?? null;
  const detailIssue = useIssue(detailIssueKey);
  const openIssue = (issue: Issue) => onSearch({ issue: issue.key });
  const closeDetail = () => {
    setStartWorkRequest(null);
    onSearch({ issue: undefined });
  };

  useEffect(() => {
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
      setNewIssueOpen(true);
      return;
    }
    if (action._tag === "clear") {
      setSelection(EMPTY_ISSUES_SELECTION);
      return;
    }
    const issue = issuesById.get(action.issueId);
    if (action._tag === "open") {
      if (issue !== undefined) openIssue(issue);
      return;
    }
    scrollToActiveRef.current = true;
    setSelection((current) =>
      selectIssueRow(current, { ids, issueId: action.issueId, mode: "replace" }),
    );
    if (detailIssueKey !== null && issue !== undefined) openIssue(issue);
  });

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    if (!scrollToActiveRef.current) return;
    scrollToActiveRef.current = false;
    const index = ids.indexOf(selection.activeId as IssueId);
    if (index === -1) return;
    listRef.current?.scrollToIndex({ index, viewOffset: 48 });
  }, [ids, selection.activeId]);

  const handleRowClick = (issue: Issue, event: MouseEvent) => {
    const mode = issueSelectModeForModifiers(event);
    setSelection((current) => selectIssueRow(current, { ids, issueId: issue.id, mode }));
    if (mode === "replace") openIssue(issue);
  };

  const openAccept = (issues: ReadonlyArray<Issue>) => {
    if (issues.length === 0) return;
    setAcceptIssues(issues);
    setAcceptOpen(true);
  };

  /**
   * Rejecting is a soft delete that leaves `triage` set, so restoring puts the item back in this
   * queue rather than into the workflow — which is what makes the Undo whole.
   */
  const reject = (issues: ReadonlyArray<Issue>) => {
    if (issues.length === 0) return;
    void (async () => {
      const rejected: Array<IssueId> = [];
      for (const issue of issues) {
        const result = await rejectTriage({ issueId: issue.id });
        if (reportIssueWriteFailure("Failed to reject the issue", result)) continue;
        rejected.push(issue.id);
      }
      if (rejected.length === 0) return;
      setSelection(EMPTY_ISSUES_SELECTION);
      const first = issues[0];
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title:
            rejected.length === 1
              ? `${first?.key ?? "Issue"} rejected`
              : `${rejected.length} items rejected`,
          description: "Restoring one puts it back in triage.",
          actionProps: {
            children: "Undo",
            onClick: () => {
              void (async () => {
                toastManager.close(toastId);
                for (const issueId of rejected) {
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

  const renderItem = ({ item }: { item: TriageRowPresentation }) => {
    const issue = issuesById.get(item.issueId as IssueId);
    if (issue === undefined) return null;
    return (
      <TriageRow
        active={selection.activeId === issue.id}
        issue={issue}
        onAccept={(target) => openAccept([target])}
        onOpen={openIssue}
        onReject={(target) => reject([target])}
        onRowClick={handleRowClick}
        row={item}
        selected={selection.ids.has(issue.id)}
      />
    );
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
          <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
            <WorkspaceBreadcrumbItem>
              <button
                className="outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSearch({ triage: undefined })}
                type="button"
              >
                Issues
              </button>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>Triage</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>

        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
          <span className="text-xs tabular-nums text-muted-foreground/70">
            {triageIssues.length} {triageIssues.length === 1 ? "item" : "items"} waiting
          </span>
          <div className="ms-auto flex items-center gap-1">
            <Button onClick={() => onSearch({ triage: undefined })} size="xs" variant="ghost">
              Back to issues
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {storeStatus === "disconnected" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>No environment connected</EmptyTitle>
                <EmptyDescription>
                  Intake runs on the machine you are connected to. Connect one to see its queue.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : storeStatus === "loading" && triageIssues.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : triageIssues.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>Triage is clear</EmptyTitle>
                <EmptyDescription>
                  Messages from a watched Slack channel land here. Accepting one gives it a status,
                  a project, and a priority in one go.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <LegendList<TriageRowPresentation>
              aria-label="Triage"
              className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
              data={rows}
              estimatedItemSize={ESTIMATED_TRIAGE_ROW_HEIGHT}
              keyExtractor={triageKeyExtractor}
              ref={listRef}
              renderItem={renderItem}
              role="listbox"
            />
          )}

          {selectedIssues.length > 1 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
              <div
                aria-label="Bulk triage actions"
                className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur-sm"
                role="toolbar"
              >
                <span className="px-2 text-xs tabular-nums text-muted-foreground">
                  {selectedIssues.length} selected
                </span>
                <Button onClick={() => reject(selectedIssues)} size="xs" variant="ghost">
                  <XIcon />
                  Reject
                </Button>
                <Button onClick={() => openAccept(selectedIssues)} size="xs" variant="ghost">
                  <CheckIcon />
                  Accept
                </Button>
                <Button
                  aria-label="Clear selection"
                  onClick={() => setSelection(EMPTY_ISSUES_SELECTION)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <NewIssueDialog
        defaultProjectId={null}
        defaultStatusId={statuses[0]?.id ?? null}
        labels={labels}
        onOpenChange={setNewIssueOpen}
        open={newIssueOpen}
        projects={projects}
        statuses={statuses}
      />

      <TriageAcceptDialog
        issues={acceptIssues}
        onAccepted={() => setSelection(EMPTY_ISSUES_SELECTION)}
        onOpenChange={setAcceptOpen}
        onStartTask={(issue) => {
          if (issue.assignee?.kind !== "agent") return;
          setStartWorkRequest({
            issueKey: issue.key,
            provider: issue.assignee.provider,
            projectId: issue.projectId,
          });
          onSearch({ issue: issue.key });
        }}
        open={acceptOpen}
        projects={projects}
        statuses={statuses}
      />

      <IssueDetailSheet
        issueKey={detailIssueKey}
        onClose={closeDetail}
        onOpenIssueKey={(key) => onSearch({ issue: key })}
        onStartWorkRequestHandled={() => setStartWorkRequest(null)}
        startWorkRequestProvider={
          startWorkRequest?.issueKey === detailIssueKey ? startWorkRequest.provider : null
        }
        startWorkRequestProjectId={
          startWorkRequest?.issueKey === detailIssueKey ? startWorkRequest.projectId : null
        }
      />
    </SidebarInset>
  );
}

function triageKeyExtractor(item: TriageRowPresentation) {
  return item.issueId;
}
