import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@spiritdevs/contracts";
import { layerMemory } from "../persistence/NodeSqliteClient.ts";
import { measureThreadStorageBytes } from "./StorageService.ts";

it.effect("counts UTF-8 payload bytes in SQLite without loading unrelated thread transcripts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of [
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_messages",
      "orchestration_v2_projection_turn_items",
      "orchestration_v2_projection_runs",
      "orchestration_v2_projection_checkpoints",
    ]) {
      yield* sql`CREATE TABLE ${sql(table)} (thread_id TEXT, payload_json TEXT)`;
      yield* sql`INSERT INTO ${sql(table)} VALUES ('thread-a', ${"🧪"}), ('thread-b', ${"unrelated".repeat(10_000)})`;
    }
    expect(yield* measureThreadStorageBytes(sql, ThreadId.make("thread-a"))).toBe(20);
    expect(yield* measureThreadStorageBytes(sql, ThreadId.make("missing"))).toBe(0);
  }).pipe(Effect.provide(layerMemory())),
);
