import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_RestoreIssueStatuses", (it) => {
  it.effect("restores the default workflow when an existing database has no statuses", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`DELETE FROM issue_statuses`;
      yield* runMigrations({ toMigrationInclusive: 55 });

      const statuses = yield* sql<{
        readonly id: string;
        readonly name: string;
        readonly category: string;
        readonly position: number;
      }>`
        SELECT id, name, category, position
        FROM issue_statuses
        ORDER BY position ASC
      `;

      assert.deepStrictEqual(
        statuses.map((status) => [status.id, status.name, status.category, status.position]),
        [
          ["backlog", "Backlog", "backlog", 1],
          ["todo", "Todo", "unstarted", 2],
          ["in-progress", "In Progress", "started", 3],
          ["in-review", "In Review", "started", 4],
          ["done", "Done", "completed", 5],
          ["canceled", "Canceled", "canceled", 6],
        ],
      );
    }),
  );

  it.effect("leaves an existing custom workflow untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`DELETE FROM issue_statuses`;
      yield* sql`
        INSERT INTO issue_statuses (id, name, color, category, position, created_at, updated_at)
        VALUES (
          'custom',
          'Custom',
          '#123456',
          'started',
          1,
          '2026-08-13T00:00:00.000Z',
          '2026-08-13T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const statuses = yield* sql<{ readonly id: string; readonly name: string }>`
        SELECT id, name FROM issue_statuses ORDER BY position ASC
      `;
      assert.deepStrictEqual(statuses, [{ id: "custom", name: "Custom" }]);
    }),
  );
});
