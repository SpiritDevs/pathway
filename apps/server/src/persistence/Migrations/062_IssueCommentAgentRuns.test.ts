import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_IssueCommentAgentRuns", (it) => {
  it.effect("adds a nullable run column without disturbing existing comments", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO issue_comments (
          id, issue_id, author_json, body, attachment_ids_json, created_at, edited_at
        ) VALUES (
          'comment-1', 'issue-1', '{"kind":"user"}', 'Already said', '[]',
          '2026-08-13T00:00:00Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 62 });

      const rows = yield* sql<{
        readonly id: string;
        readonly agent_run_json: string | null;
      }>`
        SELECT id, agent_run_json FROM issue_comments
      `;
      assert.deepStrictEqual(rows, [{ id: "comment-1", agent_run_json: null }]);
    }),
  );
});
