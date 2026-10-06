import {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadDetailSnapshotWire,
  ThreadId,
} from "@spiritdevs/contracts";
import { resolveThreadProjectionPayload } from "../../../packages/client-runtime/src/state/threadPayload.ts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { layer as sqliteLayer } from "../src/persistence/NodeSqliteClient.ts";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../src/orchestration-v2/ProjectionStore.ts";
import { threadProjectionPayload } from "../src/orchestration-v2/ThreadPayload.ts";
import { narrowHistoryPageSupport } from "../src/orchestration-v2/ThreadHistory.ts";

// node apps/server/scripts/measure-thread-snapshot.ts <snapshot.sqlite> <thread-id> ...
const [filename, ...threads] = process.argv.slice(2);
if (filename === undefined || threads.length === 0) {
  throw new Error("Usage: measure-thread-snapshot.ts <snapshot.sqlite> <thread-id> ...");
}
const legacyCodec = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot));
const wireCodec = Schema.fromJsonString(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshotWire),
);
const encodeLegacy = Schema.encodeSync(legacyCodec);
const encodeWire = Schema.encodeSync(wireCodec);
const decodeLegacy = Schema.decodeUnknownSync(legacyCodec);
const decodeWire = Schema.decodeUnknownSync(wireCodec);
const median = (samples: number[]) =>
  samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)]!;

// No migrations or server runtime: only the projection reader against a read-only database.
const results = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const results = [];
    for (const id of threads) {
      const samples = {
        legacy: [] as Array<{ bytes: number; projection: number; build: number; decode: number }>,
        references: [] as Array<{
          bytes: number;
          projection: number;
          build: number;
          decode: number;
        }>,
        compact: [] as Array<{ bytes: number; projection: number; build: number; decode: number }>,
      };
      for (let iteration = 0; iteration < 8; iteration++) {
        // Alternate order to reduce bias from GC and load on this shared machine.
        const modes = ["legacy", "references", "compact"] as const;
        for (const mode of iteration % 2 === 0 ? modes : modes.toReversed()) {
          const start = performance.now();
          const stored = yield* store.getThreadSnapshot(ThreadId.make(id), { limit: 50 });
          // Match Orchestrator.getThreadSnapshot, including main's existing support narrowing.
          const snapshot = { ...stored, projection: narrowHistoryPageSupport(stored.projection) };
          const projectionMs = performance.now() - start;
          const payload = {
            snapshotSequence: snapshot.snapshotSequence,
            projection: threadProjectionPayload(
              snapshot.projection,
              mode === "legacy"
                ? undefined
                : mode === "references"
                  ? "references-v1"
                  : "compact-v1",
            ),
            ...(snapshot.history === undefined ? {} : { history: snapshot.history }),
          };
          const json = mode === "legacy" ? encodeLegacy(snapshot) : encodeWire(payload);
          const build = performance.now() - start;
          const decodeStart = performance.now();
          if (mode === "legacy") decodeLegacy(json);
          else resolveThreadProjectionPayload(decodeWire(json).projection);
          const decode = performance.now() - decodeStart;
          if (iteration > 0)
            samples[mode].push({
              bytes: Buffer.byteLength(json),
              projection: projectionMs,
              build,
              decode,
            });
        }
      }
      results.push({
        threadId: id,
        samples: 7,
        ...Object.fromEntries(
          Object.entries(samples).map(([mode, values]) => [
            mode,
            {
              bytes: values[0]!.bytes,
              projectionMs: median(values.map((sample) => sample.projection)),
              serverBuildMs: median(values.map((sample) => sample.build)),
              clientDecodeMs: median(values.map((sample) => sample.decode)),
            },
          ]),
        ),
      });
    }
    return results;
  }).pipe(
    Effect.provide(
      projectionLayer.pipe(
        Layer.provide(
          sqliteLayer({
            filename,
            readonly: true,
          }),
        ),
      ),
    ),
  ),
);
for (const result of results) await Effect.runPromise(Console.log(JSON.stringify(result)));
