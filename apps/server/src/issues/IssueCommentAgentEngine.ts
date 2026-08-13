/**
 * IssueCommentAgentEngine - the seam between a mentioned agent's *record* and its *process*.
 *
 * The same split enrichment uses, for the same reason. `IssueTrackerService` owns the record: it
 * writes the comment and its `queued` run in one go, and republishes the comment on every
 * transition — the run rides its origin comment rather than owning a stream event, because
 * `IssuesStreamEvent` is a closed union older remote clients decode exhaustively. This service owns
 * the other half: reading the repository the issue belongs to and turning what the model says into
 * a reply.
 *
 * The two halves talk through {@link IssueCommentAgentRunRecorder} rather than through each other's
 * tags. An engine that reached for `IssueTrackerService` would make the two layers require one
 * another, and the tracker would never build.
 *
 * @module issues/IssueCommentAgentEngine
 */
import { IssueTrackerError } from "@t3tools/contracts";
import type {
  Issue,
  IssueComment,
  IssueCommentAgentMention,
  IssueCommentAgentRun,
  IssueCommentAgentRunId,
  IssueCommentAgentRunPhase,
  IssuePriority,
  ModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The fields a run may propose changing on the issue it was asked about. */
export interface IssueCommentAgentIssueUpdate {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
}

export interface IssueCommentAgentResult {
  /** Markdown. Posted as a new, ordinary comment attributed to the agent that wrote it. */
  readonly reply: string;
  /** Applied as the same agent, so the events feed says who changed the issue. */
  readonly update?: IssueCommentAgentIssueUpdate | undefined;
}

/**
 * How a run reports itself back to the tracker. Every method here rewrites the run on its origin
 * comment and republishes that comment on `issues.stream`.
 */
export interface IssueCommentAgentRunRecorder {
  /** Queued becomes running. Called once, when the process is actually up. */
  readonly markRunning: Effect.Effect<void, IssueTrackerError>;
  /** Coarse progress, printed under the pill while the run works. Idempotent. */
  readonly setPhase: (phase: IssueCommentAgentRunPhase) => Effect.Effect<void, IssueTrackerError>;
  /**
   * Append to the live transcript.
   *
   * Every append republishes the whole comment, so the engine batches process output into windows
   * of `ISSUE_COMMENT_AGENT_RUN_TRANSCRIPT_PUBLISH_INTERVAL_MS` rather than calling this per chunk.
   */
  readonly appendTranscript: (chunk: string) => Effect.Effect<void, IssueTrackerError>;
  /** Post the reply, apply what the run proposed, and land the run in `completed`. */
  readonly succeed: (result: IssueCommentAgentResult) => Effect.Effect<void, IssueTrackerError>;
  /** Land the run in `failed` with a reason a human can read. */
  readonly fail: (reason: string) => Effect.Effect<void, IssueTrackerError>;
}

export interface IssueCommentAgentStartRequest {
  /** The queued run, already written onto its comment and already published. */
  readonly run: IssueCommentAgentRun;
  /** The comment whose mention started this: the ask, and the thread position it answers from. */
  readonly comment: IssueComment;
  readonly issue: Issue;
  /**
   * The directory to read. Never null here: the tracker fails a run whose issue has no project
   * directory before this service is reached, because there is nothing to investigate.
   */
  readonly workspaceRoot: string;
  readonly recorder: IssueCommentAgentRunRecorder;
}

export interface IssueCommentAgentEngineShape {
  /**
   * Turn the composer's selection into the mention the comment stores, resolved *before* the row
   * is written so the run names the agent that ran it for good.
   *
   * The tracker never asks the provider registry itself: it has no reason to know about instances,
   * and asking here keeps the resolution beside the code that will run the instance. An unknown
   * instance fails, which refuses the comment rather than writing a run nobody can attribute.
   */
  readonly resolveMention: (input: {
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<IssueCommentAgentMention, IssueTrackerError>;

  /**
   * Drive one queued run to a terminal state.
   *
   * The tracker forks this, so it may take as long as the investigation does; it is expected to
   * report the outcome through the recorder rather than through its own success value. A failure
   * or defect escaping here is caught by the tracker and lands the run in `failed`.
   */
  readonly start: (
    request: IssueCommentAgentStartRequest,
  ) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Stop a running process. The tracker has already written `canceled` by the time this is called,
   * so an unknown or already-finished run is a no-op rather than an error.
   */
  readonly cancel: (input: {
    readonly runId: IssueCommentAgentRunId;
  }) => Effect.Effect<void, IssueTrackerError>;
}

export class IssueCommentAgentEngine extends Context.Service<
  IssueCommentAgentEngine,
  IssueCommentAgentEngineShape
>()("t3/issues/IssueCommentAgentEngine") {}

/** Every refusal this stub gives, so the message is one string rather than three. */
const UNAVAILABLE = "Mentioning an agent is not available on this server.";

/**
 * The engine before there is an engine.
 *
 * Refusing at `resolveMention` means no comment is ever written with a run on it, so the composer
 * reports "not available" instead of leaving a pill queued forever. `start` fails the run anyway,
 * for the case where a caller resolved a mention some other way.
 */
export const layerStub = Layer.succeed(IssueCommentAgentEngine, {
  resolveMention: () =>
    Effect.fail(new IssueTrackerError({ reason: "invalid", message: UNAVAILABLE })),
  start: ({ recorder }) => recorder.fail(UNAVAILABLE),
  cancel: () => Effect.void,
} satisfies IssueCommentAgentEngineShape);
