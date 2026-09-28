import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN clerk_subject TEXT`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN clerk_subject TEXT`;
});
