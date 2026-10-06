import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Match the application event source predicate so its high-water mark can
  // read the last index entry instead of combining project and thread scans.
  yield* sql`
    CREATE INDEX idx_orch_events_application_high_water
    ON orchestration_events(sequence)
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
  `;
});
