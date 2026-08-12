/**
 * IssueEnrichmentEngine - the seam between an enrichment run's *record* and its *process*.
 *
 * `IssueTrackerService` owns the record and the stream: it validates the request, writes the
 * queued row, and turns every transition into an `EnrichmentRunChanged` event. This service owns
 * the other half — spawning the configured model as a read-only one-shot in the project's
 * directory (the `codex exec --sandbox read-only` shape in `textGeneration/CodexTextGeneration.ts`)
 * and turning its output into a structured result.
 *
 * The two halves talk through {@link IssueEnrichmentRunRecorder} rather than through each other's
 * tags. That is deliberate: an engine that reached for `IssueTrackerService` would make the two
 * layers require one another, and the tracker would never build. The tracker hands the engine a
 * recorder bound to one run, and the engine reports progress into it.
 *
 * @module issues/IssueEnrichmentEngine
 */
import { IssueTrackerError } from "@t3tools/contracts";
import type {
  Issue,
  IssueEnrichmentResult,
  IssueEnrichmentRun,
  IssueEnrichmentRunId,
  ModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * How a run reports itself back to the tracker. Every method here writes the row and publishes
 * the whole run on `issues.stream`.
 */
export interface IssueEnrichmentRunRecorder {
  /** Queued becomes running. Called once, when the process is actually up. */
  readonly markRunning: Effect.Effect<void, IssueTrackerError>;
  /**
   * Append to the live transcript.
   *
   * Every append republishes the whole run, so the engine batches process output into windows of
   * `ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS` rather than calling this per chunk: a model
   * emits tokens far faster than a panel can paint them.
   */
  readonly appendTranscript: (chunk: string) => Effect.Effect<void, IssueTrackerError>;
  /** Land the run in `done` with its structured answer. */
  readonly succeed: (result: IssueEnrichmentResult) => Effect.Effect<void, IssueTrackerError>;
  /** Land the run in `failed` with a reason a human can read. */
  readonly fail: (reason: string) => Effect.Effect<void, IssueTrackerError>;
}

export interface IssueEnrichmentStartRequest {
  /** The queued row, already written and already published. */
  readonly run: IssueEnrichmentRun;
  /** What the model is being asked about: title, description, and the rest of the row. */
  readonly issue: Issue;
  /**
   * The directory to investigate. Never null here: the tracker refuses a run on a rootless
   * project before this service is reached, because there is nothing to read.
   */
  readonly workspaceRoot: string;
  readonly recorder: IssueEnrichmentRunRecorder;
}

export interface IssueEnrichmentEngineShape {
  /**
   * The model a new run is pinned to, resolved before the record is written so the row names it
   * for good. Failing here refuses the run and writes nothing.
   */
  readonly resolveModelSelection: Effect.Effect<ModelSelection, IssueTrackerError>;

  /**
   * Drive one queued run to a terminal state.
   *
   * The tracker forks this, so it may take as long as the investigation does; it is expected to
   * report the outcome through the recorder rather than through its own success value. A failure
   * or defect escaping here is caught by the tracker and lands the run in `failed`.
   */
  readonly start: (request: IssueEnrichmentStartRequest) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Stop a running process. The tracker has already marked the record failed by the time this is
   * called, so an unknown or already-finished run is a no-op rather than an error.
   */
  readonly cancel: (input: {
    readonly runId: IssueEnrichmentRunId;
  }) => Effect.Effect<void, IssueTrackerError>;
}

export class IssueEnrichmentEngine extends Context.Service<
  IssueEnrichmentEngine,
  IssueEnrichmentEngineShape
>()("t3/issues/IssueEnrichmentEngine") {}

/** Every refusal this stub gives, so the message is one string rather than three. */
const UNAVAILABLE = "Issue enrichment is not available on this server.";

/**
 * The engine before there is an engine.
 *
 * Refusing at `resolveModelSelection` means no row is ever written, so the Investigate button
 * reports "not available" instead of leaving a run queued forever. `start` fails the run anyway,
 * for the case where a caller resolved a model some other way.
 */
export const layerStub = Layer.succeed(IssueEnrichmentEngine, {
  resolveModelSelection: Effect.fail(
    new IssueTrackerError({ reason: "invalid", message: UNAVAILABLE }),
  ),
  start: ({ recorder }) => recorder.fail(UNAVAILABLE),
  cancel: () => Effect.void,
} satisfies IssueEnrichmentEngineShape);
