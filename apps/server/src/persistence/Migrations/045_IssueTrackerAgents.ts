import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stage 4 of the tracker (decision 0006): what agents leave behind.
 *
 * Two tables, both hanging off `issues` with no foreign keys, matching 041 and 042: the service
 * owns referential integrity because a soft-deleted issue still has to keep its history.
 *
 * An enrichment run is deliberately *not* a thread. It has no turns, no session, and must never
 * appear in the threads view, so it gets a table of its own rather than a `hidden` flag on
 * `projection_threads` that every reader would have to remember.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `transcript` is the streamed process output, appended in place and read whole by the panel.
  // `result_json` is the structured answer, written once when the run lands in `done`; the model
  // that produced it is pinned at creation so a later settings change cannot relabel history.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_enrichment_runs (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      state TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      transcript TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    )
  `;

  // The panel reads one issue's runs newest first, and that is the only read with a filter. Ties
  // inside a millisecond fall back to insertion order, which is `rowid` and needs no column.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_enrichment_runs_issue
    ON issue_enrichment_runs(issue_id, created_at DESC)
  `;

  // A run is a live process, so nothing survives a restart of this server: startup sweeps every
  // unfinished row into `failed`, and this is the index that sweep reads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_enrichment_runs_state
    ON issue_enrichment_runs(state)
  `;

  // One row per pair rather than a surrogate id: linking the same thread twice is the same fact
  // stated again, so the primary key is the fact itself and a relink restates the origin.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_thread_links (
      issue_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, thread_id)
    )
  `;

  // Read from the thread's side too: a thread view wants the issue it is working, and the
  // primary key is no help in that direction.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_thread_links_thread
    ON issue_thread_links(thread_id)
  `;
});
