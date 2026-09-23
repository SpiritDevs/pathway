import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { ComputerEvent, ComputerWindow } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import { ComputerApprovalRequester, make as makeApprovalGate } from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import {
  ComputerCallContext,
  ComputerCallTiming,
  withComputerCallContext,
} from "./computerCallContext.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";
import { FakeComputerBackend, type FakeComputerBackendOptions } from "./FakeComputerBackend.ts";

/**
 * Buffers every `computer.action` event from now on. The returned effect
 * drains what has been published so far without suspending.
 */
const foregroundRestoreActions = Effect.fn(function* (manager: ComputerManager) {
  const subscription = yield* manager.subscribeEvents;
  const actions: Array<Record<string, unknown>> = [];
  return Effect.map(PubSub.takeUpTo(subscription, Number.POSITIVE_INFINITY), (batch) => {
    for (const event of batch as ComputerEvent[]) {
      if (event.type === "computer.action") actions.push({ ...event });
    }
    return actions;
  });
});

function foregroundRaisedIds(backend: FakeComputerBackend): readonly unknown[] {
  return backend.callsFor("raiseWindow").map((call) => call.args[0]);
}

/**
 * The task-text authorization every raise now needs. These suites exercise the
 * raise/restore mechanics themselves; the never-raise gate has its own tests.
 */
const VISIBLE_USE_AUTHORIZED = { userRequestedVisibleUse: true } as const;

interface CapturedLog {
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** Runs `effect` with a logger that records every message and its annotations. */
const withCapturedLogs = <A, E, R>(
  effect: (logs: CapturedLog[]) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const logs: CapturedLog[] = [];
  const logger = Logger.make(({ fiber, message }) => {
    logs.push({
      message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  return effect(logs).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
};

it.layer(NodeServices.layer)("ComputerManager foreground", (it) => {
  describe("ComputerManager foreground containment", () => {
    for (const route of ["activate", "activate-and-restore", "foreground-input", "menu"]) {
      it.effect(`refuses ${route} before starting the backend or acquiring the desktop lease`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const backend = new FakeComputerBackend();
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
            let inputCalls = 0;
            const input = Effect.sync(() => {
              inputCalls += 1;
              return "typed";
            });
            const actions = yield* foregroundRestoreActions(manager);
            const call: Effect.Effect<unknown, ComputerOperationError> =
              route === "activate"
                ? manager.activateWindow("refused-thread", "fake-calculator")
                : route === "activate-and-restore"
                  ? manager.foregroundWithRestore("refused-thread", "fake-calculator")
                  : route === "menu"
                    ? manager.invokeMenu("refused-thread", { windowId: "fake-calculator" }, [
                        "File",
                      ])
                    : manager.withForegroundRestore("refused-thread", input);
            expect(yield* Effect.flip(Effect.asVoid(call))).toMatchObject({
              code: "foreground_not_requested",
              effect: "not-dispatched",
            });
            // A lease claim itself talks to the native driver. Checking only
            // raiseWindow misses clearFocusWindow, cursor setup and process startup.
            expect(backend.calls).toEqual([]);
            expect(inputCalls).toBe(0);
            expect(yield* actions).toEqual([]);
            // Refusing one thread must not reserve the desktop until its turn ends.
            expect(yield* manager.click("other-thread", { x: 100, y: 100 })).toMatchObject({
              action: "computer_click",
            });
          }),
        ),
      );
    }

    it.effect("refuses an activate with no task-text authorization, and raises nothing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const refused = yield* Effect.flip(
            manager.foregroundWithRestore("thread-1", "fake-calculator"),
          );
          expect(refused).toMatchObject({
            code: "foreground_not_requested",
            effect: "not-dispatched",
          });
          // Nothing raised, nothing aimed, no action event: the refusal is before
          // any dispatch.
          expect(foregroundRaisedIds(backend)).toEqual([]);
          expect(backend.callsFor("focusWindow")).toEqual([]);
          expect(yield* actions).toEqual([]);
        }),
      ),
    );

    it.effect("refuses an explicit false authorization the same way", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          expect(
            yield* Effect.flip(
              manager.foregroundWithRestore("thread-1", "fake-calculator", undefined, {
                userRequestedVisibleUse: false,
              }),
            ),
          ).toMatchObject({ code: "foreground_not_requested" });
          expect(foregroundRaisedIds(backend)).toEqual([]);
        }),
      ),
    );

    it.effect("refuses a foreground call and a plain activate without authorization", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          expect(
            yield* Effect.flip(manager.withForegroundRestore("thread-1", Effect.succeed("typed"))),
          ).toMatchObject({ code: "foreground_not_requested" });
          expect(
            yield* Effect.flip(manager.activateWindow("thread-1", "fake-calculator")),
          ).toMatchObject({ code: "foreground_not_requested" });
          expect(foregroundRaisedIds(backend)).toEqual([]);
        }),
      ),
    );

    it.effect(
      "refuses the raise while the user was just interacting through the pane, then allows it after quiet",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(1_000_000);
            const backend = new FakeComputerBackend();
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
            // The human drives the desktop through the pane: no owning thread.
            yield* manager.click(undefined, { x: 100, y: 100 });
            const refused = yield* Effect.flip(
              manager.foregroundWithRestore(
                "thread-1",
                "fake-calculator",
                undefined,
                VISIBLE_USE_AUTHORIZED,
              ),
            );
            expect(refused).toMatchObject({
              code: "foreground_user_interaction",
              effect: "not-dispatched",
            });
            expect(foregroundRaisedIds(backend)).toEqual([]);
            // Quiet for the guard window: the same authorized raise now runs.
            yield* TestClock.adjust(2_001);
            const result = yield* manager.foregroundWithRestore(
              "thread-1",
              "fake-calculator",
              undefined,
              VISIBLE_USE_AUTHORIZED,
            );
            expect(result.windowId).toBe("fake-calculator");
            expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
          }),
        ),
    );

    it.effect("does not let a pane raise be blocked by the pane's own interaction stamp", () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Pane input belongs to the human: the guard protects them from the agent,
          // never from themselves.
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.click(undefined, { x: 100, y: 100 });
          expect(yield* manager.activateWindow(undefined, "fake-calculator")).toMatchObject({
            windowId: "fake-calculator",
          });
          expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator"]);
        }),
      ),
    );
  });

  describe("ComputerManager foregroundWithRestore", () => {
    it.effect("restores the previously frontmost window after raising the target", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          // The default fake listing is topmost-first: fake-terminal is frontmost.
          const result = yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(result.windowId).toBe("fake-calculator");
          expect(result.note).toBeUndefined();
          expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
          const emitted = yield* actions;
          expect(emitted).toHaveLength(1);
          expect(emitted[0]).toMatchObject({
            action: "computer_activate_window",
            windowId: "fake-calculator",
            restoredWindowId: "fake-terminal",
            restoreStatus: "restored",
          });
          expect(emitted[0]).not.toHaveProperty("message");
        }),
      ),
    );

    it.effect("counts one foreground excursion on the call timing record", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const timing = new ComputerCallTiming(0);
          yield* withComputerCallContext(
            new ComputerCallContext({ timing }),
            manager.foregroundWithRestore(
              "thread-1",
              "fake-calculator",
              undefined,
              VISIBLE_USE_AUTHORIZED,
            ),
          );
          const lines = yield* withCapturedLogs((logs) =>
            Effect.map(timing.finish(), () => logs.map((log) => log.message)),
          );
          expect(lines.join("\n")).toContain("foreground_excursion=1");
        }),
      ),
    );

    it.effect("reports a missed restore as success with a note naming the unrestored window", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const raise = backend.raiseWindow.bind(backend);
          const attempts: string[] = [];
          backend.raiseWindow = (windowId: string) =>
            Effect.suspend(() => {
              attempts.push(windowId);
              if (windowId === "fake-terminal")
                return Effect.fail(new ComputerBackendError({ message: "The window closed." }));
              return raise(windowId);
            });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const result = yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          // The activation itself succeeded; only the restore missed — never silent.
          expect(result.windowId).toBe("fake-calculator");
          expect(result.note).toEqual(expect.stringContaining("fake-terminal"));
          // The throwing restore attempt is not in the backend's own call log, so
          // the attempts are tracked here: the restore was tried, then missed.
          expect(attempts).toEqual(["fake-calculator", "fake-terminal"]);
          const emitted = yield* actions;
          expect(emitted).toHaveLength(1);
          expect(emitted[0]).toMatchObject({
            restoreStatus: "restore-missed",
            restoredWindowId: "fake-terminal",
            message: expect.stringContaining("fake-terminal"),
          });
        }),
      ),
    );

    it.effect("runs the approved input between raise and restore without a second approval", () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The manager's approval seam is the gate itself: any second approval
          // would have to open a card through the requester.
          let opened = 0;
          const gate = yield* makeApprovalGate().pipe(
            Effect.provideService(ComputerApprovalRequester, {
              open: () =>
                Effect.sync(() => {
                  opened += 1;
                }),
              resolve: () => Effect.void,
            }),
          );
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({
            backend,
            actionSettleMs: 0,
            approvals: gate,
          });
          const order: string[] = [];
          const raise = backend.raiseWindow.bind(backend);
          backend.raiseWindow = (windowId: string) =>
            Effect.suspend(() => {
              order.push(`raise:${windowId}`);
              return raise(windowId);
            });
          yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            Effect.sync(() => {
              order.push("input");
            }),
            VISIBLE_USE_AUTHORIZED,
          );
          expect(order).toEqual(["raise:fake-calculator", "input", "raise:fake-terminal"]);
          // The activate approval covers the whole excursion, restore included.
          expect(opened).toBe(0);
          yield* gate.cancelThread("thread-1");
        }),
      ),
    );

    it.effect("still restores when the approved input fails, then reports the input failure", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const failure = yield* Effect.flip(
            manager.foregroundWithRestore(
              "thread-1",
              "fake-calculator",
              Effect.fail(new ComputerBackendError({ message: "input blew up" })),
              VISIBLE_USE_AUTHORIZED,
            ),
          );
          expect(failure.message).toContain("input blew up");
          // The desktop is put back even though the input failed — and a failed
          // action emits no computer.action event, as on every other path.
          expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
          expect(yield* actions).toHaveLength(0);
        }),
      ),
    );

    it.effect("skips the restore when the target is already frontmost", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const result = yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-terminal",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(result.windowId).toBe("fake-terminal");
          expect(result.note).toBeUndefined();
          expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
          const emitted = yield* actions;
          expect(emitted).toHaveLength(1);
          expect(emitted[0]).toMatchObject({ restoreStatus: "already-frontmost" });
          expect(emitted[0]).not.toHaveProperty("restoredWindowId");
        }),
      ),
    );

    it.effect("notes when no frontmost window was observable, and restores nothing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hidden: readonly ComputerWindow[] = [
            {
              id: "hidden-terminal",
              title: "Terminal",
              appName: "org.kde.konsole",
              bounds: { x: 40, y: 40, width: 960, height: 720 },
              focused: false,
              minimized: true,
              visible: false,
            },
            {
              id: "hidden-calculator",
              title: "Calculator",
              appName: "org.kde.kcalc",
              bounds: { x: 1_050, y: 120, width: 420, height: 620 },
              focused: false,
              minimized: true,
              visible: false,
            },
          ];
          const backend = new FakeComputerBackend({ windows: hidden });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const result = yield* manager.foregroundWithRestore(
            "thread-1",
            "hidden-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(result.windowId).toBe("hidden-calculator");
          expect(result.note).toEqual(expect.stringContaining("nothing was restored"));
          expect(foregroundRaisedIds(backend)).toEqual(["hidden-calculator"]);
          const emitted = yield* actions;
          expect(emitted).toHaveLength(1);
          expect(emitted[0]).toMatchObject({
            restoreStatus: "frontmost-unobservable",
          });
          expect(emitted[0]).not.toHaveProperty("restoredWindowId");
        }),
      ),
    );
  });

  describe("ComputerManager withForegroundRestore", () => {
    const terminalFirst: readonly ComputerWindow[] = [
      {
        id: "fake-terminal",
        title: "Terminal",
        appName: "org.kde.konsole",
        bounds: { x: 40, y: 40, width: 960, height: 720 },
        focused: true,
        minimized: false,
        visible: true,
      },
      {
        id: "fake-calculator",
        title: "Calculator",
        appName: "org.kde.kcalc",
        bounds: { x: 1050, y: 120, width: 420, height: 620 },
        focused: false,
        minimized: false,
        visible: true,
      },
    ];
    const calculatorFirst: readonly ComputerWindow[] = [terminalFirst[1]!, terminalFirst[0]!];

    function scriptedListing(
      backend: FakeComputerBackend,
      listing: { current: readonly ComputerWindow[] },
    ): void {
      backend.listWindows = () => Effect.sync(() => listing.current);
    }

    it.effect("puts the user's window back after a foreground call moves focus", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const listing = { current: terminalFirst };
          scriptedListing(backend, listing);
          const result = yield* manager.withForegroundRestore(
            "thread-1",
            Effect.sync(() => {
              // The foreground call raises its target past the user's window.
              listing.current = calculatorFirst;
              return "typed";
            }),
            VISIBLE_USE_AUTHORIZED,
          );
          expect(result).toBe("typed");
          expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
          expect(backend.callsFor("focusWindow").map((call) => call.args[0])).toEqual([
            "fake-terminal",
          ]);
        }),
      ),
    );

    it.effect("skips the raise when the foreground call never moved focus", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const listing = { current: terminalFirst };
          scriptedListing(backend, listing);
          yield* manager.withForegroundRestore(
            "thread-1",
            Effect.succeed("typed"),
            VISIBLE_USE_AUTHORIZED,
          );
          expect(foregroundRaisedIds(backend)).toEqual([]);
          expect(backend.callsFor("focusWindow")).toEqual([]);
        }),
      ),
    );

    it.effect("still restores when the wrapped call fails, then reports the failure", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const listing = { current: terminalFirst };
          scriptedListing(backend, listing);
          const failure = yield* Effect.flip(
            manager.withForegroundRestore(
              "thread-1",
              Effect.suspend(() => {
                listing.current = calculatorFirst;
                return Effect.fail(new ComputerBackendError({ message: "input blew up" }));
              }),
              VISIBLE_USE_AUTHORIZED,
            ),
          );
          expect(failure.message).toContain("input blew up");
          expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
        }),
      ),
    );

    it.effect("restores nothing when no frontmost window was observable", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const listing = { current: [] as readonly ComputerWindow[] };
          scriptedListing(backend, listing);
          yield* manager.withForegroundRestore(
            "thread-1",
            Effect.succeed("typed"),
            VISIBLE_USE_AUTHORIZED,
          );
          expect(foregroundRaisedIds(backend)).toEqual([]);
        }),
      ),
    );

    it.effect("warns when the post-call read fails and the restore cannot run blind", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          let actionDone = false;
          backend.listWindows = () =>
            Effect.suspend(() => {
              if (!actionDone) return Effect.succeed(terminalFirst);
              return Effect.fail(new ComputerBackendError({ message: "listing wedged" }));
            });
          const logs = yield* withCapturedLogs((logs) =>
            Effect.as(
              manager.withForegroundRestore(
                "thread-1",
                Effect.sync(() => {
                  actionDone = true;
                  return "typed";
                }),
                VISIBLE_USE_AUTHORIZED,
              ),
              logs,
            ),
          );
          // Whether the excursion stole the frontmost is unknown — that is the
          // warn, not silence.
          expect(logs).toContainEqual({
            message: "[computer] foreground call left focus unverified",
            annotations: expect.objectContaining({ previousWindowId: "fake-terminal" }),
          });
          expect(foregroundRaisedIds(backend)).toEqual([]);
        }),
      ),
    );
  });

  describe("ComputerManager masked activation", () => {
    const MASKED_FLAGS = ["PATHWAY_CUA_MASKED_ACTIVATION", "PATHWAY_CUA_MASKED_APPS"] as const;
    const saved = new Map(MASKED_FLAGS.map((flag) => [flag, process.env[flag]]));

    afterEach(() => {
      for (const flag of MASKED_FLAGS) {
        const value = saved.get(flag);
        if (value === undefined) delete process.env[flag];
        else process.env[flag] = value;
      }
    });

    /** The canary's two flags, both required before any shield may arm. */
    function armMaskedActivation(apps = "org.kde.kcalc"): void {
      process.env.PATHWAY_CUA_MASKED_ACTIVATION = "1";
      process.env.PATHWAY_CUA_MASKED_APPS = apps;
    }

    /** A macOS-dialect fake with the shield surface present — the CUA shape. */
    function shieldedMacBackend(options: FakeComputerBackendOptions = {}): FakeComputerBackend {
      return new FakeComputerBackend({ agentDialect: "macos", shield: true, ...options });
    }

    /** The engage→raise→restore→release order, as one recorded method list. */
    function shieldExcursionOrder(backend: FakeComputerBackend): readonly string[] {
      return backend.calls
        .filter((call) => ["engageShield", "raiseWindow", "releaseShield"].includes(call.method))
        .map((call) =>
          call.method === "raiseWindow" ? `${call.method}:${String(call.args[0])}` : call.method,
        );
    }

    it.effect("shields the opted-in window's raise and releases the mask after the restore", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation();
          const backend = shieldedMacBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          const result = yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(result.windowId).toBe("fake-calculator");
          // The mask goes up before the target moves and comes down only after
          // the previous window is back — the excursion is never visible.
          expect(shieldExcursionOrder(backend)).toEqual([
            "engageShield",
            "raiseWindow:fake-calculator",
            "raiseWindow:fake-terminal",
            "releaseShield",
          ]);
          const engage = backend.callsFor("engageShield")[0]!;
          expect(engage.args[0]).toMatchObject({
            windowId: "fake-calculator",
            frame: { x: 1_050, y: 120, width: 420, height: 620 },
            label: "Pathway is activating Calculator",
          });
          const shieldId = (engage.args[0] as { shieldId: string }).shieldId;
          expect(shieldId).toMatch(/^shield-[0-9a-f]{8}$/);
          // The manager minted the id, so release names the same one.
          expect(backend.callsFor("releaseShield").map((call) => call.args[0])).toEqual([shieldId]);
          expect(backend.activeShields()).toEqual([]);
          const emitted = yield* actions;
          expect(emitted).toHaveLength(1);
          expect(emitted[0]).toMatchObject({
            action: "computer_activate_window",
            masked: true,
            restoreStatus: "restored",
          });
        }),
      ),
    );

    it.effect("masks nothing while the canary flag is unset, even with a shield surface", () =>
      Effect.scoped(
        Effect.gen(function* () {
          delete process.env.PATHWAY_CUA_MASKED_ACTIVATION;
          delete process.env.PATHWAY_CUA_MASKED_APPS;
          const backend = shieldedMacBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const actions = yield* foregroundRestoreActions(manager);
          yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(backend.callsFor("engageShield")).toEqual([]);
          expect((yield* actions)[0]).not.toHaveProperty("masked");
        }),
      ),
    );

    it.effect("masks nothing when the opt-in list names a different app", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation("com.example.other");
          const backend = shieldedMacBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(backend.callsFor("engageShield")).toEqual([]);
        }),
      ),
    );

    it.effect("masks nothing on a non-macOS dialect even when armed and opted in", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation();
          // The default fake reports no dialect, which the manager reads as linux.
          const backend = new FakeComputerBackend({ shield: true });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(backend.callsFor("engageShield")).toEqual([]);
        }),
      ),
    );

    it.effect("resolves the opt-in through the owning app's bundle id, not the window title", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation("org.kde.kcalc");
          const windows: readonly ComputerWindow[] = [
            {
              id: "fake-terminal",
              title: "Terminal",
              appName: "Terminal",
              pid: 1_001,
              bounds: { x: 40, y: 40, width: 960, height: 720 },
              focused: true,
              minimized: false,
              visible: true,
            },
            {
              id: "fake-calculator",
              title: "Calculator",
              // A display name, not the bundle id the opt-in list carries.
              appName: "Calculator",
              pid: 1_002,
              bounds: { x: 1_050, y: 120, width: 420, height: 620 },
              focused: false,
              minimized: false,
              visible: true,
            },
          ];
          const backend = shieldedMacBackend({
            windows,
            apps: [
              {
                pid: 1_001,
                name: "Terminal",
                bundleId: "org.kde.konsole",
                running: true,
                active: true,
                windowCount: 1,
              },
              {
                pid: 1_002,
                name: "Calculator",
                bundleId: "org.kde.kcalc",
                running: true,
                active: false,
                windowCount: 1,
              },
            ],
          });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.foregroundWithRestore(
            "thread-1",
            "fake-calculator",
            undefined,
            VISIBLE_USE_AUTHORIZED,
          );
          expect(backend.callsFor("engageShield")).toHaveLength(1);
        }),
      ),
    );

    it.effect("refuses the activation when the opt-in is armed but no shield surface exists", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation();
          // A macOS backend whose host build lacks the shield command: the armed
          // opt-in must fail closed rather than degrade to a visible raise.
          const backend = new FakeComputerBackend({ agentDialect: "macos" });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const refused = yield* Effect.flip(
            manager.foregroundWithRestore(
              "thread-1",
              "fake-calculator",
              undefined,
              VISIBLE_USE_AUTHORIZED,
            ),
          );
          expect(refused.message).toContain("activation shield is unavailable");
          expect(foregroundRaisedIds(backend)).toEqual([]);
        }),
      ),
    );

    it.effect(
      "refuses the activation when the shield cannot engage, and releases the minted id",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            armMaskedActivation();
            const backend = shieldedMacBackend();
            backend.failNext(
              "engageShield",
              new ComputerBackendError({ message: "mask_unavailable" }),
            );
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
            // A typed backend refusal surfaces as-is; only an untyped failure is
            // wrapped in the "could not be shown" message.
            const refused = yield* Effect.flip(
              manager.foregroundWithRestore(
                "thread-1",
                "fake-calculator",
                undefined,
                VISIBLE_USE_AUTHORIZED,
              ),
            );
            expect(refused.message).toContain("mask_unavailable");
            // A lost engage reply can still leave a shield up: the minted id is
            // released before the refusal is reported, and no raise ever ran.
            const engages = backend.callsFor("engageShield");
            const releases = backend.callsFor("releaseShield");
            expect(engages).toHaveLength(1);
            expect(releases.map((call) => call.args[0])).toEqual([
              (engages[0]!.args[0] as { shieldId: string }).shieldId,
            ]);
            expect(foregroundRaisedIds(backend)).toEqual([]);
            expect(backend.activeShields()).toEqual([]);
          }),
        ),
    );

    it.effect("drops the shield when the masked excursion itself fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          armMaskedActivation();
          const backend = shieldedMacBackend();
          backend.raiseWindow = () =>
            Effect.fail(new ComputerBackendError({ message: "The window closed." }));
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const failure = yield* Effect.flip(
            manager.foregroundWithRestore(
              "thread-1",
              "fake-calculator",
              undefined,
              VISIBLE_USE_AUTHORIZED,
            ),
          );
          expect(failure.message).toContain("window closed");
          // The raise failed under an up mask: the finally path still released
          // it — a shield outlives nothing, not even a dead excursion.
          expect(backend.callsFor("releaseShield")).toHaveLength(1);
          expect(backend.activeShields()).toEqual([]);
        }),
      ),
    );
  });
});
