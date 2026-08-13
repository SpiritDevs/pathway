import { SlackChannelWatch, SlackIntakeTrigger, SlackReactionRoute } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteSlackChannelWatchInput,
  GetSlackChannelWatchByChannelInput,
  GetSlackChannelWatchInput,
  SlackChannelWatchRepository,
  type SlackChannelWatchRepositoryShape,
} from "../Services/SlackChannelWatches.ts";

/**
 * Channel-wide triggers remain columns; reaction routes are the one ordered collection and live
 * as bounded JSON. Reassembled here so the rest of the server only sees
 * {@link SlackIntakeTrigger}.
 */
const SlackIntakeTriggerDbRow = SlackIntakeTrigger.mapFields(
  Struct.assign({
    everyMessage: Schema.BooleanFromBit,
    botMention: Schema.BooleanFromBit,
  }),
);

const SlackChannelWatchDbRow = SlackChannelWatch.mapFields(
  Struct.assign({
    autoInvestigate: Schema.BooleanFromBit,
    autoAssign: Schema.BooleanFromBit,
    trigger: Schema.fromJsonString(SlackIntakeTriggerDbRow),
  }),
);

const SlackReactionRoutes = Schema.Array(SlackReactionRoute);
const decodeReactionRoutes = Schema.decodeUnknownSync(SlackReactionRoutes);
const encodeReactionRoutes = Schema.encodeSync(Schema.fromJsonString(SlackReactionRoutes));

const WATCH_COLUMNS = `
  id,
  channel_id AS "channelId",
  channel_name AS "channelName",
  project_id AS "projectId",
  cycle_id AS "cycleId",
  auto_investigate AS "autoInvestigate",
  auto_assign AS "autoAssign",
  json_object(
    'reactionRoutes', json(trigger_reaction_routes),
    'everyMessage', trigger_every_message,
    'botMention', trigger_bot_mention
  ) AS "trigger",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeSlackChannelWatchRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const watchColumns = sql.literal(WATCH_COLUMNS);

  const upsertSlackChannelWatchRow = SqlSchema.void({
    Request: SlackChannelWatch,
    execute: (row) =>
      sql`
        INSERT INTO slack_channel_watches (
          id,
          channel_id,
          channel_name,
          project_id,
          cycle_id,
          auto_investigate,
          auto_assign,
          trigger_reaction_routes,
          trigger_every_message,
          trigger_bot_mention,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.channelId},
          ${row.channelName},
          ${row.projectId},
          ${row.cycleId ?? null},
          ${row.autoInvestigate ? 1 : 0},
          ${row.autoAssign === true ? 1 : 0},
          ${encodeReactionRoutes(decodeReactionRoutes(row.trigger.reactionRoutes))},
          ${row.trigger.everyMessage ? 1 : 0},
          ${row.trigger.botMention ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          channel_id = excluded.channel_id,
          channel_name = excluded.channel_name,
          project_id = excluded.project_id,
          cycle_id = excluded.cycle_id,
          auto_investigate = excluded.auto_investigate,
          auto_assign = excluded.auto_assign,
          trigger_reaction_routes = excluded.trigger_reaction_routes,
          trigger_every_message = excluded.trigger_every_message,
          trigger_bot_mention = excluded.trigger_bot_mention,
          updated_at = excluded.updated_at
      `,
  });

  const listSlackChannelWatchRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SlackChannelWatchDbRow,
    execute: () =>
      sql`
        SELECT ${watchColumns}
        FROM slack_channel_watches
        ORDER BY created_at ASC, id ASC
      `,
  });

  const getSlackChannelWatchRowById = SqlSchema.findOneOption({
    Request: GetSlackChannelWatchInput,
    Result: SlackChannelWatchDbRow,
    execute: ({ watchId }) =>
      sql`
        SELECT ${watchColumns}
        FROM slack_channel_watches
        WHERE id = ${watchId}
      `,
  });

  const getSlackChannelWatchRowByChannel = SqlSchema.findOneOption({
    Request: GetSlackChannelWatchByChannelInput,
    Result: SlackChannelWatchDbRow,
    execute: ({ channelId }) =>
      sql`
        SELECT ${watchColumns}
        FROM slack_channel_watches
        WHERE channel_id = ${channelId}
      `,
  });

  const deleteSlackChannelWatchRow = SqlSchema.void({
    Request: DeleteSlackChannelWatchInput,
    execute: ({ watchId }) =>
      sql`
        DELETE FROM slack_channel_watches
        WHERE id = ${watchId}
      `,
  });

  const listAll: SlackChannelWatchRepositoryShape["listAll"] = () =>
    listSlackChannelWatchRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackChannelWatchRepository.listAll:query",
          "SlackChannelWatchRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: SlackChannelWatchRepositoryShape["getById"] = (input) =>
    getSlackChannelWatchRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackChannelWatchRepository.getById:query",
          "SlackChannelWatchRepository.getById:decodeRow",
        ),
      ),
    );

  const getByChannel: SlackChannelWatchRepositoryShape["getByChannel"] = (input) =>
    getSlackChannelWatchRowByChannel(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackChannelWatchRepository.getByChannel:query",
          "SlackChannelWatchRepository.getByChannel:decodeRow",
        ),
      ),
    );

  const upsert: SlackChannelWatchRepositoryShape["upsert"] = (row) =>
    upsertSlackChannelWatchRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackChannelWatchRepository.upsert:query",
          "SlackChannelWatchRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: SlackChannelWatchRepositoryShape["deleteById"] = (input) =>
    deleteSlackChannelWatchRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "SlackChannelWatchRepository.deleteById:query",
          "SlackChannelWatchRepository.deleteById:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    getByChannel,
    upsert,
    deleteById,
  } satisfies SlackChannelWatchRepositoryShape;
});

export const SlackChannelWatchRepositoryLive = Layer.effect(
  SlackChannelWatchRepository,
  makeSlackChannelWatchRepository,
);
