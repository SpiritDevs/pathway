import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_IssueAutomation", (it) => {
  it.effect("adds routing fields and durable audit claims without losing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO issues (
          id, key, title, description, status_id, priority, sort_order, triage,
          created_at, updated_at
        ) VALUES (
          'issue-1', 'ISS-1', 'Existing issue', '', 'todo', 'none', 'a0', 0,
          '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;
      yield* sql`
        INSERT INTO slack_channel_watches (
          id, channel_id, channel_name, created_at, updated_at
        ) VALUES (
          'watch-1', 'C1', 'triage', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const issueColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(issues)`;
      assert.isTrue(issueColumns.some((column) => column.name === "work_model_selection_json"));
      assert.isTrue(issueColumns.some((column) => column.name === "automation_assignment_json"));

      const watches = yield* sql<{ readonly auto_assign: number }>`
        SELECT auto_assign FROM slack_channel_watches WHERE id = 'watch-1'
      `;
      assert.deepStrictEqual(watches, [{ auto_assign: 0 }]);

      yield* sql`
        INSERT INTO issue_automation_audits (
          id, issue_id, trigger_key, rule_id, auditor_index, model_selection_json, state,
          remediation_cycle, created_at
        ) VALUES (
          'audit-1', 'issue-1', 'review-1', 'implementation', 0,
          '{"instanceId":"codex","model":"gpt"}', 'running', 0, '2026-08-13T00:00:00Z'
        )
      `;
      const duplicate = yield* Effect.result(
        sql`
          INSERT INTO issue_automation_audits (
            id, issue_id, trigger_key, rule_id, auditor_index, model_selection_json, state,
            remediation_cycle, created_at
          ) VALUES (
            'audit-2', 'issue-1', 'review-1', 'implementation', 0,
            '{"instanceId":"codex","model":"gpt"}', 'running', 0,
            '2026-08-13T00:00:01Z'
          )
        `,
      );
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );
});
