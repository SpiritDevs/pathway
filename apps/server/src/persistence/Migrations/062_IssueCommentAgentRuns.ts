import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A mentioned agent's run rides its origin comment rather than owning a table of its own.
 *
 * One nullable JSON column, so every comment written before this migration decodes unchanged: NULL
 * means "no mention dispatched this comment", which is what almost every comment is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_comments)
  `;
  if (!columns.some((column) => column.name === "agent_run_json")) {
    yield* sql`ALTER TABLE issue_comments ADD COLUMN agent_run_json TEXT`;
  }
});
