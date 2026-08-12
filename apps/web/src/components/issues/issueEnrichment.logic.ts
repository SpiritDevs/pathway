/**
 * Pure decisions behind the enrichment panel — see
 * `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Three jobs. Whether the Investigate button can be pressed at all, which the server also decides
 * and refuses with `invalid`: saying it here first is what turns a refusal into a disabled control
 * with a sentence on it. How a run reads — its state word and its duration, which is a subtraction
 * of two timestamps that are null in different combinations depending on where the run got to.
 * And what a suggestion chip writes: the result carries label *names* and an `IssuePriority`, not
 * ids and not a patch, because nothing a run produces is applied by the run.
 *
 * @module components/issues/issueEnrichment.logic
 */
import type {
  Issue,
  IssueEnrichmentResult,
  IssueEnrichmentRun,
  IssueEnrichmentRunState,
  IssueLabel,
  IssueLabelId,
  IssuePatch,
  IssuePriority,
} from "@t3tools/contracts";

import { isIssueEnrichmentRunActive } from "~/state/issues";

// ── Availability ───────────────────────────────────────────────────────

/**
 * Why Investigate is not available, or null when it is. Ordered by what a reader can act on:
 * connecting comes before picking a project, which comes before attaching a directory to it.
 */
export type IssueInvestigateBlock =
  | "disconnected"
  | "deleted"
  | "no-project"
  | "rootless-project"
  | "in-flight";

export const ISSUE_INVESTIGATE_BLOCK_REASONS: Readonly<Record<IssueInvestigateBlock, string>> = {
  disconnected: "The tracker lives on the machine you are connected to.",
  deleted: "This issue is deleted. Restore it to investigate.",
  "no-project": "An investigation runs in a project's directory. Give this issue a project first.",
  "rootless-project":
    "This project has no directory yet. Attach one and the investigation can read it.",
  "in-flight": "An investigation is already running on this issue.",
};

export function issueInvestigateBlock(input: {
  readonly connected: boolean;
  readonly deleted: boolean;
  /** Null when the issue has no project at all. */
  readonly projectId: string | null;
  /**
   * The project's `workspaceRoot`. `undefined` means the project row was not found on this
   * client, which reads the same way as rootless: there is no directory to hand the model.
   */
  readonly workspaceRoot: string | null | undefined;
  readonly hasRunInFlight: boolean;
}): IssueInvestigateBlock | null {
  if (!input.connected) return "disconnected";
  if (input.deleted) return "deleted";
  if (input.projectId === null) return "no-project";
  if (input.workspaceRoot === null || input.workspaceRoot === undefined) return "rootless-project";
  if (input.hasRunInFlight) return "in-flight";
  return null;
}

// ── Run presentation ───────────────────────────────────────────────────

export const ISSUE_ENRICHMENT_STATE_LABELS: Readonly<Record<IssueEnrichmentRunState, string>> = {
  queued: "Queued",
  running: "Investigating",
  done: "Done",
  failed: "Failed",
};

/** Which of the four ways the panel colours a run. `queued` is deliberately not `active`. */
export type IssueEnrichmentTone = "pending" | "active" | "done" | "failed";

const TONE_BY_STATE: Readonly<Record<IssueEnrichmentRunState, IssueEnrichmentTone>> = {
  queued: "pending",
  running: "active",
  done: "done",
  failed: "failed",
};

export interface IssueEnrichmentRunPresentation {
  readonly label: string;
  readonly tone: IssueEnrichmentTone;
  /** True while the run can still change: what a spinner, a cancel button, and a chip key off. */
  readonly isActive: boolean;
  /** `1m 20s`, counting up while running. Null while queued, which has no elapsed time yet. */
  readonly durationLabel: string | null;
  /** The model that ran, as the run pinned it at creation. */
  readonly modelLabel: string;
}

/** `4s`, `1m 20s`, `1h 04m`. Seconds are dropped past an hour: nobody reads them there. */
export function formatIssueEnrichmentDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${`${totalSeconds % 60}`.padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${`${minutes % 60}`.padStart(2, "0")}m`;
}

/**
 * How long the run has been going, or went for. Null while queued and null for the impossible
 * pair (finished without ever starting), rather than printing a negative or a date-of-epoch span.
 */
export function issueEnrichmentRunDurationMs(
  run: IssueEnrichmentRun,
  nowMs: number,
): number | null {
  if (run.startedAt === null) return null;
  const startedMs = Date.parse(run.startedAt);
  if (Number.isNaN(startedMs)) return null;
  const endMs = run.finishedAt === null ? nowMs : Date.parse(run.finishedAt);
  if (Number.isNaN(endMs)) return null;
  return Math.max(0, endMs - startedMs);
}

export function issueEnrichmentRunPresentation(
  run: IssueEnrichmentRun,
  nowMs: number,
): IssueEnrichmentRunPresentation {
  const durationMs = issueEnrichmentRunDurationMs(run, nowMs);
  return {
    label: ISSUE_ENRICHMENT_STATE_LABELS[run.state],
    tone: TONE_BY_STATE[run.state],
    isActive: isIssueEnrichmentRunActive(run),
    durationLabel: durationMs === null ? null : formatIssueEnrichmentDuration(durationMs),
    modelLabel: run.modelSelection.model,
  };
}

/** The run the panel opens on: the newest, which is the head of a newest-first list. */
export function latestIssueEnrichmentRun(
  runs: ReadonlyArray<IssueEnrichmentRun>,
): IssueEnrichmentRun | null {
  return runs[0] ?? null;
}

/** The one that can be cancelled. At most one exists — the server refuses a second. */
export function activeIssueEnrichmentRun(
  runs: ReadonlyArray<IssueEnrichmentRun>,
): IssueEnrichmentRun | null {
  return runs.find(isIssueEnrichmentRunActive) ?? null;
}

// ── Transcript scrolling ───────────────────────────────────────────────

/**
 * How close to the bottom counts as "at the bottom". A transcript arrives in 250ms batches, and a
 * reader who scrolled up one line should not be dragged back down by the next one — but a reader
 * sitting at the end should not lose the tail to a rounding error either.
 */
export const ISSUE_TRANSCRIPT_FOLLOW_THRESHOLD_PX = 32;

/**
 * Whether the scroller should keep following new output. Called with the metrics of the *user's*
 * last scroll, not on every append: the answer is latched, so an append that grows `scrollHeight`
 * never reads as "the user scrolled up".
 */
export function shouldFollowIssueTranscript(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? ISSUE_TRANSCRIPT_FOLLOW_THRESHOLD_PX;
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

// ── Suggestions ────────────────────────────────────────────────────────

/**
 * One suggested label as a chip. `label` is null when the run named something the tracker has no
 * row for — the server filters against the tracker's vocabulary before storing the result, so
 * this only happens when the label was deleted between the run finishing and the panel opening.
 */
export interface IssueSuggestedLabel {
  readonly name: string;
  readonly label: IssueLabel | null;
  readonly applied: boolean;
}

/** Case-insensitive, because a suggestion is a word the model typed rather than an id it read. */
export function resolveIssueSuggestedLabels(
  names: ReadonlyArray<string>,
  labels: ReadonlyArray<IssueLabel>,
  appliedLabelIds: ReadonlyArray<IssueLabelId>,
): ReadonlyArray<IssueSuggestedLabel> {
  return names.map((name): IssueSuggestedLabel => {
    const folded = name.trim().toLocaleLowerCase();
    const label = labels.find((candidate) => candidate.name.toLocaleLowerCase() === folded) ?? null;
    return {
      name,
      label,
      applied: label !== null && appliedLabelIds.includes(label.id),
    };
  });
}

/**
 * Add-only, unlike the label editor's toggle: pressing Apply on a suggestion the issue already
 * wears must not take it off, which is what a toggle would do on the second press.
 */
export function issueApplyLabelPatch(issue: Issue, labelId: IssueLabelId): IssuePatch | null {
  return issue.labelIds.includes(labelId) ? null : { labelIds: [...issue.labelIds, labelId] };
}

/** Null when the run suggested the priority the issue already has, or suggested none. */
export function issueApplyPriorityPatch(
  issue: Issue,
  priority: IssuePriority | null,
): IssuePatch | null {
  if (priority === null || priority === issue.priority) return null;
  return { priority };
}

/**
 * Whether a finished result has anything to offer, which is what decides between rendering the
 * suggestion row and rendering nothing at all.
 */
export function hasIssueEnrichmentSuggestions(
  result: IssueEnrichmentResult,
  issue: Issue,
  labels: ReadonlyArray<IssueLabel>,
): boolean {
  if (issueApplyPriorityPatch(issue, result.suggestedPriority) !== null) return true;
  return resolveIssueSuggestedLabels(result.suggestedLabels, labels, issue.labelIds).some(
    (suggestion) => suggestion.label !== null && !suggestion.applied,
  );
}
