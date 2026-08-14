import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2BrowserTakeoverStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  PreviewTakeoverFenceError,
  type PreviewTakeoverLease,
} from "../mcp/PreviewAutomationTakeover.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  BROWSER_TAKEOVER_CONTINUATION_TEXT,
  BrowserTakeoverFenceRegistry,
  BrowserTakeoverService,
  type BrowserTakeoverFenceShape,
  type BrowserTakeoverRearmInput,
  fenceRegistryLayer,
  layer as browserTakeoverLayer,
} from "./BrowserTakeoverService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:browser-takeover");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

/**
 * Provider execution never runs in these tests: the effect worker is off, so a
 * run stops at "starting" and `run.interrupt` finalizes it synchronously. That
 * keeps the whole takeover state machine observable without a single sleep.
 */
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider sessions are not opened in browser takeover tests"),
} as ProviderAdapterV2Shape;

const defaultLease: PreviewTakeoverLease = {
  hostClientId: "host-client-1",
  hostConnectionId: "host-connection-1",
  tabId: "tab-1",
};

type FenceReason = PreviewTakeoverFenceError["reason"];

interface FenceProbe {
  readonly layer: Layer.Layer<BrowserTakeoverFenceRegistry>;
  readonly calls: ReadonlyArray<string>;
  readonly failAcquire: (reason: FenceReason) => void;
  /** Runs inside `acquire` before it answers, so a test can stall there. */
  readonly gateAcquire: (gate: Effect.Effect<void>) => void;
}

/** Programmable stand-in for the preview automation fence. */
function makeFenceProbe(): FenceProbe {
  const calls: Array<string> = [];
  let acquireFailure: FenceReason | null = null;
  let acquireGate: Effect.Effect<void> = Effect.void;
  const fence: BrowserTakeoverFenceShape = {
    acquire: (input) =>
      Effect.suspend(() => {
        calls.push(`acquire:${input.takeoverId}`);
        return acquireGate.pipe(
          Effect.andThen(() =>
            acquireFailure === null
              ? Effect.succeed(defaultLease)
              : Effect.fail(
                  new PreviewTakeoverFenceError({
                    reason: acquireFailure,
                    threadId: input.threadId,
                    takeoverId: input.takeoverId,
                  }),
                ),
          ),
        );
      }),
    release: (input) =>
      Effect.sync(() => {
        calls.push(`release:${input.takeoverId}`);
      }),
    rearm: (input) =>
      Effect.sync(() => {
        calls.push(`rearm:${input.takeoverId}:${input.hostClientId}:${input.tabId}`);
      }),
  };
  return {
    layer: Layer.succeed(
      BrowserTakeoverFenceRegistry,
      BrowserTakeoverFenceRegistry.of({
        current: Effect.succeed(fence),
        set: () => Effect.void,
      }),
    ),
    calls,
    failAcquire: (reason) => {
      acquireFailure = reason;
    },
    gateAcquire: (gate) => {
      acquireGate = gate;
    },
  };
}

function makeHarness() {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "browser-takeover" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const fence = makeFenceProbe();
  const takeover = browserTakeoverLayer.pipe(
    Layer.provide(Layer.merge(threadManagement, fence.layer)),
  );
  return {
    layer: Layer.mergeAll(threadManagement, takeover, outbox, database),
    fence,
  };
}

function createThread(name: string) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(`thread:takeover:${name}`);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:takeover:${name}:create`),
      threadId,
      projectId,
      title: "Browser takeover",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

/**
 * Starts a turn and leaves it at "starting": eligible for a takeover, and
 * interruptible without a provider round trip.
 */
function startRun(name: string, threadId: ThreadId) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:takeover:${name}:send`),
      threadId,
      messageId: MessageId.make(`message:takeover:${name}:send`),
      text: "Drive the preview browser for me.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* threads.getThreadProjection(threadId);
    const run = projection.runs.at(-1);
    assert.equal(run?.status, "starting");
    return run as NonNullable<typeof run>;
  });
}

function recordActivity(input: {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly suffix?: string;
  readonly tabId?: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads
      .dispatch({
        type: "thread.preview-activity.record",
        commandId: CommandId.make(`command:takeover:${input.name}:activity${input.suffix ?? ""}`),
        threadId: input.threadId,
        runId: null,
        providerSessionId: "provider-session-1",
        tabId: input.tabId ?? "tab-1",
        hostClientId: "host-client-1",
      })
      .pipe(Effect.result);
  });
}

function requestTakeover(input: {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly suffix?: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const takeoverId = CommandId.make(
      `command:takeover:${input.name}:request${input.suffix ?? ""}`,
    );
    const outcome = yield* threads
      .dispatch({
        type: "thread.browser-takeover.request",
        commandId: takeoverId,
        threadId: input.threadId,
      })
      .pipe(Effect.result);
    return { takeoverId, outcome };
  });
}

type TransitionTarget = "pausing" | "active" | "completed" | "cancelled" | "failed";

function transitionTo(input: {
  readonly threadId: ThreadId;
  readonly takeoverId: CommandId;
  readonly commandId: string;
  readonly to: TransitionTarget;
  readonly failure?: "no_live_host" | "continuation_failed";
  readonly lease?: PreviewTakeoverLease;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads
      .dispatch({
        type: "thread.browser-takeover.transition",
        commandId: CommandId.make(input.commandId),
        threadId: input.threadId,
        takeoverId: input.takeoverId,
        to: input.to,
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        ...(input.lease === undefined
          ? {}
          : {
              hostClientId: input.lease.hostClientId,
              hostConnectionId: input.lease.hostConnectionId,
              tabId: input.lease.tabId,
            }),
      })
      .pipe(Effect.result);
  });
}

/** Rejections carry their reason on `cause`, not in the tagged error message. */
function assertRejected(failure: OrchestratorV2Error, detail: string) {
  assert.equal(failure._tag, "OrchestratorDispatchError");
  if (failure._tag !== "OrchestratorDispatchError") return;
  assert.include(String(failure.cause), detail);
}

function markerOf(threadId: ThreadId) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projection = yield* threads.getThreadProjection(threadId);
    return projection.thread.browserTakeover ?? null;
  });
}

/** Drives a fresh thread's marker to `status` using only legal commands. */
function driveMarkerTo(input: {
  readonly name: string;
  readonly status: OrchestrationV2BrowserTakeoverStatus;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* createThread(input.name);
    const run = yield* startRun(input.name, threadId);
    const { takeoverId } = yield* requestTakeover({ name: input.name, threadId });
    if (input.status !== "requested") {
      // Every state past "requested" is only reachable after the live run was
      // paused, so mirror that here instead of leaving a phantom active turn.
      yield* threads.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`command:takeover:${input.name}:drive:interrupt`),
        threadId,
        runId: run.id,
        reason: "Paused so the user can drive the browser.",
      });
    }
    const step = (to: TransitionTarget) =>
      transitionTo({
        threadId,
        takeoverId,
        commandId: `command:takeover:${input.name}:drive:${to}`,
        to,
        ...(to === "failed" ? { failure: "no_live_host" as const } : {}),
        ...(to === "active" ? { lease: defaultLease } : {}),
      });
    const proceed = () =>
      threads.dispatch({
        type: "thread.browser-takeover.proceed",
        commandId: CommandId.make(`command:takeover:${input.name}:drive:proceed`),
        threadId,
        takeoverId,
      });
    switch (input.status) {
      case "requested":
        break;
      case "pausing":
        yield* step("pausing");
        break;
      case "failed":
        yield* step("failed");
        break;
      case "active":
        yield* step("pausing");
        yield* step("active");
        break;
      case "cancelled":
        yield* step("pausing");
        yield* step("active");
        yield* step("cancelled");
        break;
      case "proceeding":
        yield* step("pausing");
        yield* step("active");
        yield* proceed();
        break;
      case "completed":
        yield* step("pausing");
        yield* step("active");
        yield* proceed();
        yield* step("completed");
        break;
    }
    const marker = yield* markerOf(threadId);
    assert.equal(marker?.status, input.status);
    return { threadId, takeoverId };
  });
}

describe("browser takeover requests", () => {
  it.effect("rejects a request when no agent turn is running", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* createThread("idle");
        const { outcome } = yield* requestTakeover({ name: "idle", threadId });
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag !== "Failure") return;
        assertRejected(outcome.failure, "no running agent turn to pause");
        assert.isNull(yield* markerOf(threadId));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects a request once the run that was driving the browser finished", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread("finished");
        const run = yield* startRun("finished", threadId);
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:takeover:finished:interrupt"),
          threadId,
          runId: run.id,
          reason: "Finished before the takeover was requested.",
        });

        const { outcome } = yield* requestTakeover({ name: "finished", threadId });
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag !== "Failure") return;
        assertRejected(outcome.failure, "no running agent turn to pause");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "arms the marker from the last preview activity and enqueues the establish effect",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const threadId = yield* createThread("arm");
          const run = yield* startRun("arm", threadId);
          yield* recordActivity({ name: "arm", threadId });

          const { takeoverId } = yield* requestTakeover({ name: "arm", threadId });
          const marker = yield* markerOf(threadId);
          assert.equal(marker?.id, takeoverId);
          assert.equal(marker?.status, "requested");
          assert.equal(marker?.runId, run.id);
          assert.equal(marker?.providerSessionId, "provider-session-1");
          assert.equal(marker?.tabId, "tab-1");
          assert.equal(marker?.hostClientId, "host-client-1");
          assert.isNull(marker?.hostConnectionId ?? null);
          assert.isNull(marker?.failure ?? null);

          assert.deepEqual(
            (yield* outbox.listByCommandId(takeoverId)).map((effect) => effect.request),
            [{ type: "browser-takeover.establish", takeoverId }],
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("absorbs a duplicate request and rejects a competing takeover", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread("duplicate");
        yield* startRun("duplicate", threadId);
        const { takeoverId } = yield* requestTakeover({ name: "duplicate", threadId });
        const armed = yield* markerOf(threadId);

        const replay = yield* requestTakeover({ name: "duplicate", threadId });
        assert.equal(replay.outcome._tag, "Success");
        assert.deepEqual(yield* markerOf(threadId), armed);
        assert.equal((yield* outbox.listByCommandId(takeoverId)).length, 1);

        const competing = yield* requestTakeover({
          name: "duplicate",
          threadId,
          suffix: ":second",
        });
        assert.equal(competing.outcome._tag, "Failure");
        if (competing.outcome._tag !== "Failure") return;
        assertRejected(competing.outcome.failure, "already has an active browser takeover");
        assert.deepEqual(yield* markerOf(threadId), armed);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("browser takeover establish", () => {
  it.effect("pauses the live run, stops its delegated cohort, and hands over the browser", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const threadId = yield* createThread("establish");
        const run = yield* startRun("establish", threadId);
        yield* threads.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("command:takeover:establish:delegate"),
          parentThreadId: threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId ?? NodeId.make("node:missing"),
          task: "Check the preview page while the parent keeps driving.",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "server",
        });
        const { takeoverId } = yield* requestTakeover({ name: "establish", threadId });

        yield* takeover.establish({
          threadId,
          takeoverId,
          attemptId: CommandId.make("attempt:establish:1"),
        });

        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`]);
        const marker = yield* markerOf(threadId);
        assert.equal(marker?.status, "active");
        assert.equal(marker?.hostClientId, defaultLease.hostClientId);
        assert.equal(marker?.hostConnectionId, defaultLease.hostConnectionId);
        assert.equal(marker?.tabId, defaultLease.tabId);
        assert.isNull(marker?.failure ?? null);

        const projection = yield* threads.getThreadProjection(threadId);
        const pausedRun = projection.runs.find((candidate) => candidate.id === run.id);
        assert.equal(pausedRun?.status, "interrupted");
        assert.equal(pausedRun?.delegatedCompletion?.disposition, "stopped");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("resumes an establish that was interrupted while pausing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const threadId = yield* createThread("resume");
        const run = yield* startRun("resume", threadId);
        const { takeoverId } = yield* requestTakeover({ name: "resume", threadId });
        // The outbox retries the same effect, so the retry carries the same
        // attempt id and the same derived command ids.
        const attemptId = CommandId.make("attempt:resume:1");

        const inAcquire = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        harness.fence.gateAcquire(
          Deferred.succeed(inAcquire, undefined).pipe(Effect.andThen(Deferred.await(held))),
        );
        const attempt = yield* Effect.forkChild(
          takeover.establish({ threadId, takeoverId, attemptId }),
        );
        yield* Deferred.await(inAcquire);
        yield* Fiber.interrupt(attempt);

        // Stranded exactly the way the finding describes: pausing, fence armed.
        assert.equal((yield* markerOf(threadId))?.status, "pausing");
        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`]);

        harness.fence.gateAcquire(Effect.void);
        yield* takeover.establish({ threadId, takeoverId, attemptId });

        const marker = yield* markerOf(threadId);
        assert.equal(marker?.status, "active");
        assert.equal(marker?.tabId, defaultLease.tabId);
        assert.isNull(marker?.failure ?? null);
        // Re-acquired rather than trusting the half-armed fence, and the run the
        // first attempt never got to interrupt is paused now.
        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`, `acquire:${takeoverId}`]);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.runs.find((candidate) => candidate.id === run.id)?.status,
          "interrupted",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ignores a pausing marker that belongs to a different takeover", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const takeover = yield* BrowserTakeoverService;
        const stranded = yield* driveMarkerTo({ name: "resume-stale", status: "pausing" });

        yield* takeover.establish({
          threadId: stranded.threadId,
          takeoverId: CommandId.make("command:takeover:resume-stale:other"),
          attemptId: CommandId.make("attempt:resume-stale:1"),
        });

        assert.deepEqual(harness.fence.calls, []);
        assert.equal((yield* markerOf(stranded.threadId))?.status, "pausing");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("releases the fence when no live preview host answered", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const takeover = yield* BrowserTakeoverService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread("no-host");
        const run = yield* startRun("no-host", threadId);
        const { takeoverId } = yield* requestTakeover({ name: "no-host", threadId });
        harness.fence.failAcquire("no_live_host");

        yield* takeover.establish({
          threadId,
          takeoverId,
          attemptId: CommandId.make("attempt:no-host:1"),
        });

        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`, `release:${takeoverId}`]);
        const marker = yield* markerOf(threadId);
        assert.equal(marker?.status, "failed");
        assert.equal(marker?.failure, "no_live_host");
        // The agent's turn is untouched: nothing was ever paused.
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.runs.find((candidate) => candidate.id === run.id)?.status,
          "starting",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the fence armed when the preview host disconnected mid-drain", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const takeover = yield* BrowserTakeoverService;
        const threadId = yield* createThread("disconnected");
        yield* startRun("disconnected", threadId);
        const { takeoverId } = yield* requestTakeover({ name: "disconnected", threadId });
        harness.fence.failAcquire("host_disconnected");

        yield* takeover.establish({
          threadId,
          takeoverId,
          attemptId: CommandId.make("attempt:disconnected:1"),
        });

        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`]);
        const marker = yield* markerOf(threadId);
        assert.equal(marker?.status, "failed");
        assert.equal(marker?.failure, "host_disconnected");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports already_finished when the run ends between request and fence", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const threadId = yield* createThread("raced");
        const run = yield* startRun("raced", threadId);
        const { takeoverId } = yield* requestTakeover({ name: "raced", threadId });
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:takeover:raced:interrupt"),
          threadId,
          runId: run.id,
          reason: "The agent finished on its own.",
        });

        yield* takeover.establish({
          threadId,
          takeoverId,
          attemptId: CommandId.make("attempt:raced:1"),
        });

        assert.deepEqual(harness.fence.calls, [`acquire:${takeoverId}`, `release:${takeoverId}`]);
        const marker = yield* markerOf(threadId);
        assert.equal(marker?.status, "failed");
        assert.equal(marker?.failure, "already_finished");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("browser takeover handback", () => {
  it.effect("proceeds once: one continuation message, one new run, fence released", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const { threadId, takeoverId } = yield* driveMarkerTo({
          name: "proceed",
          status: "active",
        });
        const before = yield* threads.getThreadProjection(threadId);

        const proceedCommandId = CommandId.make("command:takeover:proceed:handback");
        yield* threads.dispatch({
          type: "thread.browser-takeover.proceed",
          commandId: proceedCommandId,
          threadId,
          takeoverId,
        });
        assert.equal((yield* markerOf(threadId))?.status, "proceeding");
        assert.deepEqual(
          (yield* outbox.listByCommandId(proceedCommandId)).map((effect) => effect.request),
          [{ type: "browser-takeover.proceed", takeoverId }],
        );

        const step = { threadId, takeoverId, attemptId: proceedCommandId };
        yield* takeover.proceed(step);
        // A redelivered outbox effect must not send the continuation twice.
        yield* takeover.proceed(step);

        assert.deepEqual(harness.fence.calls, [`release:${takeoverId}`]);
        assert.equal((yield* markerOf(threadId))?.status, "completed");
        const after = yield* threads.getThreadProjection(threadId);
        const continuations = after.messages.filter(
          (message) => message.text === BROWSER_TAKEOVER_CONTINUATION_TEXT,
        );
        assert.equal(continuations.length, 1);
        assert.equal(continuations[0]?.createdBy, "user");
        assert.equal(after.runs.length, before.runs.length + 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("retries a continuation that could not be sent", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const { threadId, takeoverId } = yield* driveMarkerTo({
          name: "retry",
          status: "active",
        });

        yield* threads.dispatch({
          type: "thread.browser-takeover.proceed",
          commandId: CommandId.make("command:takeover:retry:proceed-1"),
          threadId,
          takeoverId,
        });
        // Archiving makes the continuation send fail the way a vanished thread
        // would, without stubbing the send path itself.
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:takeover:retry:archive"),
          threadId,
        });
        yield* takeover.proceed({
          threadId,
          takeoverId,
          attemptId: CommandId.make("command:takeover:retry:proceed-1"),
        });

        const failed = yield* markerOf(threadId);
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.failure, "continuation_failed");
        assert.isFalse(
          (yield* threads.getThreadProjection(threadId)).messages.some(
            (message) => message.text === BROWSER_TAKEOVER_CONTINUATION_TEXT,
          ),
        );

        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("command:takeover:retry:unarchive"),
          threadId,
        });
        yield* threads.dispatch({
          type: "thread.browser-takeover.proceed",
          commandId: CommandId.make("command:takeover:retry:proceed-2"),
          threadId,
          takeoverId,
        });
        yield* takeover.proceed({
          threadId,
          takeoverId,
          attemptId: CommandId.make("command:takeover:retry:proceed-2"),
        });

        assert.equal((yield* markerOf(threadId))?.status, "completed");
        assert.equal(
          (yield* threads.getThreadProjection(threadId)).messages.filter(
            (message) => message.text === BROWSER_TAKEOVER_CONTINUATION_TEXT,
          ).length,
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("releases without creating a run or a message", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const { threadId, takeoverId } = yield* driveMarkerTo({
          name: "release",
          status: "active",
        });
        const before = yield* threads.getThreadProjection(threadId);

        const releaseCommandId = CommandId.make("command:takeover:release:handback");
        yield* threads.dispatch({
          type: "thread.browser-takeover.release",
          commandId: releaseCommandId,
          threadId,
          takeoverId,
        });
        // The marker stays "active" until the fence is genuinely back.
        assert.equal((yield* markerOf(threadId))?.status, "active");
        assert.deepEqual(
          (yield* outbox.listByCommandId(releaseCommandId)).map((effect) => effect.request),
          [{ type: "browser-takeover.release", takeoverId }],
        );

        yield* takeover.release({ threadId, takeoverId, attemptId: releaseCommandId });

        assert.deepEqual(harness.fence.calls, [`release:${takeoverId}`]);
        assert.equal((yield* markerOf(threadId))?.status, "cancelled");
        const after = yield* threads.getThreadProjection(threadId);
        assert.equal(after.runs.length, before.runs.length);
        assert.equal(after.messages.length, before.messages.length);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ignores steps and transitions that name a superseded takeover", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const takeover = yield* BrowserTakeoverService;
        const { threadId, takeoverId } = yield* driveMarkerTo({
          name: "stale",
          status: "active",
        });
        const staleId = CommandId.make("command:takeover:stale:ghost");

        const staleTransition = yield* transitionTo({
          threadId,
          takeoverId: staleId,
          commandId: "command:takeover:stale:ghost-transition",
          to: "cancelled",
        });
        assert.equal(staleTransition._tag, "Failure");
        if (staleTransition._tag === "Failure") {
          assert.equal(staleTransition.failure._tag, "OrchestratorBrowserTakeoverStaleError");
        }

        // A stale step is a lost race, not an error: it stops without touching
        // the live takeover.
        yield* takeover.establish({
          threadId,
          takeoverId: staleId,
          attemptId: CommandId.make("attempt:stale:1"),
        });
        yield* takeover.proceed({
          threadId,
          takeoverId: staleId,
          attemptId: CommandId.make("attempt:stale:2"),
        });
        yield* takeover.release({
          threadId,
          takeoverId: staleId,
          attemptId: CommandId.make("attempt:stale:3"),
        });

        assert.deepEqual(harness.fence.calls, []);
        const marker = yield* markerOf(threadId);
        assert.equal(marker?.id, takeoverId);
        assert.equal(marker?.status, "active");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("browser takeover transition legality", () => {
  const statuses = [
    "requested",
    "pausing",
    "active",
    "proceeding",
    "completed",
    "cancelled",
    "failed",
  ] as const satisfies ReadonlyArray<OrchestrationV2BrowserTakeoverStatus>;
  const targets = ["pausing", "active", "completed", "cancelled", "failed"] as const;
  const legal = (from: OrchestrationV2BrowserTakeoverStatus, to: (typeof targets)[number]) => {
    switch (to) {
      case "pausing":
        return from === "requested";
      case "active":
        return from === "pausing";
      case "completed":
        return from === "proceeding";
      case "cancelled":
        return from !== "completed" && from !== "cancelled";
      case "failed":
        return from !== "completed" && from !== "cancelled";
    }
  };

  for (const from of statuses) {
    for (const to of targets) {
      const expected = legal(from, to);
      it.effect(`${expected ? "accepts" : "rejects"} ${from} -> ${to}`, () =>
        Effect.gen(function* () {
          const harness = makeHarness();
          yield* Effect.gen(function* () {
            const name = `matrix-${from}-${to}`;
            const { threadId, takeoverId } = yield* driveMarkerTo({ name, status: from });
            const outcome = yield* transitionTo({
              threadId,
              takeoverId,
              commandId: `command:takeover:${name}:attempt`,
              to,
              ...(to === "failed" ? { failure: "no_live_host" as const } : {}),
            });
            const marker = yield* markerOf(threadId);
            if (expected) {
              assert.equal(outcome._tag, "Success");
              assert.equal(marker?.status, to);
            } else {
              assert.equal(outcome._tag, "Failure");
              if (outcome._tag === "Failure") {
                assert.equal(outcome.failure._tag, "OrchestratorBrowserTakeoverStaleError");
              }
              assert.equal(marker?.status, from);
            }
          }).pipe(Effect.provide(harness.layer));
        }),
      );
    }
  }

  it.effect("requires a reason on a failing transition", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const { threadId, takeoverId } = yield* driveMarkerTo({
          name: "failure-reason",
          status: "requested",
        });
        const outcome = yield* transitionTo({
          threadId,
          takeoverId,
          commandId: "command:takeover:failure-reason:attempt",
          to: "failed",
        });
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag !== "Failure") return;
        assertRejected(outcome.failure, "must carry a failure reason");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("preview activity records", () => {
  it.effect("records a changed tuple and rejects an unchanged repeat", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread("activity");
        const run = yield* startRun("activity", threadId);
        const beforeUpdatedAt = (yield* threads.getThreadProjection(threadId)).thread.updatedAt;

        const first = yield* recordActivity({ name: "activity", threadId });
        assert.equal(first._tag, "Success");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.deepEqual(
          {
            runId: projection.thread.previewActivity?.runId,
            providerSessionId: projection.thread.previewActivity?.providerSessionId,
            tabId: projection.thread.previewActivity?.tabId,
            hostClientId: projection.thread.previewActivity?.hostClientId,
          },
          {
            runId: run.id,
            providerSessionId: "provider-session-1",
            tabId: "tab-1",
            hostClientId: "host-client-1",
          },
        );
        // Activity is agent telemetry, not thread activity.
        assert.deepEqual(projection.thread.updatedAt, beforeUpdatedAt);

        const repeat = yield* recordActivity({ name: "activity", threadId, suffix: ":2" });
        assert.equal(repeat._tag, "Failure");
        if (repeat._tag !== "Failure") return;
        assertRejected(repeat.failure, "preview activity is unchanged");

        const moved = yield* recordActivity({
          name: "activity",
          threadId,
          suffix: ":3",
          tabId: "tab-2",
        });
        assert.equal(moved._tag, "Success");
        assert.equal(
          (yield* threads.getThreadProjection(threadId)).thread.previewActivity?.tabId,
          "tab-2",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("browser takeover recovery", () => {
  it.effect("reconciles every marker that outlived the process", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const takeover = yield* BrowserTakeoverService;
        const requested = yield* driveMarkerTo({
          name: "recover-requested",
          status: "requested",
        });
        const pausing = yield* driveMarkerTo({ name: "recover-pausing", status: "pausing" });
        const active = yield* driveMarkerTo({ name: "recover-active", status: "active" });
        const sent = yield* driveMarkerTo({ name: "recover-sent", status: "proceeding" });
        const lost = yield* driveMarkerTo({ name: "recover-lost", status: "proceeding" });
        // The continuation landed before the restart; recovery must find it by
        // the derived message id rather than re-sending.
        yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make("command:takeover:recover-sent:continuation"),
          threadId: sent.threadId,
          messageId: MessageId.make(`message:browser-takeover:${sent.takeoverId}:restarted`),
          text: BROWSER_TAKEOVER_CONTINUATION_TEXT,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        });

        const summary = yield* takeover.recover;

        assert.deepEqual(summary, { failed: 3, rearmed: 1, completed: 1 });
        assert.equal((yield* markerOf(requested.threadId))?.failure, "server_restarted");
        assert.equal((yield* markerOf(pausing.threadId))?.failure, "server_restarted");
        assert.equal((yield* markerOf(active.threadId))?.status, "active");
        assert.equal((yield* markerOf(sent.threadId))?.status, "completed");
        assert.equal((yield* markerOf(lost.threadId))?.failure, "continuation_failed");
        assert.deepEqual(harness.fence.calls, [
          `rearm:${active.takeoverId}:${defaultLease.hostClientId}:${defaultLease.tabId}`,
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("browser takeover fence registry", () => {
  it.effect("replays a re-arm that recovery issued before the live fence registered", () =>
    Effect.gen(function* () {
      const registry = yield* BrowserTakeoverFenceRegistry;
      const rearmed: Array<BrowserTakeoverRearmInput> = [];
      const input = {
        threadId: ThreadId.make("thread:registry"),
        takeoverId: CommandId.make("command:takeover:registry"),
        hostClientId: defaultLease.hostClientId,
        hostConnectionId: defaultLease.hostConnectionId,
        tabId: defaultLease.tabId,
      } satisfies BrowserTakeoverRearmInput;

      // Startup recovery can beat the broker layer build, and a dropped re-arm
      // leaves a thread the user is still holding open to automation.
      const beforeRegistration = yield* registry.current;
      yield* beforeRegistration.rearm(input);
      assert.deepEqual(rearmed, []);

      yield* registry.set({
        acquire: () => Effect.die("unused"),
        release: () => Effect.void,
        rearm: (received) =>
          Effect.sync(() => {
            rearmed.push(received);
          }),
      });

      assert.deepEqual(rearmed, [input]);
    }).pipe(Effect.provide(fenceRegistryLayer)),
  );

  it.effect("fails an acquire attempted before the live fence registered", () =>
    Effect.gen(function* () {
      const registry = yield* BrowserTakeoverFenceRegistry;
      const fence = yield* registry.current;
      const outcome = yield* Effect.result(
        fence.acquire({
          threadId: ThreadId.make("thread:registry"),
          takeoverId: CommandId.make("command:takeover:registry"),
        }),
      );

      assert.equal(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      assert.equal(outcome.failure.reason, "no_live_host");
    }).pipe(Effect.provide(fenceRegistryLayer)),
  );
});
