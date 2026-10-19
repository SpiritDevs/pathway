import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type {
  ComputerEvent,
  ComputerLaunchAppResult,
  ComputerUiNode,
  ComputerWindow,
  ThreadComputerState,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerBackend, ComputerBackendActionResult } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/**
 * A calculator buried under a full-screen browser: the live failure window
 * scoping exists for, where a bare coordinate click lands on the browser.
 */
function coveredCalculatorWindows(): readonly ComputerWindow[] {
  return [
    {
      id: "fake-browser",
      title: "Browser",
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      focused: true,
      minimized: false,
      visible: true,
      stackingIndex: 0,
      occludedBy: [],
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
      stackingIndex: 1,
      occludedBy: ["fake-browser"],
    },
  ];
}

function semanticTextRoot(windowIds: readonly string[]): ComputerUiNode {
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "Semantic text test desktop",
    frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: windowIds.map((windowId, index) => ({
      role: "AXWindow",
      label: `Window ${index + 1}`,
      value: null,
      description: null,
      frame: { x: index * 400, y: 0, width: 360, height: 300 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [
        {
          role: "AXTextArea",
          label: null,
          value: "",
          description: null,
          frame: { x: index * 400 + 20, y: 40, width: 320, height: 220 },
          activationPoint: { x: index * 400 + 180, y: 150 },
          onScreen: true,
          windowId,
          children: [],
        },
      ],
    })),
  };
}

function backgroundTargetBackend() {
  const ids = ["editor-a", "editor-b", "editor-a-other"];
  const windows = ids.map(
    (id, index): ComputerWindow => ({
      id,
      title: id,
      appName: index === 1 ? "Editor B" : "Editor A",
      pid: index === 1 ? 220 : 110,
      bounds: { x: index * 400, y: 0, width: 360, height: 300 },
      focused: false,
      minimized: false,
      visible: true,
    }),
  );
  return Object.assign(
    new FakeComputerBackend({
      windows,
      root: semanticTextRoot(ids),
      apps: [
        { pid: 110, name: "Editor A", bundleId: "app.editor.a", running: true, active: false },
        { pid: 220, name: "Editor B", bundleId: "app.editor.b", running: true, active: false },
      ],
    }),
    {
      exactTargetBackgroundInput: true,
      focusNeutralSemanticText: true,
      agentDialect: "macos" as const,
    },
  );
}

/**
 * The task-text authorization every raise now needs. These suites exercise the
 * raise/restore mechanics themselves; the never-raise gate has its own tests.
 */
const VISIBLE_USE_AUTHORIZED = { userRequestedVisibleUse: true } as const;

type PressKeyArgs = Parameters<ComputerBackend["pressKey"]>;

/**
 * Records every manager event in order. `waitFor` suspends until an event
 * matching the predicate arrives (past the last one it returned); `drain`
 * collects whatever is already published without suspending.
 */
const recordEvents = (manager: ComputerManager) =>
  Effect.gen(function* () {
    const subscription = yield* manager.subscribeEvents;
    const events: ComputerEvent[] = [];
    let cursor = 0;
    const drain = Effect.map(PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER), (batch) => {
      events.push(...batch);
      return events;
    });
    const waitFor = (predicate: (event: ComputerEvent) => boolean) =>
      Effect.gen(function* () {
        yield* drain;
        while (true) {
          const index = events.findIndex((event, at) => at >= cursor && predicate(event));
          if (index >= 0) {
            cursor = index + 1;
            return events[index]!;
          }
          events.push(yield* PubSub.take(subscription));
        }
      });
    return { events, drain, waitFor };
  });

const threadStateOf = (event: ComputerEvent): ThreadComputerState | undefined =>
  event.type === "computer.thread-state" ? event.state : undefined;

/**
 * Lets the manager's backend-event fiber handle what the fake just emitted,
 * for the cases where no manager event exists to wait on.
 */
const yieldToBackendEvents = Effect.gen(function* () {
  for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
});

it.layer(NodeServices.layer)("ComputerManager window-scoped typing", (it) => {
  it.effect("types through keyboard focus when the window's text field cannot be singled out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        // Two writable fields in one window: the unique-target rule cannot choose.
        const root = semanticTextRoot(["editor-a", "editor-a"]);
        Object.assign(backend, { currentRoot: root });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        expect(yield* manager.typeText("a", "hello world", "editor-a")).toMatchObject({
          action: "computer_type_text",
          windowId: "editor-a",
        });
        // One whole-string dispatch with no element target, not a refusal.
        const call = backend.callsFor("typeText").at(-1);
        expect(call?.args[0]).toBe("hello world");
        expect(call?.args[2]).toBeUndefined();

        // A window that does not exist still refuses before any key is sent.
        const typeCalls = backend.callsFor("typeText").length;
        expect(yield* Effect.flip(manager.typeText("a", "x", "gone"))).toMatchObject({
          code: "computer_target_not_found",
        });
        expect(backend.callsFor("typeText")).toHaveLength(typeCalls);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("ComputerManager background task ownership", (it) => {
  it.effect("lets separate apps progress while protecting one app's keyboard and modal state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.click("a", { windowId: "editor-a", x: 20, y: 50 });
        yield* manager.click("b", { windowId: "editor-b", x: 420, y: 50 });
        yield* manager.pressKey("a", "enter", "editor-a");
        yield* manager.pressKey("b", "enter", "editor-b");
        expect(backend.callsFor("pressKey")).toHaveLength(2);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(yield* Effect.flip(manager.pressKey("b", "enter", "editor-a-other"))).toHaveProperty(
          "code",
          "computer_controlled_by_other_thread",
        );
        expect((yield* manager.getThreadState("b")).controlledByOtherThread).toBe(false);
        expect((yield* manager.getThreadState("b")).sharedPreviewUnavailable).toBe(true);
        yield* manager.releaseDesktopControl("a");
        expect((yield* manager.getThreadState("b")).sharedPreviewUnavailable).toBeUndefined();
        yield* manager.pressKey("b", "enter", "editor-a-other");
      }),
    ),
  );

  it.effect("allows independent semantic windows but blocks conflicting app-wide input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.typeText("a", "alpha", "editor-a");
        yield* manager.setValue("b", { windowId: "editor-a-other", role: "AXTextArea" }, "bravo");
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
        expect(
          yield* Effect.flip(
            manager.setValue("b", { windowId: "editor-a", role: "AXTextArea" }, "wrong"),
          ),
        ).toHaveProperty("code", "computer_controlled_by_other_thread");
        expect(yield* Effect.flip(manager.pressKey("b", "enter", "editor-a-other"))).toHaveProperty(
          "code",
          "computer_controlled_by_other_thread",
        );
        yield* manager.releaseDesktopControl("a");
        yield* manager.pressKey("b", "enter", "editor-a-other");
      }),
    ),
  );

  it.effect("keeps foreground, clipboard and drags globally exclusive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.pressKey("a", "enter", "editor-a");
        expect(yield* Effect.flip(manager.writeClipboard("b", "clipboard"))).toHaveProperty(
          "code",
          "computer_controlled_by_other_thread",
        );
        expect(
          yield* Effect.flip(
            manager.drag(
              "b",
              { windowId: "editor-b", x: 420, y: 50 },
              { windowId: "editor-b", x: 440, y: 60 },
            ),
          ),
        ).toHaveProperty("code", "computer_controlled_by_other_thread");
        expect(
          yield* Effect.flip(manager.activateWindow("b", "editor-b", VISIBLE_USE_AUTHORIZED)),
        ).toHaveProperty("code", "computer_controlled_by_other_thread");
        expect(backend.callsFor("drag")).toHaveLength(0);
        expect(backend.callsFor("writeClipboard")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect("protects a running app from another task's launch alias and permits other apps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.pressKey("a", "enter", "editor-a");
        expect(yield* Effect.flip(manager.launchApp("b", "app.editor.a"))).toHaveProperty(
          "code",
          "computer_controlled_by_other_thread",
        );
        yield* manager.launchApp("b", "Editor B");
        expect(backend.callsFor("launchApp")).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not release a newer background turn after a late old completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.withAgentActivity(
          "a",
          manager.pressKey("a", "enter", "editor-a"),
          undefined,
          "old",
        );
        yield* manager.releaseDesktopControl("a", "old");
        yield* manager.withAgentActivity(
          "a",
          manager.pressKey("a", "enter", "editor-a"),
          undefined,
          "new",
        );
        yield* manager.releaseDesktopControl("a", "old");
        expect(yield* Effect.flip(manager.pressKey("b", "enter", "editor-a"))).toHaveProperty(
          "code",
          "computer_controlled_by_other_thread",
        );
        yield* manager.releaseDesktopControl("a", "new");
        yield* manager.pressKey("b", "enter", "editor-a");
      }),
    ),
  );

  it.effect("does not inherit an evicted background turn on a later anonymous claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({
          backend,
          actionSettleMs: 0,
          leaseIdleMs: 100,
        });
        yield* manager.withAgentActivity(
          "a",
          manager.pressKey("a", "enter", "editor-a"),
          undefined,
          "old-a",
        );
        yield* TestClock.setTime(200);
        yield* manager.withAgentActivity(
          "b",
          manager.pressKey("b", "enter", "editor-a"),
          undefined,
          "turn-b",
        );
        yield* manager.releaseDesktopControl("b", "turn-b");
        yield* manager.withAgentActivity("a", manager.pressKey("a", "enter", "editor-a"));
        // An anonymous lease is released by any named completion; inheriting
        // old-a would incorrectly retain it against this terminal identity.
        yield* manager.releaseDesktopControl("a", "current-a");
        yield* manager.pressKey("b", "enter", "editor-a");
      }),
    ),
  );

  it.effect("releases a completed background turn only after its admitted input drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const pressCalls: PressKeyArgs[] = [];
        const realPress = backend.pressKey.bind(backend);
        Object.assign(backend, {
          pressKey: (...args: PressKeyArgs) => {
            pressCalls.push(args);
            if (pressCalls.length > 1) return realPress(args[0]);
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({}),
            );
          },
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const active = yield* manager
          .withAgentActivity("a", manager.pressKey("a", "enter", "editor-a"), undefined, "turn-a")
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* manager.releaseDesktopControl("a", "turn-a");
        const next = yield* manager
          .withAgentActivity("b", manager.pressKey("b", "enter", "editor-a"), undefined, "turn-b")
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(pressCalls).toHaveLength(1);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(active);
        yield* Fiber.join(next);
        expect(pressCalls).toHaveLength(2);
      }),
    ),
  );

  it.effect("revokes a queued task without stopping the other app's active input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const stopCalls: unknown[] = [];
        Object.assign(backend, {
          stopInput: (...args: unknown[]) =>
            Effect.sync(() => {
              stopCalls.push(args);
            }),
        });
        const pressCalls: PressKeyArgs[] = [];
        const realPress = backend.pressKey.bind(backend);
        Object.assign(backend, {
          pressKey: (...args: PressKeyArgs) => {
            pressCalls.push(args);
            if (pressCalls.length > 1) return realPress(args[0]);
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({}),
            );
          },
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const active = yield* manager
          .withAgentActivity("b", manager.pressKey("b", "enter", "editor-b"), undefined, "turn-b")
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const queued = yield* manager
          .withAgentActivity("a", manager.pressKey("a", "enter", "editor-a"), undefined, "turn-a")
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* manager.setControlEnabled("a", false);
        expect(stopCalls).toHaveLength(0);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(active);
        expect(yield* Fiber.join(queued)).toHaveProperty("controlRevoked", true);
        expect(pressCalls).toHaveLength(1);
      }),
    ),
  );

  it.effect("forwards exact key targets without focus changes and rejects window mismatches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const pressCalls: PressKeyArgs[] = [];
        const realPress = backend.pressKey.bind(backend);
        Object.assign(backend, {
          pressKey: (...args: PressKeyArgs) => {
            pressCalls.push(args);
            return realPress(args[0]);
          },
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.pressKey("a", "enter", "editor-a", {
          windowId: "editor-a",
          role: "AXTextArea",
        });
        expect(pressCalls).toContainEqual([
          "enter",
          "editor-a",
          expect.objectContaining({ node: expect.objectContaining({ windowId: "editor-a" }) }),
        ]);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
        expect(
          yield* Effect.flip(
            manager.pressKey("a", "enter", "editor-a", {
              windowId: "editor-b",
              role: "AXTextArea",
            }),
          ),
        ).toHaveProperty("code", "computer_target_invalid");
        expect(pressCalls).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "pauses after observed launch activation without losing the launch outcome or replaying",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = backgroundTargetBackend();
          const launched: ComputerLaunchAppResult = {
            computerId: backend.computerId,
            app: "Editor A",
            pid: 110,
            window: (yield* backend.listWindows())[0]!,
            focusChangedDuringLaunch: true,
          };
          let launchCalls = 0;
          Object.assign(backend, {
            launchApp: () =>
              Effect.sync(() => {
                launchCalls += 1;
                return launched;
              }),
            checkInputReady: () => Effect.void,
          });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const result = yield* manager.launchApp("a", "Editor A");
          expect(result.focusChangedDuringLaunch).toBe(true);
          expect(yield* Effect.flip(manager.pressKey("a", "enter", "editor-a"))).toHaveProperty(
            "inputPause",
          );
          expect(launchCalls).toBe(1);
          yield* withComputerTask({ threadId: "a" }, manager.getState({ windowId: "editor-a" }));
          yield* manager.pressKey("a", "enter", "editor-a");
        }),
      ),
  );

  it.effect("retains a bounded list of previously observed app names without probing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const recorded = yield* recordEvents(manager);
        yield* manager.listWindows();
        backend.emitWindowsChanged([]);
        yield* recorded.waitFor((event) => event.type === "computer.windows-changed");
        const reads = backend.callsFor("listWindows").length;
        expect(manager.observedAppNames()).toEqual(["Editor B", "Editor A"]);
        expect(backend.callsFor("listWindows")).toHaveLength(reads);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("ComputerManager and FakeComputerBackend", (it) => {
  it.effect("publishes thread snapshots, activity transitions, and backend window events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          now: () => "2026-08-15T00:00:00.000Z",
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const recorded = yield* recordEvents(manager);

        const initial = yield* manager.getThreadState("thread-1");
        expect(initial.threadId).toBe("thread-1");
        expect(initial.version).toBeGreaterThanOrEqual(0);
        // Seeding a panel is not a use of the desktop, so it costs the desktop
        // nothing: the passive probe answers whether the feature works, and the
        // window list stays empty until something really asks for the backend.
        expect(initial.windows).toEqual([]);
        expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);
        expect(initial.availability).toEqual({
          kind: "available",
          backend: "fake",
        });

        const result = yield* manager.withAgentActivity(
          "thread-1",
          Effect.gen(function* () {
            yield* recorded.waitFor((event) => threadStateOf(event)?.agentActive === true);
            const active = (yield* recorded.drain).findLast(
              (event) => event.type === "computer.thread-state",
            );
            expect(active && threadStateOf(active)?.agentActive).toBe(true);
            return yield* manager.click("thread-1", {
              label: "Calculate",
              role: "button",
            });
          }),
        );
        expect(result.point).toEqual({ x: 1_180, y: 228 });
        yield* recorded.waitFor((event) => threadStateOf(event)?.agentActive === false);
        const events = yield* recorded.drain;
        expect(
          events.filter((event) => event.type === "computer.thread-state").length,
        ).toBeGreaterThanOrEqual(3);
        const last = events.at(-1);
        expect(last && threadStateOf(last)?.agentActive).toBe(false);

        const newWindow = {
          id: "fake-notes",
          title: "Notes",
          appName: "org.kde.kwrite",
          bounds: { x: 200, y: 200, width: 500, height: 400 },
          focused: true,
          minimized: false,
          visible: true,
        };
        backend.emitWindowsChanged([newWindow]);
        yield* recorded.waitFor((event) => event.type === "computer.windows-changed");
        const refreshed = yield* manager.getThreadState("thread-1");
        expect(refreshed.windows).toEqual([newWindow]);
        expect(recorded.events.some((event) => event.type === "computer.windows-changed")).toBe(
          true,
        );
      }),
    ),
  );

  it.effect(
    "republishes every thread when backend health changes, without touching the backend",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const recorded = yield* recordEvents(manager);
          const states = () =>
            recorded.events.flatMap((event) => {
              const state = threadStateOf(event);
              return state ? [state] : [];
            });
          // Health only corrects the availability of a backend something has actually
          // asked for; before that there is nothing to be disconnected from.
          yield* manager.listWindows();
          const seeded = yield* Effect.all([
            manager.getThreadState("thread-a"),
            manager.getThreadState("thread-b"),
          ]);
          expect(seeded.map((state) => state.health.status)).toEqual(["connected", "connected"]);
          const callsBeforeHealth = backend.calls.length;

          backend.emitHealthChanged({
            status: "reconnecting",
            consecutiveFailures: 1,
            reconnects: 0,
            lastFailure: {
              message: "The backend vanished",
              at: "2026-08-16T10:00:00.000Z",
            },
            captureAvailable: false,
          });
          for (const threadId of ["thread-a", "thread-b"]) {
            yield* recorded.waitFor((event) => {
              const state = threadStateOf(event);
              return state?.threadId === threadId && state.health.status === "reconnecting";
            });
          }
          yield* recorded.drain;

          // A supervision event is answered from cache: asking the backend anything
          // here would put a round trip — and a connect attempt — on every failure.
          expect(backend.calls).toHaveLength(callsBeforeHealth);
          const degraded = ["thread-a", "thread-b"].map((threadId) =>
            states().findLast((state) => state.threadId === threadId),
          );
          expect(degraded.map((state) => state?.health.status)).toEqual([
            "reconnecting",
            "reconnecting",
          ]);
          expect(degraded.map((state) => state?.availability.kind)).toEqual([
            "backend-unavailable",
            "backend-unavailable",
          ]);
          expect(degraded[0]?.availability).toMatchObject({
            message: expect.stringContaining("The backend vanished"),
          });
          // Panels drop stale snapshots by version, so a live change must move it.
          expect(degraded[0]?.version).toBeGreaterThan(seeded[0].version);

          backend.emitHealthChanged({
            status: "connected",
            consecutiveFailures: 0,
            reconnects: 1,
            lastFailure: {
              message: "The backend vanished",
              at: "2026-08-16T10:00:00.000Z",
            },
            captureAvailable: true,
          });
          yield* recorded.waitFor((event) => {
            const state = threadStateOf(event);
            return state?.threadId === "thread-a" && state.health.reconnects === 1;
          });

          const recovered = yield* manager.getThreadState("thread-a");
          expect(recovered.availability).toEqual({
            kind: "available",
            backend: "fake",
          });
          expect(recovered.health).toMatchObject({
            status: "connected",
            reconnects: 1,
          });
        }),
      ),
  );

  it.effect("answers getStatus without a thread, corrected by live health", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const status = yield* manager.getStatus();
        expect(status.computerId).toBe("desktop");
        expect(status.availability).toEqual({ kind: "available", backend: "fake" });
        expect(status.health.status).toBe("connected");
        expect(status.capabilities.input).toBe(true);
        // No thread state was created as a side effect of asking, and merely
        // opening settings must not be the thing that establishes (and on a cold
        // backend: pre-engagement it is the probe.
        expect(backend.calls.map((call) => call.method)).not.toContain("getState");
        expect(backend.calls.map((call) => call.method)).toContain("probeAvailability");
        expect(backend.calls.map((call) => call.method)).not.toContain("availability");

        // Health corrections only apply once something real engaged the backend —
        // supervision cannot report on connections that were never made.
        yield* manager.listWindows();

        backend.emitHealthChanged({
          status: "reconnecting",
          consecutiveFailures: 2,
          reconnects: 1,
          lastFailure: {
            message: "The backend vanished",
            at: "2026-08-16T10:00:00.000Z",
          },
          captureAvailable: false,
        });
        // No thread exists to republish, so there is no manager event to wait on.
        yield* yieldToBackendEvents;
        const degraded = yield* manager.getStatus();
        expect(degraded.health.status).toBe("reconnecting");
        expect(degraded.availability).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("The backend vanished"),
        });
      }),
    ),
  );

  it.effect("reports a failed availability probe as backend-unavailable instead of throwing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        // Both reads degrade the same way: the pre-engagement probe and the
        // establishing read a live backend answers with.
        backend.failNext(
          "probeAvailability",
          new ComputerBackendError({ message: "probe exploded" }),
        );
        const status = yield* manager.getStatus();
        expect(status.availability).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("probe exploded"),
        });

        yield* manager.listWindows();
        backend.failNext(
          "availability",
          new ComputerBackendError({ message: "live read exploded" }),
        );
        const engaged = yield* manager.getStatus();
        expect(engaged.availability).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("live read exploded"),
        });
      }),
    ),
  );

  /**
   * `lastError` and availability messages are schema-bounded at 2048
   * characters, and both are composed from backend error text nothing here
   * controls. One oversized D-Bus diagnostic used to fail the encode of the
   * whole getThreadState payload — breaking thread-state pushes for that
   * thread until the message changed.
   */
  it.effect("clamps an oversized backend error before it reaches a state payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const oversized = "E".repeat(100_000);
        backend.failNext("probeAvailability", new ComputerBackendError({ message: oversized }));
        const state = yield* manager.getThreadState("thread-oversize");

        expect(state.lastError).toBeDefined();
        expect(state.lastError!.length).toBeLessThanOrEqual(2_048);
        // The availability verdict on the same payload is clamped the same way,
        // so encoding the state succeeds end to end.
        expect(state.availability.kind).toBe("backend-unavailable");
        if (state.availability.kind === "backend-unavailable") {
          expect(state.availability.message.length).toBeLessThanOrEqual(2_048);
        }
      }),
    ),
  );

  it.effect(
    "dispatches a supported semantic click once and never retries an uncertain AX effect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = Object.assign(new FakeComputerBackend(), {
            agentDialect: "macos" as const,
            supportsAction: (_target: unknown, action: string) => action === "AXPress",
          });
          const pressCalls: Array<Parameters<ComputerBackend["performAction"]>> = [];
          let rejectNext = false;
          Object.assign(backend, {
            performAction: (...args: Parameters<ComputerBackend["performAction"]>) => {
              pressCalls.push(args);
              if (rejectNext) {
                rejectNext = false;
                return Effect.fail(new ComputerBackendError({ message: "Unknown dispatch" }));
              }
              return Effect.succeed<ComputerBackendActionResult>({
                effect: "dispatched-unknown",
                verified: "unverifiable",
              });
            },
          });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.click("thread-1", { label: "Calculate", role: "button" });
          expect(pressCalls).toHaveLength(1);
          expect(pressCalls[0]?.[1]).toBe("AXPress");
          expect(backend.callsFor("click")).toHaveLength(0);
          rejectNext = true;
          const failure = yield* Effect.flip(
            manager.click("thread-1", { label: "Calculate", role: "button" }),
          );
          expect(failure.message).toContain("Unknown dispatch");
          expect(pressCalls).toHaveLength(2);
          expect(backend.callsFor("click")).toHaveLength(0);
          yield* manager.doubleClick("thread-1", {
            label: "Calculate",
            role: "button",
          });
          yield* manager.click("thread-1", { label: "Calculate", role: "button" }, ["shift"]);
          expect(pressCalls).toHaveLength(2);
          expect(backend.callsFor("doubleClick")).toHaveLength(1);
          expect(backend.callsFor("click")).toHaveLength(1);
        }),
      ),
  );

  it.effect("re-walks a fresh tree when a cached-tree target lookup misses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const realGetState = backend.getState.bind(backend);
        let calls = 0;
        Object.assign(backend, {
          getState: (options: Parameters<ComputerBackend["getState"]>[0]) =>
            Effect.map(realGetState(options), (state) => {
              calls += 1;
              // First read serves a stale tree whose target has not appeared yet —
              // what a recent-tree cache hit looks like after a UI change.
              if (calls === 1 && state.root) {
                return {
                  ...state,
                  root: {
                    ...state.root,
                    children: state.root.children.map((child) => ({
                      ...child,
                      children: [],
                    })),
                  },
                };
              }
              return state;
            }),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const result = yield* manager.click("thread-1", {
          label: "Calculate",
          role: "button",
        });
        expect(result.point).toEqual({ x: 1_180, y: 228 });
        expect(calls).toBe(2);
        expect(backend.callsFor("getState")[0]?.args[0]).toMatchObject({
          reuseRecentTree: true,
        });
        expect(backend.callsFor("getState")[1]?.args[0]).not.toMatchObject({
          reuseRecentTree: true,
        });
      }),
    ),
  );

  it.effect("falls back to a coordinate click when no AXPress token is advertised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          agentDialect: "macos" as const,
          supportsAction: () => false,
        });
        const pressCalls: Array<Parameters<ComputerBackend["performAction"]>> = [];
        const realPerform = backend.performAction.bind(backend);
        Object.assign(backend, {
          performAction: (...args: Parameters<ComputerBackend["performAction"]>) => {
            pressCalls.push(args);
            return realPerform(...args);
          },
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.click("thread-1", { label: "Calculate", role: "button" });
        expect(pressCalls).toHaveLength(0);
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("performs semantic writes only against a fresh, unambiguous snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        expect(yield* manager.setValue("thread-1", { label: "Display" }, "468")).toMatchObject({
          action: "computer_set_value",
          value: "468",
        });
        expect(
          yield* manager.performAction(
            "thread-1",
            { label: "Calculate", role: "button" },
            "activate",
          ),
        ).toMatchObject({
          action: "computer_perform_action",
          point: { x: 1_180, y: 228 },
        });
        // The fake's read-back is the substring the range covers: "468"[0..2].
        expect(
          yield* manager.selectText("thread-1", { label: "Display" }, { start: 0, length: 2 }),
        ).toMatchObject({
          action: "computer_select_text",
          value: "46",
        });

        expect(yield* Effect.flip(manager.click("thread-1", { x: 1_920, y: 1_080 }))).toMatchObject(
          {
            code: "computer_target_offscreen",
          },
        );
        expect(yield* Effect.flip(manager.click("thread-1", { x: 10 }))).toMatchObject({
          code: "computer_target_invalid",
        });

        // A bare window id is a real scroll target — the window itself, at its
        // own point — while for the semantic writes below a target that names no
        // control refuses up front with what is missing, instead of matching
        // every node in scope and dumping the whole tree as an ambiguity refusal.
        expect(
          yield* manager.scroll("thread-1", { windowId: "fake-calculator" }, 0, 300),
        ).toMatchObject({
          action: "computer_scroll",
          point: { x: 1_260, y: 430 },
        });
        expect(yield* Effect.flip(manager.setValue("thread-1", {}, "468"))).toMatchObject({
          code: "computer_target_invalid",
        });
        expect(yield* Effect.flip(manager.performAction("thread-1", {}, "activate"))).toMatchObject(
          {
            code: "computer_target_invalid",
          },
        );
        expect(
          yield* Effect.flip(manager.selectText("thread-1", {}, { start: 0, length: 1 })),
        ).toMatchObject({
          code: "computer_target_invalid",
        });
      }),
    ),
  );

  it.effect("reveals a hover target without changing keyboard aim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: coveredCalculatorWindows(),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        // An untargeted move takes the lease first, so the hover below runs with
        // control already held and must not clear the pinned focus again.
        yield* manager.moveCursor("thread-1", { x: 100, y: 100 });
        const cleared = backend.callsFor("clearFocusWindow").length;
        yield* manager.moveCursor("thread-1", {
          x: 1_100,
          y: 200,
          windowId: "fake-calculator",
        });
        expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
        expect(backend.callsFor("clearFocusWindow")).toHaveLength(cleared);
        expect(backend.callsFor("moveCursor").at(-1)?.args[0]).toEqual({
          x: 1_100,
          y: 200,
        });
      }),
    ),
  );

  it.effect("raises a target window before focusing it and scopes a coordinate click to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: coveredCalculatorWindows(),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        yield* manager.click("thread-1", { label: "Calculate", role: "button" });
        expect(
          backend.calls
            .map((call) => call.method)
            .filter((method) => ["raiseWindow", "focusWindow", "click"].includes(method)),
        ).toEqual(["raiseWindow", "focusWindow", "click"]);
        expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);

        const perceptionCalls = backend.callsFor("getState").length;
        const scoped = yield* manager.click("thread-1", {
          x: 1_100,
          y: 200,
          windowId: "fake-calculator",
        });
        expect(scoped.point).toEqual({ x: 1_100, y: 200 });
        expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 1_100,
          y: 200,
        });
        // The coordinate is authoritative, so no accessibility tree is read for it.
        expect(backend.callsFor("getState")).toHaveLength(perceptionCalls);

        // A coordinate that misses the window is refused rather than clicked
        // wherever it happens to land.
        expect(
          yield* Effect.flip(
            manager.click("thread-1", { x: 40, y: 40, windowId: "fake-calculator" }),
          ),
        ).toMatchObject({ code: "computer_target_offscreen" });
        expect(
          yield* Effect.flip(manager.click("thread-1", { x: 40, y: 40, windowId: "gone" })),
        ).toMatchObject({
          code: "computer_target_not_found",
          notFound: true,
        });
      }),
    ),
  );

  it.effect("scopes a drag to the window its origin names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        // Both endpoints inside fake-calculator (1050,120,420,620). The drag grabs
        // the named window: its origin's frame is the authority for scoping.
        yield* manager.drag(
          "thread-1",
          { x: 1_100, y: 200, windowId: "fake-calculator" },
          { x: 1_200, y: 400, windowId: "fake-calculator" },
          400,
        );
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        // The Fake records the gesture itself; the focusWindow call above is what
        // proves the window the drag was scoped to.
        expect(backend.callsFor("drag").at(-1)?.args).toEqual([
          { x: 1_100, y: 200 },
          { x: 1_200, y: 400 },
          400,
        ]);
      }),
    ),
  );

  it.effect("keeps window targeting working on a backend that cannot raise windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        Object.assign(backend, { raiseWindow: undefined });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        expect(
          yield* manager.click("thread-1", { label: "Calculate", role: "button" }),
        ).toMatchObject({ point: { x: 1_180, y: 228 } });
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
      }),
    ),
  );

  it.effect("refuses a covered target the desktop cannot raise, and clicks it once it can", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: coveredCalculatorWindows(),
        });
        Object.assign(backend, { raiseWindow: undefined });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const covered = yield* Effect.flip(
          manager.click("thread-1", {
            x: 1_100,
            y: 200,
            windowId: "fake-calculator",
          }),
        );
        expect(covered).toMatchObject({
          code: "computer_target_occluded",
        });
        // The refusal has to name what is in the way, or the model has nothing to
        // act on but a retry.
        expect(covered.message).toMatch(/Browser/);
        // Nothing was injected: the point of refusing is that no click lands in the
        // covering window.
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);

        // A label target resolves to the same buried window and is refused too.
        expect(
          yield* Effect.flip(manager.click("thread-1", { label: "Calculate", role: "button" })),
        ).toMatchObject({ code: "computer_target_occluded" });

        // A point the covering window does not contain is safe to click without a
        // raise, so it goes through.
        expect(
          yield* manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-browser" }),
        ).toMatchObject({
          point: { x: 1_100, y: 200 },
          windowId: "fake-browser",
        });
      }),
    ),
  );

  it.effect("refuses a covered target when the raise itself fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: coveredCalculatorWindows(),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        backend.failNext(
          "raiseWindow",
          new ComputerBackendError({ message: "plugin has no raiseWindow" }),
        );

        const failure = yield* Effect.flip(
          manager.click("thread-1", {
            x: 1_100,
            y: 200,
            windowId: "fake-calculator",
          }),
        );
        expect(failure.message).toMatch(/plugin has no raiseWindow/);
        expect(backend.callsFor("click")).toHaveLength(0);

        // The next call raises normally and is not held against the target.
        expect(
          yield* manager.click("thread-1", {
            x: 1_100,
            y: 200,
            windowId: "fake-calculator",
          }),
        ).toMatchObject({
          point: { x: 1_100, y: 200 },
          windowId: "fake-calculator",
        });
      }),
    ),
  );

  it.effect("routes keyboard input to a named window and leaves focus alone without one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: coveredCalculatorWindows(),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        expect(yield* manager.typeText("thread-1", "12", "fake-calculator")).toMatchObject({
          action: "computer_type_text",
          windowId: "fake-calculator",
        });
        expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

        expect(yield* manager.pressKey("thread-1", "enter", "fake-browser")).toMatchObject({
          windowId: "fake-browser",
        });
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-browser"]);
        expect(yield* manager.hotkey("thread-1", ["ctrl", "t"], "fake-browser")).toMatchObject({
          windowId: "fake-browser",
        });

        // Without a window the keystroke follows whatever focus the last action
        // left, which is what click-then-type depends on: focus is never cleared.
        const focusCalls = backend.callsFor("focusWindow").length;
        expect(yield* manager.typeText("thread-1", "9")).not.toHaveProperty("windowId");
        expect(backend.callsFor("focusWindow")).toHaveLength(focusCalls);
        expect(backend.callsFor("clearFocusWindow")).toHaveLength(1);

        // A stale id fails before any key is sent rather than typing into whatever
        // holds focus instead.
        const typeCalls = backend.callsFor("typeText").length;
        expect(yield* Effect.flip(manager.typeText("thread-1", "9", "gone"))).toMatchObject({
          code: "computer_target_not_found",
          notFound: true,
        });
        expect(backend.callsFor("typeText")).toHaveLength(typeCalls);
      }),
    ),
  );
});
