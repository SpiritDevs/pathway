import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("071_EventMaintenanceIndex", (it) => {
  it.effect("preserves compaction candidates and covers both scans without reading payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      const events = [
        { stream_id: "a", event_type: "thread.created" },
        { stream_id: "a", event_type: "thread.visited" },
        { stream_id: "a", event_type: "thread.archived" },
        { stream_id: "b", event_type: "thread.visited" },
        { stream_id: "a", event_type: "thread.visited", application_event_version: 1 },
        { stream_id: "a", event_type: "thread.archived", aggregate_kind: "project" },
        { stream_id: "b", event_type: "message.updated" },
        { stream_id: "entity", event_type: "message.updated", payload_json: '{"id":"one"}' },
        { stream_id: "entity", event_type: "message.updated", payload_json: '{"id":"one"}' },
        { stream_id: "entity", event_type: "message.updated", payload_json: '{"id":"two"}' },
      ].map((event, index) => ({
        event_id: `maintenance-index:${index}`,
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
      const types = ["thread.visited", "thread.archived"];
      const candidates = sql`
        SELECT sequence FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND event_type IN ${sql.in(types)}
          AND sequence NOT IN (
            SELECT MAX(sequence) FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
              AND event_type IN ${sql.in(types)}
            GROUP BY stream_id
          )
        ORDER BY sequence
      `;
      const before = yield* candidates;
      const entityCandidates = sql`
        SELECT sequence FROM orchestration_events
        WHERE application_event_version = 2 AND event_type = ${"message.updated"}
          AND sequence NOT IN (
            SELECT MAX(sequence) FROM orchestration_events
            WHERE application_event_version = 2 AND event_type = ${"message.updated"}
            GROUP BY stream_id, json_extract(payload_json, '$.id')
          ) ORDER BY sequence
      `;
      const beforeEntities = yield* entityCandidates;
      assert.lengthOf(beforeEntities, 1);
      assert.lengthOf(before, 1);
      yield* runMigrations({ toMigrationInclusive: 71 });
      assert.deepEqual(yield* candidates, before);
      assert.deepEqual(yield* entityCandidates, beforeEntities);
      const entityPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM orchestration_events
        WHERE application_event_version = 2 AND event_type = ${"message.updated"}
          AND sequence NOT IN (
            SELECT MAX(sequence) FROM orchestration_events
            WHERE application_event_version = 2 AND event_type = ${"message.updated"}
            GROUP BY stream_id, json_extract(payload_json, '$.id')
          )
      `;
      assert.lengthOf(
        entityPlan.filter((row) =>
          row.detail.includes("USING COVERING INDEX idx_orch_events_entity_maintenance"),
        ),
        2,
      );
      assert.isFalse(entityPlan.some((row) => row.detail.includes("TEMP B-TREE")));
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND event_type IN ${sql.in(types)}
          AND sequence NOT IN (
            SELECT MAX(sequence) FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
              AND event_type IN ${sql.in(types)}
            GROUP BY stream_id
          )
      `;
      assert.lengthOf(
        plan.filter((row) =>
          row.detail.includes("USING COVERING INDEX idx_orch_events_thread_maintenance"),
        ),
        2,
      );
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        ...events[1]!,
        event_id: "maintenance-index:later",
        stream_version: 100,
      })}`;
      assert.lengthOf(yield* candidates, 2);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 71 }), []);
    }),
  );
});
