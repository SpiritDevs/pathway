import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("079_ApplicationSequenceIndex", (it) => {
  it.effect("indexes project and V2 thread high-water marks without including legacy threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      const append = (aggregateKind: string, version: number, streamId: string) =>
        sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: streamId,
          aggregate_kind: aggregateKind,
          stream_id: streamId,
          stream_version: 1,
          event_type: "test",
          application_event_version: version,
          occurred_at: "2026-10-07T00:00:00.000Z",
          actor_kind: "server",
          payload_json: "{}",
          metadata_json: "{}",
        })}`;
      const readSequence = (indexed: boolean) =>
        sql.unsafe<{ readonly sequence: number | null }>(`
          SELECT MAX(sequence) AS sequence
          FROM orchestration_events ${indexed ? "INDEXED BY idx_orch_events_application_high_water" : ""}
          WHERE aggregate_kind = 'project'
            OR (application_event_version = 2 AND aggregate_kind = 'thread')
        `);

      assert.deepEqual(yield* readSequence(false), [{ sequence: null }]);
      yield* append("project", 1, "project");
      yield* append("thread", 2, "agent");
      const before = yield* readSequence(false);
      yield* append("thread", 1, "legacy");
      yield* append("other", 2, "other");
      assert.deepEqual(yield* readSequence(false), before);
      assert.deepEqual(yield* runMigrations(), [[79, "ApplicationSequenceIndex"]]);
      assert.deepEqual(yield* readSequence(true), before);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events INDEXED BY idx_orch_events_application_high_water
        WHERE aggregate_kind = 'project'
          OR (application_event_version = 2 AND aggregate_kind = 'thread')
      `;
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes("USING INDEX idx_orch_events_application_high_water"),
        ),
      );
      assert.isFalse(plan.some((row) => row.detail.includes("MULTI-INDEX OR")));

      yield* append("project", 2, "new-project");
      const latest = yield* sql<{
        readonly sequence: number;
      }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
      assert.deepEqual(yield* readSequence(true), latest);
      yield* append("thread", 1, "new-legacy");
      assert.deepEqual(yield* readSequence(true), latest);
      yield* sql`DELETE FROM orchestration_events`;
      assert.deepEqual(yield* readSequence(true), [{ sequence: null }]);
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
