import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Startup recovery finds provider-native subagents still open after their
  // provider process died. Only those rows enter the index, so the lookup stays
  // cheap however many finished subagents a database holds.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_open_native_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE origin = 'provider_native' AND status IN ('pending', 'running', 'waiting')
  `;
  // A provider-native subagent's own thread works through a runless root turn.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_open_runless_root_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE run_id IS NULL AND kind = 'root_turn' AND status IN ('pending', 'running', 'waiting')
  `;
});
