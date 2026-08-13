import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Distinguish pre-completion review from implementation work in every workflow consumer. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE issue_statuses
    SET category = 'review'
    WHERE id = 'in-review' AND category = 'started'
  `;
});
