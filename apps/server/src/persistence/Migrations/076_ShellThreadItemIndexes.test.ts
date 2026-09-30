import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("076_ShellThreadItemIndexes", (it) => {
  it.effect("serves one thread's pending and pull request items from partial indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const planOf = (query: string) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

      // Mirrors ProjectionStore's per-thread shell queries.
      const pendingItems = yield* planOf(`
        SELECT i.thread_id, i.payload_json
        FROM orchestration_v2_projection_turn_items i
        LEFT JOIN orchestration_v2_projection_runs r
          ON r.run_id = i.run_id
        WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
          AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
          AND (i.run_id IS NULL OR r.status <> 'rolled_back')
          AND i.thread_id IN ('thread')
      `);
      assert.include(
        pendingItems,
        "USING INDEX orchestration_v2_projection_turn_items_pending_background_idx",
      );

      const pullRequestItems = yield* planOf(`
        SELECT i.thread_id, i.payload_json
        FROM orchestration_v2_projection_turn_items i
        LEFT JOIN orchestration_v2_projection_runs r
          ON r.run_id = i.run_id
        WHERE i.type = 'source_control'
          AND json_extract(i.payload_json, '$.pullRequest') IS NOT NULL
          AND (i.run_id IS NULL OR r.status <> 'rolled_back')
          AND i.thread_id IN ('thread')
        ORDER BY i.thread_id ASC, i.ordinal ASC, i.turn_item_id ASC
      `);
      assert.include(
        pullRequestItems,
        "USING INDEX orchestration_v2_projection_turn_items_pull_request_idx",
      );
    }),
  );
});
