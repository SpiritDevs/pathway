#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { layer as eventStoreLayer } from "../src/orchestration-v2/EventStore.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../src/orchestration-v2/ProjectionStore.ts";
import {
  ProjectionMaintenanceV2,
  layer as maintenanceLayer,
} from "../src/orchestration-v2/ProjectionMaintenance.ts";

const encodeMeasurement = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      iteration: Schema.Int,
      valid: Schema.Boolean,
      threadCount: Schema.Int,
      recoveryThreadCount: Schema.Int,
      verificationMs: Schema.Int,
      shellMs: Schema.Int,
      fullRecoveryReadMs: Schema.Int,
      targetedRecoveryReadMs: Schema.Int,
    }),
  ),
);

// Uses a read-only, already migrated snapshot. No server, providers, recovery writes,
// migrations, or cloud workers are started by this benchmark.
const command = Command.make("benchmark-startup", {
  database: Argument.string("database"),
}).pipe(
  Command.withDescription(
    "Measure startup database reads against a consistent state.sqlite snapshot.",
  ),
  Command.withHandler(({ database }) => {
    const stores = Layer.mergeAll(eventStoreLayer, projectionStoreLayer).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: database, readonly: true })),
    );
    return Effect.gen(function* () {
      const maintenance = yield* ProjectionMaintenanceV2;
      const projections = yield* ProjectionStoreV2;
      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const [verificationTime, verification] = yield* Effect.timed(maintenance.verify);
        const [shellTime, shell] = yield* Effect.timed(projections.getShellSnapshot());
        const threads = [...shell.threads, ...shell.archivedThreads];
        const fullScan = Effect.forEach(
          threads,
          (thread) => projections.getThreadProjection(thread.id),
          {
            discard: true,
          },
        ).pipe(
          Effect.timed,
          Effect.map(([duration]) => duration),
        );
        const targetedScan = Effect.gen(function* () {
          const ids = yield* projections.getRecoveryThreadIds();
          yield* Effect.forEach(ids, (id) => projections.getThreadProjection(id), {
            discard: true,
          });
          return ids.length;
        }).pipe(Effect.timed);
        // Alternate order so the same strategy does not always benefit from the
        // other's reads. Verification itself warms the projection data in both cases.
        const measurements =
          iteration % 2 === 1
            ? yield* Effect.gen(function* () {
                const fullScanTime = yield* fullScan;
                const [recoveryReadTime, recoveryThreadCount] = yield* targetedScan;
                return { fullScanTime, recoveryReadTime, recoveryThreadCount };
              })
            : yield* Effect.gen(function* () {
                const [recoveryReadTime, recoveryThreadCount] = yield* targetedScan;
                const fullScanTime = yield* fullScan;
                return { fullScanTime, recoveryReadTime, recoveryThreadCount };
              });
        yield* Console.log(
          encodeMeasurement({
            iteration,
            valid: verification.valid,
            threadCount: threads.length,
            recoveryThreadCount: measurements.recoveryThreadCount,
            verificationMs: Math.round(Duration.toMillis(verificationTime)),
            shellMs: Math.round(Duration.toMillis(shellTime)),
            fullRecoveryReadMs: Math.round(Duration.toMillis(measurements.fullScanTime)),
            targetedRecoveryReadMs: Math.round(Duration.toMillis(measurements.recoveryReadTime)),
          }),
        );
      }
    }).pipe(Effect.provide(maintenanceLayer.pipe(Layer.provideMerge(stores))));
  }),
);

Command.run(command, { version: "1" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
