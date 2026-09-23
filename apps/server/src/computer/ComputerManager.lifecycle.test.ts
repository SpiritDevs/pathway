import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type {
  ComputerEvent,
  ComputerLaunchAppResult,
  ComputerWindow,
  ThreadComputerState,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { ComputerApprovalRequester, make as makeApprovalGate } from "./ComputerApprovalGate.ts";
import { COMPUTER_CONTROL_ENABLE_TIMEOUT_MS, ComputerManager } from "./ComputerManager.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";
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

/**
 * Buffers every manager event from now on. The returned effect drains what
 * has been published so far without suspending, and returns the running list.
 */
const recordEvents = Effect.fn(function* (manager: ComputerManager) {
  const subscription = yield* manager.subscribeEvents;
  const seen: ComputerEvent[] = [];
  return Effect.map(PubSub.takeUpTo(subscription, Number.POSITIVE_INFINITY), (batch) => {
    seen.push(...batch);
    return seen;
  });
});

const threadStates = (events: readonly ComputerEvent[]): ThreadComputerState[] =>
  events.flatMap((event) => (event.type === "computer.thread-state" ? [event.state] : []));

const RETURN_TO_TARGET = "Return to the target window.";

const calculatorPause = () =>
  new ComputerBackendError({
    message: RETURN_TO_TARGET,
    inputPause: { windowId: "fake-calculator", message: RETURN_TO_TARGET },
  });

it.layer(NodeServices.layer)("ComputerManager lifecycle", (it) => {
  it.effect("holds refused input until a scoped observation establishes readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        class PausedBackend extends FakeComputerBackend {
          ready = false;
          attempts = 0;
          checks = 0;
          override typeText(text: string) {
            return Effect.suspend(() => {
              this.attempts += 1;
              if (!this.ready) return Effect.fail(calculatorPause());
              return super.typeText(text);
            });
          }
          checkInputReady(_windowId: string) {
            return Effect.suspend(() => {
              this.checks += 1;
              if (!this.ready)
                return Effect.fail(new ComputerBackendError({ message: "still unavailable" }));
              return Effect.void;
            });
          }
        }
        const backend = new PausedBackend();
        const manager = yield* ComputerManager.make({ backend });
        expect(yield* Effect.flip(manager.typeText("thread-a", "hello"))).toHaveProperty(
          "inputPause",
        );
        expect(yield* Effect.flip(manager.typeText("thread-a", "hello"))).toHaveProperty(
          "inputPause",
        );
        expect(backend.attempts).toBe(1);
        expect((yield* manager.getThreadState("thread-a")).inputPause?.windowId).toBe(
          "fake-calculator",
        );
        yield* manager.releaseDesktopControl("thread-a");
        expect((yield* manager.getState({ windowId: "fake-calculator" })).inputPause).toBeDefined();
        expect(backend.checks).toBe(1);
        expect((yield* manager.getThreadState("thread-a")).inputPause).toBeDefined();
        backend.ready = true;
        yield* manager.getState({ windowId: "different-window" });
        expect(backend.checks).toBe(1);
        yield* manager.getState({ windowId: "fake-calculator" });
        expect((yield* manager.getThreadState("thread-a")).inputPause).toBeUndefined();
        yield* manager.typeText("thread-a", "hello");
        expect(backend.attempts).toBe(2);
      }),
    ),
  );

  it.effect("clears an app pause only for the observing task and a ready same-pid sibling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const windows: ComputerWindow[] = coveredCalculatorWindows().map((window, index) => ({
          ...window,
          pid: index === 0 ? 20 : 10,
        }));
        windows.push({ ...windows[1]!, id: "sibling", onCurrentSpace: true });
        class PausedBackend extends FakeComputerBackend {
          attempts = 0;
          checks = 0;
          override typeText(text: string) {
            return Effect.suspend(() => {
              if (++this.attempts === 1)
                return Effect.fail(
                  new ComputerBackendError({
                    message: "Observe the app again",
                    inputPause: {
                      windowId: "fake-calculator",
                      pid: 10,
                      message: "Observe the app again",
                    },
                  }),
                );
              return super.typeText(text);
            });
          }
          checkInputReady(_windowId: string) {
            return Effect.sync(() => {
              this.checks += 1;
            });
          }
        }
        const backend = new PausedBackend({ windows });
        const manager = yield* ComputerManager.make({ backend });
        expect(yield* Effect.flip(manager.typeText("owner", "hello"))).toHaveProperty("inputPause");
        yield* manager.releaseDesktopControl("owner");
        yield* withComputerTask(
          { threadId: "other", turnId: "turn" },
          manager.getState({ windowId: "sibling" }),
        );
        expect(backend.checks).toBe(0);
        yield* withComputerTask(
          { threadId: "owner", turnId: "turn" },
          manager.getState({ windowId: "fake-browser" }),
        );
        expect(backend.checks).toBe(0);
        expect((yield* manager.getThreadState("owner")).inputPause).toBeDefined();
        yield* withComputerTask(
          { threadId: "owner", turnId: "turn" },
          manager.getState({ windowId: "sibling" }),
        );
        expect(backend.checks).toBe(1);
        expect((yield* manager.getThreadState("owner")).inputPause).toBeUndefined();
      }),
    ),
  );

  it.effect("reports a launched app with an unusable window without replaying launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        class LaunchBackend extends FakeComputerBackend {
          launches = 0;
          override launchApp(app: string) {
            return Effect.sync(() => {
              this.launches += 1;
              return {
                computerId: this.computerId,
                app,
                pid: 10,
                window: null,
              } as ComputerLaunchAppResult;
            });
          }
          checkInputReady(_windowId: string) {
            return Effect.fail(new ComputerBackendError({ message: "ax_window_unresolved" }));
          }
        }
        const backend = new LaunchBackend({
          windows: coveredCalculatorWindows().map((window) => ({
            ...window,
            pid: window.id === "fake-calculator" ? 10 : 20,
          })),
        });
        const manager = yield* ComputerManager.make({ backend });
        expect(yield* manager.launchApp("owner", "com.apple.Calculator", [], 2_000)).toMatchObject({
          pid: 10,
          window: null,
          windowStatus: "no_usable_window",
          windowReason: "input_unavailable",
        });
        expect(backend.launches).toBe(1);
      }),
    ),
  );

  it.effect("publishes activity without additional desktop reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.listWindows();
        yield* manager.getThreadState("watched");
        const before = backend.calls.length;
        yield* manager.withAgentActivity("watched", Effect.void);
        expect(backend.calls.slice(before)).toEqual([]);
      }),
    ),
  );

  it.effect("evicts idle thread records while preserving increasing versions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const first = yield* manager.getThreadState("old");
        for (let i = 0; i < 260; i += 1) yield* manager.getThreadState(`idle-${i}`);
        const events = yield* recordEvents(manager);
        yield* manager.withAgentActivity("old", Effect.void);
        expect(threadStates(yield* events)).toHaveLength(0);
        expect((yield* manager.getThreadState("old")).version).toBeGreaterThan(first.version);
      }),
    ),
  );

  it.effect("assigns a newer version to each refreshed thread snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const initial = yield* manager.getThreadState("refreshed");
        backend.setAvailability({ kind: "backend-unavailable", message: "Paused" });
        const refreshed = yield* manager.getThreadState("refreshed");
        expect(refreshed.availability).toEqual({
          kind: "backend-unavailable",
          message: "Paused",
        });
        expect(refreshed.version).toBeGreaterThan(initial.version);
      }),
    ),
  );

  it.effect("versions a delayed refresh after cached activity publications", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        class DelayedBackend extends FakeComputerBackend {
          delay = false;
          override probeAvailability() {
            const probe = super.probeAvailability();
            return Effect.gen({ self: this }, function* () {
              if (this.delay) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(held);
              }
              return yield* probe;
            });
          }
        }
        const backend = new DelayedBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("refreshed");
        const events = yield* recordEvents(manager);
        backend.delay = true;
        backend.setAvailability({ kind: "backend-unavailable", message: "Paused" });
        const refreshing = yield* Effect.forkChild(manager.getThreadState("refreshed"));
        yield* Deferred.await(entered);
        yield* manager.withAgentActivity("refreshed", Effect.void);
        const cached = threadStates(yield* events).at(-1)!;
        expect(cached.availability.kind).toBe("available");
        yield* Deferred.succeed(held, undefined);
        const refreshed = yield* Fiber.join(refreshing);
        expect(refreshed.version).toBeGreaterThan(cached.version);
        expect(refreshed.availability.kind).toBe("backend-unavailable");
        expect(threadStates(yield* events).at(-1)).toEqual(refreshed);
      }),
    ),
  );

  it.effect(
    "pauses calibrated scrolling before any second input or launch and preserves pause during idle eviction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend });
          const pause = {
            windowId: "fake-calculator",
            message: "Return this window to the current Space.",
          };
          const scroll = backend.scroll.bind(backend);
          let attempts = 0;
          backend.scroll = (...args: Parameters<typeof scroll>) =>
            Effect.suspend(() => {
              attempts += 1;
              if (attempts === 1)
                return Effect.fail(
                  new ComputerBackendError({ message: pause.message, inputPause: pause }),
                );
              return scroll(...args);
            });
          expect(
            yield* Effect.flip(
              manager.scrollCalibrated("paused", { windowId: "fake-calculator" }, 0, 40, {
                observe: false,
              }),
            ),
          ).toHaveProperty("inputPause");
          yield* manager.releaseDesktopControl("paused");
          for (let i = 0; i < 260; i += 1) yield* manager.getThreadState(`other-${i}`);
          expect((yield* manager.getThreadState("paused")).inputPause).toEqual(pause);
          expect(
            yield* Effect.flip(manager.scrollCalibrated("paused", null, 0, 40, { observe: false })),
          ).toHaveProperty("inputPause");
          expect(yield* Effect.flip(manager.launchApp("paused", "Calculator"))).toHaveProperty(
            "inputPause",
          );
          expect(attempts).toBe(1);
          expect(backend.callsFor("launchApp")).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "refuses detached input after its original operation ends while allowing a fresh admitted call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend });
          const scope = yield* Effect.scope;
          const release = yield* Deferred.make<void>();
          let detached: Fiber.Fiber<unknown, ComputerOperationError> | undefined;
          yield* manager.withAgentActivity(
            "owner",
            Effect.gen(function* () {
              detached = yield* Deferred.await(release).pipe(
                Effect.andThen(manager.typeText("owner", "stale input")),
                Effect.forkIn(scope),
              );
            }),
            undefined,
            "old-turn",
          );
          yield* Deferred.succeed(release, undefined);
          const refused = yield* Effect.flip(Effect.asVoid(Fiber.join(detached!)));
          expect(refused.message).toContain("operation has ended");
          expect(backend.callsFor("typeText")).toHaveLength(0);
          yield* manager.withAgentActivity(
            "owner",
            manager.typeText("owner", "fresh input"),
            undefined,
            "new-turn",
          );
          expect(backend.callsFor("typeText")).toHaveLength(1);
        }),
      ),
  );

  it.effect("never re-admits a detached tool continuation after revocation and re-enable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const scope = yield* Effect.scope;
        const release = yield* Deferred.make<void>();
        let detached: Fiber.Fiber<unknown, ComputerOperationError> | undefined;
        yield* manager.withAgentActivity(
          "owner",
          Effect.gen(function* () {
            detached = yield* Deferred.await(release).pipe(
              Effect.andThen(
                manager.withAgentActivity("owner", manager.typeText("owner", "stale input")),
              ),
              Effect.forkIn(scope),
            );
          }),
        );
        yield* manager.setControlEnabled("owner", false);
        yield* manager.setControlEnabled("owner", true);
        yield* Deferred.succeed(release, undefined);
        const refused = yield* Effect.flip(Effect.asVoid(Fiber.join(detached!)));
        expect(refused.message).toContain("operation has ended");
        expect(backend.callsFor("typeText")).toHaveLength(0);
      }),
    ),
  );

  it.effect("settles a pending approval prompt when control is switched off mid-turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        const gate = yield* makeApprovalGate().pipe(
          Effect.provideService(ComputerApprovalRequester, {
            open: () => Deferred.succeed(opened, undefined),
            resolve: () => Effect.void,
          }),
        );
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, approvals: gate });
        const prompt = yield* Effect.forkChild(
          gate.request({
            threadId: "owner",
            turnId: "turn-1",
            callKey: "computer_type_text",
            toolName: "computer_type_text",
          }),
        );
        yield* Deferred.await(opened);
        yield* manager.setControlEnabled("owner", false);
        // Without the synchronous cancel, this hangs until the gate's timeout.
        expect(yield* Fiber.join(prompt)).toBe("denied");
        yield* gate.cancelThread("owner");
      }),
    ),
  );

  it.effect(
    "keeps a pause when the thread is re-armed while its readiness probe is in flight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          class PausedBackend extends FakeComputerBackend {
            ready = false;
            override typeText(text: string) {
              return Effect.suspend(() => {
                if (!this.ready) return Effect.fail(calculatorPause());
                return super.typeText(text);
              });
            }
            checkInputReady(_windowId: string) {
              return Effect.gen({ self: this }, function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(gate);
                if (!this.ready)
                  return yield* new ComputerBackendError({ message: "still unavailable" });
              });
            }
          }
          const backend = new PausedBackend();
          const manager = yield* ComputerManager.make({ backend });
          expect(yield* Effect.flip(manager.typeText("thread-a", "hello"))).toHaveProperty(
            "inputPause",
          );
          const probing = yield* Effect.forkChild(
            manager.getState({ windowId: "fake-calculator" }),
          );
          yield* Deferred.await(entered);
          // Re-armed to a new generation while the probe is in flight: the window
          // may be ready, but this pause was recorded under the older generation.
          yield* manager.setControlEnabled("thread-a", false);
          yield* manager.setControlEnabled("thread-a", true);
          backend.ready = true;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(probing);
          expect((yield* manager.getThreadState("thread-a")).inputPause).toBeDefined();
          expect(yield* Effect.flip(manager.typeText("thread-a", "hello"))).toHaveProperty(
            "inputPause",
          );
        }),
      ),
  );

  it.effect("measures a macOS scroll inside the two-leg, three-capture budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({ agentDialect: "macos" });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const { result, observation } = yield* manager.scrollCalibrated(
          "thread-1",
          { x: 1_100, y: 200 },
          0,
          400,
          { observe: true },
        );
        // macOS joins the common loop: probe + corrected remainder = two injects,
        // before + one after per leg = three captures, the last doubling as the
        // caller's observation. The fake's canned captures never change, so the
        // correlator honestly reports zero travel.
        expect(backend.callsFor("scroll")).toHaveLength(2);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
        expect(observation).toBeDefined();
        expect(result.scroll?.traveledY).toBe(0);
        expect(result.scroll?.requested).toEqual({ deltaX: 0, deltaY: 400 });
        expect(result.scroll?.routes).toEqual(["wheel", "wheel"]);
        const unobserved = yield* manager.scrollCalibrated(
          "thread-1",
          { x: 1_100, y: 200 },
          0,
          400,
          { observe: false },
        );
        expect(unobserved.observation).toBeUndefined();
        expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
      }),
    ),
  );

  it.effect("an action resolving after thread removal does not resurrect the thread's state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Deferred.make<void>();
        const launched = yield* Deferred.make<void>();
        const backend = new FakeComputerBackend();
        backend.launchApp = (app: string) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(launched, undefined);
            yield* Deferred.await(pending);
            return { computerId: backend.computerId, app, window: null } as ComputerLaunchAppResult;
          });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const events = yield* recordEvents(manager);

        const launching = yield* Effect.forkChild(
          Effect.ignore(manager.launchApp("removed-thread", "kcalc")),
        );
        yield* Deferred.await(launched);
        const removing = yield* Effect.forkChild(manager.handleThreadRemoved("removed-thread"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(pending, undefined);
        yield* Fiber.await(launching);
        yield* Fiber.await(removing);

        // The launch's emitAction fired after removal: the tombstone must keep it
        // from opening a pane or recreating the record the removal deleted.
        expect((yield* events).some((event) => event.type === "computer.open-pane-requested")).toBe(
          false,
        );
        const statesBefore = threadStates(yield* events).length;
        const state = yield* manager.getThreadState("removed-thread");
        expect(state.agentActive).toBe(false);
        expect(threadStates(yield* events)).toHaveLength(statesBefore);
      }),
    ),
  );

  it.effect("publishes a reported thread error exactly once, then lets refresh own the field", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);
        const states = Effect.map(events, (all) =>
          threadStates(all).filter((state) => state.threadId === "err-thread"),
        );
        yield* manager.getThreadState("err-thread");
        yield* manager.recordThreadError("err-thread", "backend hiccup");
        // The report lands in exactly one published snapshot...
        expect(
          (yield* states).filter((state) => state.lastError === "backend hiccup"),
        ).toHaveLength(1);
        // ...and the next publish reports the physical read, not a stale echo.
        yield* manager.getThreadState("err-thread");
        expect((yield* states).at(-1)?.lastError).toBeNull();
        expect(
          (yield* states).filter((state) => state.lastError === "backend hiccup"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("a pause arriving after control was revoked leaves no stale pause state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Deferred.make<void>();
        const typed = yield* Deferred.make<void>();
        const backend = new FakeComputerBackend();
        backend.typeText = (_text: string) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(typed, undefined);
            yield* Deferred.await(pending);
            return yield* calculatorPause();
          });
        const manager = yield* ComputerManager.make({ backend });
        const typing = yield* Effect.forkChild(
          Effect.exit(manager.typeText("paused-thread", "hi")),
        );
        yield* Deferred.await(typed);
        // The disable latches synchronously; the stop it queues drains once the
        // in-flight call settles, so the pause lands after the latch.
        const disabling = yield* Effect.forkChild(
          manager.setControlEnabled("paused-thread", false),
          { startImmediately: true },
        );
        yield* Deferred.succeed(pending, undefined);
        yield* Fiber.join(disabling);
        yield* Fiber.join(typing);
        // The pause landed after the revocation — recording it would tell the
        // panel a disabled thread is waiting on a window it cannot act on.
        expect((yield* manager.getThreadState("paused-thread")).inputPause).toBeUndefined();
      }),
    ),
  );

  it.effect("thread removal completes on a wedged stop — the teardown wait is bounded", () =>
    Effect.gen(function* () {
      let stops = 0;
      const backend = Object.assign(new FakeComputerBackend(), {
        stopInput: () =>
          Effect.suspend(() => {
            stops += 1;
            return Effect.never;
          }),
      });
      const scope = yield* Scope.make();
      const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 }).pipe(
        Scope.provide(scope),
      );
      yield* manager.launchApp("wedged", "kcalc");
      const removing = yield* Effect.forkChild(manager.handleThreadRemoved("wedged"));
      // The host never answers stopInput: only the teardown bound lets the
      // removal finish — the tombstone and deletions are already held.
      yield* TestClock.adjust(COMPUTER_CONTROL_ENABLE_TIMEOUT_MS + 1_000);
      yield* Fiber.join(removing);
      expect(stops).toBeGreaterThan(0);
      const disposing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* TestClock.adjust(COMPUTER_CONTROL_ENABLE_TIMEOUT_MS * 2 + 2_000);
      yield* Fiber.join(disposing);
    }),
  );
});
