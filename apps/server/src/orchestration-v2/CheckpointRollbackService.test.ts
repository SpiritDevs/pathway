import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackServiceLayer,
} from "./CheckpointRollbackService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreReadError, ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackThreadInput } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect("rejects a non-ready checkpoint before opening a session or restoring files", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("wraps underlying failures with an unexpected-failure reason and cause", () => {
  const threadId = ThreadId.make("thread:rollback-unexpected-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-unexpected-failure");
  const checkpointId = CheckpointId.make("checkpoint:rollback-unexpected-failure");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-unexpected-failure");
  const projectionError = new ProjectionStoreReadError({
    threadId,
    cause: new Error("database read failed"),
  });
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.fail(projectionError),
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to execute rollback target ${checkpointId} on provider thread ${providerThreadId} for thread ${threadId}.`,
    );
    assert.strictEqual(error.cause, projectionError);
  }).pipe(Effect.provide(testLayer));
});

it.effect("terminalizes every node in a stopped run being rolled back", () => {
  const threadId = ThreadId.make("thread:rollback-subtree");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-subtree");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-subtree");
  const checkpointId = CheckpointId.make("checkpoint:rollback-subtree");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-subtree");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_subtree");
  const runId = RunId.make("run:rollback-subtree");
  const rootNodeId = NodeId.make("node:rollback-subtree:root");
  const childNodeId = NodeId.make("node:rollback-subtree:child");
  const now = DateTime.makeUnsafe("2026-08-12T00:00:00.000Z");
  const providerThread = {
    id: providerThreadId,
    threadId,
    providerSessionId,
    providerInstanceId,
    driver: "codex",
    lastRunOrdinal: 1,
  };
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    checkpoints: [
      {
        id: checkpointId,
        scopeId,
        status: "ready",
        appRunOrdinal: 0,
        runId: null,
        nodeId: null,
      },
    ],
    checkpointScopes: [{ id: scopeId }],
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        rootNodeId,
        status: "interrupted",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        status: "completed",
      },
      {
        id: childNodeId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        rootNodeId,
        status: "running",
      },
    ],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let writtenEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [];
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () => Effect.void,
          deleteStaleRefs: () => Effect.void,
        }),
        Layer.mock(EventSinkV2)({
          write: ({ events }) => {
            writtenEvents = events;
            return Effect.succeed([]);
          },
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: () => Effect.succeed({ providerThread }),
            } as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });

    const rolledBackNodeIds = writtenEvents.flatMap((event) =>
      event.type === "node.updated" && event.payload.status === "rolled_back"
        ? [event.payload.id]
        : [],
    );
    assert.deepEqual(rolledBackNodeIds, [rootNodeId, childNodeId]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("excludes stale turns but retains cancelled turns on a repeated rollback", () => {
  const threadId = ThreadId.make("thread:rollback-repeated");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-repeated");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-repeated");
  const checkpointId = CheckpointId.make("checkpoint:rollback-repeated");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-repeated");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_repeated");
  const targetRunId = RunId.make("run:rollback-repeated:target");
  const staleRunId = RunId.make("run:rollback-repeated:stale");
  const cancelledRunId = RunId.make("run:rollback-repeated:cancelled");
  const currentRunId = RunId.make("run:rollback-repeated:current");
  const targetAttemptId = RunAttemptId.make("attempt:rollback-repeated:target");
  const staleAttemptId = RunAttemptId.make("attempt:rollback-repeated:stale");
  const cancelledAttemptId = RunAttemptId.make("attempt:rollback-repeated:cancelled");
  const currentAttemptId = RunAttemptId.make("attempt:rollback-repeated:current");
  const targetTurnId = ProviderTurnId.make("provider-turn:rollback-repeated:target");
  const staleTurnId = ProviderTurnId.make("provider-turn:rollback-repeated:stale");
  const cancelledTurnId = ProviderTurnId.make("provider-turn:rollback-repeated:cancelled");
  const currentTurnId = ProviderTurnId.make("provider-turn:rollback-repeated:current");
  const targetNodeId = NodeId.make("node:rollback-repeated:target");
  const staleNodeId = NodeId.make("node:rollback-repeated:stale");
  const cancelledNodeId = NodeId.make("node:rollback-repeated:cancelled");
  const currentNodeId = NodeId.make("node:rollback-repeated:current");
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId,
    driver: "codex",
  };
  const providerTurn = (
    id: ProviderTurnId,
    runAttemptId: RunAttemptId,
    nodeId: NodeId,
    ordinal: number,
  ) => ({
    id,
    providerThreadId,
    runAttemptId,
    nodeId,
    ordinal,
    status: "completed",
  });
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    checkpoints: [
      {
        id: checkpointId,
        scopeId,
        status: "ready",
        appRunOrdinal: 1,
        runId: targetRunId,
        nodeId: targetNodeId,
      },
    ],
    checkpointScopes: [{ id: scopeId }],
    runs: [
      {
        id: targetRunId,
        ordinal: 1,
        activeAttemptId: targetAttemptId,
        providerInstanceId,
        rootNodeId: targetNodeId,
        status: "completed",
      },
      {
        id: staleRunId,
        ordinal: 2,
        activeAttemptId: staleAttemptId,
        providerInstanceId,
        rootNodeId: staleNodeId,
        status: "rolled_back",
      },
      {
        id: cancelledRunId,
        ordinal: 3,
        activeAttemptId: cancelledAttemptId,
        providerInstanceId,
        rootNodeId: cancelledNodeId,
        status: "cancelled",
      },
      {
        id: currentRunId,
        ordinal: 4,
        activeAttemptId: currentAttemptId,
        providerInstanceId,
        rootNodeId: currentNodeId,
        status: "completed",
      },
    ],
    attempts: [
      { id: targetAttemptId, runId: targetRunId, providerTurnId: targetTurnId },
      { id: staleAttemptId, runId: staleRunId, providerTurnId: staleTurnId },
      {
        id: cancelledAttemptId,
        runId: cancelledRunId,
        providerTurnId: cancelledTurnId,
      },
      { id: currentAttemptId, runId: currentRunId, providerTurnId: currentTurnId },
    ],
    nodes: [
      { id: targetNodeId, runId: targetRunId },
      { id: staleNodeId, runId: staleRunId },
      { id: cancelledNodeId, runId: cancelledRunId },
      { id: currentNodeId, runId: currentRunId },
    ],
    providerTurns: [
      providerTurn(targetTurnId, targetAttemptId, targetNodeId, 1),
      providerTurn(staleTurnId, staleAttemptId, staleNodeId, 2),
      providerTurn(cancelledTurnId, cancelledAttemptId, cancelledNodeId, 3),
      providerTurn(currentTurnId, currentAttemptId, currentNodeId, 4),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const repeatedProjection = {
    ...projection,
    runs: projection.runs.map((run) =>
      run.id === cancelledRunId || run.id === currentRunId
        ? { ...run, status: "rolled_back" as const }
        : run,
    ),
  };
  const rollbackInputs: Array<ProviderAdapterV2RollbackThreadInput> = [];
  let writtenEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [];
  let projectionReadCount = 0;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () => Effect.void,
          deleteStaleRefs: () => Effect.void,
        }),
        Layer.mock(EventSinkV2)({
          write: ({ events }) => {
            writtenEvents = [...writtenEvents, ...events];
            return Effect.succeed([]);
          },
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.succeed(projectionReadCount++ === 0 ? projection : repeatedProjection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) => {
                rollbackInputs.push(input);
                return Effect.succeed({ providerThread });
              },
            } as never),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });

    assert.deepEqual(
      rollbackInputs[0]?.providerThreadTurns.map((turn) => turn.id),
      [targetTurnId, cancelledTurnId, currentTurnId],
    );
    assert.lengthOf(rollbackInputs, 1);
    assert.deepEqual(
      writtenEvents.flatMap((event) =>
        event.type === "run.updated" && event.payload.status === "rolled_back"
          ? [event.payload.id]
          : [],
      ),
      [cancelledRunId, currentRunId],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect("stales checkpoints thread-wide and deletes refs under each checkpoint's scope", () => {
  const threadId = ThreadId.make("thread:rollback-cross-scope");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-cross-scope");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-cross-scope");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_cross_scope");
  const targetScopeId = CheckpointScopeId.make("checkpoint-scope:rollback-cross-scope:target");
  const otherScopeId = CheckpointScopeId.make("checkpoint-scope:rollback-cross-scope:other");
  const targetCheckpointId = CheckpointId.make("checkpoint:rollback-cross-scope:target");
  const staleTargetScopeCheckpointId = CheckpointId.make(
    "checkpoint:rollback-cross-scope:stale-target-scope",
  );
  const staleOtherScopeCheckpointId = CheckpointId.make(
    "checkpoint:rollback-cross-scope:stale-other-scope",
  );
  const retainedOtherScopeCheckpointId = CheckpointId.make(
    "checkpoint:rollback-cross-scope:retained-other-scope",
  );
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId,
    driver: "codex",
  };
  const targetScope = { id: targetScopeId, cwd: "/workspace/target" };
  const otherScope = { id: otherScopeId, cwd: "/workspace/other" };
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    checkpoints: [
      {
        id: targetCheckpointId,
        scopeId: targetScopeId,
        status: "ready",
        appRunOrdinal: 0,
        runId: null,
        nodeId: NodeId.make("node:rollback-cross-scope:target"),
      },
      {
        id: staleTargetScopeCheckpointId,
        scopeId: targetScopeId,
        status: "ready",
        appRunOrdinal: 1,
        runId: RunId.make("run:rollback-cross-scope:target"),
        nodeId: NodeId.make("node:rollback-cross-scope:stale-target"),
      },
      {
        id: staleOtherScopeCheckpointId,
        scopeId: otherScopeId,
        status: "ready",
        appRunOrdinal: 2,
        runId: RunId.make("run:rollback-cross-scope:other"),
        nodeId: NodeId.make("node:rollback-cross-scope:stale-other"),
      },
      {
        id: retainedOtherScopeCheckpointId,
        scopeId: otherScopeId,
        status: "ready",
        appRunOrdinal: 0,
        runId: null,
        nodeId: NodeId.make("node:rollback-cross-scope:retained-other"),
      },
    ],
    checkpointScopes: [targetScope, otherScope],
    runs: [],
    nodes: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const deletedRefs: Array<{
    scopeId: CheckpointScopeId;
    checkpointIds: ReadonlyArray<CheckpointId>;
  }> = [];
  let writtenEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [];
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () => Effect.void,
          deleteStaleRefs: ({ scope, checkpoints }) =>
            Effect.sync(() => {
              deletedRefs.push({
                scopeId: scope.id,
                checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
              });
            }),
        }),
        Layer.mock(EventSinkV2)({
          write: ({ events }) => {
            writtenEvents = events;
            return Effect.succeed([]);
          },
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    yield* service.execute({
      threadId,
      providerThreadId,
      checkpointId: targetCheckpointId,
      scopeId: targetScopeId,
    });

    assert.deepEqual(deletedRefs, [
      { scopeId: targetScopeId, checkpointIds: [staleTargetScopeCheckpointId] },
      { scopeId: otherScopeId, checkpointIds: [staleOtherScopeCheckpointId] },
    ]);
    const staleCheckpointIds = writtenEvents.flatMap((event) =>
      event.type === "checkpoint.captured" && event.payload.status === "stale"
        ? [event.payload.id]
        : [],
    );
    assert.deepEqual(staleCheckpointIds, [
      staleTargetScopeCheckpointId,
      staleOtherScopeCheckpointId,
    ]);
  }).pipe(Effect.provide(testLayer));
});
