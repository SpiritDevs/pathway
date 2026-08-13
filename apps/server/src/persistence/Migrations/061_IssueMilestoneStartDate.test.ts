import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_IssueMilestoneStartDate", (it) => {
  it.effect("adds a nullable start date without disturbing existing milestones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO issue_milestones (
          id, project_id, name, description, target_date, position, created_at, updated_at
        ) VALUES (
          'milestone-1', 'project-1', 'Structure', NULL, '2026-09-01', 1,
          '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 61 });

      const rows = yield* sql<{
        readonly id: string;
        readonly start_date: string | null;
        readonly target_date: string | null;
      }>`
        SELECT id, start_date, target_date FROM issue_milestones
      `;
      assert.deepStrictEqual(rows, [
        { id: "milestone-1", start_date: null, target_date: "2026-09-01" },
      ]);
    }),
  );
});
