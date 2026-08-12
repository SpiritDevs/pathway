/**
 * IssueCommentRepository - Persistence interface for the comment thread on an issue.
 *
 * Comments are their own visible record rather than change-log rows, so nothing here writes to
 * `issue_events`. The author is stored as the same `IssueActor` JSON the log uses, because an
 * agent comments the same way a person does and the feed has to say which.
 *
 * @module IssueCommentRepository
 */
import { IssueComment, IssueCommentId, IssueId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueCommentsInput = Schema.Struct({ issueId: IssueId });
export type ListIssueCommentsInput = typeof ListIssueCommentsInput.Type;

export const GetIssueCommentInput = Schema.Struct({ commentId: IssueCommentId });
export type GetIssueCommentInput = typeof GetIssueCommentInput.Type;

export const DeleteIssueCommentInput = Schema.Struct({ commentId: IssueCommentId });
export type DeleteIssueCommentInput = typeof DeleteIssueCommentInput.Type;

/**
 * IssueCommentRepositoryShape - Service API for comment rows.
 */
export interface IssueCommentRepositoryShape {
  /**
   * List one issue's comments oldest first. An edit does not move `createdAt`, so this order is
   * stable across edits.
   */
  readonly listByIssue: (
    input: ListIssueCommentsInput,
  ) => Effect.Effect<ReadonlyArray<IssueComment>, IssueTrackerRepositoryError>;

  /**
   * Read one comment by id.
   */
  readonly getById: (
    input: GetIssueCommentInput,
  ) => Effect.Effect<Option.Option<IssueComment>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one comment row, keyed by id.
   */
  readonly upsert: (row: IssueComment) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one comment row.
   *
   * Hard, unlike an issue: a deleted comment leaves no gap to restore into, and the attachments it
   * carried stay on disk because nothing else can be reached from a row that is gone.
   */
  readonly deleteById: (
    input: DeleteIssueCommentInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueCommentRepository - Service tag for comment persistence.
 */
export class IssueCommentRepository extends Context.Service<
  IssueCommentRepository,
  IssueCommentRepositoryShape
>()("t3/persistence/Services/IssueComments/IssueCommentRepository") {}
