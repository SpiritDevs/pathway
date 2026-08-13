/**
 * IssueEventRepository - Persistence interface for the issue change log.
 *
 * Append-only. This is the activity feed, the audit trail for agent writes, and the undo
 * substrate, so nothing here updates or deletes a row.
 *
 * @module IssueEventRepository
 */
import { IssueEvent, IssueId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueEventsInput = Schema.Struct({ issueId: IssueId });
export type ListIssueEventsInput = typeof ListIssueEventsInput.Type;

/**
 * The fields a history reconstruction replays. Narrow on purpose: a description edit is noise to
 * anything counting issues, and the log holds far more rows of it.
 */
export const ISSUE_EVENT_ASSIGNMENT_FIELDS = ["status", "milestone"] as const;

export const ListIssueEventsByFieldInput = Schema.Struct({
  issueIds: Schema.Array(IssueId),
  fields: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
export type ListIssueEventsByFieldInput = typeof ListIssueEventsByFieldInput.Type;

/**
 * IssueEventRepositoryShape - Service API for change log rows.
 */
export interface IssueEventRepositoryShape {
  /**
   * Append one change log row.
   */
  readonly append: (row: IssueEvent) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Append many change log rows in one transaction.
   *
   * One edit can change several fields, and the feed should show all of them or none.
   */
  readonly appendMany: (
    rows: ReadonlyArray<IssueEvent>,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * List the change log for one issue, oldest first.
   */
  readonly listByIssue: (
    input: ListIssueEventsInput,
  ) => Effect.Effect<ReadonlyArray<IssueEvent>, IssueTrackerRepositoryError>;

  /**
   * List the named `field_changed` rows for a set of issues at once, oldest first.
   *
   * One query rather than one per issue, and covered by `idx_issue_events_issue(issue_id,
   * created_at)`. An empty `issueIds` answers with nothing without touching the database.
   */
  readonly listByIssuesAndFields: (
    input: ListIssueEventsByFieldInput,
  ) => Effect.Effect<ReadonlyArray<IssueEvent>, IssueTrackerRepositoryError>;
}

/**
 * IssueEventRepository - Service tag for change log persistence.
 */
export class IssueEventRepository extends Context.Service<
  IssueEventRepository,
  IssueEventRepositoryShape
>()("t3/persistence/Services/IssueEvents/IssueEventRepository") {}
