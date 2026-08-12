import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stage 5 of the tracker (decision 0006): Slack intake.
 *
 * Four tables and four columns, and three of the four tables exist only because the transport is
 * polling. This server sleeps, so intake reads `conversations.history` from a stored cursor rather
 * than listening on a socket — which means the database, not a process, has to remember where the
 * reader got to, what it has already turned into issues, and which messages the bot wrote itself.
 *
 * No foreign keys, matching 041 through 045: the service owns referential integrity, and a channel
 * whose watch was deleted still has a cursor worth keeping in case it is watched again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `channel_id` is unique rather than the primary key: the watch is an entity a client edits by
  // id, but two watches on one channel would poll it twice and file everything twice.
  //
  // The trigger is three columns rather than one JSON blob because all three are switches and the
  // poller reads them on every pass. All three off is a paused channel, not an invalid row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_channel_watches (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      channel_name TEXT NOT NULL,
      project_id TEXT,
      trigger_emoji TEXT,
      trigger_every_message INTEGER NOT NULL DEFAULT 0,
      trigger_bot_mention INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Where the reader got to, per channel. `last_ts` is the newest message it has seen;
  // `reaction_scan_ts` is separate because a reaction arrives *after* the message it decorates —
  // a trigger emoji added today to a message from last week must still file, so the reaction pass
  // trails the history pass and keeps its own mark.
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_cursors (
      channel_id TEXT PRIMARY KEY,
      last_ts TEXT,
      reaction_scan_ts TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  // The entire echo-suppression story. The bot posts into the source thread on comments and
  // status changes; without this the very next poll would read its own post back and file it, or
  // comment it onto the issue it came from, forever.
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_outbound_posts (
      channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, message_ts)
    )
  `;

  // Dedupe and routing at once. A poll that overlaps the last one — a cursor is a floor, not a
  // fence — must not file the same message twice, and a thread reply has to find the issue its
  // parent message became. `issue_id` is nullable: a message can be seen and deliberately not
  // filed, and remembering that is what stops it from being reconsidered on every pass.
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_processed_messages (
      channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      issue_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, message_ts)
    )
  `;

  // Read from the issue's side when the bot has to answer into the thread an issue came from.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_slack_processed_messages_issue
    ON slack_processed_messages(issue_id)
  `;

  // The source, carried on the issue row rather than in a side table: the list draws a Slack
  // marker on a triage item, and a join would make the tracker's first read two reads.
  const issueColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issues)
  `;

  if (!issueColumns.some((column) => column.name === "slack_channel_id")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN slack_channel_id TEXT
    `;
  }

  if (!issueColumns.some((column) => column.name === "slack_message_ts")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN slack_message_ts TEXT
    `;
  }

  if (!issueColumns.some((column) => column.name === "slack_permalink")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN slack_permalink TEXT
    `;
  }

  if (!issueColumns.some((column) => column.name === "slack_author_name")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN slack_author_name TEXT
    `;
  }
});
