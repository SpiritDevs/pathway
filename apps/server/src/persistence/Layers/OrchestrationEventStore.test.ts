import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      // Model stored corruption from before the JSON expression index existed;
      // otherwise SQLite rejects the fixture before replay reaches its decoder.
      yield* sql`DROP INDEX idx_orch_events_entity_maintenance`;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("orders project and V2 agent events in the retained application event source", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectId = ProjectId.make("project-shared-stream");
      const threadId = ThreadId.make("thread-shared-stream");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const occurredAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
      const now = DateTime.formatIso(occurredAt);
      const baselineSequence = yield* eventStore.latestApplicationSequence;

      const projectEvent = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("event-project-shared-stream"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("command-project-shared-stream"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-shared-stream"),
        metadata: {},
        payload: {
          projectId,
          title: "Shared stream",
          workspaceRoot: "/tmp/shared-stream",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const [threadEvent] = yield* eventStore.appendAgentEvents({
        commandId: CommandId.make("command-thread-shared-stream"),
        events: [
          {
            id: EventId.make("event-thread-shared-stream"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt,
            payload: {
              id: threadId,
              projectId,
              title: "Thread",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                rootThreadId: threadId,
                parentThreadId: null,
                relationshipToParent: null,
              },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: occurredAt,
              updatedAt: occurredAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      assert.equal(yield* eventStore.latestApplicationSequence, threadEvent!.sequence);

      const applicationEvents = yield* eventStore
        .streamApplicationEvents({ afterSequence: baselineSequence })
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        applicationEvents.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );
      assert.isTrue("aggregateKind" in applicationEvents[0]!);
      assert.isTrue("event" in applicationEvents[1]!);

      const finiteReplay = yield* eventStore
        .readApplicationEvents({
          afterSequence: baselineSequence,
          throughSequence: threadEvent!.sequence,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        finiteReplay.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );

      const legacyReplay = yield* eventStore.readFromSequence(projectEvent.sequence - 1).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(
        legacyReplay.map((event) => event.type),
        ["project.created"],
      );
    }),
  );

  it.effect("filters agent reads and high-water marks by thread and command", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const providerInstanceId = ProviderInstanceId.make("codex");
      const occurredAt = DateTime.makeUnsafe("2026-01-03T00:00:00.000Z");
      const threadCreated = (id: string, threadId: ThreadId) =>
        ({
          id: EventId.make(id),
          type: "thread.created",
          threadId,
          providerInstanceId,
          occurredAt,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project-filtered-reads"),
            title: "Thread",
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: occurredAt,
            updatedAt: occurredAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        }) as const;
      const threadA = ThreadId.make("thread-filtered-a");
      const threadB = ThreadId.make("thread-filtered-b");
      const commandA1 = CommandId.make("command-filtered-a1");
      const commandA2 = CommandId.make("command-filtered-a2");
      const commandB = CommandId.make("command-filtered-b");
      const [a1] = yield* eventStore.appendAgentEvents({
        commandId: commandA1,
        events: [threadCreated("event-filtered-a1", threadA)],
      });
      const [b1] = yield* eventStore.appendAgentEvents({
        commandId: commandB,
        events: [threadCreated("event-filtered-b1", threadB)],
      });
      const [a2] = yield* eventStore.appendAgentEvents({
        commandId: commandA2,
        events: [threadCreated("event-filtered-a2", threadA)],
      });
      const sequences = (input: Parameters<typeof eventStore.readAgentEvents>[0]) =>
        eventStore.readAgentEvents(input).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, (event) => event.sequence)),
        );

      assert.deepEqual(yield* sequences({ threadId: threadA }), [a1!.sequence, a2!.sequence]);
      assert.deepEqual(yield* sequences({ threadId: threadA, afterSequence: a1!.sequence }), [
        a2!.sequence,
      ]);
      assert.deepEqual(
        yield* sequences({ threadId: threadA, afterSequence: 0, throughSequence: b1!.sequence }),
        [a1!.sequence],
      );
      assert.deepEqual(yield* sequences({ commandId: commandB }), [b1!.sequence]);
      assert.deepEqual(yield* sequences({ threadId: threadA, commandId: commandA2 }), [
        a2!.sequence,
      ]);
      assert.deepEqual(yield* sequences({ threadId: threadB, commandId: commandA2 }), []);

      assert.equal(yield* eventStore.latestAgentSequence(threadA), a2!.sequence);
      assert.equal(yield* eventStore.latestAgentSequence(threadB), b1!.sequence);
      assert.equal(
        yield* eventStore.latestAgentSequence(ThreadId.make("thread-filtered-missing")),
        0,
      );
      assert.equal(yield* eventStore.latestAgentSequence(), a2!.sequence);
      assert.equal(yield* eventStore.latestApplicationSequence, a2!.sequence);
    }),
  );
});
