/**
 * IssueThreadLinkRepository - Persistence interface for the thread ↔ issue links.
 *
 * A link says a thread is working an issue. It is read from both ends — the issue's detail sheet
 * lists its threads, and a thread wants the issue it came from — so the pair is the primary key
 * and the thread side is indexed.
 *
 * @module IssueThreadLinkRepository
 */
import { IssueId, IssueThreadLink, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const ListIssueThreadLinksByIssueInput = Schema.Struct({ issueId: IssueId });
export type ListIssueThreadLinksByIssueInput = typeof ListIssueThreadLinksByIssueInput.Type;

export const ListIssueThreadLinksByThreadInput = Schema.Struct({ threadId: ThreadId });
export type ListIssueThreadLinksByThreadInput = typeof ListIssueThreadLinksByThreadInput.Type;

export const UnlinkIssueThreadInput = Schema.Struct({ issueId: IssueId, threadId: ThreadId });
export type UnlinkIssueThreadInput = typeof UnlinkIssueThreadInput.Type;

/**
 * IssueThreadLinkRepositoryShape - Service API for thread link rows.
 */
export interface IssueThreadLinkRepositoryShape {
  /**
   * Record that a thread is working an issue.
   *
   * Keyed by the pair, so linking the same thread again restates the origin rather than adding a
   * second row saying the same thing. `createdAt` is left at the first link's value: the fact is
   * when this thread started on this issue, not when somebody last said so.
   */
  readonly link: (row: IssueThreadLink) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Drop one link. The thread is untouched — unlinking is forgetting the association, not
   * archiving somebody's conversation.
   */
  readonly unlink: (
    input: UnlinkIssueThreadInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * One issue's threads, oldest first.
   */
  readonly listByIssue: (
    input: ListIssueThreadLinksByIssueInput,
  ) => Effect.Effect<ReadonlyArray<IssueThreadLink>, IssueTrackerRepositoryError>;

  /**
   * One thread's issues. A thread usually works one, but nothing stops it from working two.
   */
  readonly listByThread: (
    input: ListIssueThreadLinksByThreadInput,
  ) => Effect.Effect<ReadonlyArray<IssueThreadLink>, IssueTrackerRepositoryError>;
}

/**
 * IssueThreadLinkRepository - Service tag for thread link persistence.
 */
export class IssueThreadLinkRepository extends Context.Service<
  IssueThreadLinkRepository,
  IssueThreadLinkRepositoryShape
>()("t3/persistence/Services/IssueThreadLinks/IssueThreadLinkRepository") {}
