import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "initiating_environment_id")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN initiating_environment_id TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "initiating_environment_id")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN initiating_environment_id TEXT
    `;
  }
});
