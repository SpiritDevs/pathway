import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_IssueReviewStatusCategory", (it) => {
  it.effect(
    "recategorizes the default review status without changing custom started statuses",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 59 });
        yield* sql`
        INSERT INTO issue_statuses (
          id, name, color, category, position, created_at, updated_at
        ) VALUES (
          'custom-check', 'Check', '#abcdef', 'started', 4.5,
          '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 60 });

        const rows = yield* sql<{ readonly id: string; readonly category: string }>`
        SELECT id, category FROM issue_statuses
        WHERE id IN ('in-review', 'custom-check')
        ORDER BY id
      `;
        assert.deepStrictEqual(rows, [
          { id: "custom-check", category: "started" },
          { id: "in-review", category: "review" },
        ]);
      }),
  );
});
