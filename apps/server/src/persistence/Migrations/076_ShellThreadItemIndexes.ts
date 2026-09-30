import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Live shell streams rebuild one thread's shell for every coalesced event
  // window. Its pending-background and pull-request lookups filtered every
  // item of the thread by type; these partial indexes hold only the few
  // matching rows. Their WHERE clauses must stay textually identical to the
  // shell queries in ProjectionStore or SQLite will not use them.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_pending_background_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_pull_request_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)
    WHERE type = 'source_control'
      AND json_extract(payload_json, '$.pullRequest') IS NOT NULL
  `;
});
