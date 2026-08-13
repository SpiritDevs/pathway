import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
  PreviewAutomationTakeoverActiveError,
  PreviewTabId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  PreviewAutomationBroker,
  layer as previewAutomationBrokerLayer,
} from "../mcp/PreviewAutomationBroker.ts";
import type { PreviewTakeoverLease } from "../mcp/PreviewAutomationTakeover.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  BROWSER_TAKEOVER_CONTINUATION_TEXT,
  BrowserTakeoverFenceRegistry,
  BrowserTakeoverService,
  type BrowserTakeoverFenceRegistryShape,
  activitySinkLayer as browserTakeoverActivitySinkLayer,
  fenceRegistryLayer,
  layer as browserTakeoverServiceLayer,
  registerPreviewAutomationFence,
} from "./BrowserTakeoverService.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

/**
 * End-to-end browser takeover: the real orchestrator, the real effect worker,
 * the real preview automation broker and its fence — wired exactly the way
 * `server.ts` wires them — driven by a deterministic provider adapter whose
 * turn stays open until the test lets it go.
 *
 * Nothing here waits on a clock. Orchestration progress is observed through the
 * thread's stored event stream, and every point where the test needs to be
 * *inside* a step (mid-drain, fence acquired but run not yet terminal) is
 * reached by parking the real fence on a deferred the test controls.
 */

const projectId = ProjectId.make("project:browser-takeover-integration");
const environmentId = EnvironmentId.make("environment:browser-takeover-integration");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerSessionId = "provider-session:browser-takeover";
const modelSelection = { instanceId, model: "gpt-5.1-codex" } satisfies ModelSelection;
const initialPrompt = "Drive the preview browser for me.";

/**
 * The literal the user sees. Pinned here as well as in the service so a reword
 * has to be a deliberate, reviewed change on both sides.
 */
const expectedContinuationText =
  "I’ve finished configuring the browser and it is ready in the current Preview tab. Continue from the browser’s current state.";

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

type BrokerShape = PreviewAutomationBroker["Service"];

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId,
  providerInstanceId: instanceId,
  providerDriverKind: driver,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

// ---------------------------------------------------------------------------
// Deterministic provider adapter
// ---------------------------------------------------------------------------

interface AdapterProbe {
  readonly adapter: ProviderAdapterV2Shape;
  readonly startedTurns: Ref.Ref<ReadonlyArray<string>>;
  readonly interruptedTurns: Ref.Ref<number>;
}

/**
 * Mirrors `OrchestratorMcpToolkit.integration.test.ts`'s adapter, minus the
 * cross-provider machinery. Two gates matter here: `holdTurn` keeps a turn
 * running so a takeover has something to pause, and `holdInterrupt` keeps the
 * interrupt from terminalizing so the test can observe the window where the
 * fence is held but the run is not over yet.
 */
function makeTakeoverAdapter(input: {
  readonly holdTurn?: (turn: ProviderAdapterV2TurnInput) => Deferred.Deferred<void> | undefined;
  readonly holdInterrupt?: Deferred.Deferred<void>;
  readonly startedTurns: Ref.Ref<ReadonlyArray<string>>;
  readonly interruptedTurns: Ref.Ref<number>;
}): ProviderAdapterV2Shape {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        // Turns that stay open outlive the `startTurn` call, exactly as they do
        // for a real provider, so their completion runs on the session's scope.
        const sessionScope = yield* Effect.scope;
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();

        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.startedTurns, (turns) => [...turns, turnInput.message.text]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              const nativeTurnRef = {
                driver,
                nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                strength: "strong",
              } as const;
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef,
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const completeTurn = Effect.gen(function* () {
                const completedAt = yield* DateTime.now;
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turnInput.providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef,
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "completed",
                      startedAt: eventTime,
                      completedAt,
                    },
                  },
                  {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      id: TurnItemId.make(
                        `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      threadId: turnInput.threadId,
                      runId: turnInput.runId,
                      nodeId: turnInput.rootNodeId,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: turnInput.runOrdinal * 100 + 1,
                      status: "completed",
                      title: null,
                      startedAt: eventTime,
                      completedAt,
                      updatedAt: completedAt,
                      type: "assistant_message",
                      messageId: MessageId.make(
                        `message:codex:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      text: `Codex completed: ${turnInput.message.text}`,
                      streaming: false,
                    },
                  },
                  {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
                ]);
              });
              const gate = input.holdTurn?.(turnInput);
              if (gate === undefined) {
                return yield* completeTurn;
              }
              // A real adapter returns from `startTurn` as soon as the turn is
              // submitted and reports the end of the turn on the session's event
              // stream. Blocking here instead would hold the thread's provider
              // effect lane, and the interrupt a takeover issues could never be
              // claimed behind it.
              yield* Deferred.await(gate).pipe(
                Effect.andThen(completeTurn),
                Effect.forkIn(sessionScope),
              );
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              yield* Ref.update(input.interruptedTurns, (count) => count + 1);
              if (input.holdInterrupt !== undefined) {
                yield* Deferred.await(input.holdInterrupt);
              }
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("readThreadSnapshot is unused in this test"),
          rollbackThread: () => Effect.die("rollbackThread is unused in this test"),
          forkThread: () => Effect.die("forkThread is unused in this test"),
        };
      }),
  };
}

function makeAdapterProbe(options: {
  readonly holdTurn?: (turn: ProviderAdapterV2TurnInput) => Deferred.Deferred<void> | undefined;
  readonly holdInterrupt?: Deferred.Deferred<void>;
}) {
  return Effect.gen(function* () {
    const startedTurns = yield* Ref.make<ReadonlyArray<string>>([]);
    const interruptedTurns = yield* Ref.make(0);
    return {
      adapter: makeTakeoverAdapter({ ...options, startedTurns, interruptedTurns }),
      startedTurns,
      interruptedTurns,
    } satisfies AdapterProbe;
  });
}

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

const serverEnvironmentLayer = Layer.succeed(
  ServerEnvironment,
  ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("ServerEnvironment.getDescriptor is unused in this test"),
  }),
);

/**
 * Builds the fence registry once, outside the layer graph, and hands it back as
 * a value layer. The orchestrator harness and the broker registration both need
 * the *same* registry; sharing a constructed value says so directly instead of
 * leaning on layer memoization to make two references meet.
 */
const makeSharedFenceRegistryLayer = Effect.gen(function* () {
  const registry = yield* Effect.provide(BrowserTakeoverFenceRegistry, fenceRegistryLayer);
  return Layer.succeed(BrowserTakeoverFenceRegistry, registry);
});

function makeTakeoverTestLayer(input: {
  readonly name: string;
  readonly cwd: string;
  readonly adapter: ProviderAdapterV2Shape;
  readonly registryLayer: Layer.Layer<BrowserTakeoverFenceRegistry>;
  readonly runEffectWorker?: boolean;
}) {
  const providerRegistryLayer = makeProviderAdapterRegistryLayer([input.adapter]);
  // Built against whatever orchestrator it is provided, so the harness can wire
  // the real service into the effect worker and the test can call `recover`.
  const browserTakeoverLayer = browserTakeoverServiceLayer.pipe(
    Layer.provide(Layer.merge(ThreadManagement.layer, input.registryLayer)),
  );
  const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: input.name,
      runtimePolicyOverride: {
        cwd: input.cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    },
    providerRegistryLayer,
    {
      browserTakeoverLayer,
      ...(input.runEffectWorker === false ? { runEffectWorker: false as const } : {}),
    },
  );
  const threadManagementLayer = ThreadManagement.layer.pipe(Layer.provide(orchestratorLayer));
  const takeoverLayer = browserTakeoverLayer.pipe(Layer.provide(orchestratorLayer));
  // Same shape as `server.ts`: the broker layer publishes activity through the
  // orchestration sink, and the fence it exposes is registered into the registry
  // the takeover service reads from.
  const previewAutomationLayer = Layer.effectDiscard(registerPreviewAutomationFence).pipe(
    Layer.provideMerge(
      previewAutomationBrokerLayer.pipe(
        Layer.provide(browserTakeoverActivitySinkLayer.pipe(Layer.provide(threadManagementLayer))),
      ),
    ),
  );
  return Layer.mergeAll(
    orchestratorLayer,
    threadManagementLayer,
    takeoverLayer,
    previewAutomationLayer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(input.registryLayer, serverEnvironmentLayer, NodeServices.layer),
    ),
  );
}

// ---------------------------------------------------------------------------
// Event-driven waiting
// ---------------------------------------------------------------------------

/**
 * Re-reads the thread projection on every stored event for that thread until
 * `predicate` holds. `streamStoredEventsFrom` subscribes before it reads the
 * high-water mark, so a state reached before this call is still seen on the
 * replay leg — no polling, no sleeps, no lost updates.
 */
function awaitThread(
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
  label: string,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return orchestrator.streamStoredEventsFrom({ threadId }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(predicate),
    Stream.runHead,
    // Purely a diagnostic bound: a correct run matches on an event, not a timer.
    Effect.timeoutOption(Duration.seconds(60)),
    Effect.flatMap((outcome) =>
      Option.isSome(outcome) && Option.isSome(outcome.value)
        ? Effect.succeed(outcome.value.value)
        : Effect.die(new Error(`Timed out waiting for ${label} on thread ${threadId}.`)),
    ),
  );
}

/**
 * The broker publishes preview activity on a detached fiber, so a takeover
 * requested straight after an `invoke` can snapshot a thread that has not seen
 * the host yet. Every test waits for the pin to land before requesting.
 */
const awaitPinnedActivity = (
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
  pinnedTabId: PreviewTabId,
) =>
  awaitThread(
    orchestrator,
    threadId,
    "preview activity",
    (projection) => (projection.thread.previewActivity?.tabId ?? null) === pinnedTabId,
  );

const takeoverStatusIs =
  (status: string) =>
  (projection: OrchestrationV2ThreadProjection): boolean =>
    (projection.thread.browserTakeover?.status ?? null) === status;

const markerOf = (projection: OrchestrationV2ThreadProjection) =>
  projection.thread.browserTakeover ?? null;

const continuationMessages = (projection: OrchestrationV2ThreadProjection, takeoverId: CommandId) =>
  projection.messages.filter((message) =>
    message.id.startsWith(`message:browser-takeover:${takeoverId}:`),
  );

// ---------------------------------------------------------------------------
// Fake desktop host
// ---------------------------------------------------------------------------

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void,
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

interface FakeHost {
  readonly clientId: string;
  readonly connectionId: () => string;
  readonly routed: ReadonlyArray<RoutedRequest>;
  readonly consumer: Fiber.Fiber<void, never>;
}

/**
 * A desktop Preview host: answers every request with the pinned tab, except the
 * ones `hold` claims, which stay in flight so a drain has something to wait on.
 */
function connectHost(input: {
  readonly broker: BrokerShape;
  readonly pinnedTabId: PreviewTabId;
  readonly clientId?: string;
  readonly hold?: (request: RoutedRequest) => boolean;
}) {
  return Effect.gen(function* () {
    const clientId = input.clientId ?? "preview-host-1";
    const routed: Array<RoutedRequest> = [];
    let connectionId = "";
    const host: PreviewAutomationHost = { clientId, environmentId };
    const requests = requestsFrom(yield* input.broker.connect(host), (id) => {
      connectionId = id;
    });
    const consumer = yield* Stream.runForEach(requests, (request) => {
      routed.push(request);
      if (input.hold?.(request) === true) return Effect.void;
      return (
        input.broker
          .respond({
            clientId,
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: request.operation === "open" ? { tabId: input.pinnedTabId } : "done",
          })
          // A response for a request the drain already cancelled is not the
          // host misbehaving; it must not tear the connection down.
          .pipe(Effect.ignore)
      );
    }).pipe(Effect.orDie, Effect.forkScoped);
    yield* Effect.yieldNow;
    return {
      clientId,
      connectionId: () => connectionId,
      routed,
      consumer,
    } satisfies FakeHost;
  });
}

// ---------------------------------------------------------------------------
// Fence hooks
// ---------------------------------------------------------------------------

interface FenceHooks {
  readonly beforeAcquire?: Effect.Effect<void>;
  readonly afterAcquire?: (lease: PreviewTakeoverLease) => Effect.Effect<void>;
  readonly beforeRelease?: Effect.Effect<void>;
}

/**
 * Wraps the *registered* fence — the broker's — rather than replacing it, so
 * every assertion still runs against real fence behaviour. The registry
 * resolves the fence per call, so installing hooks mid-test is enough.
 */
function installFenceHooks(registry: BrowserTakeoverFenceRegistryShape, hooks: FenceHooks) {
  return Effect.gen(function* () {
    const inner = yield* registry.current;
    yield* registry.set({
      acquire: (input) =>
        (hooks.beforeAcquire ?? Effect.void).pipe(
          Effect.andThen(inner.acquire(input)),
          Effect.tap((lease) => hooks.afterAcquire?.(lease) ?? Effect.void),
        ),
      release: (input) =>
        (hooks.beforeRelease ?? Effect.void).pipe(Effect.andThen(inner.release(input))),
      rearm: (input) => inner.rearm(input),
    });
  });
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function createThread(name: string, threadId: ThreadId, worktreePath: string) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: "Browser takeover",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function startRun(name: string, threadId: ThreadId) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:${name}:send`),
      threadId,
      messageId: MessageId.make(`message:${name}:send`),
      text: initialPrompt,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function requestTakeover(name: string, threadId: ThreadId) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const takeoverId = CommandId.make(`command:${name}:takeover`);
    const outcome = yield* threads
      .dispatch({ type: "thread.browser-takeover.request", commandId: takeoverId, threadId })
      .pipe(Effect.result);
    return { takeoverId, outcome };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("browser takeover integration", () => {
  it.live("pauses the agent, hands over the pinned tab, and continues on proceed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-happy-path");
        const threadId = ThreadId.make("thread:browser-takeover-happy");
        const pinnedTabId = PreviewTabId.make("tab-pinned");
        const holdFirstTurn = yield* Deferred.make<void>();
        const holdInterrupt = yield* Deferred.make<void>();
        const fenceAcquired = yield* Deferred.make<PreviewTakeoverLease>();
        let holdSnapshots = true;
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
          holdInterrupt,
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const broker = yield* PreviewAutomationBroker;
          const registry = yield* BrowserTakeoverFenceRegistry;
          const scope = scopeFor(threadId);

          yield* createThread("happy", threadId, cwd);
          yield* startRun("happy", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );

          // 1. The agent drives the Preview browser. The broker pins a tab and
          //    publishes activity, which is what makes a takeover offerable.
          const host = yield* connectHost({
            broker,
            pinnedTabId,
            hold: (request) => request.operation === "snapshot" && holdSnapshots,
          });
          const opened = yield* broker.invoke<{ readonly tabId: PreviewTabId }>({
            scope,
            operation: "open",
            input: {},
          });
          expect(opened.tabId).toBe(pinnedTabId);
          const withActivity = yield* awaitPinnedActivity(orchestrator, threadId, pinnedTabId);
          expect(withActivity.thread.previewActivity?.hostClientId).toBe(host.clientId);

          // An automation call the host never answers, so the takeover drain has
          // real in-flight work to wait for.
          const inFlight = yield* broker
            .invoke<string>({ scope, operation: "snapshot", input: {} })
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          // Park the fence right after it hands back the lease: that is the one
          // instant where exclusivity is held but the run is not terminal yet.
          yield* installFenceHooks(registry, {
            afterAcquire: (lease) => Deferred.succeed(fenceAcquired, lease).pipe(Effect.asVoid),
          });

          // 2. requested -> pausing.
          const { takeoverId, outcome } = yield* requestTakeover("happy", threadId);
          expect(outcome._tag).toBe("Success");
          const pausing = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to start pausing",
            takeoverStatusIs("pausing"),
          );
          expect(markerOf(pausing)?.tabId).toBe(pinnedTabId);

          // 3. The drain waits for in-flight automation; the request the host is
          //    sitting on finishes normally once it answers.
          expect(yield* Deferred.isDone(fenceAcquired)).toBe(false);
          const heldRequest = host.routed.find((request) => request.operation === "snapshot");
          holdSnapshots = false;
          yield* broker.respond({
            clientId: host.clientId,
            connectionId: host.connectionId(),
            requestId: heldRequest?.requestId ?? "",
            ok: true,
            result: "done",
          });
          expect(yield* Fiber.join(inFlight)).toBe("done");
          const lease = yield* Deferred.await(fenceAcquired);
          expect(lease).toMatchObject({ tabId: pinnedTabId, hostClientId: host.clientId });

          // 4. While the takeover is still pausing the browser is already fenced,
          //    and a fresh automation call fails typed instead of hanging.
          const blocked = yield* broker
            .invoke<void>({ scope, operation: "status", input: {} })
            .pipe(Effect.flip);
          expect(blocked).toBeInstanceOf(PreviewAutomationTakeoverActiveError);
          expect(blocked).toMatchObject({ takeoverId });
          const stillPausing = yield* orchestrator.getThreadProjection(threadId);
          expect(markerOf(stillPausing)?.status).toBe("pausing");

          // 5. The run is interrupted and only then does the takeover go active.
          yield* Deferred.succeed(holdInterrupt, undefined);
          const active = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to become active",
            takeoverStatusIs("active"),
          );
          expect(yield* Ref.get(probe.interruptedTurns)).toBeGreaterThan(0);
          const pausedRun = active.runs.find((run) => run.id === markerOf(active)?.runId);
          expect(pausedRun?.status).toBe("interrupted");
          expect(active.providerTurns.every((turn) => turn.status !== "running")).toBe(true);
          expect(markerOf(active)).toMatchObject({
            tabId: pinnedTabId,
            hostClientId: host.clientId,
            hostConnectionId: host.connectionId(),
          });

          // 6. Proceed: the fence comes back before the continuation exists, and
          //    exactly one message and one new run come out of it.
          const releaseSawContinuation: Array<boolean> = [];
          yield* installFenceHooks(registry, {
            beforeRelease: Effect.gen(function* () {
              const projection = yield* threads.getThreadProjection(threadId);
              releaseSawContinuation.push(continuationMessages(projection, takeoverId).length > 0);
            }).pipe(Effect.orDie),
          });
          yield* threads.dispatch({
            type: "thread.browser-takeover.proceed",
            commandId: CommandId.make("command:happy:proceed"),
            threadId,
            takeoverId,
          });
          const completed = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to complete",
            takeoverStatusIs("completed"),
          );
          expect(releaseSawContinuation).toEqual([false]);
          const continuation = continuationMessages(completed, takeoverId);
          expect(continuation).toHaveLength(1);
          expect(continuation[0]?.text).toBe(expectedContinuationText);
          expect(continuation[0]?.text).toBe(BROWSER_TAKEOVER_CONTINUATION_TEXT);
          expect(continuation[0]?.createdBy).toBe("user");
          expect(completed.runs).toHaveLength(2);

          const resumed = yield* awaitThread(
            orchestrator,
            threadId,
            "the continuation run to finish",
            (projection) =>
              projection.runs.length === 2 &&
              projection.runs.every((run) => run.status !== "starting" && run.status !== "running"),
          );
          expect(resumed.runs).toHaveLength(2);
          expect(yield* Ref.get(probe.startedTurns)).toEqual([
            initialPrompt,
            BROWSER_TAKEOVER_CONTINUATION_TEXT,
          ]);

          // 7. Automation works again and lands on the very tab the user was
          //    just holding.
          expect(yield* broker.invoke<string>({ scope, operation: "snapshot", input: {} })).toBe(
            "done",
          );
          expect(host.routed[host.routed.length - 1]?.tabId).toBe(pinnedTabId);
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-happy",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("fails a takeover whose run finished before the fence was acquired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-already-finished");
        const threadId = ThreadId.make("thread:browser-takeover-finished");
        const pinnedTabId = PreviewTabId.make("tab-finished");
        const holdFirstTurn = yield* Deferred.make<void>();
        const letAcquire = yield* Deferred.make<void>();
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const broker = yield* PreviewAutomationBroker;
          const registry = yield* BrowserTakeoverFenceRegistry;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const scope = scopeFor(threadId);

          yield* createThread("finished", threadId, cwd);
          yield* startRun("finished", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          yield* connectHost({ broker, pinnedTabId });
          yield* broker.invoke({ scope, operation: "open", input: {} });
          yield* awaitPinnedActivity(orchestrator, threadId, pinnedTabId);

          // Hold the establish step at the fence, then let the run finish under it.
          yield* installFenceHooks(registry, { beforeAcquire: Deferred.await(letAcquire) });
          const { takeoverId } = yield* requestTakeover("finished", threadId);
          yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to start pausing",
            takeoverStatusIs("pausing"),
          );

          yield* Deferred.succeed(holdFirstTurn, undefined);
          yield* awaitThread(orchestrator, threadId, "the run to finish", (projection) =>
            projection.runs.every((run) => run.status === "completed"),
          );
          yield* Deferred.succeed(letAcquire, undefined);

          const failed = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to fail",
            takeoverStatusIs("failed"),
          );
          expect(markerOf(failed)?.failure).toBe("already_finished");

          // Nothing was handed over, so nothing stays fenced.
          expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
            "done",
          );
          expect(continuationMessages(failed, takeoverId)).toHaveLength(0);
          expect(failed.runs).toHaveLength(1);

          // And a fresh request on a finished thread is refused at the door.
          const rejected = yield* threads
            .dispatch({
              type: "thread.browser-takeover.request",
              commandId: CommandId.make("command:finished:takeover-again"),
              threadId,
            })
            .pipe(Effect.flip);
          if (rejected._tag !== "OrchestratorDispatchError") {
            return yield* Effect.die(
              new Error(`Expected a dispatch rejection, got ${rejected._tag}.`),
            );
          }
          expect(String(rejected.cause)).toContain("no running agent turn to pause");
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-finished",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("fails a takeover when no preview host is live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-no-host");
        const threadId = ThreadId.make("thread:browser-takeover-no-host");
        const holdFirstTurn = yield* Deferred.make<void>();
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;

          yield* createThread("no-host", threadId, cwd);
          yield* startRun("no-host", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );

          const { takeoverId } = yield* requestTakeover("no-host", threadId);
          const failed = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to fail",
            takeoverStatusIs("failed"),
          );
          expect(markerOf(failed)?.failure).toBe("no_live_host");
          expect(continuationMessages(failed, takeoverId)).toHaveLength(0);
          // The run was never interrupted: there was nothing to hand over.
          expect(yield* Ref.get(probe.interruptedTurns)).toBe(0);
          expect(failed.runs).toHaveLength(1);
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-no-host",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("keeps automation fenced when the pinned host dies while pausing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-host-disconnect");
        const threadId = ThreadId.make("thread:browser-takeover-host-disconnect");
        const pinnedTabId = PreviewTabId.make("tab-disconnect");
        const holdFirstTurn = yield* Deferred.make<void>();
        const letAcquire = yield* Deferred.make<void>();
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const broker = yield* PreviewAutomationBroker;
          const registry = yield* BrowserTakeoverFenceRegistry;
          const scope = scopeFor(threadId);

          yield* createThread("host-disconnect", threadId, cwd);
          yield* startRun("host-disconnect", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );

          // The host answers "open" but never answers the snapshot, so the drain
          // is still waiting when the connection dies.
          const host = yield* connectHost({
            broker,
            pinnedTabId,
            hold: (request) => request.operation === "snapshot",
          });
          yield* broker.invoke({ scope, operation: "open", input: {} });
          yield* awaitPinnedActivity(orchestrator, threadId, pinnedTabId);
          const inFlight = yield* broker
            .invoke<string>({ scope, operation: "snapshot", input: {} })
            .pipe(Effect.flip, Effect.forkScoped);
          yield* Effect.yieldNow;

          yield* installFenceHooks(registry, { beforeAcquire: Deferred.await(letAcquire) });
          const { takeoverId } = yield* requestTakeover("host-disconnect", threadId);
          yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to start pausing",
            takeoverStatusIs("pausing"),
          );

          // Releasing the hook lets the real fence arm and start draining; the
          // blocked probe proves the arm landed before the host is dropped.
          yield* Deferred.succeed(letAcquire, undefined);
          yield* Effect.yieldNow;
          const blockedWhileDraining = yield* broker
            .invoke<void>({ scope, operation: "status", input: {} })
            .pipe(Effect.flip);
          expect(blockedWhileDraining).toBeInstanceOf(PreviewAutomationTakeoverActiveError);

          yield* Fiber.interrupt(host.consumer);
          yield* Fiber.join(inFlight);

          const failed = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to fail",
            takeoverStatusIs("failed"),
          );
          expect(markerOf(failed)?.failure).toBe("host_disconnected");

          // Fail safe: the agent stays fenced until the user releases.
          const stillBlocked = yield* broker
            .invoke<void>({ scope, operation: "status", input: {} })
            .pipe(Effect.flip);
          expect(stillBlocked).toBeInstanceOf(PreviewAutomationTakeoverActiveError);
          expect(stillBlocked).toMatchObject({ takeoverId });
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-host-disconnect",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("treats a repeated proceed as the same continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-duplicate-proceed");
        const threadId = ThreadId.make("thread:browser-takeover-duplicate");
        const pinnedTabId = PreviewTabId.make("tab-duplicate");
        const holdFirstTurn = yield* Deferred.make<void>();
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const broker = yield* PreviewAutomationBroker;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const scope = scopeFor(threadId);

          yield* createThread("duplicate", threadId, cwd);
          yield* startRun("duplicate", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          yield* connectHost({ broker, pinnedTabId });
          yield* broker.invoke({ scope, operation: "open", input: {} });
          yield* awaitPinnedActivity(orchestrator, threadId, pinnedTabId);

          const { takeoverId, outcome } = yield* requestTakeover("duplicate", threadId);
          expect(outcome._tag).toBe("Success");
          yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to become active",
            takeoverStatusIs("active"),
          );

          const proceedCommandId = CommandId.make("command:duplicate:proceed");
          yield* threads.dispatch({
            type: "thread.browser-takeover.proceed",
            commandId: proceedCommandId,
            threadId,
            takeoverId,
          });
          const completed = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to complete",
            takeoverStatusIs("completed"),
          );
          expect(continuationMessages(completed, takeoverId)).toHaveLength(1);

          // Same command id: absorbed by the command receipt.
          yield* threads
            .dispatch({
              type: "thread.browser-takeover.proceed",
              commandId: proceedCommandId,
              threadId,
              takeoverId,
            })
            .pipe(Effect.result);
          // Different command id: the marker is terminal, so it is refused as stale.
          const stale = yield* threads
            .dispatch({
              type: "thread.browser-takeover.proceed",
              commandId: CommandId.make("command:duplicate:proceed-again"),
              threadId,
              takeoverId,
            })
            .pipe(Effect.flip);
          expect(stale._tag).toBe("OrchestratorBrowserTakeoverStaleError");

          const settled = yield* awaitThread(
            orchestrator,
            threadId,
            "the continuation run to finish",
            (projection) =>
              projection.runs.length === 2 &&
              projection.runs.every((run) => run.status !== "starting" && run.status !== "running"),
          );
          expect(continuationMessages(settled, takeoverId)).toHaveLength(1);
          expect(settled.runs).toHaveLength(2);
          expect(markerOf(settled)?.status).toBe("completed");
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-duplicate",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("ends a takeover without continuing when the user releases it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-release");
        const threadId = ThreadId.make("thread:browser-takeover-release");
        const pinnedTabId = PreviewTabId.make("tab-release");
        const holdFirstTurn = yield* Deferred.make<void>();
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        const probe = yield* makeAdapterProbe({
          holdTurn: (turn) => (turn.message.text === initialPrompt ? holdFirstTurn : undefined),
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const broker = yield* PreviewAutomationBroker;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const scope = scopeFor(threadId);

          yield* createThread("release", threadId, cwd);
          yield* startRun("release", threadId);
          yield* awaitThread(orchestrator, threadId, "the provider turn to open", (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          yield* connectHost({ broker, pinnedTabId });
          yield* broker.invoke({ scope, operation: "open", input: {} });
          yield* awaitPinnedActivity(orchestrator, threadId, pinnedTabId);

          const { takeoverId, outcome } = yield* requestTakeover("release", threadId);
          expect(outcome._tag).toBe("Success");
          const active = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to become active",
            takeoverStatusIs("active"),
          );
          const messagesWhileActive = active.messages.length;

          yield* threads.dispatch({
            type: "thread.browser-takeover.release",
            commandId: CommandId.make("command:release:release"),
            threadId,
            takeoverId,
          });
          const cancelled = yield* awaitThread(
            orchestrator,
            threadId,
            "the takeover to cancel",
            takeoverStatusIs("cancelled"),
          );

          expect(markerOf(cancelled)?.failure).toBeNull();
          expect(continuationMessages(cancelled, takeoverId)).toHaveLength(0);
          expect(cancelled.messages).toHaveLength(messagesWhileActive);
          expect(cancelled.runs).toHaveLength(1);
          expect(yield* Ref.get(probe.startedTurns)).toEqual([initialPrompt]);

          // The browser is the agent's again, on the same pinned tab.
          expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
            "done",
          );
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-release",
              cwd,
              adapter: probe.adapter,
              registryLayer,
            }),
          ),
        );
      }),
    ),
  );

  it.live("fails half-established takeovers and re-arms active ones after a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("browser-takeover-recovery");
        const pinnedTabId = PreviewTabId.make("tab-recovery");
        const registryLayer = yield* makeSharedFenceRegistryLayer;
        // The effect worker is off: recovery is about markers that outlived the
        // process, so the test drives the state machine with commands only.
        const probe = yield* makeAdapterProbe({});

        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const broker = yield* PreviewAutomationBroker;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const takeover = yield* BrowserTakeoverService;

          const requestedThreadId = ThreadId.make("thread:browser-takeover-recovery-requested");
          const pausingThreadId = ThreadId.make("thread:browser-takeover-recovery-pausing");
          const activeThreadId = ThreadId.make("thread:browser-takeover-recovery-active");

          const armThread = (name: string, threadId: ThreadId) =>
            Effect.gen(function* () {
              yield* createThread(name, threadId, cwd);
              yield* startRun(name, threadId);
              const started = yield* orchestrator.getThreadProjection(threadId);
              const run = started.runs.at(-1);
              if (run === undefined) return yield* Effect.die(new Error(`${name} started no run.`));
              expect(run.status).toBe("starting");
              const { takeoverId } = yield* requestTakeover(name, threadId);
              return { takeoverId, runId: run.id };
            });

          const requested = yield* armThread("recovery-requested", requestedThreadId);
          const pausing = yield* armThread("recovery-pausing", pausingThreadId);
          const active = yield* armThread("recovery-active", activeThreadId);

          const transition = (
            name: string,
            threadId: ThreadId,
            takeoverId: CommandId,
            to: "pausing" | "active",
            lease?: PreviewTakeoverLease,
          ) =>
            threads.dispatch({
              type: "thread.browser-takeover.transition",
              commandId: CommandId.make(`command:${name}:transition:${to}`),
              threadId,
              takeoverId,
              to,
              ...(lease === undefined
                ? {}
                : {
                    hostClientId: lease.hostClientId,
                    hostConnectionId: lease.hostConnectionId,
                    tabId: lease.tabId,
                  }),
            });

          yield* transition("recovery-pausing", pausingThreadId, pausing.takeoverId, "pausing");
          // Reaching "active" for real means the run was paused first.
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:recovery-active:interrupt"),
            threadId: activeThreadId,
            runId: active.runId,
            reason: "Paused so the user can drive the browser.",
          });
          yield* transition("recovery-active", activeThreadId, active.takeoverId, "pausing");
          yield* transition("recovery-active", activeThreadId, active.takeoverId, "active", {
            hostClientId: "preview-host-1",
            hostConnectionId: "connection-before-restart",
            tabId: pinnedTabId,
          });

          const host = yield* connectHost({ broker, pinnedTabId });
          const activeScope = scopeFor(activeThreadId);
          expect(
            yield* broker.invoke<string>({ scope: activeScope, operation: "status", input: {} }),
          ).toBe("done");

          // The restart: durable markers survive, the in-memory fence does not.
          const summary = yield* takeover.recover;
          expect(summary).toEqual({ failed: 2, rearmed: 1, completed: 0 });

          const recoveredRequested = yield* orchestrator.getThreadProjection(requestedThreadId);
          expect(markerOf(recoveredRequested)).toMatchObject({
            status: "failed",
            failure: "server_restarted",
          });
          const recoveredPausing = yield* orchestrator.getThreadProjection(pausingThreadId);
          expect(markerOf(recoveredPausing)).toMatchObject({
            status: "failed",
            failure: "server_restarted",
          });

          const recoveredActive = yield* orchestrator.getThreadProjection(activeThreadId);
          // Never auto-resumed: the user is still holding the browser.
          expect(markerOf(recoveredActive)?.status).toBe("active");
          expect(continuationMessages(recoveredActive, active.takeoverId)).toHaveLength(0);
          expect(recoveredActive.runs).toHaveLength(1);

          const blocked = yield* broker
            .invoke<void>({ scope: activeScope, operation: "status", input: {} })
            .pipe(Effect.flip);
          expect(blocked).toBeInstanceOf(PreviewAutomationTakeoverActiveError);
          expect(blocked).toMatchObject({ takeoverId: active.takeoverId });

          // Threads whose takeover failed are not fenced.
          expect(
            yield* broker.invoke<string>({
              scope: scopeFor(requestedThreadId),
              operation: "status",
              input: {},
            }),
          ).toBe("done");
          expect(host.routed.length).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(
            makeTakeoverTestLayer({
              name: "browser-takeover-recovery",
              cwd,
              adapter: probe.adapter,
              registryLayer,
              runEffectWorker: false,
            }),
          ),
        );
      }),
    ),
  );
});
