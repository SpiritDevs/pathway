import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/shell";
import type {
  GitRunStackedActionResult,
  GitStackedAction,
  OrchestrationV2ProjectedTurnItem,
  VcsStatusResult,
} from "@spiritdevs/contracts";
import { isTemporaryWorktreeBranch } from "@spiritdevs/shared/git";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../sourceControlPresentation";

export type GitActionIconName = "commit" | "push" | "pr";

export const LEGACY_PUSH_AUTO_SETTLE_DELAY_MS = 10_000;

export function legacyPushAutoSettlementActivityKey(
  thread: Pick<
    EnvironmentThreadShell,
    | "latestUserMessageAt"
    | "latestRun"
    | "runtime"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "pendingBackgroundTasks"
    | "settledOverride"
    | "snoozedUntil"
    | "pinnedAt"
    | "archivedAt"
  >,
): string {
  return JSON.stringify({
    latestUserMessageAt: thread.latestUserMessageAt,
    latestRun: thread.latestRun,
    runtime: thread.runtime,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    pendingBackgroundTasks: thread.pendingBackgroundTasks,
    settledOverride: thread.settledOverride,
    snoozedUntil: thread.snoozedUntil,
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
  });
}

export function shouldWarnAboutLegacyPushAutoSettlement(input: {
  readonly capability: boolean;
  readonly result: GitRunStackedActionResult;
  readonly isDefaultRef: boolean;
}): boolean {
  const createsPullRequest =
    input.result.action === "create_pr" || input.result.action === "commit_push_pr";
  return (
    input.capability &&
    input.result.push.status === "pushed" &&
    input.isDefaultRef &&
    !createsPullRequest
  );
}

export function formatLegacyPushAutoSettlementCountdown(
  deadlineMs: number | null,
  nowMs: number,
): string | null {
  if (deadlineMs === null) return null;
  const secondsRemaining = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  return `Settling thread in ${secondsRemaining}s unless activity resumes.`;
}

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function isPushCommandFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly _tag?: unknown; readonly operation?: unknown };
  return (
    candidate._tag === "GitCommandError" &&
    typeof candidate.operation === "string" &&
    candidate.operation.startsWith("GitVcsDriver.pushCurrentBranch.")
  );
}

export function buildPushRecoveryPrompt(): string {
  return [
    "The source-control action reached its push step, but Git rejected the push.",
    "Inspect the current branch, its upstream, the working tree, and the remote state. Safely bring the branch up to date using this repository's conventions, preserving unrelated local work. Resolve any conflicts while preserving the intent of both sides, run the relevant focused checks, and retry the push.",
    "Do not force-push or discard unrelated changes. If authentication, permissions, or branch policy prevents recovery, stop and explain the blocker instead of bypassing it.",
  ].join("\n");
}

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

export function resolveGitActionProgressPresentation(input: {
  readonly isRunning: boolean;
  readonly operation: string | null;
  readonly currentLabel: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
}): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? currentLabel
        : isPull
          ? "Pulling latest changes..."
          : "Starting source control action...",
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
  terminology?: ChangeRequestTerminology;
}): string[] {
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  const branchStages = input.featureBranch ? ["Preparing feature ref..."] : [];
  const pushStage = input.pushTarget ? `Pushing to ${input.pushTarget}...` : "Pushing...";
  const prStages = [
    `Preparing ${terminology.shortLabel}...`,
    `Generating ${terminology.shortLabel} content...`,
    `Creating ${terminology.singular}...`,
  ];

  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages = input.action === "commit" || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["Committing..."]
      : ["Generating commit message...", "Committing..."];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: "Push",
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  // An open change request is surfaced by the standalone attribution row, so
  // the menu offers no change-request entry at all while one is open.
  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: `Create ${terminology.shortLabel}`,
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: "Commit",
          disabled: true,
          kind: "show_hint",
          hint: "Branch is up to date. No action needed.",
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  // An open change request is surfaced by the standalone attribution row in the
  // details panel, so the action button rests in its disabled up-to-date state.
  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export type CommitFileScope = "thread" | "all";

export interface ThreadScopeFileSplit {
  readonly threadFiles: readonly string[];
  readonly otherFiles: readonly string[];
}

export function actionIncludesCommitStep(action: GitStackedAction): boolean {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

function normalizeScopePath(path: string): string {
  let normalized = path.replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Working-tree paths from the thread's recorded work: file edits reported by
 * the provider plus per-turn checkpoint file summaries. Superseded (rolled
 * back) items are already absent from the visible projection.
 */
export function collectThreadTouchedPaths(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const projected of items) {
    const item = projected.item;
    if (item.type === "file_change") {
      touched.add(normalizeScopePath(item.fileName));
    } else if (item.type === "checkpoint") {
      for (const file of item.files) {
        touched.add(normalizeScopePath(file.path));
      }
    }
  }
  return touched;
}

/**
 * Splits the dirty working-tree files into those attributable to the thread
 * and the rest. Provider items may record absolute paths while git status is
 * repo-relative, so a path also matches when one form is a full-segment
 * suffix of the other.
 */
export function splitWorkingTreeFilesByThread(input: {
  readonly workingTreePaths: ReadonlyArray<string>;
  readonly touchedPaths: ReadonlySet<string>;
}): ThreadScopeFileSplit {
  const threadFiles: string[] = [];
  const otherFiles: string[] = [];
  for (const path of input.workingTreePaths) {
    const normalized = normalizeScopePath(path);
    let isThreadFile = false;
    for (const touched of input.touchedPaths) {
      if (
        touched === normalized ||
        touched.endsWith(`/${normalized}`) ||
        normalized.endsWith(`/${touched}`)
      ) {
        isThreadFile = true;
        break;
      }
    }
    if (isThreadFile) {
      threadFiles.push(path);
    } else {
      otherFiles.push(path);
    }
  }
  return { threadFiles, otherFiles };
}

/**
 * Scoping to the thread only matters when the thread owns some of the dirty
 * files and other work owns the rest; otherwise every commit-scope choice
 * stages the same set.
 */
export function canScopeCommitToThread(split: ThreadScopeFileSplit): boolean {
  return split.threadFiles.length > 0 && split.otherFiles.length > 0;
}

/** The filePaths subset for a scoped commit; undefined means stage everything. */
export function resolveScopedCommitFilePaths(input: {
  readonly scope: CommitFileScope;
  readonly split: ThreadScopeFileSplit;
}): string[] | undefined {
  if (input.scope !== "thread" || !canScopeCommitToThread(input.split)) {
    return undefined;
  }
  return [...input.split.threadFiles];
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default ref?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: "Push to default ref?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@spiritdevs/shared/git";
