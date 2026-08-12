/**
 * IssueMilestoneRepository - Persistence interface for milestone rows.
 *
 * A milestone is a named checkpoint inside one project. The rows are configuration-shaped rather
 * than usage-shaped — tens per environment, not thousands — so every read here is the whole set
 * and the service never needs a per-project query.
 *
 * @module IssueMilestoneRepository
 */
import { IsoDateTime, IssueMilestone, IssueMilestoneId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetIssueMilestoneInput = Schema.Struct({ milestoneId: IssueMilestoneId });
export type GetIssueMilestoneInput = typeof GetIssueMilestoneInput.Type;

export const DeleteIssueMilestoneInput = Schema.Struct({ milestoneId: IssueMilestoneId });
export type DeleteIssueMilestoneInput = typeof DeleteIssueMilestoneInput.Type;

export const IssueMilestonePosition = Schema.Struct({
  milestoneId: IssueMilestoneId,
  position: Schema.Number,
});
export type IssueMilestonePosition = typeof IssueMilestonePosition.Type;

export const SetIssueMilestonePositionsInput = Schema.Struct({
  positions: Schema.Array(IssueMilestonePosition),
  updatedAt: IsoDateTime,
});
export type SetIssueMilestonePositionsInput = typeof SetIssueMilestonePositionsInput.Type;

/**
 * IssueMilestoneRepositoryShape - Service API for milestone rows.
 */
export interface IssueMilestoneRepositoryShape {
  /**
   * List every milestone across every project, ordered by project then position.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueMilestone>, IssueTrackerRepositoryError>;

  /**
   * Read one milestone by id.
   */
  readonly getById: (
    input: GetIssueMilestoneInput,
  ) => Effect.Effect<Option.Option<IssueMilestone>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one milestone row, keyed by id.
   */
  readonly upsert: (row: IssueMilestone) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one milestone row.
   *
   * Clearing `milestone_id` on the issues that wore it is the caller's job — this repository does
   * not reach into `issues`.
   */
  readonly deleteById: (
    input: DeleteIssueMilestoneInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Rewrite positions for a set of milestones in one transaction.
   */
  readonly setPositions: (
    input: SetIssueMilestonePositionsInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueMilestoneRepository - Service tag for milestone persistence.
 */
export class IssueMilestoneRepository extends Context.Service<
  IssueMilestoneRepository,
  IssueMilestoneRepositoryShape
>()("t3/persistence/Services/IssueMilestones/IssueMilestoneRepository") {}
