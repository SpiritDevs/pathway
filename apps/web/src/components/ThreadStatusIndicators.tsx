import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@spiritdevs/client-runtime/environment";
import type {
  OrchestrationV2PullRequestAttachment,
  PullRequestDetail,
  SourceControlProviderInfo,
  VcsStatusResult,
} from "@spiritdevs/contracts";
import { getChangeRequestTerminologyFromUrl } from "@spiritdevs/shared/sourceControl";
import {
  CloudIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  GitPullRequestArrowIcon,
  TerminalIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { sameAttachedPullRequest, useAttachedPullRequests } from "../state/threadPullRequest";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function settledPrHoverColorClass(state: NonNullable<ThreadPr>["state"]): string {
  switch (state) {
    case "open":
      return "group-hover/v2-row:text-emerald-600 dark:group-hover/v2-row:text-emerald-300/90";
    case "merged":
      return "group-hover/v2-row:text-violet-600 dark:group-hover/v2-row:text-violet-300/90";
    case "closed":
      return "group-hover/v2-row:text-red-600 dark:group-hover/v2-row:text-red-300/90";
  }
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
  detail?: Pick<PullRequestDetail, "checks" | "isDraft">,
): PrStatusIndicator | null {
  function formatPrState(state: NonNullable<ThreadPr>["state"]): string {
    return state.charAt(0).toUpperCase() + state.slice(1);
  }

  function formatPrStatusLead(pr: NonNullable<ThreadPr>, changeRequestShortName: string): string {
    return `${changeRequestShortName} #${pr.number} - ${formatPrState(pr.state)}`;
  }
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  const failedChecks =
    detail?.checks.filter((check) => check.status === "failure" || check.status === "cancelled")
      .length ?? 0;
  const pendingChecks = detail?.checks.filter((check) => check.status === "pending").length ?? 0;
  const checkLabel =
    failedChecks > 0 ? "Checks failing" : pendingChecks > 0 ? "Checks pending" : null;
  const tooltipLead = `${formatPrStatusLead(pr, presentation.shortName)}${pr.state === "open" && checkLabel ? ` - ${checkLabel}` : ""}`;
  const tooltip = `${tooltipLead}: ${pr.title}`;

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} ${checkLabel?.toLowerCase() ?? (detail?.isDraft ? "draft" : "open")}`,
      colorClass:
        failedChecks > 0
          ? "text-red-600 dark:text-red-300/90"
          : pendingChecks > 0
            ? "text-amber-600 dark:text-amber-300/90"
            : detail?.isDraft
              ? "text-secondary-label"
              : "text-emerald-600 dark:text-emerald-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-red-600 dark:text-red-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  return null;
}

export function attachedPrStatusIndicator(
  pr: OrchestrationV2PullRequestAttachment,
): PrStatusIndicator {
  const terminology = getChangeRequestTerminologyFromUrl(pr.url);
  const tooltipLead = `${terminology.shortLabel} #${pr.number} - Attached`;
  const tooltipTitle = "Attached to thread";
  return {
    label: `${terminology.shortLabel} attached`,
    colorClass: "text-secondary-label hover:text-foreground",
    tooltip: `${tooltipLead}: ${tooltipTitle}`,
    tooltipLead,
    tooltipTitle,
    url: pr.url,
  };
}

export function resolveThreadPrBadge(input: {
  readonly branchPullRequest: ThreadPr;
  readonly attachedPullRequest: OrchestrationV2PullRequestAttachment | null | undefined;
  readonly attachedDetail?: Pick<
    PullRequestDetail,
    | "number"
    | "url"
    | "title"
    | "state"
    | "headBranch"
    | "baseBranch"
    | "provider"
    | "checks"
    | "isDraft"
  > | null;
  readonly attachedError?: string | null;
  readonly provider: SourceControlProviderInfo | null | undefined;
}): {
  readonly pullRequest: OrchestrationV2PullRequestAttachment;
  readonly status: PrStatusIndicator;
  readonly changeRequestState: NonNullable<ThreadPr>["state"] | null;
} | null {
  const { attachedPullRequest, branchPullRequest, provider, attachedDetail, attachedError } = input;
  if (attachedPullRequest) {
    if (attachedDetail && sameAttachedPullRequest(attachedPullRequest, attachedDetail)) {
      const pr = {
        ...attachedDetail,
        // A merged PR cannot reopen. A newer branch observation must not be
        // hidden by an older detail-cache response for the same PR.
        state:
          branchPullRequest?.state === "merged" &&
          sameAttachedPullRequest(attachedPullRequest, branchPullRequest)
            ? ("merged" as const)
            : attachedDetail.state,
        baseRef: attachedDetail.baseBranch,
        headRef: attachedDetail.headBranch,
      };
      const status = prStatusIndicator(
        pr,
        {
          kind: attachedDetail.provider,
          name: attachedDetail.provider,
          baseUrl: new URL(attachedDetail.url).origin,
        },
        attachedDetail,
      )!;
      return {
        pullRequest: attachedPullRequest,
        changeRequestState: pr.state,
        status: attachedError
          ? {
              ...status,
              tooltip: `${status.tooltip}. Status refresh failed: ${attachedError}`,
              tooltipTitle: `${status.tooltipTitle}. Status refresh failed: ${attachedError}`,
            }
          : status,
      };
    }
    const matchesBranchPullRequest =
      branchPullRequest?.number === attachedPullRequest.number &&
      branchPullRequest.url === attachedPullRequest.url;
    const status =
      (matchesBranchPullRequest ? prStatusIndicator(branchPullRequest, provider) : null) ??
      attachedPrStatusIndicator(attachedPullRequest);
    return {
      pullRequest: attachedPullRequest,
      changeRequestState: matchesBranchPullRequest ? branchPullRequest.state : null,
      status: attachedError
        ? {
            ...status,
            label: `${getChangeRequestTerminologyFromUrl(attachedPullRequest.url).shortLabel} status unavailable`,
            colorClass: "text-amber-600 dark:text-amber-300/90",
            tooltip: attachedError,
            tooltipTitle: attachedError,
          }
        : status,
    };
  }
  const status = prStatusIndicator(branchPullRequest, provider);
  return branchPullRequest && status
    ? { pullRequest: branchPullRequest, status, changeRequestState: branchPullRequest.state }
    : null;
}

export function resolveThreadPrBadges({
  branchPullRequest,
  detachedPullRequestUrls,
  attachedQueries,
  provider,
}: {
  branchPullRequest: ThreadPr;
  detachedPullRequestUrls?: ReadonlyArray<string> | undefined;
  attachedQueries: ReadonlyArray<{
    attachment: OrchestrationV2PullRequestAttachment;
    data: Parameters<typeof resolveThreadPrBadge>[0]["attachedDetail"];
    error: string | null;
  }>;
  provider: SourceControlProviderInfo | null | undefined;
}) {
  const visibleBranchPr =
    branchPullRequest && !detachedPullRequestUrls?.includes(branchPullRequest.url)
      ? branchPullRequest
      : null;
  const badges = attachedQueries.map(
    (query) =>
      resolveThreadPrBadge({
        branchPullRequest: visibleBranchPr,
        attachedPullRequest: query.attachment,
        attachedDetail: query.data ?? null,
        attachedError: query.error,
        provider,
      })!,
  );
  if (visibleBranchPr && !badges.some((badge) => badge.pullRequest.url === visibleBranchPr.url)) {
    badges.push(
      resolveThreadPrBadge({
        branchPullRequest: visibleBranchPr,
        attachedPullRequest: null,
        provider,
      })!,
    );
  }
  return badges;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
}

export function resolveThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): ThreadPr | null {
  const { threadBranch, gitStatus } = input;
  if (gitStatus === null) {
    return null;
  }

  if (threadBranch === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadProject = useProject(
    useMemo(
      () =>
        thread.projectId === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const pr = resolveThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
  });
  const attachedQueries = useAttachedPullRequests(thread);
  const badges = resolveThreadPrBadges({
    branchPullRequest: pr,
    detachedPullRequestUrls: thread.detachedPullRequestUrls,
    attachedQueries,
    provider: gitStatus.data?.sourceControlProvider,
  });
  const changeRequestStatus = (
    badges.find((badge) => badge.changeRequestState !== "merged") ?? badges.at(-1)
  )?.status;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!changeRequestStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {changeRequestStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={changeRequestStatus.tooltip}
                className={`inline-flex items-center justify-center ${changeRequestStatus.colorClass}`}
              />
            }
          >
            {badges.length > 1 ? (
              <>
                <GitPullRequestArrowIcon className="size-3" />
                <span className="text-xs">{badges.length}</span>
              </>
            ) : (
              <ChangeRequestStatusIcon className="size-3" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={changeRequestStatus} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
