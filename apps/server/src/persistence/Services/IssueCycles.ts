/**
 * IssueCycleRepository - Persistence interface for cycle rows.
 *
 * Cycles span everything rather than belonging to a project, and there are a handful of them, so
 * the only read here is the whole ordered set. Whether a cycle is upcoming, active, or ended is
 * derived from today and never stored; `completedAt` is not that flag, it is the stamp saying the
 * server has already carried the cycle's unfinished issues forward.
 *
 * @module IssueCycleRepository
 */
import { IsoDateTime, IssueCycle, IssueCycleId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetIssueCycleInput = Schema.Struct({ cycleId: IssueCycleId });
export type GetIssueCycleInput = typeof GetIssueCycleInput.Type;

export const DeleteIssueCycleInput = Schema.Struct({ cycleId: IssueCycleId });
export type DeleteIssueCycleInput = typeof DeleteIssueCycleInput.Type;

export const CompleteIssueCycleInput = Schema.Struct({
  cycleId: IssueCycleId,
  completedAt: IsoDateTime,
});
export type CompleteIssueCycleInput = typeof CompleteIssueCycleInput.Type;

/**
 * IssueCycleRepositoryShape - Service API for cycle rows.
 */
export interface IssueCycleRepositoryShape {
  /**
   * List every cycle in start-date order, ties broken by id so the order is total.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueCycle>, IssueTrackerRepositoryError>;

  /**
   * Read one cycle by id.
   */
  readonly getById: (
    input: GetIssueCycleInput,
  ) => Effect.Effect<Option.Option<IssueCycle>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one cycle row, keyed by id.
   */
  readonly upsert: (row: IssueCycle) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one cycle row.
   *
   * Clearing `cycle_id` on the issues it held is the caller's job.
   */
  readonly deleteById: (
    input: DeleteIssueCycleInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Stamp `completed_at` on one cycle, freezing it against a second carry-over.
   */
  readonly complete: (
    input: CompleteIssueCycleInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueCycleRepository - Service tag for cycle persistence.
 */
export class IssueCycleRepository extends Context.Service<
  IssueCycleRepository,
  IssueCycleRepositoryShape
>()("t3/persistence/Services/IssueCycles/IssueCycleRepository") {}
