import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records which packaged build last decoded every stored projection, so a
 * restart of the same build can skip the full decode sweep at startup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE orchestration_v2_projection_metadata
    ADD COLUMN decode_verified_build TEXT
  `;
});
