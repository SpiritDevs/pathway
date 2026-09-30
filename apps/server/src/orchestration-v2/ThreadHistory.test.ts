import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  narrowHistoryPageSupport,
  threadHistoryNeedsSnapshot,
  threadProjectionExists,
} from "./ThreadHistory.ts";

const TestLayer = projectionStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const now = DateTime.makeUnsafe("2026-09-19T01:00:00Z");
const instanceId = ProviderInstanceId.make("codex");

const seedThread = Effect.fn("seedThread")(function* (
  name: string,
  count: number,
  forkedFrom: OrchestrationV2AppThread["forkedFrom"] = null,
) {
  const store = yield* ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  const runId = RunId.make(`run:${name}`);
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    createdBy: "user",
    creationSource: "web",
    projectId: null,
    title: name,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`${name}:message:0`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`${name}:created`),
    threadId,
    occurredAt: now,
    type: "thread.created",
    payload: thread,
  });
  yield* store.apply({
    id: EventId.make(`${name}:run`),
    threadId,
    occurredAt: now,
    type: "run.created",
    payload: run,
  });
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const base = {
      id: TurnItemId.make(`${name}:item:${ordinal}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const messageId = MessageId.make(`${name}:message:${ordinal}`);
    const item: OrchestrationV2TurnItem =
      ordinal % 10 === 0
        ? {
            ...base,
            type: "user_message",
            messageId,
            text: `Prompt ${ordinal}`,
            attachments: [],
            inputIntent: ordinal === 0 ? "turn_start" : "steer",
            createdBy: "user",
            creationSource: "web",
          }
        : ordinal % 10 === 9
          ? {
              ...base,
              type: "assistant_message",
              messageId,
              text: `Answer ${ordinal}`,
              streaming: false,
            }
          : {
              ...base,
              type: "command_execution",
              input: `command ${ordinal}`,
              output: `output ${ordinal} ${"x".repeat(8192)}`,
            };
    yield* store.apply({
      id: EventId.make(`${name}:item-event:${ordinal}`),
      threadId,
      occurredAt: now,
      type: "turn-item.updated",
      payload: item,
    });
    if (item.type === "user_message" || item.type === "assistant_message") {
      yield* store.apply({
        id: EventId.make(`${name}:message-event:${ordinal}`),
        threadId,
        occurredAt: now,
        type: "message.updated",
        payload: {
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          text: item.text,
          role: item.type === "user_message" ? "user" : "assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          creationSource: "web",
        },
      });
    }
  }
  return { threadId, runId, run, thread };
});

it.layer(TestLayer)("bounded thread history", (it) => {
  it.effect(
    "pages actual items inside one long run, preserves order, and jumps through the full index",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const { threadId } = yield* seedThread("pages", 140);
        const full = yield* store.getThreadSnapshot(threadId);
        assert.lengthOf(full.projection.turnItems, 140);
        assert.isUndefined(full.history);
        const latest = yield* store.getThreadSnapshot(threadId, { limit: 50 });
        assert.deepEqual(
          latest.projection.visibleTurnItems,
          full.projection.visibleTurnItems.slice(90),
        );
        assert.lengthOf(latest.projection.turnItems, 50);
        assert.lengthOf(latest.history!.index, 14);
        assert.equal(latest.history!.index[0]!.assistantPreview, "Answer 9");
        assert.isTrue(latest.history!.hasOlder);
        assert.isFalse(latest.history!.hasNewer);
        assert.include(
          latest.projection.messages.map((message) => message.id),
          MessageId.make("pages:message:0"),
        );
        const older = yield* store.getThreadSnapshot(threadId, {
          limit: 50,
          before: latest.history!.beforeCursor!,
        });
        assert.deepEqual(
          older.projection.visibleTurnItems,
          full.projection.visibleTurnItems.slice(40, 90),
        );
        const newer = yield* store.getThreadSnapshot(threadId, {
          limit: 50,
          after: older.history!.afterCursor!,
        });
        assert.deepEqual(newer.projection.visibleTurnItems, latest.projection.visibleTurnItems);
        const around = yield* store.getThreadSnapshot(threadId, {
          limit: 25,
          around: MessageId.make("pages:message:20"),
        });
        assert.deepEqual(
          around.projection.visibleTurnItems,
          full.projection.visibleTurnItems.slice(8, 33),
        );
        assert.isTrue(around.history!.hasOlder);
        assert.isTrue(around.history!.hasNewer);
      }),
  );

  it.effect("does not read or decode completed tool bodies outside the requested page", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { threadId } = yield* seedThread("bounded-payload", 130);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = 'intentionally not JSON' WHERE turn_item_id = 'bounded-payload:item:1'`;
      const page = yield* store.getThreadSnapshot(threadId, { limit: 50 });
      assert.lengthOf(page.projection.turnItems, 50);
      assert.equal(page.projection.visibleTurnItems[0]!.item.ordinal, 80);
      const legacyFailure = yield* Effect.flip(store.getThreadSnapshot(threadId));
      assert.equal(legacyFailure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect(
    "keeps nested inherited history and synthetic fork markers identical to a full projection",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const source = yield* seedThread("fork-source", 30);
        const child = yield* seedThread("fork-child", 20, {
          type: "run",
          threadId: source.threadId,
          runId: source.runId,
        });
        const nested = yield* seedThread("fork-nested", 10, {
          type: "run",
          threadId: child.threadId,
          runId: child.runId,
        });
        const full = yield* store.getThreadSnapshot(nested.threadId);
        const latest = yield* store.getThreadSnapshot(nested.threadId, { limit: 40 });
        assert.deepEqual(
          latest.projection.visibleTurnItems,
          full.projection.visibleTurnItems.slice(-40),
        );
        const around = yield* store.getThreadSnapshot(nested.threadId, {
          limit: 40,
          around: MessageId.make("fork-source:message:20"),
        });
        assert.deepEqual(
          around.projection.visibleTurnItems,
          full.projection.visibleTurnItems.slice(0, 40),
        );
        yield* store.apply({
          id: EventId.make("source-rollback"),
          threadId: source.threadId,
          occurredAt: now,
          type: "run.updated",
          payload: { ...source.run, status: "rolled_back" },
        });
        const afterRollback = yield* store.getThreadSnapshot(nested.threadId, {
          limit: 40,
          around: MessageId.make("fork-source:message:20"),
        });
        assert.deepEqual(
          afterRollback.projection.visibleTurnItems,
          around.projection.visibleTurnItems,
        );
      }),
  );

  it.effect(
    "rejects removed cursors instead of mislabeling the latest content as an older page",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const { threadId } = yield* seedThread("missing-cursor", 10);
        const failure = yield* Effect.flip(
          store.getThreadSnapshot(threadId, { limit: 5, before: TurnItemId.make("deleted") }),
        );
        assert.equal(failure._tag, "ProjectionStoreReadError");
      }),
  );

  it.effect(
    "counts only missed events for the requested thread through its high water sequence",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:backlog");
        for (let index = 1; index <= 300; index++) {
          yield* sql`INSERT INTO orchestration_events (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${index * 10}, ${`backlog:${index}`}, 'thread', ${threadId}, ${index}, 'message.updated', '2026-09-19T01:00:00Z', 'system', '{}', '{}', 2)`;
        }
        assert.isFalse(yield* threadHistoryNeedsSnapshot(ThreadId.make("thread:other"), 0, 3000));
        assert.isFalse(yield* threadHistoryNeedsSnapshot(threadId, 0, 2500));
        assert.isTrue(yield* threadHistoryNeedsSnapshot(threadId, 0, 2510));
        assert.isFalse(yield* threadHistoryNeedsSnapshot(threadId, 1000, 3000));
        assert.isTrue(yield* threadHistoryNeedsSnapshot(threadId, 4000, 3000));
        const store = yield* ProjectionStoreV2;
        const seeded = yield* seedThread("backlog", 10);
        const snapshot = yield* store.getThreadSnapshot(seeded.threadId, { limit: 5 });
        assert.equal(snapshot.snapshotSequence, 3000);
      }),
  );

  it.effect("finds resume targets exactly where the thread shell exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStoreV2;
      const { threadId } = yield* seedThread("resume-target", 3);
      const missing = ThreadId.make("thread:resume-target-missing");
      assert.isTrue(yield* threadProjectionExists(threadId));
      assert.isFalse(yield* threadProjectionExists(missing));
      assert.isNull(yield* store.getThreadShell(missing));

      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-09-19T02:00:00Z' WHERE thread_id = ${threadId}`;
      assert.isFalse(yield* threadProjectionExists(threadId));
      assert.isNull(yield* store.getThreadShell(threadId));
    }),
  );
});

it("narrows a page's execution support to its items plus live and latest work", () => {
  const threadId = ThreadId.make("thread:narrow");
  const run = (id: string, ordinal: number, status: string) => ({
    id,
    ordinal,
    status,
    rootNodeId: `${id}:root`,
  });
  const node = (id: string, runId: string, status: string, parentNodeId: string | null) => ({
    id,
    runId,
    status,
    parentNodeId,
    rootNodeId: `${runId}:root`,
    providerTurnId: null,
  });
  const projection = {
    thread: { id: threadId },
    runs: [run("r1", 1, "completed"), run("r2", 2, "completed"), run("r3", 3, "running")],
    attempts: ["r1", "r2", "r3"].map((runId) => ({
      id: `${runId}:attempt`,
      runId,
      rootNodeId: `${runId}:root`,
      providerTurnId: null,
    })),
    nodes: [
      node("r1:root", "r1", "completed", null),
      node("r1:tool", "r1", "completed", "r1:root"),
      node("r2:root", "r2", "completed", null),
      node("r2:reasoning", "r2", "completed", "r2:root"),
      node("r2:tool", "r2", "completed", "r2:reasoning"),
      node("r2:other", "r2", "completed", "r2:root"),
      node("r3:root", "r3", "running", null),
      node("r3:tool", "r3", "running", "r3:root"),
    ],
    providerTurns: [
      { id: "t1", nodeId: "r1:root", runAttemptId: "r1:attempt", status: "completed" },
      { id: "t2", nodeId: "r2:root", runAttemptId: "r2:attempt", status: "completed" },
      { id: "t3", nodeId: "r3:root", runAttemptId: "r3:attempt", status: "running" },
    ],
    subagents: [],
    plans: [],
    runtimeRequests: [],
    messages: [],
    turnItems: [
      { threadId, runId: "r2", nodeId: "r2:tool", providerTurnId: null },
      // Inherited items belong to the source thread's own support.
      {
        threadId: ThreadId.make("thread:source"),
        runId: "r1",
        nodeId: "r1:tool",
        providerTurnId: null,
      },
    ],
    visibleTurnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  const narrowed = narrowHistoryPageSupport(projection);
  assert.deepEqual(
    narrowed.nodes.map((entry) => entry.id),
    ["r2:root", "r2:reasoning", "r2:tool", "r3:root", "r3:tool"],
  );
  assert.deepEqual(
    narrowed.attempts.map((entry) => entry.id),
    ["r2:attempt", "r3:attempt"],
  );
  assert.deepEqual(
    narrowed.providerTurns.map((entry) => entry.id),
    ["t2", "t3"],
  );
  assert.strictEqual(narrowed.runs, projection.runs);
});
