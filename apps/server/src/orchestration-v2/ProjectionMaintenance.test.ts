import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import {
  ProjectionDecodeBuild,
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";

const stores = Layer.mergeAll(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const TestLayer = Layer.mergeAll(stores, eventSinkLayer.pipe(Layer.provide(stores)));

const maintenanceFor = (build: string | null) =>
  Effect.service(ProjectionMaintenanceV2).pipe(
    Effect.provide(
      projectionMaintenanceLayer.pipe(Layer.provide(Layer.succeed(ProjectionDecodeBuild, build))),
    ),
  );

it.layer(TestLayer)("ProjectionMaintenanceV2 decode verification", (it) => {
  it.effect("decodes every projection once per packaged build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:decode-verification");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:decode-verification"),
        title: "Decode verification",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:decode-verification:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const verifiedBuild = sql<{ readonly build: string | null }>`
        SELECT decode_verified_build AS build
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
      `.pipe(Effect.map((rows) => rows[0]?.build ?? null));

      const buildA = yield* maintenanceFor("1.0.0+latest");
      assert.isTrue((yield* buildA.verify).valid);
      assert.equal(yield* verifiedBuild, "1.0.0+latest");

      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = '{}'
        WHERE thread_id = ${threadId}
      `;
      // The same build trusts its earlier sweep and skips decoding.
      assert.isTrue((yield* buildA.verify).valid);

      // Source runs never trust the mark.
      const source = yield* maintenanceFor(null);
      assert.deepEqual((yield* source.verify).unreadableThreadIds, [threadId]);

      // A different build sweeps again, finds the damage, and marks itself after rebuilding.
      const buildB = yield* maintenanceFor("1.1.0+latest");
      const broken = yield* buildB.verify;
      assert.isFalse(broken.valid);
      assert.deepEqual(broken.unreadableThreadIds, [threadId]);
      assert.equal(yield* verifiedBuild, "1.0.0+latest");
      assert.isTrue((yield* buildB.rebuild).valid);
      assert.equal(yield* verifiedBuild, "1.1.0+latest");
    }),
  );
});
