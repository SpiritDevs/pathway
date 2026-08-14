/**
 * How a mention-dispatched agent run reads in the comment thread.
 *
 * The run rides its origin comment rather than owning a stream event, so there is no panel to open
 * and no page to navigate to: the whole of it is a line under the comment that started it. That
 * line has to say four different things — waiting, working, broke, done — and offer the one action
 * each of those states has, which is the entirety of what this module decides.
 *
 * Progress copy is coarse on purpose. `phase` is the only signal the engine gives, and a null phase
 * is not "idle": it is a run that has started and said nothing yet, which reads as working.
 *
 * @module components/issues/issueCommentAgentRun.logic
 */
import type {
  IssueCommentAgentRun,
  IssueCommentAgentRunPhase,
  IssueCommentAgentRunState,
} from "@spiritdevs/contracts";

/** What the thread prints while a run is `running`, per phase the engine reports. */
export const ISSUE_COMMENT_AGENT_RUN_PHASE_LABELS: Readonly<
  Record<IssueCommentAgentRunPhase, string>
> = {
  thinking: "Thinking…",
  researching: "Researching the project…",
  replying: "Writing reply…",
};

/** A started run that has not named a phase yet. Not "idle": it is running. */
export const ISSUE_COMMENT_AGENT_RUN_WORKING_LABEL = "Working…";

/** How the line is coloured. `queued` is deliberately not `active`: nothing is happening yet. */
export type IssueCommentAgentRunTone = "pending" | "active" | "done" | "failed" | "canceled";

const TONE_BY_STATE: Readonly<Record<IssueCommentAgentRunState, IssueCommentAgentRunTone>> = {
  queued: "pending",
  running: "active",
  completed: "done",
  failed: "failed",
  canceled: "canceled",
};

export interface IssueCommentAgentRunPresentation {
  readonly label: string;
  readonly tone: IssueCommentAgentRunTone;
  /** True while the run can still change: what the pulse and the cancel button key off. */
  readonly isActive: boolean;
  readonly canCancel: boolean;
  /** Terminal and not successful: retry re-dispatches the comment, it never resumes the run. */
  readonly canRetry: boolean;
  /** The refusal or the crash, only on `failed`. A cancel is not an error and has none. */
  readonly errorText: string | null;
  /** `4s`, on a finished run only. A live duration would tick a thread nobody is watching. */
  readonly durationLabel: string | null;
}

/** `4s`, `1m 20s`, `1h 04m` — the same shape an investigation prints, for the same reason. */
export function formatIssueCommentAgentRunDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${`${totalSeconds % 60}`.padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${`${minutes % 60}`.padStart(2, "0")}m`;
}

/**
 * How long the run took. Null unless both ends exist and agree on their order: a run that finished
 * without ever starting is a bug in the writer, and printing `-3s` would hide it rather than show
 * it.
 */
export function issueCommentAgentRunDurationMs(
  run: Pick<IssueCommentAgentRun, "startedAt" | "finishedAt">,
): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  const startedMs = Date.parse(run.startedAt);
  const finishedMs = Date.parse(run.finishedAt);
  if (Number.isNaN(startedMs) || Number.isNaN(finishedMs)) return null;
  return finishedMs < startedMs ? null : finishedMs - startedMs;
}

/** Everything the line under a comment renders from. */
export function issueCommentAgentRunPresentation(
  run: Pick<
    IssueCommentAgentRun,
    "state" | "phase" | "error" | "replyCommentId" | "startedAt" | "finishedAt"
  >,
): IssueCommentAgentRunPresentation {
  const isActive = run.state === "queued" || run.state === "running";
  const durationMs = issueCommentAgentRunDurationMs(run);
  return {
    label:
      run.state === "queued"
        ? "Waiting to start"
        : run.state === "running"
          ? run.phase === null
            ? ISSUE_COMMENT_AGENT_RUN_WORKING_LABEL
            : ISSUE_COMMENT_AGENT_RUN_PHASE_LABELS[run.phase]
          : run.state === "completed"
            ? // A completed run with no reply produced nothing to read, and saying "Replied" then
              // would send somebody looking for a comment that is not there.
              run.replyCommentId === null
              ? "Finished"
              : "Replied"
            : run.state === "canceled"
              ? "Canceled"
              : "Failed",
    tone: TONE_BY_STATE[run.state],
    isActive,
    canCancel: isActive,
    canRetry: run.state === "failed" || run.state === "canceled",
    errorText:
      run.state !== "failed"
        ? null
        : run.error !== null && run.error.trim().length > 0
          ? run.error.trim()
          : "The agent run failed.",
    durationLabel:
      run.state === "completed" && durationMs !== null
        ? formatIssueCommentAgentRunDuration(durationMs)
        : null,
  };
}

/** The details disclosure only earns its row once there is something behind it. */
export function hasIssueCommentAgentRunDetails(
  run: Pick<IssueCommentAgentRun, "transcript">,
): boolean {
  return run.transcript.trim().length > 0;
}
