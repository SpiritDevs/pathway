import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("068_ProjectlessConversations", (it) => {
  it.effect("preserves existing threads while allowing a null project owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json, provider_instance_id) VALUES ('existing', 'project', 'Existing thread', 'codex', 'full-access', 'default', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z', '{"retained":true}', 'codex')`;
      yield* runMigrations({ toMigrationInclusive: 68 });
      const existing = yield* sql<{
        project_id: string;
        payload_json: string;
        provider_instance_id: string;
      }>`SELECT project_id, payload_json, provider_instance_id FROM orchestration_v2_projection_threads WHERE thread_id = 'existing'`;
      assert.deepEqual(existing, [
        { project_id: "project", payload_json: '{"retained":true}', provider_instance_id: "codex" },
      ]);
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json, provider_instance_id) VALUES ('conversation', NULL, 'Conversation', 'codex', 'full-access', 'default', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z', '{}', 'codex')`;
      const rows = yield* sql<{
        project_id: string | null;
      }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = 'conversation'`;
      assert.isNull(rows[0]?.project_id);
      const indexes = yield* sql<{
        name: string;
      }>`PRAGMA index_list(orchestration_v2_projection_threads)`;
      assert.isTrue(
        indexes.some(
          (index) => index.name === "orchestration_v2_projection_threads_project_updated_idx",
        ),
      );
    }),
  );
});
