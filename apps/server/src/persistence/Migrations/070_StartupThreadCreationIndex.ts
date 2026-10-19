import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Startup verification needs thread identities without reading the full event history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep the equality columns in the key so SQLite selects this covering index
  // over the general stream index even before ANALYZE has collected statistics.
  yield* sql`
    CREATE INDEX idx_orch_events_v2_thread_created
    ON orchestration_events(application_event_version, aggregate_kind, event_type, stream_id)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'thread.created'
  `;
});
