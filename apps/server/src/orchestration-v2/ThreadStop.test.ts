import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DelegatedCompletionCohort,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-orchestration-v2-thread-stop-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by thread stop tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
).pipe(
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

interface SeedRun {
  readonly id: RunId;
  readonly status: "running" | "completed";
  /** A running run without an attempt cannot be interrupted. */
  readonly withoutAttempt?: boolean;
  readonly delegatedCompletion?: OrchestrationV2DelegatedCompletionCohort;
}

interface SeedTask {
  readonly id: NodeId;
  readonly runId: RunId;
  readonly childThreadId: ThreadId;
  readonly delivery: "pending" | "claimed" | "delivered";
}

const rootNodeOf = (runId: RunId) => NodeId.make(`node:root:${runId}`);

/** Seeds a thread whose runs never reached a provider turn, so Stop needs no provider session. */
const seedThread = (input: {
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<SeedRun>;
  readonly tasks?: ReadonlyArray<SeedTask>;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make(`project:${input.threadId}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${input.threadId}`);
    yield* (yield* OrchestrationEngineService).dispatch({
      type: "project.create",
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId,
      title: "Thread stop",
      workspaceRoot: `/workspace/${input.threadId}`,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: DateTime.formatIso(now),
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId,
      title: "Thread stop",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const event = (id: string) => ({
      id: EventId.make(`event:${input.threadId}:${id}`),
      threadId: input.threadId,
      occurredAt: now,
    });
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        ...event("provider-thread"),
        type: "provider-thread.updated",
        driver,
        providerInstanceId: modelSelection.instanceId,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: input.threadId,
          ownerNodeId: rootNodeOf(input.runs[0]!.id),
          nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: input.runs.length,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ];
    input.runs.forEach((run, index) => {
      const running = run.status === "running";
      const attemptId = RunAttemptId.make(`attempt:${run.id}`);
      const rootNodeId = rootNodeOf(run.id);
      events.push({
        ...event(`node:${run.id}`),
        type: "node.updated",
        payload: {
          id: rootNodeId,
          threadId: input.threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: running ? "running" : "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: running ? null : now,
        },
      });
      if (running && run.withoutAttempt !== true) {
        events.push({
          ...event(`attempt:${run.id}`),
          type: "run-attempt.updated",
          payload: {
            id: attemptId,
            runId: run.id,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId,
            providerTurnId: null,
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
      }
      events.push({
        ...event(`run:${run.id}`),
        type: "run.updated",
        runId: run.id,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        payload: {
          id: run.id,
          threadId: input.threadId,
          ordinal: index + 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:${run.id}`),
          rootNodeId,
          activeAttemptId: running && run.withoutAttempt !== true ? attemptId : null,
          status: run.status,
          requestedAt: now,
          startedAt: now,
          completedAt: running ? null : now,
          checkpointId: null,
          contextHandoffId: null,
          ...(run.delegatedCompletion === undefined
            ? {}
            : { delegatedCompletion: run.delegatedCompletion }),
        },
      });
    });
    for (const task of input.tasks ?? []) {
      events.push({
        ...event(`task:${task.id}`),
        type: "subagent.updated",
        runId: task.runId,
        nodeId: task.id,
        driver,
        providerInstanceId: modelSelection.instanceId,
        payload: {
          id: task.id,
          threadId: input.threadId,
          runId: task.runId,
          parentNodeId: rootNodeOf(task.runId),
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: task.childThreadId,
          nativeTaskRef: null,
          prompt: "Delegated work.",
          title: null,
          model: null,
          completionWake: "always",
          completionDelivery: { state: task.delivery, observedByRunId: null },
          status: task.delivery === "pending" ? "running" : "completed",
          result: task.delivery === "pending" ? null : "done",
          startedAt: now,
          completedAt: task.delivery === "pending" ? null : now,
          updatedAt: now,
        },
      });
    }
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events,
    });
  });

const openCohort = (
  delivery: OrchestrationV2DelegatedCompletionCohort["delivery"] = null,
): OrchestrationV2DelegatedCompletionCohort => ({
  disposition: "open",
  nextGeneration: delivery === null ? 1 : delivery.generation + 1,
  settledDeliveryCount: 0,
  delivery,
});

const runOf = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* OrchestratorV2).getThreadProjection(threadId);
    return projection.runs.find((run) => run.id === runId) as OrchestrationV2Run;
  });

/** Runs queued effects, including the Stop walk each stopped thread enqueues, until none remain. */
const drainEffects = Effect.gen(function* () {
  const worker = yield* OrchestrationEffectWorkerV2;
  while ((yield* worker.drain()) > 0) {
    // Each drained walk can enqueue the next level's.
  }
});

it.layer(TestLayer)("Stop on a thread", (it) => {
  it.effect("stops the delegated tree and drops every wake the thread is owed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threads = yield* ThreadManagementService;
      const parent = ThreadId.make("thread:stop-tree-parent");
      const earlierRun = RunId.make("run:stop-tree-parent-earlier");
      const parentRun = RunId.make("run:stop-tree-parent-current");
      const busyChild = ThreadId.make("thread:stop-tree-busy-child");
      const busyChildRun = RunId.make("run:stop-tree-busy-child");
      const idleChild = ThreadId.make("thread:stop-tree-idle-child");
      const idleChildRun = RunId.make("run:stop-tree-idle-child");
      const grandchild = ThreadId.make("thread:stop-tree-grandchild");
      const grandchildRun = RunId.make("run:stop-tree-grandchild");
      const idleGrandchild = ThreadId.make("thread:stop-tree-idle-grandchild");
      const idleGrandchildRun = RunId.make("run:stop-tree-idle-grandchild");
      const earlierTask = NodeId.make("node:stop-tree-earlier-task");
      const wakeMessage = MessageId.make("message:stop-tree-wake");

      yield* seedThread({ threadId: grandchild, runs: [{ id: grandchildRun, status: "running" }] });
      yield* seedThread({
        threadId: idleGrandchild,
        runs: [{ id: idleGrandchildRun, status: "running" }],
      });
      yield* seedThread({
        threadId: busyChild,
        runs: [{ id: busyChildRun, status: "running", delegatedCompletion: openCohort() }],
        tasks: [
          {
            id: NodeId.make("node:stop-tree-grandchild-task"),
            runId: busyChildRun,
            childThreadId: grandchild,
            delivery: "pending",
          },
        ],
      });
      // An idle child owes nothing and has nothing running, but what it delegated still runs.
      yield* seedThread({
        threadId: idleChild,
        runs: [{ id: idleChildRun, status: "completed" }],
        tasks: [
          {
            id: NodeId.make("node:stop-tree-idle-grandchild-task"),
            runId: idleChildRun,
            childThreadId: idleGrandchild,
            delivery: "delivered",
          },
        ],
      });
      yield* seedThread({
        threadId: parent,
        runs: [
          {
            id: earlierRun,
            status: "completed",
            delegatedCompletion: openCohort({
              generation: 1,
              messageId: wakeMessage,
              taskIds: [earlierTask],
            }),
          },
          { id: parentRun, status: "running", delegatedCompletion: openCohort() },
        ],
        tasks: [
          { id: earlierTask, runId: earlierRun, childThreadId: idleChild, delivery: "claimed" },
          {
            id: NodeId.make("node:stop-tree-busy-task"),
            runId: parentRun,
            childThreadId: busyChild,
            delivery: "pending",
          },
        ],
      });
      // The wake an earlier run's task already earned waits behind the running turn.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:stop-tree-wake"),
        threadId: parent,
        messageId: wakeMessage,
        text: `Delegated task ${earlierTask} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: { parentRunId: earlierRun, generation: 1, taskIds: [earlierTask] },
      });
      const queuedWake = (yield* orchestrator.getThreadProjection(parent)).runs.find(
        (run) => run.userMessageId === wakeMessage,
      );
      assert.equal(queuedWake?.status, "queued");

      const stop = {
        type: "run.interrupt",
        commandId: CommandId.make("command:stop-tree"),
        threadId: parent,
        runId: parentRun,
        stopDelegatedTasks: true,
      } as const;
      yield* orchestrator.dispatch(stop);

      const stopped = yield* orchestrator.getThreadProjection(parent);
      assert.equal(stopped.runs.find((run) => run.id === parentRun)?.status, "interrupted");
      assert.equal(
        stopped.runs.find((run) => run.id === earlierRun)?.delegatedCompletion?.disposition,
        "stopped",
      );
      assert.equal(stopped.runs.find((run) => run.id === queuedWake?.id)?.status, "cancelled");
      assert.deepEqual(
        stopped.subagents.map((task) => task.completionDelivery?.state),
        ["disposed", "disposed"],
      );

      yield* drainEffects;
      assert.equal((yield* runOf(busyChild, busyChildRun)).status, "interrupted");
      assert.equal((yield* runOf(grandchild, grandchildRun)).status, "interrupted");
      assert.equal((yield* runOf(idleChild, idleChildRun)).status, "completed");
      assert.equal((yield* runOf(idleGrandchild, idleGrandchildRun)).status, "interrupted");
      assert.equal(
        (yield* runOf(busyChild, busyChildRun)).delegatedCompletion?.disposition,
        "stopped",
      );

      // A retried walk and a replayed Stop change nothing.
      const sequences = yield* Effect.forEach(
        [parent, busyChild, idleChild, grandchild, idleGrandchild],
        (threadId) => threads.getThreadEventSequence(threadId),
      );
      yield* orchestrator.dispatch(stop);
      yield* threads.stopDelegatedTasks({ threadId: parent, commandId: stop.commandId });
      yield* drainEffects;
      assert.deepEqual(
        yield* Effect.forEach(
          [parent, busyChild, idleChild, grandchild, idleGrandchild],
          (threadId) => threads.getThreadEventSequence(threadId),
        ),
        sequences,
      );
    }),
  );

  it.effect("leaves delegated tasks running on a plain interrupt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const parent = ThreadId.make("thread:plain-interrupt-parent");
      const parentRun = RunId.make("run:plain-interrupt-parent");
      const child = ThreadId.make("thread:plain-interrupt-child");
      const childRun = RunId.make("run:plain-interrupt-child");
      yield* seedThread({ threadId: child, runs: [{ id: childRun, status: "running" }] });
      yield* seedThread({
        threadId: parent,
        runs: [{ id: parentRun, status: "running", delegatedCompletion: openCohort() }],
        tasks: [
          {
            id: NodeId.make("node:plain-interrupt-task"),
            runId: parentRun,
            childThreadId: child,
            delivery: "pending",
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("command:plain-interrupt"),
        threadId: parent,
        runId: parentRun,
      });
      yield* drainEffects;

      assert.equal((yield* runOf(parent, parentRun)).status, "interrupted");
      assert.equal((yield* runOf(child, childRun)).status, "running");
    }),
  );

  it.effect("tries every delegated task before failing on one it cannot stop", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const parent = ThreadId.make("thread:stop-partial-parent");
      const parentRun = RunId.make("run:stop-partial-parent");
      const stuck = ThreadId.make("thread:stop-partial-stuck");
      const stuckRun = RunId.make("run:stop-partial-stuck");
      const sibling = ThreadId.make("thread:stop-partial-sibling");
      const siblingRun = RunId.make("run:stop-partial-sibling");
      yield* seedThread({
        threadId: stuck,
        runs: [{ id: stuckRun, status: "running", withoutAttempt: true }],
      });
      yield* seedThread({ threadId: sibling, runs: [{ id: siblingRun, status: "running" }] });
      yield* seedThread({
        threadId: parent,
        runs: [{ id: parentRun, status: "completed" }],
        tasks: [
          {
            id: NodeId.make("node:stop-partial-stuck"),
            runId: parentRun,
            childThreadId: stuck,
            delivery: "delivered",
          },
          {
            id: NodeId.make("node:stop-partial-sibling"),
            runId: parentRun,
            childThreadId: sibling,
            delivery: "delivered",
          },
        ],
      });

      const failure = yield* threads
        .stopDelegatedTasks({
          threadId: parent,
          commandId: CommandId.make("command:stop-partial"),
        })
        .pipe(Effect.flip);
      assert.include(String(failure.cause), "no active attempt");
      assert.equal((yield* runOf(sibling, siblingRun)).status, "interrupted");
      assert.equal((yield* runOf(stuck, stuckRun)).status, "running");
    }),
  );

  it.effect("refuses a delegation from a run that was asked to stop", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const parent = ThreadId.make("thread:stopping-delegation");
      const parentRun = RunId.make("run:stopping-delegation");
      yield* seedThread({ threadId: parent, runs: [{ id: parentRun, status: "running" }] });
      const now = yield* DateTime.now;
      // The interrupt request a provider-backed Stop records while its turn winds down.
      yield* (yield* EventSinkV2).write({
        commandId: CommandId.make("command:stopping-delegation-request"),
        events: [
          {
            id: EventId.make("event:stopping-delegation-request"),
            type: "turn-item.updated",
            threadId: parent,
            runId: parentRun,
            nodeId: rootNodeOf(parentRun),
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:stopping-delegation-request"),
              threadId: parent,
              runId: parentRun,
              nodeId: rootNodeOf(parentRun),
              providerThreadId: ProviderThreadId.make(`provider-thread:${parent}`),
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: "Interrupt requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "run_interrupt_request",
              message: "Interrupt requested",
            },
          },
        ],
      });

      const error = yield* orchestrator
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:stopping-delegation"),
          parentThreadId: parent,
          parentRunId: parentRun,
          parentNodeId: rootNodeOf(parentRun),
          task: "Start late work.",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
        })
        .pipe(Effect.flip);
      assert.include(String("cause" in error ? error.cause : error), "is stopping");
    }),
  );
});
