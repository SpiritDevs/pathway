/**
 * IssueEnrichmentRunRepository - Persistence interface for enrichment runs.
 *
 * A run is a read-only investigation of an issue's repository: a state, the model it was pinned
 * to, a transcript that grows while it runs, and one structured result at the end. It is not a
 * thread and has no turns, which is why it lives here rather than in the projections.
 *
 * The write surface is deliberately narrow — create, start, append, finish — because those are
 * the only four things that ever happen to a run. Nothing edits a finished one.
 *
 * @module IssueEnrichmentRunRepository
 */
import {
  IsoDateTime,
  IssueEnrichmentResult,
  IssueEnrichmentRun,
  IssueEnrichmentRunId,
  IssueId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueEnrichmentRunsInput = Schema.Struct({ issueId: IssueId });
export type ListIssueEnrichmentRunsInput = typeof ListIssueEnrichmentRunsInput.Type;

export const GetIssueEnrichmentRunInput = Schema.Struct({ runId: IssueEnrichmentRunId });
export type GetIssueEnrichmentRunInput = typeof GetIssueEnrichmentRunInput.Type;

/** Queued becomes running exactly once, and that is when the clock on the run starts. */
export const StartIssueEnrichmentRunInput = Schema.Struct({
  runId: IssueEnrichmentRunId,
  startedAt: IsoDateTime,
});
export type StartIssueEnrichmentRunInput = typeof StartIssueEnrichmentRunInput.Type;

/**
 * Appended in the database rather than read-modify-written here: chunks arrive faster than a
 * round trip, and two of them racing would otherwise lose one.
 */
export const AppendIssueEnrichmentTranscriptInput = Schema.Struct({
  runId: IssueEnrichmentRunId,
  chunk: Schema.String,
});
export type AppendIssueEnrichmentTranscriptInput = typeof AppendIssueEnrichmentTranscriptInput.Type;

/**
 * The one terminal write. `done` carries a result and `failed` carries a reason; both stamp
 * `finished_at`, which is the other half of the duration the panel prints.
 */
export const FinishIssueEnrichmentRunInput = Schema.Struct({
  runId: IssueEnrichmentRunId,
  state: Schema.Literals(["done", "failed"]),
  result: Schema.NullOr(IssueEnrichmentResult),
  error: Schema.NullOr(Schema.String),
  finishedAt: IsoDateTime,
});
export type FinishIssueEnrichmentRunInput = typeof FinishIssueEnrichmentRunInput.Type;

/**
 * IssueEnrichmentRunRepositoryShape - Service API for enrichment run rows.
 */
export interface IssueEnrichmentRunRepositoryShape {
  /**
   * Insert one queued run.
   */
  readonly create: (row: IssueEnrichmentRun) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Read one run by id.
   */
  readonly getById: (
    input: GetIssueEnrichmentRunInput,
  ) => Effect.Effect<Option.Option<IssueEnrichmentRun>, IssueTrackerRepositoryError>;

  /**
   * One issue's runs, newest first: the panel opens on the latest and shows the rest as history.
   */
  readonly listByIssue: (
    input: ListIssueEnrichmentRunsInput,
  ) => Effect.Effect<ReadonlyArray<IssueEnrichmentRun>, IssueTrackerRepositoryError>;

  /**
   * Every run still queued or running, across every issue.
   *
   * A run is a live process, so nothing here survives a restart of this server: the layer sweeps
   * this list into `failed` at startup, and the tracker uses it to refuse a second run on an
   * issue that already has one in flight.
   */
  readonly listUnfinished: () => Effect.Effect<
    ReadonlyArray<IssueEnrichmentRun>,
    IssueTrackerRepositoryError
  >;

  /**
   * Move a queued run to running and stamp when it started.
   */
  readonly start: (
    input: StartIssueEnrichmentRunInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Append to a run's transcript, dropping the head once the bound is reached.
   */
  readonly appendTranscript: (
    input: AppendIssueEnrichmentTranscriptInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Land a run in `done` or `failed`.
   */
  readonly finish: (
    input: FinishIssueEnrichmentRunInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueEnrichmentRunRepository - Service tag for enrichment run persistence.
 */
export class IssueEnrichmentRunRepository extends Context.Service<
  IssueEnrichmentRunRepository,
  IssueEnrichmentRunRepositoryShape
>()("t3/persistence/Services/IssueEnrichmentRuns/IssueEnrichmentRunRepository") {}
