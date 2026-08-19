import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Turn-item ordinals are banded per run: run N owns [N * RUN_BAND_SIZE, ...]. */
const RUN_BAND_SIZE = 1_000_000;

/**
 * Source-control markers carry no run id, and the position allocator used to
 * confine run-less items to the pre-run band. Every push marker therefore
 * landed on ordinal 1 and rendered above the conversation it belonged to.
 * The allocator now appends run-less items after the rest of the thread; move
 * the markers that were already filed under the old rule to match.
 *
 * The stored event payload is repaired alongside the projection so a later
 * projection rebuild (which replays payload ordinals verbatim) keeps the fix.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const misfiled = yield* sql<{
    readonly thread_id: string;
    readonly turn_item_id: string;
  }>`
    SELECT thread_id, turn_item_id
    FROM orchestration_v2_projection_turn_items
    WHERE type = 'source_control' AND ordinal < ${RUN_BAND_SIZE}
    ORDER BY thread_id ASC, ordinal ASC, turn_item_id ASC
  `;

  for (const row of misfiled) {
    const maxRows = yield* sql<{ readonly max_ordinal: number | null }>`
      SELECT MAX(ordinal) AS max_ordinal
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${row.thread_id}
    `;
    const maxOrdinal = maxRows[0]?.max_ordinal ?? 0;
    // A thread whose items all sit below the first run band never ran, so the
    // marker is already in chronological order.
    if (maxOrdinal < RUN_BAND_SIZE) continue;

    const ordinal = maxOrdinal + 1;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET ordinal = ${ordinal},
          payload_json = json_set(payload_json, '$.ordinal', ${ordinal})
      WHERE turn_item_id = ${row.turn_item_id}
    `;
    yield* sql`
      UPDATE orchestration_v2_turn_item_positions
      SET ordinal = ${ordinal}
      WHERE thread_id = ${row.thread_id} AND turn_item_id = ${row.turn_item_id}
    `;
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.ordinal', ${ordinal})
      WHERE event_type = 'turn-item.updated'
        AND json_extract(payload_json, '$.id') = ${row.turn_item_id}
    `;
  }
});
