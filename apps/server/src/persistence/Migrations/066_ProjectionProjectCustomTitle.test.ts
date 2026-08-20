import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("066_ProjectionProjectCustomTitle", (it) => {
  it.effect("adds a false-by-default custom-title marker to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations({ toMigrationInclusive: 66 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_projects)`;
      const titleIsCustom = columns.find((column) => column.name === "title_is_custom");

      assert.equal(titleIsCustom?.name, "title_is_custom");
      assert.equal(titleIsCustom?.notnull, 1);
      assert.equal(titleIsCustom?.dflt_value, "0");
    }),
  );
});
