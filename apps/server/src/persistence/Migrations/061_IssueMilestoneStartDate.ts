import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A milestone with two ends is a bar on the timeline; every existing one stays a point. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_milestones)
  `;
  if (!columns.some((column) => column.name === "start_date")) {
    yield* sql`ALTER TABLE issue_milestones ADD COLUMN start_date TEXT`;
  }
});
