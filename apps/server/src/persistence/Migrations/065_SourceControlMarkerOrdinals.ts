import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Turn-item ordinals are banded per run: run N owns [N * RUN_BAND_SIZE, ...]. */
const RUN_BAND_SIZE = 1_000_000;

/**
 * Source-control markers used to be stored in the run-less prefix even when a
 * run had already produced them. Associate each affected marker with the most
 * recent run that existed when it was recorded, preserving markers that truly
 * predate the thread's first run.
 *
 * Event payloads are repaired alongside the projection so a later projection
 * rebuild retains the corrected run and ordinal.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const misfiled = yield* sql<{
    readonly thread_id: string;
    readonly turn_item_id: string;
    readonly updated_at: string;
  }>`
    SELECT thread_id, turn_item_id, updated_at
    FROM orchestration_v2_projection_turn_items
    WHERE type = 'source_control'
      AND run_id IS NULL
      AND ordinal < ${RUN_BAND_SIZE}
    ORDER BY thread_id ASC, updated_at ASC, ordinal ASC, turn_item_id ASC
  `;

  for (const marker of misfiled) {
    const runs = yield* sql<{ readonly run_id: string; readonly ordinal: number }>`
      SELECT run_id, ordinal
      FROM orchestration_v2_projection_runs
      WHERE thread_id = ${marker.thread_id}
        AND requested_at <= ${marker.updated_at}
      ORDER BY ordinal DESC, run_id DESC
      LIMIT 1
    `;
    const run = runs[0];
    if (run === undefined) continue;

    const lowerBound = run.ordinal * RUN_BAND_SIZE;
    const upperBound = lowerBound + RUN_BAND_SIZE - 1;
    const maxRows = yield* sql<{ readonly max_ordinal: number | null }>`
      SELECT MAX(ordinal) AS max_ordinal
      FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${marker.thread_id}
        AND ordinal >= ${lowerBound}
        AND ordinal <= ${upperBound}
    `;
    const ordinal = (maxRows[0]?.max_ordinal ?? lowerBound) + 1;

    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET run_id = ${run.run_id},
          ordinal = ${ordinal},
          payload_json = json_set(
            payload_json,
            '$.runId', ${run.run_id},
            '$.ordinal', ${ordinal}
          )
      WHERE turn_item_id = ${marker.turn_item_id}
    `;
    yield* sql`
      UPDATE orchestration_v2_turn_item_positions
      SET ordinal = ${ordinal}
      WHERE thread_id = ${marker.thread_id} AND turn_item_id = ${marker.turn_item_id}
    `;
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        '$.runId', ${run.run_id},
        '$.ordinal', ${ordinal}
      )
      WHERE event_type = 'turn-item.updated'
        AND json_extract(payload_json, '$.id') = ${marker.turn_item_id}
    `;
  }
});
