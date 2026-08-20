import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const THREAD_ID = "thread-1";
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const insertRun = (input: {
  readonly runId: string;
  readonly ordinal: number;
  readonly requestedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = encodeUnknownJsonString({
      id: input.runId,
      threadId: THREAD_ID,
      ordinal: input.ordinal,
      requestedAt: input.requestedAt,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${input.runId}, ${THREAD_ID}, ${input.ordinal}, 'codex', NULL, 'completed',
        ${input.requestedAt}, ${input.requestedAt}, ${payload}
      )
    `;
  });

const insertTurnItem = (input: {
  readonly turnItemId: string;
  readonly runId: string | null;
  readonly ordinal: number;
  readonly type: string;
  readonly updatedAt: string;
  readonly streamVersion: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = encodeUnknownJsonString({
      id: input.turnItemId,
      threadId: THREAD_ID,
      runId: input.runId,
      ordinal: input.ordinal,
      type: input.type,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${input.turnItemId}, ${THREAD_ID}, ${input.runId}, NULL, NULL, NULL,
        NULL, ${input.ordinal}, ${input.type}, 'completed', ${input.updatedAt}, ${payload}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${THREAD_ID}, ${input.turnItemId}, ${input.ordinal})
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`event:${input.turnItemId}`}, 'thread', ${THREAD_ID}, ${input.streamVersion},
        'turn-item.updated', ${input.updatedAt}, 'system', ${payload}, '{}', 2
      )
    `;
  });

describe("065_SourceControlMarkerOrdinals", () => {
  it.effect("files a historical marker under the run that preceded it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* insertRun({
        runId: "run-1",
        ordinal: 1,
        requestedAt: "2026-08-19T23:00:00Z",
      });
      yield* insertRun({
        runId: "run-2",
        ordinal: 2,
        requestedAt: "2026-08-19T23:10:00Z",
      });
      yield* insertTurnItem({
        turnItemId: "item:marker",
        runId: null,
        ordinal: 1,
        type: "source_control",
        updatedAt: "2026-08-19T23:05:00Z",
        streamVersion: 1,
      });
      yield* insertTurnItem({
        turnItemId: "item:user",
        runId: "run-1",
        ordinal: 1_000_001,
        type: "user_message",
        updatedAt: "2026-08-19T23:01:00Z",
        streamVersion: 2,
      });
      yield* insertTurnItem({
        turnItemId: "item:assistant",
        runId: "run-1",
        ordinal: 1_000_002,
        type: "assistant_message",
        updatedAt: "2026-08-19T23:04:00Z",
        streamVersion: 3,
      });
      yield* insertTurnItem({
        turnItemId: "item:later-run",
        runId: "run-2",
        ordinal: 2_000_001,
        type: "user_message",
        updatedAt: "2026-08-19T23:11:00Z",
        streamVersion: 4,
      });

      yield* runMigrations({ toMigrationInclusive: 65 });

      const itemRows = yield* sql<{
        readonly runId: string | null;
        readonly ordinal: number;
      }>`
        SELECT run_id AS "runId", ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:marker'
      `;
      assert.deepStrictEqual(itemRows, [{ runId: "run-1", ordinal: 1_000_003 }]);

      const stored = yield* sql<{ readonly runId: string | null; readonly ordinal: number }>`
        SELECT json_extract(payload_json, '$.runId') AS "runId",
               json_extract(payload_json, '$.ordinal') AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:marker'
        UNION ALL
        SELECT 'run-1', ordinal
        FROM orchestration_v2_turn_item_positions
        WHERE turn_item_id = 'item:marker'
        UNION ALL
        SELECT json_extract(payload_json, '$.runId'),
               json_extract(payload_json, '$.ordinal')
        FROM orchestration_events
        WHERE event_id = 'event:item:marker'
      `;
      assert.deepStrictEqual(stored, [
        { runId: "run-1", ordinal: 1_000_003 },
        { runId: "run-1", ordinal: 1_000_003 },
        { runId: "run-1", ordinal: 1_000_003 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("leaves a marker in the prefix when it predates the first run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* insertRun({
        runId: "run-1",
        ordinal: 1,
        requestedAt: "2026-08-19T23:00:00Z",
      });
      yield* insertTurnItem({
        turnItemId: "item:early-marker",
        runId: null,
        ordinal: 1,
        type: "source_control",
        updatedAt: "2026-08-19T22:55:00Z",
        streamVersion: 1,
      });

      yield* runMigrations({ toMigrationInclusive: 65 });

      const rows = yield* sql<{ readonly runId: string | null; readonly ordinal: number }>`
        SELECT run_id AS "runId", ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:early-marker'
      `;
      assert.deepStrictEqual(rows, [{ runId: null, ordinal: 1 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
