import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_IssuePullRequests", (it) => {
  it.effect("adds nullable PR metadata without disturbing existing issues", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO issues (
          id, key, title, description, status_id, priority, sort_order, created_at, updated_at
        ) VALUES (
          'issue-1', 'ISS-1', 'Already here', '', 'todo', 'none', 'm',
          '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });

      const rows = yield* sql<{
        readonly id: string;
        readonly pull_request_json: string | null;
      }>`SELECT id, pull_request_json FROM issues`;
      assert.deepStrictEqual(rows, [{ id: "issue-1", pull_request_json: null }]);
    }),
  );
});
