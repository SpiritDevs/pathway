import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_IssueTrackerViews", (it) => {
  it.effect("creates the views table and its ordering index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      assert.include(
        tables.map((table) => table.name),
        "issue_views",
      );

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`
        PRAGMA table_info(issue_views)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));
      assert.strictEqual(byName.get("id")?.pk, 1);
      // Every other column is required: a view with no configuration is not a view.
      for (const expected of ["name", "position", "config_json", "created_at", "updated_at"]) {
        assert.strictEqual(byName.get(expected)?.notnull, 1, expected);
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_views)
      `;
      assert.include(
        indexes.map((index) => index.name),
        "idx_issue_views_position",
      );
    }),
  );

  it.effect("keeps ids unique so a rewritten view replaces rather than duplicates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        INSERT INTO issue_views (id, name, position, config_json, created_at, updated_at)
        VALUES ('view-1', 'Mine', 1, '{}', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
      `;
      yield* sql`
        INSERT OR IGNORE INTO issue_views (id, name, position, config_json, created_at, updated_at)
        VALUES ('view-1', 'Theirs', 2, '{}', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
      `;

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM issue_views
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.name),
        ["Mine"],
      );
    }),
  );
});
