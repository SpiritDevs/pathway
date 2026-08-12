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
}

/**
 * IssueEventRepository - Service tag for change log persistence.
 */
export class IssueEventRepository extends Context.Service<
  IssueEventRepository,
  IssueEventRepositoryShape
>()("t3/persistence/Services/IssueEvents/IssueEventRepository") {}
