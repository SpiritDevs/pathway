/**
 * IssueRepository - Persistence interface for issue rows.
 *
 * Owns the `issues` table only. Labels are a join table and belong to
 * `IssueLabelRepository`, so a row here is an issue minus its `labelIds`; the domain service
 * composes the two into the `Issue` the wire carries.
 *
 * @module IssueRepository
 */
import {
  IsoDateTime,
  IssueCycleId,
  IssueDate,
  IssueId,
  IssueKey,
  IssueMilestoneId,
  IssuePriority,
  IssuePullRequest,
  IssueSlackSource,
  IssueStatusId,
  IssueAssignee,
  IssueAutomationAssignment,
  ModelSelection,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const IssueRecord = Schema.Struct({
  id: IssueId,
  key: IssueKey,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  statusId: IssueStatusId,
  priority: IssuePriority,
  assignee: Schema.NullOr(IssueAssignee),
  workModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  automationAssignment: Schema.optionalKey(Schema.NullOr(IssueAutomationAssignment)),
  pullRequest: Schema.optionalKey(Schema.NullOr(IssuePullRequest)),
  projectId: Schema.NullOr(ProjectId),
  milestoneId: Schema.NullOr(IssueMilestoneId),
  cycleId: Schema.NullOr(IssueCycleId),
  parentId: Schema.NullOr(IssueId),
  sortOrder: TrimmedNonEmptyString,
  dueDate: Schema.NullOr(IssueDate),
  triage: Schema.Boolean,
  /**
   * Four columns on this table rather than a side table, reassembled by the layer: the list draws
   * a Slack marker on a triage item, and a join would make the snapshot's one read two.
   */
  slackSource: Schema.NullOr(IssueSlackSource),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type IssueRecord = typeof IssueRecord.Type;

export const GetIssueInput = Schema.Struct({ issueId: IssueId });
export type GetIssueInput = typeof GetIssueInput.Type;

export const GetIssueByKeyInput = Schema.Struct({ key: IssueKey });
export type GetIssueByKeyInput = typeof GetIssueByKeyInput.Type;

export const SoftDeleteIssueInput = Schema.Struct({
  issueId: IssueId,
  deletedAt: IsoDateTime,
});
export type SoftDeleteIssueInput = typeof SoftDeleteIssueInput.Type;

export const RestoreIssueInput = Schema.Struct({
  issueId: IssueId,
  updatedAt: IsoDateTime,
});
export type RestoreIssueInput = typeof RestoreIssueInput.Type;

export const SetIssueSortOrderInput = Schema.Struct({
  issueId: IssueId,
  sortOrder: TrimmedNonEmptyString,
  /** Null leaves the status alone; a value moves column and position in the same write. */
  statusId: Schema.NullOr(IssueStatusId),
  updatedAt: IsoDateTime,
});
export type SetIssueSortOrderInput = typeof SetIssueSortOrderInput.Type;

export const ReassignIssueStatusInput = Schema.Struct({
  fromStatusId: IssueStatusId,
  toStatusId: IssueStatusId,
  updatedAt: IsoDateTime,
});
export type ReassignIssueStatusInput = typeof ReassignIssueStatusInput.Type;

/**
 * A named set rather than a `WHERE milestone_id = ?` sweep: the caller already knows which issues
 * moved, because it has to write a change-log row and publish a diff for each one.
 */
export const SetIssueMilestoneInput = Schema.Struct({
  issueIds: Schema.Array(IssueId),
  milestoneId: Schema.NullOr(IssueMilestoneId),
  updatedAt: IsoDateTime,
});
export type SetIssueMilestoneInput = typeof SetIssueMilestoneInput.Type;

export const SetIssueCycleInput = Schema.Struct({
  issueIds: Schema.Array(IssueId),
  cycleId: Schema.NullOr(IssueCycleId),
  updatedAt: IsoDateTime,
});
export type SetIssueCycleInput = typeof SetIssueCycleInput.Type;

export const SetIssuePullRequestInput = Schema.Struct({
  issueId: IssueId,
  pullRequest: IssuePullRequest,
  updatedAt: IsoDateTime,
});
export type SetIssuePullRequestInput = typeof SetIssuePullRequestInput.Type;

/**
 * IssueRepositoryShape - Service API for issue rows.
 */
export interface IssueRepositoryShape {
  /**
   * List every issue row, soft-deleted ones included.
   *
   * This is what the snapshot reads: a client that can see a deleted issue can restore it without
   * a second round trip.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<IssueRecord>, IssueTrackerRepositoryError>;

  /**
   * List issue rows that have not been soft-deleted.
   */
  readonly listLive: () => Effect.Effect<ReadonlyArray<IssueRecord>, IssueTrackerRepositoryError>;

  /**
   * List soft-deleted issue rows, most recently deleted first.
   */
  readonly listDeleted: () => Effect.Effect<
    ReadonlyArray<IssueRecord>,
    IssueTrackerRepositoryError
  >;

  /**
   * Read one issue row by id.
   */
  readonly getById: (
    input: GetIssueInput,
  ) => Effect.Effect<Option.Option<IssueRecord>, IssueTrackerRepositoryError>;

  /**
   * Read one issue row by its human key, `ISS-12`.
   */
  readonly getByKey: (
    input: GetIssueByKeyInput,
  ) => Effect.Effect<Option.Option<IssueRecord>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one issue row, keyed by id.
   */
  readonly upsert: (row: IssueRecord) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Insert or replace many issue rows in one transaction.
   *
   * A bulk edit or a CSV import is one write or none: a half-applied selection is worse than a
   * refused one.
   */
  readonly upsertMany: (
    rows: ReadonlyArray<IssueRecord>,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Stamp `deleted_at` on one issue row.
   */
  readonly softDelete: (
    input: SoftDeleteIssueInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Clear `deleted_at` on one issue row.
   */
  readonly restore: (input: RestoreIssueInput) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Write the fractional order key, and optionally the status, for one issue row.
   */
  readonly setSortOrder: (
    input: SetIssueSortOrderInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Move every issue on one status to another.
   *
   * Deleting a status has to say where its issues go, and this is that move.
   */
  readonly reassignStatus: (
    input: ReassignIssueStatusInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Point a set of issues at one milestone, or at none.
   *
   * Deleting a milestone is this with `null`: unlike a status, "no milestone" is a valid value, so
   * the delete does not have to ask where the issues go.
   */
  readonly setMilestone: (
    input: SetIssueMilestoneInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Point a set of issues at one cycle, or at none. This is both the carry-over of an ended cycle
   * and the clear a cycle delete performs.
   */
  readonly setCycle: (
    input: SetIssueCycleInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /** Attach VCS discovery without rewriting a concurrently edited issue row. */
  readonly setPullRequest: (
    input: SetIssuePullRequestInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * IssueRepository - Service tag for issue persistence.
 */
export class IssueRepository extends Context.Service<IssueRepository, IssueRepositoryShape>()(
  "t3/persistence/Services/Issues/IssueRepository",
) {}
