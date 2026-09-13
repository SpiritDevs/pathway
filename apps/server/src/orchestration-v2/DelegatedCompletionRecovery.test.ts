import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ContextTransferId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandPolicyV2 } from "./CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2, layer as orchestratorLayer } from "./Orchestrator.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
  layerMemory,
} from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "./ProviderContinuationRequests.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import { ThreadForkServiceV2 } from "./ThreadForkService.ts";

const now = DateTime.makeUnsafe("2026-09-12T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const fixture = (name: string) => {
  const threadId = ThreadId.make(`thread:${name}`);
  const parentRunId = RunId.make(`run:${name}:parent`);
  const messageId = MessageId.make(`message:${name}`);
  const taskId = NodeId.make(`task:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: null,
    title: name,
    providerInstanceId,
    modelSelection,
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
  const run: OrchestrationV2Run = {
    id: parentRunId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${name}:parent`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
    delegatedCompletion: {
      disposition: "open",
      nextGeneration: 2,
      delivery: { generation: 1, messageId, taskIds: [taskId] },
    },
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text: "Delegated result",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    delegatedCompletion: { parentRunId, generation: 1, taskIds: [taskId] },
  };
  return { threadId, thread, run, message };
};

const threadEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${thread.id}:thread`),
  type: "thread.created",
  threadId: thread.id,
  occurredAt: now,
  payload: thread,
});
const runEvent = (run: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${run.id}`),
  type: "run.updated",
  threadId: run.threadId,
  runId: run.id,
  occurredAt: now,
  payload: run,
});
const messageEvent = (message: OrchestrationV2ConversationMessage): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${message.id}`),
  type: "message.updated",
  threadId: message.threadId,
  occurredAt: now,
  payload: message,
});

const storesLayer = Layer.mergeAll(projectionStoreLayer, eventStoreLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

for (const [name, layer] of [
  ["SQLite", storesLayer],
  ["memory", layerMemory],
] as const) {
  it.effect(
    `${name}: recovers only terminal app-owned children whose results are not transferred`,
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const parent = fixture("child-parent");
        yield* store.apply(threadEvent(parent.thread));
        const wanted: Array<ThreadId> = [];
        for (const status of [
          "completed",
          "interrupted",
          "failed",
          "cancelled",
          "rolled_back",
          "running",
        ] as const) {
          const child = fixture(`child-${status}`);
          const taskId = NodeId.make(`task:${status}`);
          yield* store.apply(
            threadEvent({
              ...child.thread,
              archivedAt: status === "interrupted" ? now : null,
              lineage: {
                parentThreadId: parent.threadId,
                rootThreadId: parent.threadId,
                relationshipToParent: "subagent",
              },
              forkedFrom: { type: "node", nodeId: taskId },
            }),
          );
          yield* store.apply(runEvent({ ...child.run, status, delegatedCompletion: undefined }));
          const task: OrchestrationV2DomainEvent = {
            id: EventId.make(`event:task:${status}`),
            type: "subagent.updated",
            threadId: parent.threadId,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId: parent.threadId,
              runId: null,
              parentNodeId: NodeId.make("node:parent"),
              origin: "provider_native",
              createdBy: "agent",
              driver,
              providerInstanceId,
              providerThreadId: null,
              childThreadId: child.threadId,
              nativeTaskRef: null,
              prompt: "Task",
              title: null,
              model: null,
              status: "completed",
              result: "Result",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          };
          yield* store.apply(task);
          assert.notInclude(
            (yield* store.getPendingSubagentCompletionThreads()).map((thread) => thread.id),
            child.threadId,
          );
          yield* store.apply({ ...task, payload: { ...task.payload, origin: "app_owned" } });
          if (status !== "running") wanted.push(child.threadId);
        }
        assert.deepEqual(
          (yield* store.getPendingSubagentCompletionThreads())
            .map((thread) => thread.id)
            .toSorted(),
          wanted.toSorted(),
        );
        const transferred = fixture("child-completed");
        yield* store.apply({
          id: EventId.make("event:child:transferred"),
          type: "context-transfer.created",
          threadId: parent.threadId,
          occurredAt: now,
          payload: {
            id: ContextTransferId.make("transfer:child"),
            type: "subagent_result",
            sourceThreadId: transferred.threadId,
            targetThreadId: parent.threadId,
            sourcePoint: { threadId: transferred.threadId },
            basePoint: null,
            sourceProviderInstanceId: providerInstanceId,
            targetProviderInstanceId: providerInstanceId,
            targetRunId: null,
            status: "pending",
            resolution: null,
            createdBy: "system",
            error: null,
            createdAt: now,
            updatedAt: now,
            consumedAt: null,
          },
        });
        assert.notInclude(
          (yield* store.getPendingSubagentCompletionThreads()).map((thread) => thread.id),
          transferred.threadId,
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect(
    `${name}: reads metadata and queue candidates without loading conversation history`,
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        assert.deepEqual(yield* store.getThreadMetadata(), []);
        assert.deepEqual(yield* store.getQueuedRunThreadIds(), []);
        const ordinary = fixture("ordinary");
        const queued = fixture("queued");
        const archived = fixture("archived");
        const deleted = fixture("deleted");
        const armed = fixture("armed");
        for (const thread of [
          ordinary.thread,
          queued.thread,
          { ...archived.thread, archivedAt: now },
          { ...deleted.thread, deletedAt: now },
          { ...armed.thread, settleAfterCompletion: true },
        ]) {
          yield* store.apply(threadEvent(thread));
        }
        for (const entry of [queued, archived, deleted]) {
          yield* store.apply(runEvent({ ...entry.run, status: "queued" }));
        }
        // A second queued run must not duplicate the thread's recovery entry.
        yield* store.apply(
          runEvent({ ...queued.run, id: RunId.make("run:second"), ordinal: 2, status: "queued" }),
        );
        const metadata = yield* store.getThreadMetadata();
        assert.deepEqual(
          metadata.map((thread) => thread.id).toSorted(),
          [archived.threadId, armed.threadId, ordinary.threadId, queued.threadId].toSorted(),
        );
        assert.isTrue(
          metadata.find((thread) => thread.id === armed.threadId)?.settleAfterCompletion,
        );
        assert.deepEqual(yield* store.getQueuedRunThreadIds(), [queued.threadId]);
        yield* store.apply(runEvent({ ...queued.run, status: "cancelled" }));
        assert.deepEqual(yield* store.getQueuedRunThreadIds(), [queued.threadId]);
        yield* store.apply(
          runEvent({
            ...queued.run,
            id: RunId.make("run:second"),
            ordinal: 2,
            status: "completed",
          }),
        );
        assert.deepEqual(yield* store.getQueuedRunThreadIds(), []);
      }).pipe(Effect.provide(layer)),
  );
  it.effect(`${name}: finds current delivery candidates without including unrelated history`, () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      assert.deepEqual(yield* store.getDelegatedCompletionRecoveryThreadIds(), []);
      const ordinary = fixture("ordinary");
      const messageOnly = fixture("message-only");
      const runOnly = fixture("run-only");
      const archived = fixture("archived");
      const deleted = fixture("deleted");
      const settled = fixture("settled");
      const events = [
        threadEvent(ordinary.thread),
        messageEvent({ ...ordinary.message, delegatedCompletion: undefined }),
        threadEvent(messageOnly.thread),
        messageEvent(messageOnly.message),
        threadEvent(runOnly.thread),
        runEvent(runOnly.run),
        threadEvent({ ...archived.thread, archivedAt: now }),
        messageEvent(archived.message),
        runEvent(archived.run),
        threadEvent({ ...deleted.thread, deletedAt: now }),
        messageEvent(deleted.message),
        runEvent(deleted.run),
        threadEvent(settled.thread),
        runEvent({
          ...settled.run,
          delegatedCompletion: { disposition: "stopped", nextGeneration: 2, delivery: null },
        }),
      ];
      yield* Effect.forEach(events, store.apply, { discard: true });
      assert.deepEqual(yield* store.getDelegatedCompletionRecoveryThreadIds(), [
        archived.threadId,
        messageOnly.threadId,
        runOnly.threadId,
      ]);

      yield* store.apply(
        runEvent({
          ...runOnly.run,
          delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
        }),
      );
      yield* store.apply(messageEvent(ordinary.message));
      assert.deepEqual(yield* store.getDelegatedCompletionRecoveryThreadIds(), [
        archived.threadId,
        messageOnly.threadId,
        ordinary.threadId,
      ]);
    }).pipe(Effect.provide(layer)),
  );
}

const startupDependencies = Layer.mergeAll(
  Layer.mock(CheckpointServiceV2)({}),
  Layer.mock(CommandPolicyV2)({}),
  Layer.mock(CommandReceiptStoreV2)({}),
  Layer.mock(ContextHandoffServiceV2)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderSessionManagerV2)({}),
  Layer.mock(ProviderSwitchServiceV2)({}),
  Layer.mock(RuntimePolicyV2)({}),
  Layer.mock(ThreadForkServiceV2)({}),
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "pathway-delegated-recovery-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("SQLite: a malformed payload does not hide other recovery candidates", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const healthy = fixture("healthy");
    const badMessage = fixture("bad-message");
    const badRun = fixture("bad-run");
    yield* Effect.forEach(
      [
        threadEvent(healthy.thread),
        messageEvent(healthy.message),
        threadEvent(badMessage.thread),
        messageEvent(badMessage.message),
        threadEvent(badRun.thread),
        runEvent(badRun.run),
      ],
      store.apply,
      { discard: true },
    );
    yield* sql`
      UPDATE orchestration_v2_projection_messages SET payload_json = '{'
      WHERE thread_id = ${badMessage.threadId}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{'
      WHERE thread_id = ${badRun.threadId}
    `;
    assert.lengthOf(yield* store.getThreadMetadata(), 3);
    assert.deepEqual(yield* store.getDelegatedCompletionRecoveryThreadIds(), [
      badMessage.threadId,
      badRun.threadId,
      healthy.threadId,
    ]);
  }).pipe(Effect.provide(storesLayer)),
);

for (const status of ["completed", "interrupted", "failed", "cancelled", "rolled_back"] as const) {
  it.effect(
    `startup reconciles ${status} archived deliveries and re-offers pending work without reading unrelated archived threads`,
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const sink = yield* EventSinkV2;
        const archived = fixture("startup-archived");
        const pending = fixture("startup-pending");
        const ordinary = fixture("startup-ordinary");
        const providerThreadId = ProviderThreadId.make("provider-thread:startup-pending");
        const deliveryRun: OrchestrationV2Run = {
          ...archived.run,
          id: RunId.make("run:startup-delivery"),
          ordinal: 2,
          userMessageId: archived.message.id,
          status,
          delegatedCompletion: undefined,
        };
        yield* sink.write({
          events: [
            threadEvent({ ...archived.thread, archivedAt: now }),
            runEvent(archived.run),
            messageEvent(archived.message),
            runEvent(deliveryRun),
            {
              id: EventId.make("event:startup-archived:task"),
              type: "subagent.updated",
              threadId: archived.threadId,
              occurredAt: now,
              payload: {
                id: archived.message.delegatedCompletion!.taskIds[0]!,
                threadId: archived.threadId,
                runId: archived.run.id,
                parentNodeId: NodeId.make("node:startup-archived:parent"),
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Recover the delegated result",
                title: null,
                model: null,
                completionWake: "always",
                completionDelivery: { state: "claimed", observedByRunId: null },
                status: "completed",
                result: "Finished",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
            threadEvent(pending.thread),
            runEvent({ ...pending.run, providerThreadId }),
            {
              id: EventId.make("event:startup-pending:provider-thread"),
              type: "provider-thread.updated",
              threadId: pending.threadId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver,
                providerInstanceId,
                providerSessionId: null,
                appThreadId: pending.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:pending", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            threadEvent({ ...ordinary.thread, archivedAt: now }),
            messageEvent({ ...ordinary.message, delegatedCompletion: undefined }),
          ],
        });
        const reads: Array<ThreadId> = [];
        const offers: Array<ProviderContinuationRequest> = [];
        const restart = OrchestratorV2.pipe(
          Effect.asVoid,
          Effect.provide(orchestratorLayer.pipe(Layer.provide(startupDependencies))),
          Effect.provideService(ProjectionStoreV2, {
            ...store,
            getThreadProjection: (threadId) =>
              Effect.sync(() => reads.push(threadId)).pipe(
                Effect.andThen(store.getThreadProjection(threadId)),
              ),
          }),
          // All input events predate startup. Only the startup pass should repair
          // them in this test, without a concurrent live terminal-event subscriber.
          Effect.provideService(EventSinkV2, { ...sink, stream: () => Stream.never }),
          Effect.provideService(ProviderContinuationRequests, {
            offer: (request) =>
              Effect.sync(() => {
                offers.push(request);
              }),
            take: Effect.never,
          }),
        );
        yield* restart;
        assert.notInclude(reads, ordinary.threadId);
        const repaired = yield* store.getThreadProjection(archived.threadId);
        assert.deepEqual(repaired.runs[0]?.delegatedCompletion, {
          disposition: "open",
          nextGeneration: 2,
          settledDeliveryCount: 1,
          delivery: null,
        });
        assert.deepEqual(repaired.subagents[0]?.completionDelivery, {
          state: status === "cancelled" ? "pending" : "delivered",
          observedByRunId: null,
        });
        assert.equal(offers.length, 1);
        assert.equal(offers[0]?.threadId, pending.threadId);
        assert.equal(offers[0]?.delegatedCompletion?.messageId, pending.message.id);

        yield* sink.write({ events: [messageEvent(pending.message)] });
        yield* restart;
        assert.equal(offers.length, 1, "a persisted delivery message must not be offered again");
        const afterRestart = yield* store.getThreadProjection(archived.threadId);
        assert.deepEqual(
          afterRestart.runs[0]?.delegatedCompletion,
          repaired.runs[0]?.delegatedCompletion,
        );
        assert.notInclude(reads, ordinary.threadId);
      }).pipe(Effect.provide(eventSinkLayer.pipe(Layer.provideMerge(storesLayer)))),
  );
}
