import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEventJson,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import migration from "../persistence/Migrations/067_AgentTimeTracking.ts";
import { runEvent, timestamp } from "./agentTimeTracking.testkit.ts";
import { makeAgentTimeTrackingStore } from "./agentTimeTrackingStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const decodeProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection);
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS orchestration_events`;
  yield* sql`DROP TABLE IF EXISTS agent_time_tracking_sessions`;
  yield* sql`DROP TABLE IF EXISTS agent_time_tracking_cursors`;
  yield* sql`CREATE TABLE orchestration_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, command_id TEXT, stream_id TEXT, event_type TEXT,
    occurred_at TEXT, payload_json TEXT, metadata_json TEXT, application_event_version INTEGER
  )`;
  yield* migration;
  yield* sql`INSERT INTO orchestration_events
    (event_id, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version)
    VALUES ('thread-event', 'thread-1', 'thread.created', ${timestamp(0)},
      '{"projectId":"project-1","title":"Ship feature","lineage":{"relationshipToParent":null}}', '{}', 2)`;
});
const append = Effect.fn("test.append")(function* (
  event: OrchestrationV2DomainEvent,
  commandId: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const encoded = encodeEvent(event);
  yield* sql`INSERT INTO orchestration_events
    (event_id, command_id, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version)
    VALUES (${encoded.id}, ${commandId}, ${encoded.threadId}, ${encoded.type}, ${encoded.occurredAt},
      ${encodeJson(encoded.payload)}, ${encodeJson({ runId: event.runId })}, 2)`;
});

layer("durable agent time capture", (it) => {
  it.effect("persists one completed summary without changing recorded time", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* store.capture();
      assert.isNull(yield* store.nextSummary());
      yield* append(runEvent("completed", 30));
      yield* store.capture();
      const session = yield* store.nextSummary();
      assert.isNotNull(session);
      if (!session) return;
      const sql = yield* SqlClient.SqlClient;
      for (const [runId, text] of [
        [session.id, "initial draft"],
        [session.id, "verified checkout recovery"],
        ["other-run", "unrelated work"],
      ]) {
        yield* sql`INSERT INTO orchestration_events(stream_id, event_type, payload_json, metadata_json, application_event_version)
          VALUES (${session.threadId}, 'message.updated', ${encodeJson({ id: `assistant-${runId}`, text })}, ${encodeJson({ runId })}, 2)`;
      }
      const context = yield* store.summaryContext(session);
      assert.include(context, "completed");
      assert.include(context, "verified checkout recovery");
      assert.notInclude(context, "initial draft");
      assert.notInclude(context, "unrelated work");
      yield* store.saveSummary(session, {
        title: "Implement checkout recovery",
        description: "Added stash and retry actions.",
      });
      assert.isNull(yield* store.nextSummary());
      const pending = yield* store.pending(Date.parse(timestamp(31)));
      assert.strictEqual(pending[0]?.title, "Implement checkout recovery");
      assert.deepEqual(pending[0]?.intervals, session.intervals);
      assert.strictEqual(pending[0]?.revision, session.revision + 1);
      yield* store.acknowledge(session);
      const summarized = yield* store.pending(Date.parse(timestamp(32)));
      assert.strictEqual(summarized.length, 1);
      yield* store.acknowledge(summarized[0]!);
      assert.deepEqual(yield* store.pending(Date.parse(timestamp(33))), []);
    }),
  );
  it.effect("retries legacy fallback summaries with a durable backoff", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* append(runEvent("completed", 30));
      yield* store.capture();
      const session = (yield* store.nextSummary())!;
      yield* store.saveSummary(session, {
        title: "Agent work completed",
        description: "Summary unavailable",
      });
      assert.isNotNull(yield* store.nextSummary());
      yield* store.deferSummary(session);
      assert.isNull(yield* store.nextSummary());
      yield* TestClock.adjust("5 minutes");
      assert.isNotNull(yield* store.nextSummary());
      yield* store.saveSummary(session, {
        title: "Explain project architecture",
        description: "Reviewed project documentation and explained the app structure.",
      });
      assert.isNull(yield* store.nextSummary());
    }),
  );
  for (const scenario of [
    { trigger: "startup", blocking: null, trackedSeconds: 30 },
    { trigger: "startup", blocking: false, trackedSeconds: 30 },
    { trigger: "startup", blocking: true, trackedSeconds: 20 },
    { trigger: "shutdown", blocking: null, trackedSeconds: 3600 },
  ] as const) {
    it.effect(
      `uses real ${scenario.trigger} recovery provenance with blocking=${scenario.blocking}`,
      () =>
        Effect.gen(function* () {
          yield* setup;
          const sql = yield* SqlClient.SqlClient;
          const store = yield* makeAgentTimeTrackingStore("company-1");
          const running = runEvent("running", 0, "run.created");
          yield* append(running);
          const requestEvent =
            scenario.blocking === null
              ? null
              : yield* decodeEvent({
                  id: "request-event",
                  threadId: "thread-1",
                  runId: "run-1",
                  type: "runtime-request.updated",
                  occurredAt: timestamp(20),
                  payload: {
                    id: "request-1",
                    nodeId: "request-node",
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "pending",
                    isBlocking: scenario.blocking,
                    responseCapability: { type: "not_resumable", reason: "process-owned request" },
                    createdAt: timestamp(20),
                    resolvedAt: null,
                  },
                });
          if (requestEvent) yield* append(requestEvent);
          yield* store.capture();
          yield* store.pending(Date.parse(timestamp(30)));
          const projection = yield* decodeProjection({
            updatedAt: DateTime.makeUnsafe(timestamp(30)),
            thread: {
              id: "thread-1",
              projectId: "project-1",
              title: "Ship feature",
              createdBy: "user",
              creationSource: "web",
              providerInstanceId: "codex",
              modelSelection: { instanceId: "codex", model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                rootThreadId: "thread-1",
                parentThreadId: null,
                relationshipToParent: null,
              },
              forkedFrom: null,
              createdAt: DateTime.makeUnsafe(timestamp(0)),
              updatedAt: DateTime.makeUnsafe(timestamp(0)),
              archivedAt: null,
              deletedAt: null,
            },
            runs: [running.payload],
            runtimeRequests: requestEvent ? [requestEvent.payload] : [],
            attempts: [],
            nodes: [],
            subagents: [],
            providerSessions: [],
            providerThreads: [],
            providerTurns: [],
            messages: [],
            plans: [],
            turnItems: [],
            checkpointScopes: [],
            checkpoints: [],
            contextHandoffs: [],
            visibleTurnItems: [],
            contextTransfers: [],
          });
          const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getRecoveryThreadIds: () => Effect.succeed([projection.thread.id]),
                  getThreadProjection: () => Effect.succeed(projection),
                }),
                Layer.mock(EventSink.EventSinkV2)({
                  commitCommand: (input) =>
                    Effect.gen(function* () {
                      // Keep the actual recovery command id on every persisted event, as EventSink does.
                      for (const event of input.events)
                        yield* append(event, input.commandId).pipe(
                          Effect.provideService(SqlClient.SqlClient, sql),
                          Effect.orDie,
                        );
                      return {
                        committed: true,
                        cancelledEffectCount: 0,
                        storedEvents: [],
                        receipt: {
                          commandId: input.commandId,
                          threadId: input.threadId,
                          commandType: input.commandType,
                          acceptedAt: input.acceptedAt,
                          resultSequence: 0,
                          status: "accepted" as const,
                          error: null,
                        },
                      };
                    }),
                }),
                IdAllocator.layer,
                Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                  runOnce: Effect.succeed(false),
                }),
                Layer.mock(EffectOutbox.EffectOutboxV2)({
                  reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                }),
              ),
            ),
          );
          yield* TestClock.setTime(Date.parse(timestamp(3600)));
          yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
            Effect.flatMap((service) => service.reconcile(scenario.trigger)),
            Effect.provide(recoveryLayer),
          );
          // Server startup runs recovery before the parked cloud publisher is constructed.
          const restarted = yield* makeAgentTimeTrackingStore("company-1");
          const pending = yield* restarted.pending(Date.parse(timestamp(3600)));
          assert.equal(pending[0]!.state, "stopped");
          assert.equal(
            pending[0]!.intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0),
            scenario.trackedSeconds * 1000,
          );
        }),
    );
  }
  it.effect("starts at enablement and replays pending lifecycle events once after restart", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* append(runEvent("running", 0, "run.created", "old-run"));
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 10, "run.created"));
      yield* append(runEvent("completed", 40));
      yield* store.capture();
      const pending = yield* store.pending(Date.parse(timestamp(50)));
      assert.lengthOf(pending, 1);
      assert.equal(pending[0]!.intervals[0]!.end - pending[0]!.intervals[0]!.start, 30_000);
      // A network failure before acknowledgement leaves the durable snapshot queued.
      const restarted = yield* makeAgentTimeTrackingStore("company-1");
      yield* restarted.capture();
      const retry = yield* restarted.pending(Date.parse(timestamp(60)));
      assert.deepEqual(retry, pending);
      yield* restarted.acknowledge(retry[0]!);
      assert.deepEqual(yield* restarted.pending(Date.parse(timestamp(70))), []);
    }),
  );

  it.effect("caps a crashed process at its last heartbeat and excludes downtime", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* store.capture();
      const heartbeat = yield* store.pending(Date.parse(timestamp(30)));
      yield* store.acknowledge(heartbeat[0]!);
      const restarted = yield* makeAgentTimeTrackingStore("company-1");
      const paused = yield* restarted.pending(Date.parse(timestamp(3600)));
      assert.equal(paused[0]!.state, "paused");
      assert.equal(paused[0]!.intervals[0]!.end - paused[0]!.intervals[0]!.start, 30_000);
      yield* append(runEvent("running", 3600));
      yield* append(runEvent("completed", 3630));
      yield* restarted.capture();
      const ended = yield* restarted.pending(Date.parse(timestamp(3630)));
      assert.equal(
        ended[0]!.intervals.reduce((total, interval) => total + interval.end - interval.start, 0),
        60_000,
      );
    }),
  );

  it.effect("recovers a committed completion before capping an interrupted publisher", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* store.capture();
      yield* store.pending(Date.parse(timestamp(30)));
      yield* append(runEvent("completed", 60));
      const restarted = yield* makeAgentTimeTrackingStore("company-1");
      const pending = yield* restarted.pending(Date.parse(timestamp(3600)));
      assert.equal(pending[0]!.state, "stopped");
      assert.equal(pending[0]!.intervals[0]!.end - pending[0]!.intervals[0]!.start, 60_000);
    }),
  );

  it.effect("does not add separate clocks for subagent threads", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_events SET payload_json =
      '{"projectId":"project-1","title":"Child","lineage":{"relationshipToParent":"subagent"}}'
      WHERE event_type = 'thread.created'`;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* append(runEvent("completed", 30));
      yield* store.capture();
      assert.deepEqual(yield* store.pending(Date.parse(timestamp(30))), []);
    }),
  );

  it.effect("uses the project at run creation and advances past unrelated events", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* sql`INSERT INTO orchestration_events
      (event_id, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version)
      VALUES ('move-event', 'thread-1', 'thread.metadata-updated', ${timestamp(5)},
        '{"projectId":"project-2","title":"Moved feature","lineage":{"relationshipToParent":null}}', '{}', 2)`;
      yield* append(runEvent("running", 10, "run.created"));
      yield* sql`INSERT INTO orchestration_events
      (event_id, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version)
      VALUES ('later-move', 'thread-1', 'thread.metadata-updated', ${timestamp(15)},
        '{"projectId":"project-3","title":"Later move","lineage":{"relationshipToParent":null}}', '{}', 2)`;
      yield* store.capture();
      const pending = yield* store.pending(Date.parse(timestamp(20)));
      assert.equal(pending[0]!.localProjectId, "project-2");
      const cursors = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM agent_time_tracking_cursors`;
      const latest = yield* sql<{
        sequence: number;
      }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
      assert.equal(cursors[0]!.sequence, latest[0]!.sequence);
    }),
  );

  it.effect("retries refused rows without starving later sessions", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* append(runEvent("completed", 10));
      yield* store.capture();
      const template = (yield* store.pending(Date.parse(timestamp(10))))[0]!;
      for (let index = 0; index < 501; index += 1) {
        const session = { ...template, id: `refused-${index}` };
        yield* sql`INSERT INTO agent_time_tracking_sessions
        (company_id, run_id, thread_id, state, payload_json, dirty)
        VALUES ('company-1', ${session.id}, ${session.threadId}, 'stopped', ${encodeJson(session)}, 1)`;
      }
      const first = yield* store.pending(Date.parse(timestamp(20)));
      const second = yield* store.pending(Date.parse(timestamp(30)));
      const visited = new Set([...first, ...second].map((session) => session.id));
      assert.equal(visited.size, 502);
    }),
  );

  it.effect("parks unbound completed sessions durably for five minutes then retries", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* append(runEvent("completed", 10));
      yield* store.capture();
      const session = (yield* store.pending(Date.parse(timestamp(10))))[0]!;
      yield* store.deferUnbound(session, Date.parse(timestamp(10)));
      assert.deepEqual(yield* store.pending(Date.parse(timestamp(25))), []);
      const restarted = yield* makeAgentTimeTrackingStore("company-1");
      assert.deepEqual(yield* restarted.pending(Date.parse(timestamp(309))), []);
      const retry = yield* restarted.pending(Date.parse(timestamp(310)));
      assert.deepEqual(retry, [session]);
      // Once the binding exists, successful publication leaves completed history off the queue.
      yield* restarted.acknowledge(retry[0]!);
      assert.deepEqual(yield* restarted.pending(Date.parse(timestamp(610))), []);
    }),
  );

  it.effect("keeps heartbeats durable during an unbound project's retry delay", () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* makeAgentTimeTrackingStore("company-1");
      yield* append(runEvent("running", 0, "run.created"));
      yield* store.capture();
      const session = (yield* store.pending(Date.parse(timestamp(10))))[0]!;
      yield* store.deferUnbound(session, Date.parse(timestamp(10)));
      assert.deepEqual(yield* store.pending(Date.parse(timestamp(100))), []);
      const restarted = yield* makeAgentTimeTrackingStore("company-1");
      const retry = yield* restarted.pending(Date.parse(timestamp(310)));
      assert.equal(retry[0]!.state, "paused");
      assert.equal(retry[0]!.intervals[0]!.end - retry[0]!.intervals[0]!.start, 100_000);
    }),
  );
});
