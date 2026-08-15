import { assert, it } from "@effect/vitest";
import { SlackReactionRoute } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const decodeRoutes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(SlackReactionRoute)),
);

layer("056_IssueTrackerSlackReactionRouting", (it) => {
  it.effect("preserves the old reaction as an inheriting route", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO slack_channel_watches (
          id, channel_id, channel_name, project_id, trigger_emoji, created_at, updated_at
        )
        VALUES (
          'watch-1', 'C1', 'triage', 'project-1', 'ticket',
          '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const rows = yield* sql<{
        readonly trigger_reaction_routes: string;
        readonly auto_investigate: number;
      }>`
        SELECT trigger_reaction_routes, auto_investigate
        FROM slack_channel_watches
        WHERE id = 'watch-1'
      `;
      assert.deepStrictEqual(decodeRoutes(rows[0]?.trigger_reaction_routes ?? "[]"), [
        { emoji: "ticket", projectId: null, autoInvestigate: null },
      ]);
      assert.strictEqual(rows[0]?.auto_investigate, 0);
    }),
  );

  it.effect("leaves a watch without an old reaction paused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO slack_channel_watches (id, channel_id, channel_name, created_at, updated_at)
        VALUES ('watch-2', 'C2', 'support', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const rows = yield* sql<{ readonly trigger_reaction_routes: string }>`
        SELECT trigger_reaction_routes FROM slack_channel_watches WHERE id = 'watch-2'
      `;
      assert.deepStrictEqual(decodeRoutes(rows[0]?.trigger_reaction_routes ?? "[]"), []);
    }),
  );
});
