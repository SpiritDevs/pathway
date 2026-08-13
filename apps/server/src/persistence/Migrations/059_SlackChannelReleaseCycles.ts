import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A watched Slack channel can place every filed issue into one release cycle. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_channel_watches)
  `;
  if (!columns.some((column) => column.name === "cycle_id")) {
    yield* sql`ALTER TABLE slack_channel_watches ADD COLUMN cycle_id TEXT`;
  }
});
