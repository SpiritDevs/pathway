import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  GetSlackCursorInput,
  SlackCursor,
  SlackIntakeLedgerRepository,
  type SlackIntakeLedgerRepositoryShape,
  SlackMessageRefInput,
  SlackOutboundPost,
  SlackProcessedMessage,
} from "../Services/SlackIntakeLedger.ts";

const CURSOR_COLUMNS = `
  channel_id AS "channelId",
  last_ts AS "lastTs",
  reaction_scan_ts AS "reactionScanTs",
  updated_at AS "updatedAt"
`;

const PROCESSED_COLUMNS = `
  channel_id AS "channelId",
  message_ts AS "messageTs",
  issue_id AS "issueId",
  created_at AS "createdAt"
`;

const OUTBOUND_COLUMNS = `
  channel_id AS "channelId",
  message_ts AS "messageTs",
  created_at AS "createdAt"
`;

const makeSlackIntakeLedgerRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cursorColumns = sql.literal(CURSOR_COLUMNS);
  const processedColumns = sql.literal(PROCESSED_COLUMNS);
  const outboundColumns = sql.literal(OUTBOUND_COLUMNS);

  const getSlackCursorRow = SqlSchema.findOneOption({
    Request: GetSlackCursorInput,
    Result: SlackCursor,
    execute: ({ channelId }) =>
      sql`
        SELECT ${cursorColumns}
        FROM slack_cursors
        WHERE channel_id = ${channelId}
      `,
  });

  const setSlackCursorRow = SqlSchema.void({
    Request: SlackCursor,
    execute: (row) =>
      sql`
        INSERT INTO slack_cursors (
          channel_id,
          last_ts,
          reaction_scan_ts,
          updated_at
        )
        VALUES (
          ${row.channelId},
          ${row.lastTs},
          ${row.reactionScanTs},
          ${row.updatedAt}
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          last_ts = excluded.last_ts,
          reaction_scan_ts = excluded.reaction_scan_ts,
          updated_at = excluded.updated_at
      `,
  });

  // `created_at` is left alone on conflict: the fact is when the bot posted, not when it last
  // said so, and a second record of the same post is the same post.
  const recordSlackOutboundRow = SqlSchema.void({
    Request: SlackOutboundPost,
    execute: (row) =>
      sql`
        INSERT INTO slack_outbound_posts (
          channel_id,
          message_ts,
          created_at
        )
        VALUES (
          ${row.channelId},
          ${row.messageTs},
          ${row.createdAt}
        )
        ON CONFLICT (channel_id, message_ts)
        DO NOTHING
      `,
  });

  const getSlackOutboundRow = SqlSchema.findOneOption({
    Request: SlackMessageRefInput,
    Result: SlackOutboundPost,
    execute: ({ channelId, messageTs }) =>
      sql`
        SELECT ${outboundColumns}
        FROM slack_outbound_posts
        WHERE channel_id = ${channelId} AND message_ts = ${messageTs}
      `,
  });

  // `issue_id` *is* rewritten on conflict, unlike the outbound registry: a message first seen and
  // skipped becomes a real issue the moment somebody adds the trigger reaction to it.
  const recordSlackProcessedRow = SqlSchema.void({
    Request: SlackProcessedMessage,
    execute: (row) =>
      sql`
        INSERT INTO slack_processed_messages (
          channel_id,
          message_ts,
          issue_id,
          created_at
        )
        VALUES (
          ${row.channelId},
          ${row.messageTs},
          ${row.issueId},
          ${row.createdAt}
        )
        ON CONFLICT (channel_id, message_ts)
        DO UPDATE SET issue_id = excluded.issue_id
      `,
  });

  const getSlackProcessedRow = SqlSchema.findOneOption({
    Request: SlackMessageRefInput,
    Result: SlackProcessedMessage,
    execute: ({ channelId, messageTs }) =>
      sql`
        SELECT ${processedColumns}
        FROM slack_processed_messages
        WHERE channel_id = ${channelId} AND message_ts = ${messageTs}
      `,
  });

  const getCursor: SlackIntakeLedgerRepositoryShape["getCursor"] = (input) =>
    getSlackCursorRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.getCursor:query",
          "SlackIntakeLedgerRepository.getCursor:decodeRow",
        ),
      ),
    );

  const setCursor: SlackIntakeLedgerRepositoryShape["setCursor"] = (row) =>
    setSlackCursorRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.setCursor:query",
          "SlackIntakeLedgerRepository.setCursor:encodeRequest",
        ),
      ),
    );

  const recordOutbound: SlackIntakeLedgerRepositoryShape["recordOutbound"] = (row) =>
    recordSlackOutboundRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.recordOutbound:query",
          "SlackIntakeLedgerRepository.recordOutbound:encodeRequest",
        ),
      ),
    );

  const hasOutbound: SlackIntakeLedgerRepositoryShape["hasOutbound"] = (input) =>
    getSlackOutboundRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.hasOutbound:query",
          "SlackIntakeLedgerRepository.hasOutbound:decodeRow",
        ),
      ),
    );

  const recordProcessed: SlackIntakeLedgerRepositoryShape["recordProcessed"] = (row) =>
    recordSlackProcessedRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.recordProcessed:query",
          "SlackIntakeLedgerRepository.recordProcessed:encodeRequest",
        ),
      ),
    );

  const getProcessed: SlackIntakeLedgerRepositoryShape["getProcessed"] = (input) =>
    getSlackProcessedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackIntakeLedgerRepository.getProcessed:query",
          "SlackIntakeLedgerRepository.getProcessed:decodeRow",
        ),
      ),
    );

  return {
    getCursor,
    setCursor,
    recordOutbound,
    hasOutbound,
    recordProcessed,
    getProcessed,
  } satisfies SlackIntakeLedgerRepositoryShape;
});

export const SlackIntakeLedgerRepositoryLive = Layer.effect(
  SlackIntakeLedgerRepository,
  makeSlackIntakeLedgerRepository,
);
