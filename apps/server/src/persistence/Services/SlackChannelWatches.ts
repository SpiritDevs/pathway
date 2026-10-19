/**
 * SlackChannelWatchRepository - Persistence interface for the watched Slack channels.
 *
 * A watch is configuration: a channel, the project its messages get tagged with, and the switches
 * that decide what turns a message into a triage item. There are a handful of rows, read whole on
 * every poll and on every snapshot, so every read here is the full set in a stable order.
 *
 * The channel is unique, not the id: the id is what a client edits a row by, but two watches on
 * one channel would poll it twice and file everything twice.
 *
 * @module SlackChannelWatchRepository
 */
import { SlackChannelId, SlackChannelWatch, SlackChannelWatchId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const GetSlackChannelWatchInput = Schema.Struct({ watchId: SlackChannelWatchId });
export type GetSlackChannelWatchInput = typeof GetSlackChannelWatchInput.Type;

export const GetSlackChannelWatchByChannelInput = Schema.Struct({ channelId: SlackChannelId });
export type GetSlackChannelWatchByChannelInput = typeof GetSlackChannelWatchByChannelInput.Type;

export const DeleteSlackChannelWatchInput = Schema.Struct({ watchId: SlackChannelWatchId });
export type DeleteSlackChannelWatchInput = typeof DeleteSlackChannelWatchInput.Type;

/**
 * SlackChannelWatchRepositoryShape - Service API for watched channel rows.
 */
export interface SlackChannelWatchRepositoryShape {
  /**
   * Every watch, oldest first with ties broken by id so the order is total.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<SlackChannelWatch>,
    IssueTrackerRepositoryError
  >;

  /**
   * Read one watch by id.
   */
  readonly getById: (
    input: GetSlackChannelWatchInput,
  ) => Effect.Effect<Option.Option<SlackChannelWatch>, IssueTrackerRepositoryError>;

  /**
   * Read one watch by the channel it watches. This is the poller's lookup, and the check that
   * refuses a second watch on a channel already covered.
   */
  readonly getByChannel: (
    input: GetSlackChannelWatchByChannelInput,
  ) => Effect.Effect<Option.Option<SlackChannelWatch>, IssueTrackerRepositoryError>;

  /**
   * Insert or replace one watch row, keyed by id.
   */
  readonly upsert: (row: SlackChannelWatch) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Delete one watch row.
   *
   * The channel's cursor and its processed messages are deliberately left behind: unwatching is
   * usually a pause, and re-watching a channel whose ledger had been swept would refile every
   * message still inside Slack's history window.
   */
  readonly deleteById: (
    input: DeleteSlackChannelWatchInput,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
}

/**
 * SlackChannelWatchRepository - Service tag for watched channel persistence.
 */
export class SlackChannelWatchRepository extends Context.Service<
  SlackChannelWatchRepository,
  SlackChannelWatchRepositoryShape
>()("@spiritdevs/pathway/persistence/Services/SlackChannelWatches/SlackChannelWatchRepository") {}
