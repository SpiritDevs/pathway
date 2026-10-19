import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_IssueTrackerSlack", (it) => {
  it.effect("keys a watch by id but holds one watch per channel", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO slack_channel_watches (
          id, channel_id, channel_name, trigger_emoji, created_at, updated_at
        )
        VALUES ('watch-1', 'C1', 'triage', 'ticket', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
      `;

      // Two watches on one channel would poll it twice and file everything twice.
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO slack_channel_watches (
          id, channel_id, channel_name, created_at, updated_at
        )
        VALUES ('watch-2', 'C1', 'triage', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
      `);
      assert.isTrue(duplicate._tag === "Failure");

      // All three switches default off: a channel created without a trigger is paused, not broken.
      const rows = yield* sql<{
        readonly trigger_every_message: number;
        readonly trigger_bot_mention: number;
        readonly project_id: string | null;
      }>`
        SELECT trigger_every_message, trigger_bot_mention, project_id
        FROM slack_channel_watches
        WHERE id = 'watch-1'
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.trigger_every_message, row.trigger_bot_mention, row.project_id]),
        [[0, 0, null]],
      );
    }),
  );

  it.effect("gives a cursor two marks, because a reaction trails the message it decorates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO slack_cursors (channel_id, last_ts, updated_at)
        VALUES ('C1', '1723459200.000100', '2026-08-12T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO slack_cursors (channel_id, last_ts, reaction_scan_ts, updated_at)
        VALUES ('C1', '1723459300.000100', '1723458000.000100', '2026-08-12T00:01:00Z')
        ON CONFLICT (channel_id)
        DO UPDATE SET
          last_ts = excluded.last_ts,
          reaction_scan_ts = excluded.reaction_scan_ts,
          updated_at = excluded.updated_at
      `;

      const rows = yield* sql<{
        readonly last_ts: string | null;
        readonly reaction_scan_ts: string | null;
      }>`
        SELECT last_ts, reaction_scan_ts FROM slack_cursors WHERE channel_id = 'C1'
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.last_ts, row.reaction_scan_ts]),
        [["1723459300.000100", "1723458000.000100"]],
      );
    }),
  );

  it.effect("keys the echo registry and the dedupe table by channel and ts together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO slack_outbound_posts (channel_id, message_ts, created_at)
        VALUES ('C1', '1723459200.000100', '2026-08-12T00:00:00Z')
      `;
      // The same ts in another channel is another message: Slack's ts is only unique per channel.
      yield* sql`
        INSERT INTO slack_outbound_posts (channel_id, message_ts, created_at)
        VALUES ('C2', '1723459200.000100', '2026-08-12T00:00:00Z')
      `;
      const outbound = yield* sql<{ readonly channel_id: string }>`
        SELECT channel_id FROM slack_outbound_posts ORDER BY channel_id
      `;
      assert.deepStrictEqual(
        outbound.map((row) => row.channel_id),
        ["C1", "C2"],
      );

      // A message can be seen and deliberately not filed, so `issue_id` is nullable.
      yield* sql`
        INSERT INTO slack_processed_messages (channel_id, message_ts, issue_id, created_at)
        VALUES ('C1', '1723459200.000100', NULL, '2026-08-12T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO slack_processed_messages (channel_id, message_ts, issue_id, created_at)
        VALUES ('C1', '1723459200.000100', 'issue-1', '2026-08-12T00:00:01Z')
        ON CONFLICT (channel_id, message_ts)
        DO UPDATE SET issue_id = excluded.issue_id
      `;
      const processed = yield* sql<{ readonly issue_id: string | null }>`
        SELECT issue_id FROM slack_processed_messages WHERE channel_id = 'C1'
      `;
      assert.deepStrictEqual(
        processed.map((row) => row.issue_id),
        ["issue-1"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(slack_processed_messages)
      `;
      assert.include(
        indexes.map((index) => index.name),
        "idx_slack_processed_messages_issue",
      );
    }),
  );

  it.effect("hangs the source off the issue row, all four columns optional", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(issues)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));
      for (const added of [
        "slack_channel_id",
        "slack_message_ts",
        "slack_permalink",
        "slack_author_name",
      ]) {
        assert.strictEqual(byName.get(added)?.notnull, 0, added);
      }
    }),
  );
});
