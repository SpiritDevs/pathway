import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_allowance_hold
    ON orchestration_v2_projection_runs(thread_id, ordinal)
    WHERE json_extract(payload_json, '$.allowanceHold') IS NOT NULL
      AND json_extract(payload_json, '$.allowanceHold') != ''`;
});
