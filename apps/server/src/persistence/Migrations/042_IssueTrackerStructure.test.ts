import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_IssueTrackerStructure", (it) => {
  it.effect("creates the structure tables and their indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tableNames = tables.map((table) => table.name);
      for (const expected of [
        "issue_milestones",
        "issue_cycles",
        "issue_todos",
        "issue_relations",
        "issue_comments",
      ]) {
        assert.include(tableNames, expected);
      }

      const relationIndexes = yield* sql<{ readonly name: string; readonly unique: number }>`
        PRAGMA index_list(issue_relations)
      `;
      // One row per pair, so the triple is the key: a repeat of the same statement cannot land.
      assert.isTrue(relationIndexes.some((index) => index.unique === 1));
      assert.include(
        relationIndexes.map((index) => index.name),
        "idx_issue_relations_related",
      );

      const milestoneIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_milestones)
      `;
      assert.include(
        milestoneIndexes.map((index) => index.name),
        "idx_issue_milestones_project",
      );

      const todoIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_todos)
      `;
      assert.include(
        todoIndexes.map((index) => index.name),
        "idx_issue_todos_issue",
      );

      const commentIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_comments)
      `;
      assert.include(
        commentIndexes.map((index) => index.name),
        "idx_issue_comments_issue",
      );
    }),
  );

  it.effect("adds the milestone and cycle columns to the issues table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(issues)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));
      // Nullable: an issue with no milestone and no cycle is the normal case, not a missing value.
      assert.strictEqual(byName.get("milestone_id")?.notnull, 0);
      assert.strictEqual(byName.get("cycle_id")?.notnull, 0);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issues)
      `;
      const indexNames = indexes.map((index) => index.name);
      assert.include(indexNames, "idx_issues_milestone");
      assert.include(indexNames, "idx_issues_cycle");
    }),
  );

  it.effect("refuses a second copy of the same relation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });

      yield* sql`
        INSERT INTO issue_relations (id, issue_id, related_issue_id, kind)
        VALUES ('relation-1', 'issue-1', 'issue-2', 'blocks')
      `;
      yield* sql`
        INSERT OR IGNORE INTO issue_relations (id, issue_id, related_issue_id, kind)
        VALUES ('relation-2', 'issue-1', 'issue-2', 'blocks')
      `;
      // The inverse is a different triple, and the same pair with another kind is too.
      yield* sql`
        INSERT INTO issue_relations (id, issue_id, related_issue_id, kind)
        VALUES ('relation-3', 'issue-2', 'issue-1', 'blocks')
      `;

      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM issue_relations ORDER BY id ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.id),
        ["relation-1", "relation-3"],
      );
    }),
  );
});
