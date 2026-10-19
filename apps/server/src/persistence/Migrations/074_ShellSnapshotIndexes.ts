import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Turn item rows carry multi-kilobyte payloads, so reading run_id, type, or
  // status from the table touches roughly one page per item. The shell
  // snapshot counts and filters every item on each load; cover those reads so
  // it stays on small index pages instead of rereading the whole table.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_run_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_type_status_idx
    ON orchestration_v2_projection_turn_items(type, status, thread_id, run_id)
  `;
  // The shell reads each thread's most recently updated message.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_messages_thread_updated_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at, message_id)
  `;
});
