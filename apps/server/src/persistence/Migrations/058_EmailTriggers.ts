import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE email_trigger_rules (
      rule_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      sender TEXT,
      subject TEXT,
      recipient TEXT,
      prompt_template TEXT NOT NULL,
      max_triggers_per_hour INTEGER NOT NULL,
      rate_limit_window_started_at TEXT,
      triggers_in_current_window INTEGER NOT NULL DEFAULT 0,
      auto_disabled_at TEXT,
      auto_disabled_reason TEXT
    ) STRICT
  `;

  yield* sql`
    CREATE INDEX email_trigger_rules_project_idx
    ON email_trigger_rules(project_id, name, rule_id)
  `;

  yield* sql`
    CREATE TABLE email_trigger_firings (
      firing_id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES email_trigger_rules(rule_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      fired_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      loop_message_id TEXT,
      UNIQUE(rule_id, message_id)
    ) STRICT
  `;

  yield* sql`
    CREATE INDEX email_trigger_firings_project_idx
    ON email_trigger_firings(project_id, fired_ms DESC, firing_id DESC)
  `;

  yield* sql`
    CREATE INDEX email_trigger_firings_thread_idx
    ON email_trigger_firings(rule_id, thread_id, fired_ms DESC)
  `;

  yield* sql`
    CREATE TABLE email_trigger_processed_messages (
      rule_id TEXT NOT NULL REFERENCES email_trigger_rules(rule_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      processed_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY(rule_id, message_id)
    ) STRICT
  `;
});
