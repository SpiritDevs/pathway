import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("080_ScheduledTaskWebhooks", (it) => {
  it.effect("keeps existing scheduled tasks and adds webhook storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "existing",
        title: "task",
        prompt: "Run",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      yield* runMigrations({ toMigrationInclusive: 80 });

      const rows = yield* sql<{
        task_id: string;
        webhook_token: string | null;
        webhook_secret: string | null;
      }>`SELECT task_id, webhook_token, webhook_secret FROM scheduled_tasks`;
      assert.deepEqual(rows, [{ task_id: "existing", webhook_token: null, webhook_secret: null }]);
      const deliveries = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_task_webhook_deliveries`;
      assert.equal(deliveries[0]?.count, 0);
    }),
  );
});
