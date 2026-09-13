import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("070_StartupThreadCreationIndex", (it) => {
  it.effect("verifies thread identities using a covering index without scanning history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      const events = [
        { stream_id: "b", event_type: "thread.created" },
        { stream_id: "a", event_type: "thread.created" },
        { stream_id: "a", event_type: "thread.created" },
        { stream_id: "a", event_type: "thread.deleted" },
        { stream_id: "legacy", event_type: "thread.created", application_event_version: 1 },
        { stream_id: "project", event_type: "thread.created", aggregate_kind: "project" },
        { stream_id: "updated", event_type: "thread.metadata-updated" },
      ].map((event, index) => ({
        event_id: `startup-index:${index}`,
        aggregate_kind: "thread",
        application_event_version: 2,
        stream_version: index,
        occurred_at: "2026-09-12T00:00:00.000Z",
        actor_kind: "server",
        payload_json: "{}",
        metadata_json: "{}",
        ...event,
      }));
      yield* sql`INSERT INTO orchestration_events ${sql.insert(events)}`;

      const readThreadIds = sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const before = yield* readThreadIds;
      assert.deepStrictEqual(before, [{ thread_id: "a" }, { thread_id: "b" }]);

      yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepStrictEqual(yield* readThreadIds, before);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      assert.ok(
        plan.some((row) =>
          row.detail.includes("USING COVERING INDEX idx_orch_events_v2_thread_created"),
        ),
      );
      assert.isFalse(plan.some((row) => row.detail.includes("USE TEMP B-TREE")));

      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        ...events[0]!,
        event_id: "startup-index:after-migration",
        stream_id: "c",
      })}`;
      assert.deepStrictEqual(yield* readThreadIds, [...before, { thread_id: "c" }]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 70 }), []);
    }),
  );
});
