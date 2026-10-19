import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("074_ShellSnapshotIndexes", (it) => {
  it.effect("serves shell snapshot item scans from indexes instead of payload rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const planOf = (query: string) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

      const itemCount = yield* planOf(`
        SELECT COUNT(*)
        FROM orchestration_v2_projection_turn_items i
        LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
        WHERE i.thread_id = 'thread' AND (i.run_id IS NULL OR r.status <> 'rolled_back')
      `);
      assert.include(
        itemCount,
        "USING COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx",
      );

      const runItemCounts = yield* planOf(`
        SELECT thread_id, run_id, COUNT(*) AS item_count
        FROM orchestration_v2_projection_turn_items
        WHERE run_id IS NOT NULL
        GROUP BY thread_id, run_id
      `);
      assert.include(
        runItemCounts,
        "USING COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx",
      );
      assert.notInclude(runItemCounts, "TEMP B-TREE");

      const pendingItems = yield* planOf(`
        SELECT i.thread_id, i.payload_json
        FROM orchestration_v2_projection_turn_items i
        WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
          AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
      `);
      assert.include(
        pendingItems,
        "USING INDEX orchestration_v2_projection_turn_items_type_status_idx",
      );

      const latestMessage = yield* planOf(`
        SELECT payload_json
        FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread'
        ORDER BY updated_at DESC, message_id DESC
        LIMIT 1
      `);
      assert.include(
        latestMessage,
        "USING INDEX orchestration_v2_projection_messages_thread_updated_idx",
      );
      assert.notInclude(latestMessage, "TEMP B-TREE");
    }),
  );
});
