import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_time_tracking_cursors (
    company_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_time_tracking_sessions (
    company_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, run_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_time_tracking_pending
    ON agent_time_tracking_sessions(company_id, next_attempt_at, last_attempt_at, run_id)
    WHERE dirty = 1 OR state = 'running'`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_time_tracking_thread
    ON agent_time_tracking_sessions(company_id, thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_time_tracking_running
    ON agent_time_tracking_sessions(company_id) WHERE state = 'running'`;
});
