import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rootless projects: a project can be created from a name alone and have a
 * directory attached later, so `workspace_root` stops being NOT NULL.
 *
 * SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt.
 * Nothing references `projection_projects` by foreign key, which is what makes
 * the drop-and-rename safe; the two indexes on it die with the old table and
 * are recreated below.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
    PRAGMA table_info(projection_projects)
  `;
  const workspaceRoot = columns.find((column) => column.name === "workspace_root");

  if (workspaceRoot === undefined || workspaceRoot.notnull === 0) {
    return;
  }

  yield* sql`
    CREATE TABLE projection_projects_rootless (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT,
      default_model_selection_json TEXT,
      default_thread_env_mode TEXT,
      favicon_path TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_projects_rootless (
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      default_thread_env_mode,
      favicon_path,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    )
    SELECT
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      default_thread_env_mode,
      favicon_path,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    FROM projection_projects
  `;

  yield* sql`DROP TABLE projection_projects`;

  yield* sql`ALTER TABLE projection_projects_rootless RENAME TO projection_projects`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_workspace_root_deleted_at
    ON projection_projects(workspace_root, deleted_at)
  `;
});
