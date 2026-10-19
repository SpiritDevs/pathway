/**
 * IssueTodoRepository - Persistence interface for the checklist rows on an issue.
 *
 * A todo is not a sub-issue: it has no key, no status, and no place in the list view, which is why
 * it is a table of its own rather than a shape of `issues`. Reads are always scoped to one issue,
 * because todos are loaded when a detail sheet opens rather than with the snapshot.
 *
 * @module IssueTodoRepository
 */
import { IssueId, IssueTodo, IssueTodoId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueTodosInput = Schema.Struct({ issueId: IssueId });
export type ListIssueTodosInput = typeof ListIssueTodosInput.Type;

export const GetIssueTodoInput = Schema.Struct({ todoId: IssueTodoId });
export type GetIssueTodoInput = typeof GetIssueTodoInput.Type;

export const DeleteIssueTodoInput = Schema.Struct({ todoId: IssueTodoId });
export type DeleteIssueTodoInput = typeof DeleteIssueTodoInput.Type;

export const IssueTodoPosition = Schema.Struct({
  todoId: IssueTodoId,
  position: Schema.Number,
});
export type IssueTodoPosition = typeof IssueTodoPosition.Type;

export const SetIssueTodoPositionsInput = Schema.Struct({
  positions: Schema.Array(IssueTodoPosition),
});
export type SetIssueTodoPositionsInput = typeof SetIssueTodoPositionsInput.Type;

/**
 * IssueTodoRepositoryShape - Service API for todo rows.
 */
export interface IssueTodoRepositoryShape {
  /**
   * List one issue's checklist in ascending position, ties broken by id.
   */
  readonly listByIssue: (
    input: ListIssueTodosInput,
  ) => Effect.Effect<ReadonlyArray<IssueTodo>, IssueTrackerRepositoryError>;

  /**
   * Read one todo by id.
   */
  readonly getById: (
    input: GetIssueTodoInput,
  ) => Effect.Effect<Option.Option<IssueTodo>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one todo row, keyed by id.
   */
  readonly upsert: (row: IssueTodo) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one todo row.
   */
  readonly deleteById: (
    input: DeleteIssueTodoInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Rewrite positions for a set of todos in one transaction.
   */
  readonly setPositions: (
    input: SetIssueTodoPositionsInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueTodoRepository - Service tag for todo persistence.
 */
export class IssueTodoRepository extends Context.Service<
  IssueTodoRepository,
  IssueTodoRepositoryShape
>()("@spiritdevs/pathway/persistence/Services/IssueTodos/IssueTodoRepository") {}
