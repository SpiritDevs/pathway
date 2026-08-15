import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  type ModelSelection,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestState,
  type ThreadId,
} from "@spiritdevs/contracts";
import { pullRequestReviewThreadTitle } from "@spiritdevs/shared/pullRequestReview";
import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CircleDotIcon,
  ChevronDownIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  ScanSearchIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCopyToClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePrimarySettings } from "~/hooks/useSettings";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { newMessageId, newThreadId } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { primaryServerProvidersAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

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
import { toastManager } from "../ui/toast";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { PullRequestDetailGhost, PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { PullRequestAgentReviewDialog } from "./PullRequestAgentReviewDialog";
import { PullRequestReviewingTab } from "./PullRequestReviewingTab";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import type { PullRequestAskSelectionInput } from "./PullRequestCodeTab";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import {
  allowedPullRequestMergeMethods,
  buildAskAboutLinesHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  canPerformPullRequestAction,
  isPullRequestConflicting,
  pullRequestActionMenuHasGroup,
  pullRequestFindingKey,
  resolvePullRequestChromeCollapse,
  resolvePullRequestPrimaryAction,
  resolveSelectedMergeMethod,
  type PullRequestChromeMetrics,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import { buildPullRequestAgentReviewPrompt } from "./pullRequestAgentReview.logic";
import { usePullRequestActionRunner, usePullRequestHandoffs } from "./usePullRequestActions";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code" | "reviewing";

/** Named for the host rather than "externally": the point is where you will land. */
const OPEN_ON_HOST_LABELS: Partial<Record<string, string>> = {
  github: "Open on GitHub",
  gitlab: "Open on GitLab",
  bitbucket: "Open on Bitbucket",
  "azure-devops": "Open on Azure DevOps",
};

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
  { value: "reviewing", label: "Reviewing" },
];

/** Room for rounding: a scroller within a pixel of its content is not one the reader scrolls. */
const SCROLLABLE_EPSILON = 1;

/**
 * The one scroller whose position the folding chrome answers to: the outermost vertically
 * scrolling element of the tab on screen. Everything else a captured scroll event can come
 * from — a diff row travelling sideways, an inner list with its own overflow, a tab still
 * mounted behind this one being restored by its virtualizer — is reporting a position in a
 * different space, and folding the chrome on it is how the chrome ends up flapping.
 */
function isActiveTabScroller(target: HTMLElement, tab: DetailTab): boolean {
  if (target.scrollHeight - target.clientHeight <= SCROLLABLE_EPSILON) return false;
  const pane = target.closest<HTMLElement>("[data-pr-tab]");
  if (pane === null || pane.dataset.prTab !== tab) return false;
  for (let node = target.parentElement; node !== null && node !== pane; node = node.parentElement) {
    // Overflowing is not the same as scrolling: a clipped `overflow-hidden` box can measure
    // taller than it paints and is nobody's scroller. The style is only consulted for the few
    // ancestors that overflow at all, so the usual walk never leaves the layout numbers.
    if (node.scrollHeight - node.clientHeight <= SCROLLABLE_EPSILON) continue;
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return false;
  }
  return true;
}

// The diff viewer pulls in its worker pool, so it stays out of the bundle until Code is opened.
// Named rather than inlined so the panel can also call it itself, to start the download before
// anyone has clicked the tab.
const loadCodeTab = () => import("./PullRequestCodeTab");
const PullRequestCodeTab = lazy(loadCodeTab);

export function PullRequestDetailPanel({
  environmentId,
  reference,
  refreshToken: forcedRefreshToken = 0,
  onActed,
  onClose,
  onStateChange,
  context = "page",
  chromeVariant = "full",
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /**
   * Bumped by whatever holds the panel when a reader asks for everything on screen to be read
   * again. The panel owns its own reads, so the page cannot refresh them for it — it says when,
   * and this says it.
   */
  refreshToken?: number;
  /**
   * An action changed this pull request on the host, so a list showing it is now out of date.
   * Told rather than assumed: only the page knows whether it is showing one.
   */
  onActed?: () => void;
  /** Page-owned detail columns use this to clear the selected pull request. */
  onClose?: () => void;
  /** Keeps compact chrome, such as the right-panel tab, in step with refreshed host state. */
  onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: PullRequestState;
    isDraft: boolean;
  }) => void;
  /**
   * Beside a thread, the checkout affordance disappears: the panel is showing that thread's
   * own pull request, so the branch is already under the reader's feet — and checking it out
   * again is at best a no-op and at worst git refusing a branch two checkouts.
   */
  context?: "page" | "thread";
  /**
   * How the metadata above the content behaves: `full` keeps every row pinned; `collapse`
   * folds the whole of it into the top row once the active tab scrolls, and unfolds at the
   * top — the chrome spends its height on what is being read.
   */
  chromeVariant?: "full" | "collapse";
}) {
  const pullRequestKey = `${reference.projectId}:${reference.repository}#${reference.number}`;
  const [tab, setTab] = useState<DetailTab>("summary");
  const [timelineOrder, setTimelineOrder] = useState<"newest" | "oldest">("newest");
  const [codeCommitScope, setCodeCommitScope] = useState<{
    readonly pullRequestKey: string;
    readonly oid: string | null;
  }>(() => ({ pullRequestKey, oid: null }));
  const selectedCodeCommitOid =
    codeCommitScope.pullRequestKey === pullRequestKey ? codeCommitScope.oid : null;
  const selectCodeCommit = (oid: string | null) => {
    setCodeCommitScope({ pullRequestKey, oid });
  };
  const openCommit = (oid: string) => {
    selectCodeCommit(oid);
    setTab("code");
  };
  // Every tab the reader has opened stays mounted behind the active one. The diff viewer
  // always needed this (it virtualizes against its own scroll position); the trace showed the
  // summary needs it too — a large description re-parses its whole markdown on every return
  // to the tab. `visibility` keeps boxes, sizes and scroll offsets, and takes hidden content
  // out of the tab order and the accessibility tree.
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<DetailTab>>(
    () => new Set<DetailTab>(["summary"]),
  );
  useEffect(() => {
    setMountedTabs((previous) =>
      previous.has(tab) ? previous : new Set<DetailTab>(previous).add(tab),
    );
  }, [tab]);
  // Whether the chrome is folded is a property of the tab being read, not of the panel: each
  // tab scrolls its own container, so a tab left at the top must show a full chrome even when
  // the tab beside it is deep in a diff. Keyed state rather than a state plus a remembered
  // copy — a tab switch then has nothing to re-sync, and no frame paints the wrong chrome.
  const [condensedByTab, setCondensedByTab] = useState<Partial<Record<DetailTab, boolean>>>({});
  const condensed = chromeVariant === "collapse" && (condensedByTab[tab] ?? false);
  // A different pull request is a different set of scrollers, all of them at the top.
  useEffect(() => {
    setCondensedByTab({});
  }, [pullRequestKey]);
  // Collapsing removes the fold's height from the chrome, which hands that height to the
  // scrollport and would leap the content up by it mid-scroll. The cure is exact compensation:
  // give the height back to `scrollTop` before the next paint, so the content under the
  // reader's eyes does not move and the collapse itself is the only thing that changes.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  // The condensed chrome's second row opens as the fold closes, so the height the scrollport
  // gains is the fold's minus this row's. Measured the same way the fold is: `scrollHeight`
  // through a zero track reads its natural height in either state.
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const delta = compensationRef.current;
    compensationRef.current = null;
    if (delta === null || delta === 0) return;
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [condensed]);
  // Both heights, read on render rather than on every scroll event: `scrollHeight` forces a
  // synchronous layout, and a scroll handler over a virtualized diff is the last place to ask
  // for one. Rendering covers the changes the panel knows about — the conflict row arriving,
  // a tab appearing — and the observer covers the ones it does not, such as a resize wrapping
  // the title onto a second line.
  const chromeMetricsRef = useRef<PullRequestChromeMetrics>({
    foldHeight: 0,
    condensedRowHeight: 0,
  });
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const measureChrome = useCallback(() => {
    // `scrollHeight` through a zero-height track reads natural height in either state, so the
    // measurement does not depend on which way the chrome happens to be folded right now.
    chromeMetricsRef.current = {
      foldHeight: foldRef.current?.scrollHeight ?? 0,
      condensedRowHeight: condensedRowRef.current?.scrollHeight ?? 0,
    };
  }, []);
  useLayoutEffect(measureChrome);
  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    if (chrome === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureChrome);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, [measureChrome]);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  const { copyToClipboard: copyBranchToClipboard, isCopied: isBranchCopied } = useCopyToClipboard({
    target: "branch name",
    timeout: 1600,
  });
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [startingReview, setStartingReview] = useState(false);
  const [launchedReview, setLaunchedReview] = useState<{
    readonly pullRequestKey: string;
    readonly threadId: ThreadId;
    readonly publishComments: boolean;
  } | null>(null);
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const threadShells = useThreadShells();
  const reviewInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const reviewModelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const startReviewTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  // The chunk is fetched as soon as the panel exists rather than waiting for the Code tab to be
  // clicked, so a reader who does click it lands on a chunk already in the module cache.
  useEffect(() => {
    void loadCodeTab();
  }, []);

  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  // Detail and diff are independent server reads, so the diff for the default view (no commit,
  // no cursor) is started here too rather than waiting for the Code tab to mount. This is one
  // extra cached read per opened pull request even for readers who never open the tab, but it
  // turns the tab's first paint from a cold request into a cache hit.
  const _diffWarmUpQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({ environmentId, input: { ...reference } }),
  );
  const coreDetail = detailQuery.data;
  const activity = activityQuery.data;
  const detail = useMemo(
    () =>
      coreDetail === null
        ? null
        : {
            ...coreDetail,
            author: activity?.author ?? coreDetail.author,
            reviewers: activity?.reviewers ?? coreDetail.reviewers,
            comments: activity?.comments ?? [],
            commentCount: activity?.commentCount ?? 0,
            commentsTruncated: activity?.commentsTruncated ?? false,
            reviewThreads: activity?.reviewThreads ?? [],
            commits: activity?.commits ?? [],
          },
    [activity, coreDetail],
  );
  const reviewProject = useMemo(
    () =>
      detail === null
        ? null
        : (projects.find(
            (project) => project.environmentId === environmentId && project.id === detail.projectId,
          ) ?? null),
    [detail, environmentId, projects],
  );
  const initialReviewModelSelection = useMemo<ModelSelection | null>(
    () =>
      resolveDefaultProviderModelSelection(
        serverProviders,
        reviewProject?.defaultModelSelection ?? settings.textGenerationModelSelection,
      ),
    [reviewProject?.defaultModelSelection, serverProviders, settings.textGenerationModelSelection],
  );
  const prepareReviewThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  const discoveredReview = useMemo(() => {
    if (detail === null) return null;
    const draftTitle = pullRequestReviewThreadTitle({
      repository: detail.repository,
      number: detail.number,
      publishComments: false,
    });
    const publishingTitle = pullRequestReviewThreadTitle({
      repository: detail.repository,
      number: detail.number,
      publishComments: true,
    });
    return (
      threadShells
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.projectId === detail.projectId &&
            thread.deletedAt === null &&
            (thread.title === draftTitle || thread.title === publishingTitle),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    );
  }, [detail, environmentId, threadShells]);
  const activeReview =
    launchedReview?.pullRequestKey === pullRequestKey
      ? launchedReview
      : discoveredReview === null
        ? null
        : {
            pullRequestKey,
            threadId: discoveredReview.id,
            publishComments: discoveredReview.title.endsWith(" · publish"),
          };
  const activityPending = activityQuery.isPending && activity === null;
  const activityError = activity === null ? activityQuery.error : null;
  const refreshDetail = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
  }, [activityQuery.refresh, detailQuery.refresh]);
  useEffect(() => {
    if (!detail) return;
    onStateChange?.({
      projectId: detail.projectId,
      repository: detail.repository,
      number: detail.number,
      state: detail.state,
      isDraft: detail.isDraft,
    });
  }, [detail, onStateChange]);
  // A pull request changes while it is open in front of somebody — a push lands, a check
  // finishes, a review arrives — so the panel reads it again on the way back to the window and
  // while a reader sits on it. Keyed by the pull request rather than by the panel, because this
  // one panel shows a different pull request every time it is opened.
  useLiveRefresh(refreshDetail, {
    key: `pull-request:${reference.projectId}:${reference.repository}#${reference.number}`,
  });
  // The button, on the other hand, goes around the server's cache rather than through it: it is
  // the answer for a reader who can see that what they are looking at is behind. The
  // invalidation goes first so the re-reads miss that cache; if it fails, the reads still run
  // and at worst answer from it.
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshFromHost = useCallback(async () => {
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
    setRefreshToken((token) => token + 1);
  }, [environmentId, invalidate, reference, refreshDetail]);
  const startAgentReview = useCallback(
    (input: {
      readonly modelSelection: ModelSelection;
      readonly instructions: string;
      readonly publishComments: boolean;
    }) => {
      if (detail === null || startingReview) return;
      setStartingReview(true);
      const toastId = toastManager.add({
        type: "loading",
        title: "Preparing the pull request review…",
      });
      void (async () => {
        const threadId = newThreadId();
        try {
          const prepared = await prepareReviewThread.run({
            reference: detail.url,
            mode: "worktree",
            threadId,
            isolateWorktree: true,
          });
          if (prepared._tag === "Failure") {
            const description =
              prepareReviewThread.error instanceof Error
                ? prepareReviewThread.error.message
                : "The pull request checkout could not be prepared.";
            toastManager.update(toastId, {
              type: "error",
              title: "Could not prepare the review",
              description,
            });
            return;
          }
          if (!prepared.value.isOnPullRequestHead) {
            toastManager.update(toastId, {
              type: "error",
              title: "The review checkout is behind the pull request",
              description:
                "The isolated review checkout could not be prepared at the latest commit. Start the review again.",
            });
            return;
          }

          const createdAt = new Date().toISOString();
          const title = pullRequestReviewThreadTitle({
            repository: detail.repository,
            number: detail.number,
            publishComments: input.publishComments,
          });
          const started = await startReviewTurn({
            environmentId,
            input: {
              threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: buildPullRequestAgentReviewPrompt({
                  number: detail.number,
                  title: detail.title,
                  url: detail.url,
                  repository: detail.repository,
                  headBranch: detail.headBranch,
                  baseBranch: detail.baseBranch,
                  instructions: input.instructions,
                }),
                attachments: [],
              },
              modelSelection: input.modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              bootstrap: {
                createThread: {
                  projectId: detail.projectId,
                  title,
                  modelSelection: input.modelSelection,
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: prepared.value.branch,
                  worktreePath: prepared.value.worktreePath,
                  createdAt,
                },
              },
              createdAt,
            },
          });
          if (started._tag === "Failure") {
            const failure = squashAtomCommandFailure(started);
            toastManager.update(toastId, {
              type: "error",
              title: "Could not start the agent review",
              description:
                failure instanceof Error ? failure.message : "The agent could not be started.",
            });
            return;
          }
          setLaunchedReview({ pullRequestKey, threadId, publishComments: input.publishComments });
          setMountedTabs((previous) => new Set<DetailTab>(previous).add("reviewing"));
          setTab("reviewing");
          setReviewDialogOpen(false);
          toastManager.update(toastId, {
            type: "success",
            title: "Agent review started",
            description: "Follow its progress in Reviewing.",
          });
        } catch (error) {
          toastManager.update(toastId, {
            type: "error",
            title: "Could not start the agent review",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        } finally {
          setStartingReview(false);
        }
      })();
    },
    [detail, environmentId, prepareReviewThread, pullRequestKey, startReviewTurn, startingReview],
  );
  // A refresh asked for by the page: the detail, and through the token below, the diff with it.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => {
      refreshDetail();
      onActed?.();
    },
  });
  const { handoff, startAsk, startHandoff } = usePullRequestHandoffs({ environmentId, detail });

  const askAboutPullRequest = () => {
    if (!detail) return;
    void startAsk("ask", {
      ...buildAskAboutPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const explainPullRequest = () => {
    if (!detail) return;
    void startAsk("explain", {
      ...buildExplainPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  /** Lines the reader marked in the diff, asked about rather than commented on. */
  const askAboutSelection = (selection: PullRequestAskSelectionInput) => {
    if (!detail) return;
    void startAsk(`ask:${selection.comment.id}`, {
      ...buildAskAboutLinesHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        comment: selection.comment,
        question: selection.question,
      }),
    });
  };

  const startCheckout = (mode: "worktree" | "local") => {
    if (!detail) return;
    void startHandoff(`checkout:${mode}`, null, mode);
  };

  /** One finding, handed over on its own — the surfaces that show findings call this. */
  const startFixFinding = (finding: PullRequestFinding) => {
    if (!detail) return;
    void startHandoff(
      pullRequestFindingKey(finding),
      buildFixFindingHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        finding,
      }),
    );
  };

  const startFixFindings = () => {
    if (!detail) return;
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: detail.reviewThreads,
        comments: detail.comments,
        checks: detail.checks,
        commentsTruncated: detail.commentsTruncated,
      }),
    );
  };

  const startResolveConflicts = () => {
    if (!detail) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: detail.number,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const allowedMergeMethods = allowedPullRequestMergeMethods(detail);
  const selectedMergeMethod = resolveSelectedMergeMethod(allowedMergeMethods, mergeMethod);
  const conflicting = isPullRequestConflicting(detail);
  // A host that cannot produce a patch has no Code tab to open. The tabs themselves stay hidden
  // until the detail arrives, so the loading ghost is the panel's only unfinished UI.
  const visibleTabs = TABS.filter((item) => {
    if (item.value === "code") return detail === null || detail.capabilities.diff;
    if (item.value === "reviewing") return activeReview !== null;
    return true;
  });
  // The Code tab can be opened while the detail is still on its way, and the detail may then say
  // this host has no patch to show. The tab goes, so whoever was standing on it is moved back to
  // the summary rather than left looking at a panel that is no longer reachable.
  useEffect(() => {
    if (!visibleTabs.some((item) => item.value === tab)) setTab("summary");
  }, [tab, visibleTabs]);
  const can = (action: PullRequestAction) => canPerformPullRequestAction(detail, action);
  const primaryAction = resolvePullRequestPrimaryAction(detail);
  // What the menu's action group holds. Named once so the separators around it are drawn from
  // the same answer as its contents, rather than on the assumption that it has any.
  const showsDraftToggle =
    detail?.state === "open" &&
    can(detail.isDraft ? "ready" : "draft") &&
    !(detail.isDraft && primaryAction === "ready");
  const showsMergeMethods =
    detail?.state === "open" &&
    can("merge") &&
    !detail.isDraft &&
    !conflicting &&
    allowedMergeMethods.length > 1;
  // The pull request number carries this state in the overview and the right-panel tab mirrors
  // it. Conflicts keep their own row below: an open pull request remains green there.
  const statePresentation = detail
    ? resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft })
    : null;
  const checksSummary = detail ? summarizePullRequestChecks(detail.checks) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* The top row's geometry never changes: both of its states occupy the same stacked
          cell and crossfade, so the actions on the right have one home whatever the chrome
          is doing below. The fold and this fade share one 200ms clock. */}
      <div
        ref={chromeRef}
        className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60"
      >
        {/* The fixed height lives on the two top-row cells — not the grid, whose later rows
            are the fold — so the actions have one immovable home in both states. */}
        <div className="ml-4 grid h-11 min-w-0 items-center">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-opacity sm:text-xs motion-reduce:transition-none",
              // Sequenced, not simultaneous: the leaving layer clears quickly before the
              // arriving one lands, so no frame shows both texts superimposed at half opacity.
              condensed
                ? "pointer-events-none opacity-0 duration-100"
                : "opacity-100 delay-75 duration-150",
            )}
          >
            {detail && statePresentation ? (
              <>
                <span className="min-w-0 truncate" title={detail.repository}>
                  {detail.repository}
                </span>
                <button
                  type="button"
                  onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open pull request #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
              </>
            ) : null}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-sm transition-opacity sm:text-xs motion-reduce:transition-none",
              condensed
                ? "opacity-100 delay-75 duration-150"
                : "pointer-events-none opacity-0 duration-100",
            )}
          >
            {detail && statePresentation ? (
              <>
                <button
                  type="button"
                  tabIndex={condensed ? 0 : -1}
                  onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open pull request #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
                <span className="min-w-0 truncate font-medium text-foreground" title={detail.title}>
                  {detail.title}
                </span>
                {conflicting ? (
                  <Badge
                    variant="error"
                    className="h-5 shrink-0 gap-1 rounded px-1.5 text-[10px] text-destructive"
                  >
                    <TriangleAlertIcon className="size-3" />
                    Conflicts
                  </Badge>
                ) : checksSummary ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {checksSummary}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-11 min-w-0 flex-nowrap items-center justify-end gap-1">
          {detail ? (
            <>
              <Menu>
                <MenuTrigger
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="More pull request actions"
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-72">
                  <MenuItem disabled={detailQuery.isPending} onClick={() => void refreshFromHost()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
                    <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
                      <span className="text-xs text-muted-foreground">
                        Opens a thread that knows which pull request you mean.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
                    <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "explain" ? "Opening..." : "Explain this PR"}</span>
                      <span className="text-xs text-muted-foreground">
                        A walk through the diff and what to read closely.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={startingReview} onClick={() => setReviewDialogOpen(true)}>
                    <ScanSearchIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>
                        {activeReview === null
                          ? "Review with an agent"
                          : "Start another agent review"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Choose an agent, model, reasoning, and speed.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={startFixFindings}>
                    <HammerIcon className="size-3.5" />
                    {handoff === "findings" ? "Preparing..." : "Fix findings in a thread"}
                  </MenuItem>
                  <MenuSeparator />
                  {detail.state === "open" ? (
                    <>
                      {/* Only where the button row could not take it: "Ready for review" on a
                          draft is the primary header button, so offering it here as well would
                          show the same action twice. */}
                      {showsDraftToggle ? (
                        <MenuItem
                          disabled={actionPending}
                          onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
                        >
                          {detail.isDraft ? (
                            <GitPullRequestIcon className="size-3.5" />
                          ) : (
                            <GitPullRequestDraftIcon className="size-3.5" />
                          )}
                          {detail.isDraft ? "Ready for review" : "Convert to draft"}
                        </MenuItem>
                      ) : null}
                      {/* A preference for the merge action rather than a second action, so it
                          is a radio group here instead of a chevron welded to the Merge pill.
                          Hidden while conflicting: every method would fail. */}
                      {/* Only where merging is on offer at all: a strategy to merge with is not
                          a choice for someone who may not merge. */}
                      {showsMergeMethods ? (
                        <>
                          {/* Only below the draft control. A host with no draft of its own, or
                              a draft whose control is already the header button, would leave
                              this against the separator that opened the group. */}
                          {showsDraftToggle ? <MenuSeparator /> : null}
                          <MenuRadioGroup
                            value={selectedMergeMethod}
                            onValueChange={(method) =>
                              setMergeMethod(method as PullRequestMergeMethod)
                            }
                          >
                            {allowedMergeMethods.map((method) => (
                              <MenuRadioItem key={method} value={method} disabled={actionPending}>
                                {/* The radio item lays its children out as one block, so the
                                    icon and the label need their own row to share a line. */}
                                <span className="flex min-w-0 items-center gap-2">
                                  <GitMergeIcon className="size-3.5" />
                                  <span className="capitalize">{method}</span>
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </>
                      ) : null}
                      {pullRequestActionMenuHasGroup(showsDraftToggle, showsMergeMethods) ? (
                        <MenuSeparator />
                      ) : null}
                    </>
                  ) : null}
                  <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
                    <ArrowUpRightIcon className="size-3.5" />
                    {OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  </MenuItem>
                  <MenuItem onClick={() => void writeTextToClipboard(detail.url)}>
                    <LinkIcon className="size-3.5" />
                    Copy link
                  </MenuItem>
                  {/* Only where the button row could not take it, so it is never offered twice. */}
                  {conflicting && primaryAction !== "resolve" ? (
                    <MenuItem disabled={handoff !== null} onClick={startResolveConflicts}>
                      <GitMergeIcon className="size-3.5" />
                      {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts in a thread"}
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" && can("close") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={actionPending}
                        onClick={() => setConfirmAction("close")}
                      >
                        <GitPullRequestClosedIcon className="size-3.5" />
                        Close pull request
                      </MenuItem>
                    </>
                  ) : detail.state === "closed" && can("reopen") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
                        <GitPullRequestIcon className="size-3.5" />
                        Reopen pull request
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
              {/* Checking a pull request out is the reason to open one here at all, so it is a
                  button of its own rather than a side effect of asking an agent for something.
                  It asks where, because the two answers are not interchangeable: one leaves your
                  work where it is, the other moves the repository you are standing in. Only on
                  the page: beside a thread the branch is already checked out right there. */}
              {context === "page" ? (
                <Menu>
                  <MenuTrigger
                    disabled={handoff !== null}
                    render={
                      <Button size="xs" variant="outline">
                        {handoff?.startsWith("checkout") ? (
                          "Checking out..."
                        ) : (
                          <>
                            <GitBranchIcon className="size-3" />
                            Check out
                            <ChevronDownIcon className="size-3 text-muted-foreground" />
                          </>
                        )}
                      </Button>
                    }
                  />
                  <MenuPopup align="end" side="bottom" className="min-w-72">
                    <MenuItem onClick={() => startCheckout("worktree")}>
                      <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In a separate worktree</span>
                        <span className="text-xs text-muted-foreground">
                          Its own folder and thread. Nothing you have open moves.
                        </span>
                      </span>
                    </MenuItem>
                    <MenuItem onClick={() => startCheckout("local")}>
                      <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In this repository</span>
                        <span className="text-xs text-muted-foreground">
                          Switches the branch you are working in, like `gh pr checkout`.
                        </span>
                      </span>
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
              {primaryAction === "ready" ? (
                <Button size="xs" disabled={actionPending} onClick={() => void perform("ready")}>
                  Ready for review
                </Button>
              ) : primaryAction === "merge" ? (
                <Button
                  size="xs"
                  disabled={actionPending}
                  onClick={() => setConfirmAction("merge")}
                >
                  {actionPending ? "Merging..." : "Merge"}
                </Button>
              ) : null}
            </>
          ) : null}
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse pull request panel"
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {/* The condensed chrome's second row: the tabs that the closing fold takes with it,
            and compact copies of the branch pair and diff stat so they stay in sight while
            the full rows are folded away. Same zero-track mechanism as the fold, inverted. */}
        <div className={cn("col-span-2 grid", condensed ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none"
                : "opacity-0",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="flex min-w-0 items-center gap-1 px-4 pb-2">
                <nav aria-label="Pull request tabs" className="flex shrink-0 items-center gap-0.5">
                  {visibleTabs.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      tabIndex={condensed ? 0 : -1}
                      aria-pressed={tab === item.value}
                      onClick={() => setTab(item.value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] transition-colors",
                        tab === item.value
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
                <span
                  className="ml-auto inline-flex min-w-0 shrink items-center gap-1 font-mono text-[11px] text-muted-foreground"
                  title={`${detail.baseBranch} ← ${detail.headBranch}`}
                >
                  <span className="truncate">{detail.baseBranch}</span>
                  <ArrowLeftIcon aria-label="receives changes from" className="size-3 shrink-0" />
                  <span className="truncate">{detail.headBranch}</span>
                </span>
                <span className="ml-2 inline-flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <FileDiffIcon className="size-3" />
                    {detail.changedFiles.toLocaleString()}
                  </span>
                  <PullRequestDiffStat
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-[11px]"
                  />
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Folding is a grid track going to zero: the rows below stay mounted, the track
            animates closed over them, and `inert` takes the hidden controls out of the tab
            order for as long as the chrome is condensed. */}
        <div
          className={cn(
            "col-span-2 grid",
            // Instant in both directions: the scroll compensation keeps the content pinned
            // through either flip, and an animated track would fight it frame by frame. The
            // top row's crossfade is the transition.
            condensed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
          )}
        >
          <div
            ref={foldRef}
            // One-way on purpose: appearing content eases in over ground the instant track
            // already reserved; departing content cuts, because its ground is gone in the
            // same frame and the scroll compensation reads it as scrolled past.
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-0"
                : "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none",
            )}
            inert={condensed}
          >
            {detail ? (
              <div className="col-span-2 mt-3 min-w-0 px-4 pb-4">
                <h1 className="text-base font-semibold leading-snug">{detail.title}</h1>
                <PullRequestMetaLine className="mt-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={detail.author} className="font-medium" />
                  <span>updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
                </PullRequestMetaLine>

                <div className="mt-4 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <code
                    className="min-w-0 max-w-48 shrink truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground"
                    title={detail.baseBranch}
                  >
                    {detail.baseBranch}
                  </code>
                  <ArrowLeftIcon aria-label="receives changes from" className="size-4 shrink-0" />
                  <button
                    type="button"
                    className="grid min-w-0 max-w-64 shrink cursor-pointer rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    aria-label={isBranchCopied ? "Branch name copied" : "Copy pull request branch"}
                    title={isBranchCopied ? "Copied" : "Copy pull request branch"}
                    onClick={() => copyBranchToClipboard(detail.headBranch)}
                  >
                    <code
                      className={cn(
                        "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none",
                        isBranchCopied ? "opacity-0" : "opacity-100",
                      )}
                      title={detail.headBranch}
                    >
                      {detail.headBranch}
                    </code>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "col-start-1 row-start-1 truncate text-center transition-opacity duration-150 motion-reduce:transition-none",
                        isBranchCopied ? "opacity-100" : "opacity-0",
                      )}
                    >
                      Copied
                    </span>
                  </button>
                  <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <FileDiffIcon className="size-3.5" />
                      {detail.changedFiles.toLocaleString()}{" "}
                      {detail.changedFiles === 1 ? "file" : "files"}
                    </span>
                    <PullRequestDiffStat
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="shrink-0 font-mono text-xs"
                    />
                  </span>
                </div>
              </div>
            ) : null}

            {detail && conflicting ? (
              <div className="col-span-2 flex items-center gap-1 px-4 pb-3">
                <Badge
                  variant="error"
                  className="h-auto gap-1.5 rounded-md px-3 py-1.5 text-xs text-destructive"
                >
                  <TriangleAlertIcon className="size-3.5" />
                  Merge conflicts
                </Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto text-destructive hover:bg-destructive/8 hover:text-destructive"
                  disabled={handoff !== null}
                  onClick={startResolveConflicts}
                >
                  {handoff === "conflicts" ? "Preparing..." : "Resolve in a new thread"}
                  <ArrowUpRightIcon className="size-3.5 text-destructive" />
                </Button>
              </div>
            ) : null}

            {detail ? (
              <nav
                className="col-span-2 flex min-w-0 items-center gap-1 overflow-x-auto border-t border-border/60 px-4 py-2"
                aria-label="Pull request tabs"
              >
                {visibleTabs.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={tab === item.value}
                    onClick={() => setTab(item.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
                      tab === item.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
                {tab === "summary" ? (
                  <span
                    className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                    aria-label={checksSummary ? `Checks: ${checksSummary}` : "Checks"}
                  >
                    <CircleDotIcon aria-hidden className="size-3.5" />
                    {checksSummary}
                  </span>
                ) : tab === "timeline" ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <PullRequestMetaLine
                      className={cn(
                        "whitespace-nowrap text-[11px] transition-opacity",
                        (activityPending || activityError) && "opacity-35",
                      )}
                    >
                      <span
                        className="inline-flex items-center gap-1"
                        aria-label={
                          activityError
                            ? "Comments unavailable"
                            : `${detail.commentCount.toLocaleString()} ${
                                detail.commentCount === 1 ? "comment" : "comments"
                              }`
                        }
                      >
                        <MessageSquareIcon aria-hidden className="size-3" />
                        {activityError
                          ? "—"
                          : activityPending
                            ? "…"
                            : detail.commentCount.toLocaleString()}
                      </span>
                      <span
                        className="inline-flex items-center gap-1"
                        aria-label={
                          activityError
                            ? "Commits unavailable"
                            : `${detail.commits.length.toLocaleString()} ${
                                detail.commits.length === 1 ? "commit" : "commits"
                              }`
                        }
                      >
                        <GitCommitHorizontalIcon aria-hidden className="size-3" />
                        {activityError
                          ? "—"
                          : activityPending
                            ? "…"
                            : detail.commits.length.toLocaleString()}
                      </span>
                    </PullRequestMetaLine>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-7 px-2 text-[10px] text-muted-foreground"
                      aria-label={
                        timelineOrder === "newest"
                          ? "Show oldest activity first"
                          : "Show newest activity first"
                      }
                      onClick={() =>
                        setTimelineOrder((value) => (value === "newest" ? "oldest" : "newest"))
                      }
                    >
                      <ArrowDownUpIcon aria-hidden className="size-3" />
                      {timelineOrder === "newest" ? "Newest first" : "Oldest first"}
                    </Button>
                  </div>
                ) : null}
              </nav>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        // Scroll does not bubble, but it captures: one listener hears every tab's own scroll
        // container. It also hears every scroller nested inside them — a diff line scrolling
        // sideways, a comment box with its own overflow, a hidden tab the diff viewer restores
        // while it is off screen — none of which say anything about how far the reader has
        // come. Only the active tab's own outermost vertical scroller does.
        onScrollCapture={(event) => {
          if (chromeVariant !== "collapse") return;
          const scroller = event.target;
          if (!(scroller instanceof HTMLElement)) return;
          if (!isActiveTabScroller(scroller, tab)) return;
          scrollerRef.current = scroller;
          const next = resolvePullRequestChromeCollapse({
            condensed,
            scrollTop: scroller.scrollTop,
            metrics: chromeMetricsRef.current,
          });
          if (next.condensed === condensed) return;
          // The compensation is handed to the layout effect rather than applied here: the
          // fold has not closed yet, so the height being given back does not exist until
          // React has painted the state this event is about to set.
          compensationRef.current = next.scrollCompensation;
          setCondensedByTab((previous) => ({ ...previous, [tab]: next.condensed }));
        }}
      >
        {detailQuery.isPending && !detail ? (
          // The ghost wears the shape of the tab being waited on, so switching tabs mid-load
          // does not flash a summary outline under a timeline heading.
          tab === "timeline" ? (
            <PullRequestTimelineGhost />
          ) : tab === "code" ? (
            <DiffPanelLoadingState label="Loading pull request diff..." />
          ) : (
            <PullRequestDetailGhost />
          )
        ) : detailQuery.error && !detail ? (
          <PullRequestsUnavailableState error={detailQuery.error} onRetry={refreshDetail} />
        ) : detail ? (
          <>
            {mountedTabs.has("summary") ? (
              <div
                data-pr-tab="summary"
                className={cn("absolute inset-0", tab !== "summary" && "invisible")}
              >
                <PullRequestSummaryTab
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  activityError={activityError}
                  pendingFinding={handoff}
                  onFixFinding={startFixFinding}
                  onRefresh={refreshDetail}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div
                data-pr-tab="timeline"
                className={cn("absolute inset-0", tab !== "timeline" && "invisible")}
              >
                {activityPending ? (
                  <PullRequestTimelineGhost />
                ) : activityError ? (
                  <PullRequestActivityUnavailableState
                    error={activityError}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <PullRequestTimelineTab
                    detail={detail}
                    order={timelineOrder}
                    onOpenCommit={openCommit}
                  />
                )}
              </div>
            ) : null}
            {mountedTabs.has("code") ? (
              <div
                data-pr-tab="code"
                className={cn("absolute inset-0", tab !== "code" && "invisible")}
              >
                <Suspense fallback={<DiffPanelLoadingState label="Loading pull request diff..." />}>
                  <PullRequestCodeTab
                    onAskAboutSelection={askAboutSelection}
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    selectedCommitOid={selectedCodeCommitOid}
                    onSelectedCommitChange={selectCodeCommit}
                    pendingFinding={handoff}
                    onFixFinding={startFixFinding}
                    onRefresh={refreshDetail}
                    refreshToken={refreshToken}
                  />
                </Suspense>
              </div>
            ) : null}
            {mountedTabs.has("reviewing") && activeReview !== null ? (
              <div
                data-pr-tab="reviewing"
                className={cn("absolute inset-0", tab !== "reviewing" && "invisible")}
              >
                <PullRequestReviewingTab
                  codeAvailable={detail.capabilities.diff}
                  environmentId={environmentId}
                  onOpenCode={() => setTab("code")}
                  publishComments={activeReview.publishComments}
                  reference={reference}
                  threadId={activeReview.threadId}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <PullRequestAgentReviewDialog
        canPublishComments={
          detail?.capabilities.review.inlineComment === true &&
          detail.capabilities.review.verdicts.includes("comment")
        }
        initialModelSelection={initialReviewModelSelection}
        instanceEntries={reviewInstanceEntries}
        modelOptionsByInstance={reviewModelOptionsByInstance}
        onOpenChange={setReviewDialogOpen}
        onStart={startAgentReview}
        open={reviewDialogOpen}
        starting={startingReview}
      />

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "merge" ? "Merge pull request?" : "Close pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "merge"
                ? `This merges #${reference.number} using ${selectedMergeMethod}.`
                : `This closes #${reference.number} without merging it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirmAction === "close" ? "destructive" : "default"}
              disabled={actionPending}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action === "merge") void perform("merge", selectedMergeMethod);
                if (action === "close") void perform("close");
              }}
            >
              {confirmAction === "merge" ? "Merge" : "Close"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
