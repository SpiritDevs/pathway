/**
 * IssueViewRepository - Persistence interface for saved views.
 *
 * A view is a named chip bar: filter, grouping, sort, and layout, stored as one JSON blob beside
 * a name and a position. The rows are configuration-shaped — a handful per environment — so every
 * read here is the whole set in display order.
 *
 * @module IssueViewRepository
 */
import { IsoDateTime, IssueView, IssueViewId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetIssueViewInput = Schema.Struct({ viewId: IssueViewId });
export type GetIssueViewInput = typeof GetIssueViewInput.Type;

export const DeleteIssueViewInput = Schema.Struct({ viewId: IssueViewId });
export type DeleteIssueViewInput = typeof DeleteIssueViewInput.Type;

export const IssueViewPosition = Schema.Struct({
  viewId: IssueViewId,
  position: Schema.Number,
});
export type IssueViewPosition = typeof IssueViewPosition.Type;

export const SetIssueViewPositionsInput = Schema.Struct({
  positions: Schema.Array(IssueViewPosition),
  updatedAt: IsoDateTime,
});
export type SetIssueViewPositionsInput = typeof SetIssueViewPositionsInput.Type;

/**
 * IssueViewRepositoryShape - Service API for saved view rows.
 */
export interface IssueViewRepositoryShape {
  /**
   * List every view in ascending position, ties broken by id so the order is total.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueView>, IssueTrackerRepositoryError>;

  /**
   * Read one view by id.
   */
  readonly getById: (
    input: GetIssueViewInput,
  ) => Effect.Effect<Option.Option<IssueView>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one view row, keyed by id.
   */
  readonly upsert: (row: IssueView) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one view row. A view owns nothing, so nothing else has to be swept after it.
   */
  readonly deleteById: (
    input: DeleteIssueViewInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Rewrite positions for a set of views in one transaction.
   */
  readonly setPositions: (
    input: SetIssueViewPositionsInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueViewRepository - Service tag for saved view persistence.
 */
export class IssueViewRepository extends Context.Service<
  IssueViewRepository,
  IssueViewRepositoryShape
>()("t3/persistence/Services/IssueViews/IssueViewRepository") {}
