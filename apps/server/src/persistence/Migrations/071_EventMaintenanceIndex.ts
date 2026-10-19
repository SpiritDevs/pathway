import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Compaction groups full-state events by stream. Cover its filtering and
  // ordering so an unchanged database does not reread historical payloads.
  yield* sql`
    CREATE INDEX idx_orch_events_thread_maintenance
    ON orchestration_events(aggregate_kind, application_event_version, stream_id, event_type, sequence)
  `;
  yield* sql`
    CREATE INDEX idx_orch_events_entity_maintenance
    ON orchestration_events(application_event_version, event_type, stream_id, json_extract(payload_json, '$.id'), sequence)
  `;
});
