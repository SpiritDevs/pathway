import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_SlackChannelReleaseCycles", (it) => {
  it.effect("adds a nullable cycle without losing existing channel watches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO slack_channel_watches (
          id, channel_id, channel_name, created_at, updated_at
        ) VALUES (
          'watch-1', 'C1', 'releases', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      const rows = yield* sql<{ readonly id: string; readonly cycle_id: string | null }>`
        SELECT id, cycle_id FROM slack_channel_watches
      `;
      assert.deepStrictEqual(rows, [{ id: "watch-1", cycle_id: null }]);
    }),
  );
});
