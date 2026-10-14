import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("081_NativeSubagentRecoveryIndexes", (it) => {
  it.effect("indexes only open native subagents and open runless root turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      const subagent = (id: string, origin: string, status: string) =>
        sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
          subagent_id: id,
          thread_id: `thread:${id}`,
          run_id: null,
          parent_node_id: "node:parent",
          provider: "codex",
          provider_thread_id: null,
          child_thread_id: null,
          origin,
          status,
          started_at: null,
          completed_at: null,
          updated_at: "2026-10-15T00:00:00.000Z",
          payload_json: "{}",
        })}`;
      const node = (id: string, runId: string | null, kind: string, status: string) =>
        sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
          node_id: id,
          thread_id: `thread:${id}`,
          run_id: runId,
          parent_node_id: null,
          root_node_id: id,
          kind,
          status,
          provider_thread_id: null,
          provider_turn_id: null,
          runtime_request_id: null,
          checkpoint_scope_id: null,
          started_at: null,
          completed_at: null,
          payload_json: "{}",
        })}`;
      yield* subagent("native-open", "provider_native", "running");
      yield* subagent("native-done", "provider_native", "completed");
      yield* subagent("app-owned-open", "app_owned", "running");
      yield* node("runless-open", null, "root_turn", "running");
      yield* node("runless-done", null, "root_turn", "completed");
      yield* node("run-open", "run:1", "root_turn", "running");
      yield* node("tool-open", null, "tool_call", "running");

      const subagentQuery = `
        SELECT thread_id FROM orchestration_v2_projection_subagents
        INDEXED BY orchestration_v2_projection_subagents_open_native_idx
        WHERE origin = 'provider_native' AND status IN ('pending', 'running', 'waiting')
      `;
      const nodeQuery = `
        SELECT thread_id FROM orchestration_v2_projection_nodes
        INDEXED BY orchestration_v2_projection_nodes_open_runless_root_idx
        WHERE run_id IS NULL AND kind = 'root_turn' AND status IN ('pending', 'running', 'waiting')
      `;
      assert.deepEqual(yield* sql.unsafe(subagentQuery), [{ thread_id: "thread:native-open" }]);
      assert.deepEqual(yield* sql.unsafe(nodeQuery), [{ thread_id: "thread:runless-open" }]);
      // Both scans read only the open rows their partial index holds.
      for (const [query, index] of [
        [subagentQuery, "orchestration_v2_projection_subagents_open_native_idx"],
        [nodeQuery, "orchestration_v2_projection_nodes_open_runless_root_idx"],
      ] as const) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
        assert.isTrue(plan.some((row) => row.detail.includes(`USING INDEX ${index}`)));
      }
    }),
  );
});
