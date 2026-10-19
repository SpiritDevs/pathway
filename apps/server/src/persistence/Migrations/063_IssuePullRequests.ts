import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cache the change request discovered on a linked work thread directly on the issue row. Lists and
 * boards can then draw it without one source-control subprocess per visible card.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE issues ADD COLUMN pull_request_json TEXT`;
});
