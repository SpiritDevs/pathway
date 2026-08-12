/**
 * IssueLabelRepository - Persistence interface for labels and their assignment to issues.
 *
 * The join table lives here rather than on `IssueRepository` so an issue write and a label write
 * stay separable: relabelling does not rewrite the issue row.
 *
 * @module IssueLabelRepository
 */
import { IssueId, IssueLabel, IssueLabelId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetIssueLabelInput = Schema.Struct({ labelId: IssueLabelId });
export type GetIssueLabelInput = typeof GetIssueLabelInput.Type;

export const DeleteIssueLabelInput = Schema.Struct({ labelId: IssueLabelId });
export type DeleteIssueLabelInput = typeof DeleteIssueLabelInput.Type;

export const IssueLabelAssignment = Schema.Struct({
  issueId: IssueId,
  labelId: IssueLabelId,
});
export type IssueLabelAssignment = typeof IssueLabelAssignment.Type;

export const ListIssueLabelAssignmentsInput = Schema.Struct({ issueId: IssueId });
export type ListIssueLabelAssignmentsInput = typeof ListIssueLabelAssignmentsInput.Type;

export const SetIssueLabelAssignmentsInput = Schema.Struct({
  issueId: IssueId,
  /** The complete set, not a delta: whatever is not here is removed. */
  labelIds: Schema.Array(IssueLabelId),
});
export type SetIssueLabelAssignmentsInput = typeof SetIssueLabelAssignmentsInput.Type;

/**
 * IssueLabelRepositoryShape - Service API for label rows and assignments.
 */
export interface IssueLabelRepositoryShape {
  /**
   * List every label in creation order.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueLabel>, IssueTrackerRepositoryError>;

  /**
   * Read one label by id.
   */
  readonly getById: (
    input: GetIssueLabelInput,
  ) => Effect.Effect<Option.Option<IssueLabel>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one label row, keyed by id.
   */
  readonly upsert: (row: IssueLabel) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one label and every assignment of it, in one transaction.
   */
  readonly deleteById: (
    input: DeleteIssueLabelInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * List every assignment pair.
   *
   * The snapshot reads this once and groups client-side rather than issuing a query per issue.
   */
  readonly listAssignments: () => Effect.Effect<
    ReadonlyArray<IssueLabelAssignment>,
    IssueTrackerRepositoryError
  >;

  /**
   * List the labels assigned to one issue.
   */
  readonly listAssignmentsByIssue: (
    input: ListIssueLabelAssignmentsInput,
  ) => Effect.Effect<ReadonlyArray<IssueLabelId>, IssueTrackerRepositoryError>;

  /**
   * Replace the label set on one issue in one transaction.
   */
  readonly setAssignments: (
    input: SetIssueLabelAssignmentsInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueLabelRepository - Service tag for label persistence.
 */
export class IssueLabelRepository extends Context.Service<
  IssueLabelRepository,
  IssueLabelRepositoryShape
>()("t3/persistence/Services/IssueLabels/IssueLabelRepository") {}
