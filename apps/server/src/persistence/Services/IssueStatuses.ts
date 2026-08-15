/**
 * IssueStatusRepository - Persistence interface for the workflow statuses.
 *
 * Statuses are configured once per environment and read on every list render, so the row shape is
 * the wire shape: there is nothing to project.
 *
 * @module IssueStatusRepository
 */
import { IsoDateTime, IssueStatus, IssueStatusId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetIssueStatusInput = Schema.Struct({ statusId: IssueStatusId });
export type GetIssueStatusInput = typeof GetIssueStatusInput.Type;

export const DeleteIssueStatusInput = Schema.Struct({ statusId: IssueStatusId });
export type DeleteIssueStatusInput = typeof DeleteIssueStatusInput.Type;

export const IssueStatusPosition = Schema.Struct({
  statusId: IssueStatusId,
  position: Schema.Number,
});
export type IssueStatusPosition = typeof IssueStatusPosition.Type;

export const SetIssueStatusPositionsInput = Schema.Struct({
  positions: Schema.Array(IssueStatusPosition),
  updatedAt: IsoDateTime,
});
export type SetIssueStatusPositionsInput = typeof SetIssueStatusPositionsInput.Type;

/**
 * IssueStatusRepositoryShape - Service API for issue status rows.
 */
export interface IssueStatusRepositoryShape {
  /**
   * List every status in ascending position, ties broken by id so the order is total.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueStatus>, IssueTrackerRepositoryError>;

  /**
   * Read one status by id.
   */
  readonly getById: (
    input: GetIssueStatusInput,
  ) => Effect.Effect<Option.Option<IssueStatus>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one status row, keyed by id.
   */
  readonly upsert: (row: IssueStatus) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one status row.
   *
   * Reassigning the issues it held is the caller's job — this repository does not reach into
   * `issues`.
   */
  readonly deleteById: (
    input: DeleteIssueStatusInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Rewrite positions for a set of statuses in one transaction.
   */
  readonly setPositions: (
    input: SetIssueStatusPositionsInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueStatusRepository - Service tag for issue status persistence.
 */
export class IssueStatusRepository extends Context.Service<
  IssueStatusRepository,
  IssueStatusRepositoryShape
>()("@spiritdevs/pathway/persistence/Services/IssueStatuses/IssueStatusRepository") {}
