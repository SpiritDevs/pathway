import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Model routing, configurable workflow movement, and durable multi-model audit bookkeeping. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const issueColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(issues)`;
  if (!issueColumns.some((column) => column.name === "work_model_selection_json")) {
    yield* sql`ALTER TABLE issues ADD COLUMN work_model_selection_json TEXT`;
  }
  if (!issueColumns.some((column) => column.name === "automation_assignment_json")) {
    yield* sql`ALTER TABLE issues ADD COLUMN automation_assignment_json TEXT`;
  }

  const watchColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_channel_watches)
  `;
  if (!watchColumns.some((column) => column.name === "auto_assign")) {
    yield* sql`
      ALTER TABLE slack_channel_watches
      ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0
    `;
  }

  // One row per configured auditor and review transition. The unique key makes replaying the
  // issue stream after a reconnect harmless and gives a restarted coordinator a recovery point.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_automation_audits (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      trigger_key TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      auditor_index INTEGER NOT NULL,
      model_selection_json TEXT NOT NULL,
      state TEXT NOT NULL,
      verdict TEXT,
      summary TEXT,
      findings_json TEXT,
      error TEXT,
      remediation_cycle INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (issue_id, trigger_key, rule_id, auditor_index)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_automation_audits_issue
    ON issue_automation_audits(issue_id, created_at DESC)
  `;
});
