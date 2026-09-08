import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_threads_projectless (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL,
      provider_instance_id TEXT
    )
  `;
  yield* sql`INSERT INTO orchestration_v2_projection_threads_projectless SELECT * FROM orchestration_v2_projection_threads`;
  yield* sql`DROP TABLE orchestration_v2_projection_threads`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads_projectless RENAME TO orchestration_v2_projection_threads`;
  yield* sql`CREATE INDEX orchestration_v2_projection_threads_project_updated_idx ON orchestration_v2_projection_threads(project_id, updated_at)`;
});
