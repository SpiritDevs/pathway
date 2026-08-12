import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0041 from "./041_IssueTracker.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_IssueTracker", (it) => {
  it.effect("creates the tracker tables and their indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tableNames = tables.map((table) => table.name);
      for (const expected of [
        "issue_statuses",
        "issue_labels",
        "issues",
        "issue_label_assignments",
        "issue_events",
        "issue_tracker_config",
      ]) {
        assert.include(tableNames, expected);
      }

      const issueIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issues)
      `;
      const issueIndexNames = issueIndexes.map((index) => index.name);
      assert.include(issueIndexNames, "idx_issues_live_status");
      assert.include(issueIndexNames, "idx_issues_triage");
      assert.include(issueIndexNames, "idx_issues_project");

      const eventIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_events)
      `;
      assert.include(
        eventIndexes.map((index) => index.name),
        "idx_issue_events_issue",
      );

      const keyIndexes = yield* sql<{ readonly name: string; readonly unique: number }>`
        PRAGMA index_list(issues)
      `;
      assert.isTrue(keyIndexes.some((index) => index.unique === 1));
    }),
  );

  it.effect("seeds the default statuses and the key counter", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const statuses = yield* sql<{
        readonly id: string;
        readonly name: string;
        readonly color: string;
        readonly category: string;
        readonly position: number;
      }>`
        SELECT id, name, color, category, position
        FROM issue_statuses
        ORDER BY position ASC
      `;

      assert.deepStrictEqual(
        statuses.map((status) => [status.id, status.name, status.category, status.color]),
        [
          ["backlog", "Backlog", "backlog", "#95a2b3"],
          ["todo", "Todo", "unstarted", "#e2e2e2"],
          ["in-progress", "In Progress", "started", "#f2c94c"],
          ["in-review", "In Review", "started", "#26b5ce"],
          ["done", "Done", "completed", "#5e6ad2"],
          ["canceled", "Canceled", "canceled", "#95a2b3"],
        ],
      );
      assert.deepStrictEqual(
        statuses.map((status) => status.position),
        [1, 2, 3, 4, 5, 6],
      );

      const config = yield* sql<{
        readonly key_prefix: string;
        readonly next_number: number;
      }>`
        SELECT key_prefix, next_number FROM issue_tracker_config
      `;
      assert.deepStrictEqual(config, [{ key_prefix: "ISS", next_number: 1 }]);
    }),
  );

  it.effect("re-running the migration neither duplicates nor resets the seed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });

      yield* sql`UPDATE issue_tracker_config SET next_number = 42 WHERE id = 1`;
      yield* sql`DELETE FROM issue_statuses WHERE id = 'canceled'`;

      yield* Migration0041;

      const statusCounts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM issue_statuses
      `;
      // Statuses are seeded only into an empty table, so a deliberately removed one stays removed.
      assert.strictEqual(statusCounts[0]?.count, 5);

      const config = yield* sql<{ readonly next_number: number }>`
        SELECT next_number FROM issue_tracker_config
      `;
      assert.deepStrictEqual(config, [{ next_number: 42 }]);
    }),
  );
});
