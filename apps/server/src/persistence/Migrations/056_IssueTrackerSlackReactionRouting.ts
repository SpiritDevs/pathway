import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Multiple reaction routes and the channel-level investigation default for Slack intake. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_channel_watches)
  `;

  if (!columns.some((column) => column.name === "trigger_reaction_routes")) {
    yield* sql`
      ALTER TABLE slack_channel_watches
      ADD COLUMN trigger_reaction_routes TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!columns.some((column) => column.name === "auto_investigate")) {
    yield* sql`
      ALTER TABLE slack_channel_watches
      ADD COLUMN auto_investigate INTEGER NOT NULL DEFAULT 0
    `;
  }

  // Preserve the one reaction older versions supported as the first inheriting route. The old
  // column stays in place so migration 046 remains a faithful description of released databases.
  yield* sql`
    UPDATE slack_channel_watches
    SET trigger_reaction_routes = json_array(
      json_object(
        'emoji', trigger_emoji,
        'projectId', NULL,
        'autoInvestigate', NULL
      )
    )
    WHERE trigger_emoji IS NOT NULL
      AND trigger_reaction_routes = '[]'
  `;
});
