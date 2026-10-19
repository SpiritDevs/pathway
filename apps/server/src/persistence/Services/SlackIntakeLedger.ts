/**
 * SlackIntakeLedgerRepository - the bookkeeping polling needs and a socket would not.
 *
 * Three tables, one repository, because they are one fact split three ways: what the reader has
 * read, what it has already acted on, and what it wrote itself. Intake polls
 * `conversations.history` from a stored cursor rather than listening — this server sleeps, and a
 * cursor is the only transport that catches up — so all three of those have to survive a restart,
 * and none of them means anything without the others.
 *
 * - `slack_cursors` is where the reader got to, per channel.
 * - `slack_processed_messages` is what it has already decided about, so an overlapping poll does
 *   not file the same message twice, and a thread reply can find the issue its parent became.
 * - `slack_outbound_posts` is what the bot wrote. That registry is the entire echo-suppression
 *   story: without it the next poll reads the bot's own status update back and files it.
 *
 * @module SlackIntakeLedgerRepository
 */
import { IsoDateTime, IssueId, SlackChannelId, SlackMessageTs } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

/**
 * Where the reader got to in one channel.
 *
 * `reactionScanTs` trails `lastTs` on purpose: a reaction arrives after the message it decorates,
 * so a trigger emoji added today to a message from last week has to be found by a pass that looks
 * further back than the newest message does.
 */
export const SlackCursor = Schema.Struct({
  channelId: SlackChannelId,
  /** Null on a channel never yet read: the first poll decides where to start. */
  lastTs: Schema.NullOr(SlackMessageTs),
  reactionScanTs: Schema.NullOr(SlackMessageTs),
  updatedAt: IsoDateTime,
});
export type SlackCursor = typeof SlackCursor.Type;

/**
 * One message the reader has already decided about. `issueId` is null when the decision was not to
 * file: remembering a refusal is what stops it from being reconsidered on every pass.
 */
export const SlackProcessedMessage = Schema.Struct({
  channelId: SlackChannelId,
  messageTs: SlackMessageTs,
  issueId: Schema.NullOr(IssueId),
  createdAt: IsoDateTime,
});
export type SlackProcessedMessage = typeof SlackProcessedMessage.Type;

export const SlackOutboundPost = Schema.Struct({
  channelId: SlackChannelId,
  messageTs: SlackMessageTs,
  createdAt: IsoDateTime,
});
export type SlackOutboundPost = typeof SlackOutboundPost.Type;

export const GetSlackCursorInput = Schema.Struct({ channelId: SlackChannelId });
export type GetSlackCursorInput = typeof GetSlackCursorInput.Type;

export const SlackMessageRefInput = Schema.Struct({
  channelId: SlackChannelId,
  messageTs: SlackMessageTs,
});
export type SlackMessageRefInput = typeof SlackMessageRefInput.Type;

/**
 * SlackIntakeLedgerRepositoryShape - Service API for the poller's bookkeeping.
 */
export interface SlackIntakeLedgerRepositoryShape {
  /**
   * Read one channel's cursor. `None` is a channel never polled, which is not the same as a
   * channel polled and found empty.
   */
  readonly getCursor: (
    input: GetSlackCursorInput,
  ) => Effect.Effect<Option.Option<SlackCursor>, IssueTrackerRepositoryError>;

  /**
   * Write one channel's cursor, replacing whatever was there.
   */
  readonly setCursor: (row: SlackCursor) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Remember that the bot wrote this message, so the next poll skips reading it back.
   *
   * Idempotent: recording the same post twice is the same fact stated again.
   */
  readonly recordOutbound: (
    row: SlackOutboundPost,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * Whether the bot wrote this message. The poller asks this of every message it reads.
   */
  readonly hasOutbound: (
    input: SlackMessageRefInput,
  ) => Effect.Effect<boolean, IssueTrackerRepositoryError>;

  /**
   * Remember what was decided about a message.
   *
   * Keyed by channel and ts, so a second pass over an overlapping window restates the decision
   * rather than filing a second issue. An existing row's `issueId` is rewritten: a message first
   * seen and skipped can be filed later when somebody adds the trigger reaction.
   */
  readonly recordProcessed: (
    row: SlackProcessedMessage,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;

  /**
   * What was decided about one message. This is both the dedupe check and the thread-reply route:
   * a reply carries its parent's ts, and the issue that parent became is on this row.
   */
  readonly getProcessed: (
    input: SlackMessageRefInput,
  ) => Effect.Effect<Option.Option<SlackProcessedMessage>, IssueTrackerRepositoryError>;
}

/**
 * SlackIntakeLedgerRepository - Service tag for the Slack poller's bookkeeping.
 */
export class SlackIntakeLedgerRepository extends Context.Service<
  SlackIntakeLedgerRepository,
  SlackIntakeLedgerRepositoryShape
>()("@spiritdevs/pathway/persistence/Services/SlackIntakeLedger/SlackIntakeLedgerRepository") {}
