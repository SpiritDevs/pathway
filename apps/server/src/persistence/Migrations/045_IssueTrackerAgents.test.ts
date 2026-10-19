import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_IssueTrackerAgents", (it) => {
  it.effect("creates the enrichment run table with its two reads indexed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`
        PRAGMA table_info(issue_enrichment_runs)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));
      assert.strictEqual(byName.get("id")?.pk, 1);
      for (const required of ["issue_id", "state", "model_selection_json", "created_at"]) {
        assert.strictEqual(byName.get(required)?.notnull, 1, required);
      }
      // A queued run has no result, no error, and no timestamps but its own.
      for (const optional of ["result_json", "error", "started_at", "finished_at"]) {
        assert.strictEqual(byName.get(optional)?.notnull, 0, optional);
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_enrichment_runs)
      `;
      const names = indexes.map((index) => index.name);
      assert.include(names, "idx_issue_enrichment_runs_issue");
      assert.include(names, "idx_issue_enrichment_runs_state");
    }),
  );

  it.effect("defaults a transcript to empty, so an appended chunk is never appended to null", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* sql`
        INSERT INTO issue_enrichment_runs (id, issue_id, state, model_selection_json, created_at)
        VALUES ('run-1', 'issue-1', 'queued', '{}', '2026-08-12T00:00:00Z')
      `;
      yield* sql`
        UPDATE issue_enrichment_runs
        SET transcript = transcript || 'reading files'
        WHERE id = 'run-1'
      `;

      const rows = yield* sql<{ readonly transcript: string }>`
        SELECT transcript FROM issue_enrichment_runs WHERE id = 'run-1'
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.transcript),
        ["reading files"],
      );
    }),
  );

  it.effect("keys a thread link by the pair, so relinking restates rather than duplicates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* sql`
        INSERT INTO issue_thread_links (issue_id, thread_id, origin, created_at)
        VALUES ('issue-1', 'thread-1', 'start-work', '2026-08-12T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO issue_thread_links (issue_id, thread_id, origin, created_at)
        VALUES ('issue-1', 'thread-1', 'manual', '2026-08-12T01:00:00Z')
        ON CONFLICT (issue_id, thread_id)
        DO UPDATE SET origin = excluded.origin
      `;
      // The same thread on a different issue is a different fact, and both survive.
      yield* sql`
        INSERT INTO issue_thread_links (issue_id, thread_id, origin, created_at)
        VALUES ('issue-2', 'thread-1', 'manual', '2026-08-12T02:00:00Z')
      `;

      const rows = yield* sql<{ readonly issue_id: string; readonly origin: string }>`
        SELECT issue_id, origin FROM issue_thread_links ORDER BY issue_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.issue_id, row.origin]),
        [
          ["issue-1", "manual"],
          ["issue-2", "manual"],
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(issue_thread_links)
      `;
      assert.include(
        indexes.map((index) => index.name),
        "idx_issue_thread_links_thread",
      );
    }),
  );
});
