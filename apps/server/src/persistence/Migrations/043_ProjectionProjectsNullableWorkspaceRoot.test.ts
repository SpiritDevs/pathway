import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionProjectsNullableWorkspaceRoot", (it) => {
  it.effect("drops NOT NULL from the project workspace root and keeps existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-rooted',
          'Rooted',
          '/tmp/rooted',
          '[]',
          '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const workspaceRoot = columns.find((column) => column.name === "workspace_root");
      assert.equal(workspaceRoot?.notnull, 0);

      const preserved = yield* sql<{ readonly workspaceRoot: string | null }>`
        SELECT workspace_root AS "workspaceRoot"
        FROM projection_projects
        WHERE project_id = 'project-rooted'
      `;
      assert.equal(preserved[0]?.workspaceRoot, "/tmp/rooted");

      // The point of the rebuild: a project can now exist without a directory.
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-rootless',
          'Rootless',
          NULL,
          '[]',
          '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z',
          NULL
        )
      `;

      const rootless = yield* sql<{ readonly workspaceRoot: string | null }>`
        SELECT workspace_root AS "workspaceRoot"
        FROM projection_projects
        WHERE project_id = 'project-rootless'
      `;
      assert.equal(rootless[0]?.workspaceRoot, null);
    }),
  );

  it.effect("recreates the indexes the table rebuild dropped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list('projection_projects')
      `;
      const names = indexes.map((index) => index.name);
      assert.include(names, "idx_projection_projects_updated_at");
      assert.include(names, "idx_projection_projects_workspace_root_deleted_at");
    }),
  );
});
