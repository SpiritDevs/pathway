import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const THREAD_ID = "thread-1";

const insertTurnItem = (input: {
  readonly turnItemId: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly type: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = `{"id":"${input.turnItemId}","threadId":"${input.threadId}","ordinal":${input.ordinal},"type":"${input.type}"}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${input.turnItemId}, ${input.threadId}, NULL, NULL, NULL, NULL,
        NULL, ${input.ordinal}, ${input.type}, 'completed', '2026-08-19T23:00:00Z', ${payload}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${input.threadId}, ${input.turnItemId}, ${input.ordinal})
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`event:${input.turnItemId}`}, 'thread', ${input.threadId}, ${input.ordinal},
        'turn-item.updated', '2026-08-19T23:00:00Z', 'system', ${payload}, '{}', 2
      )
    `;
  });

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("065_SourceControlMarkerOrdinals", (it) => {
  it.effect("moves a pre-run source-control marker after the run it followed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* insertTurnItem({
        turnItemId: "item:marker",
        threadId: THREAD_ID,
        ordinal: 1,
        type: "source_control",
      });
      yield* insertTurnItem({
        turnItemId: "item:user",
        threadId: THREAD_ID,
        ordinal: 1_000_001,
        type: "user_message",
      });
      yield* insertTurnItem({
        turnItemId: "item:assistant",
        threadId: THREAD_ID,
        ordinal: 1_000_002,
        type: "assistant_message",
      });

      yield* runMigrations({ toMigrationInclusive: 65 });

      const items = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
        SELECT turn_item_id, ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${THREAD_ID}
        ORDER BY ordinal ASC
      `;
      assert.deepStrictEqual(
        items.map((item) => item.turn_item_id),
        ["item:user", "item:assistant", "item:marker"],
      );

      const marker = items.find((item) => item.turn_item_id === "item:marker");
      assert.equal(marker?.ordinal, 1_000_003);

      const payloadOrdinals = yield* sql<{ readonly ordinal: number }>`
        SELECT json_extract(payload_json, '$.ordinal') AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:marker'
        UNION ALL
        SELECT ordinal FROM orchestration_v2_turn_item_positions
        WHERE turn_item_id = 'item:marker'
        UNION ALL
        SELECT json_extract(payload_json, '$.ordinal')
        FROM orchestration_events
        WHERE event_id = 'event:item:marker'
      `;
      assert.deepStrictEqual(
        payloadOrdinals.map((row) => row.ordinal),
        [1_000_003, 1_000_003, 1_000_003],
      );
    }),
  );

  it.effect("leaves a marker alone when the thread never ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* insertTurnItem({
        turnItemId: "item:lone-marker",
        threadId: "thread-2",
        ordinal: 1,
        type: "source_control",
      });

      yield* runMigrations({ toMigrationInclusive: 65 });

      const rows = yield* sql<{ readonly ordinal: number }>`
        SELECT ordinal FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:lone-marker'
      `;
      assert.equal(rows[0]?.ordinal, 1);
    }),
  );
});
