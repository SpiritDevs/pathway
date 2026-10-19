import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("preserves project threads and permits projectless threads", () => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 67 });
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json, provider_instance_id)
    VALUES ('existing', 'project-1', 'Existing', 'codex', 'full-access', 'default', '2026-09-08', '2026-09-08', '{}', 'codex-personal')`;
  yield* runMigrations({ toMigrationInclusive: 68 });
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json, provider_instance_id)
    VALUES ('conversation', NULL, 'Conversation', 'codex', 'full-access', 'default', '2026-09-08', '2026-09-08', '{}', 'codex-personal')`;
  const rows = yield* sql<{ thread_id: string; project_id: string | null; provider_instance_id: string }>`SELECT thread_id, project_id, provider_instance_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
  assert.deepStrictEqual(rows, [
    { thread_id: 'conversation', project_id: null, provider_instance_id: 'codex-personal' },
    { thread_id: 'existing', project_id: 'project-1', provider_instance_id: 'codex-personal' },
  ]);
  const indexes = yield* sql<{ name: string }>`PRAGMA index_list(orchestration_v2_projection_threads)`;
  assert.ok(indexes.some(index => index.name === 'orchestration_v2_projection_threads_project_updated_idx'));
}).pipe(Effect.provide(NodeSqliteClient.layerMemory())));
