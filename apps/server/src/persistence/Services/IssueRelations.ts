/**
 * IssueRelationRepository - Persistence interface for the directed pairs between issues.
 *
 * One row per relation, never two. "Blocked by" is a `blocks` row read from the other end, so the
 * inverse is a direction on the read rather than a second row that could drift out of agreement
 * with the first — which is why `listByIssue` unions both ends and tags each edge.
 *
 * @module IssueRelationRepository
 */
import { IssueId, IssueRelation, IssueRelationEdge, IssueRelationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueRelationsInput = Schema.Struct({ issueId: IssueId });
export type ListIssueRelationsInput = typeof ListIssueRelationsInput.Type;

export const GetIssueRelationInput = Schema.Struct({ relationId: IssueRelationId });
export type GetIssueRelationInput = typeof GetIssueRelationInput.Type;

export const DeleteIssueRelationInput = Schema.Struct({ relationId: IssueRelationId });
export type DeleteIssueRelationInput = typeof DeleteIssueRelationInput.Type;

/**
 * IssueRelationRepositoryShape - Service API for relation rows.
 */
export interface IssueRelationRepositoryShape {
  /**
   * List one issue's complete edge list, both directions, outgoing first.
   */
  readonly listByIssue: (
    input: ListIssueRelationsInput,
  ) => Effect.Effect<ReadonlyArray<IssueRelationEdge>, IssueTrackerRepositoryError>;

  /**
   * Read one relation by id.
   */
  readonly getById: (
    input: GetIssueRelationInput,
  ) => Effect.Effect<Option.Option<IssueRelation>, IssueTrackerRepositoryError>;

  /**
   * Insert one relation row.
   *
   * The table's unique key is the whole triple, so a repeat of an existing pair is ignored rather
   * than failing — the service refuses the duplicate before it gets here, with a message that
   * says which pair.
   */
  readonly insert: (row: IssueRelation) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one relation row.
   */
  readonly deleteById: (
    input: DeleteIssueRelationInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueRelationRepository - Service tag for relation persistence.
 */
export class IssueRelationRepository extends Context.Service<
  IssueRelationRepository,
  IssueRelationRepositoryShape
>()("t3/persistence/Services/IssueRelations/IssueRelationRepository") {}
