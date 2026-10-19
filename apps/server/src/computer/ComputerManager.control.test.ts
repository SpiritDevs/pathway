import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type {
  ComputerEvent,
  ComputerUiNode,
  ComputerWindow,
  ProviderApprovalDecision,
  ThreadComputerState,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerBackendActionResult } from "./ComputerBackend.ts";
import {
  ComputerApprovalRequester,
  make as makeComputerApprovalGate,
  type ComputerApprovalPrompt,
} from "./ComputerApprovalGate.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import { ComputerManager } from "./ComputerManager.ts";
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

/**
 * Every event the manager publishes from the moment this opens. `drain` pulls
 * whatever has arrived without suspending and returns the whole history, so a
 * test reads it the way Synara read the array its `onEvent` callback filled.
 */
const recordEvents = (
  manager: ComputerManager,
): Effect.Effect<
  {
    readonly drain: Effect.Effect<readonly ComputerEvent[]>;
    /** Suspends until an event matching `predicate` has been published. */
    readonly waitFor: (predicate: (event: ComputerEvent) => boolean) => Effect.Effect<void>;
  },
  never,
  Scope.Scope
> =>
  Effect.map(manager.subscribeEvents, (subscription) => {
    const seen: ComputerEvent[] = [];
    const drain = Effect.map(PubSub.takeUpTo(subscription, Number.POSITIVE_INFINITY), (events) => {
      seen.push(...events);
      return seen;
    });
    const waitFor = (predicate: (event: ComputerEvent) => boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (!(yield* drain).some(predicate)) {
          seen.push(yield* PubSub.take(subscription));
        }
      });
    return { drain, waitFor };
  });

const openPaneRequests = (events: readonly ComputerEvent[]): string[] =>
  events.flatMap((event) =>
    event.type === "computer.open-pane-requested" ? [event.threadId] : [],
  );

const threadStates = (events: readonly ComputerEvent[]): ThreadComputerState[] =>
  events.flatMap((event) => (event.type === "computer.thread-state" ? [event.state] : []));

const SETTLE_ENV = ["PATHWAY_CUA_CONDITIONAL_SETTLE", "PATHWAY_CUA_ACTION_SETTLE_MS"] as const;
type SettleEnv = (typeof SETTLE_ENV)[number];

const assignEnv = (name: SettleEnv, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/** Sets one settle flag for the rest of the test's scope, restoring it on close. */
const setEnv = (name: SettleEnv, value: string | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      assignEnv(name, value);
      return previous;
    }),
    (previous) => Effect.sync(() => assignEnv(name, previous)),
  );

/**
 * The settle is a bare `Effect.sleep(actionSettleMs)`: whether it ran is
 * visible as a sleep requested with exactly that duration, which is a
 * deterministic check no elapsed-time assertion can match. The recording clock
 * answers every sleep at once, the way Synara spied on `setTimeout`.
 */
const recordSleeps = Effect.gen(function* () {
  const base = yield* Clock.Clock;
  const sleeps: number[] = [];
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.sync(() => {
        sleeps.push(Duration.toMillis(duration));
      }),
  };
  return {
    sleeps,
    waitedFor: (ms: number) => sleeps.includes(ms),
    clear: () => {
      sleeps.length = 0;
    },
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Clock.Clock, clock),
  };
});

/** A backend whose key presses report whatever verdict the test sets. */
class ProvenBackend extends FakeComputerBackend {
  proof: ComputerBackendActionResult = {};
  override pressKey(key: string) {
    return Effect.map(super.pressKey(key), (result) => ({ ...result, ...this.proof }));
  }
}

/**
 * Press then observe inside one agent call, optionally naming the window the
 * action touched — the only case the driver observer can scope to.
 */
const pressThenObserve = (manager: ComputerManager, windowId?: string) =>
  manager.withAgentActivity(
    "thread-1",
    Effect.gen(function* () {
      yield* manager.pressKey("thread-1", "enter");
      return yield* manager.captureActionScreenshot(windowId);
    }),
  );

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const refuseSettle = (message: string) => Effect.fail(new ComputerBackendError({ message }));

it.layer(NodeServices.layer)("ComputerManager and FakeComputerBackend (control)", (it) => {
  it.effect(
    "explains a scoped injection the desktop refused, and passes other failures through",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({
            windows: coveredCalculatorWindows(),
          });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

          // A refusal means nothing was delivered, so the caller has to be told that
          // and told what to change; the compositor only names the call it declined.
          backend.failNext(
            "click",
            new ComputerBackendError({
              message: "The computer backend rejected pressButton.",
              retryable: true,
              rejectedOperation: "pressButton",
            }),
          );
          const refused = yield* Effect.flip(
            manager.click("thread-1", {
              x: 1_100,
              y: 200,
              windowId: "fake-calculator",
            }),
          );
          expect(refused).toMatchObject({ code: "computer_target_refused" });
          expect(refused.message).toMatch(/no input was sent/);
          expect(refused.message).toMatch(/label instead of a coordinate/);

          // An unscoped action has no window to blame, so its error is left alone.
          backend.failNext(
            "click",
            new ComputerBackendError({
              message: "The computer backend rejected pressButton.",
              rejectedOperation: "pressButton",
            }),
          );
          const unscoped = yield* Effect.flip(manager.click("thread-1", { x: 1_100, y: 200 }));
          expect(unscoped.message).toMatch(/computer backend rejected pressButton/);

          // A fault is not a refusal: rewriting it would claim an injection never
          // happened when it may well have.
          backend.failNext(
            "click",
            new ComputerBackendError({ message: "session bus disconnected" }),
          );
          const fault = yield* Effect.flip(
            manager.click("thread-1", {
              x: 1_100,
              y: 200,
              windowId: "fake-calculator",
            }),
          );
          expect(fault.message).toMatch(/session bus disconnected/);
        }),
      ),
  );

  describe("the post-action settle", () => {
    it.effect(
      "PATHWAY_CUA_CONDITIONAL_SETTLE=0 restores the fixed wait even on a verified effect",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "0");
            const backend = new ProvenBackend();
            backend.proof = { effect: "verified", verified: "confirmed" };
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager));
            expect(sleeps.waitedFor(60)).toBe(true);
          }),
        ),
    );

    it.effect("skips the wait on a verified effect by default — no flag needed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
          const backend = new ProvenBackend();
          backend.proof = { effect: "verified", verified: "confirmed" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager));
          expect(sleeps.waitedFor(60)).toBe(false);
        }),
      ),
    );

    it.effect("still waits the compiled 300 ms when nothing overrides it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_ACTION_SETTLE_MS", undefined);
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
          const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager));
          expect(sleeps.waitedFor(300)).toBe(true);
        }),
      ),
    );

    it.effect("PATHWAY_CUA_ACTION_SETTLE_MS overrides the wait, and an explicit 0 removes it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
          yield* setEnv("PATHWAY_CUA_ACTION_SETTLE_MS", "45");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const manager = yield* ComputerManager.make({
                backend: new FakeComputerBackend(),
              });
              const sleeps = yield* recordSleeps;
              yield* sleeps.run(pressThenObserve(manager));
              expect(sleeps.waitedFor(45)).toBe(true);
            }),
          );

          yield* setEnv("PATHWAY_CUA_ACTION_SETTLE_MS", "0");
          const zeroed = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
          const zero = yield* recordSleeps;
          yield* zero.run(pressThenObserve(zeroed));
          // 0 means no settle leg at all — no sleep is even requested.
          expect(zero.waitedFor(0)).toBe(false);
        }),
      ),
    );

    it.effect("a constructor override wins over PATHWAY_CUA_ACTION_SETTLE_MS", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
          yield* setEnv("PATHWAY_CUA_ACTION_SETTLE_MS", "45");
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            actionSettleMs: 60,
          });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager));
          expect(sleeps.waitedFor(60)).toBe(true);
          expect(sleeps.waitedFor(45)).toBe(false);
        }),
      ),
    );

    it.effect("PATHWAY_CUA_CONDITIONAL_SETTLE skips the wait on a verified effect", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend();
          backend.proof = { effect: "verified" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager));
          expect(sleeps.waitedFor(60)).toBe(false);
        }),
      ),
    );

    it.effect("PATHWAY_CUA_CONDITIONAL_SETTLE skips the wait on a confirmed read-back", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend();
          backend.proof = { verified: "confirmed" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager));
          expect(sleeps.waitedFor(60)).toBe(false);
        }),
      ),
    );

    const unprovenVerdicts: ReadonlyArray<
      readonly [label: string, proof: ComputerBackendActionResult]
    > = [
      ["an unconfirmed read-back", { verified: "unconfirmed" }],
      ["an unverifiable surface", { verified: "unverifiable" }],
      ["an unknown dispatch", { effect: "dispatched-unknown" }],
      ["no verdict at all", {}],
    ];
    for (const [label, proof] of unprovenVerdicts) {
      it.effect(`PATHWAY_CUA_CONDITIONAL_SETTLE keeps the wait after ${label}`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
            const backend = new ProvenBackend();
            backend.proof = proof;
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager));
            expect(sleeps.waitedFor(60)).toBe(true);
          }),
        ),
      );
    }

    it.effect("consumes the proof once: a second observation in the same call settles again", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend();
          backend.proof = { effect: "verified" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(
            manager.withAgentActivity(
              "thread-1",
              Effect.gen(function* () {
                yield* manager.pressKey("thread-1", "enter");
                yield* manager.captureActionScreenshot();
                expect(sleeps.waitedFor(60)).toBe(false);
                yield* manager.captureActionScreenshot();
                expect(sleeps.waitedFor(60)).toBe(true);
              }),
            ),
          );
        }),
      ),
    );

    it.effect("a second action's verdict replaces the first inside one call", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(
            manager.withAgentActivity(
              "thread-1",
              Effect.gen(function* () {
                backend.proof = { effect: "verified" };
                yield* manager.pressKey("thread-1", "enter");
                // The second action could not prove itself; its verdict is the one
                // the following observation must honor.
                backend.proof = { effect: "dispatched-unknown" };
                yield* manager.pressKey("thread-1", "enter");
                yield* manager.captureActionScreenshot();
                expect(sleeps.waitedFor(60)).toBe(true);
              }),
            ),
          );
        }),
      ),
    );

    it.effect("a verdict never waives a later call's settle", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend();
          backend.proof = { effect: "verified" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(
            manager.withAgentActivity(
              "thread-1",
              // The observation was never taken inside this call, so the proof is
              // still sitting on the context when the call ends — and must die
              // with it.
              Effect.asVoid(manager.pressKey("thread-1", "enter")),
            ),
          );
          yield* sleeps.run(
            manager.withAgentActivity(
              "thread-1",
              Effect.gen(function* () {
                yield* manager.captureActionScreenshot();
                expect(sleeps.waitedFor(60)).toBe(true);
              }),
            ),
          );
        }),
      ),
    );

    it.effect(
      "prefers the driver's observed settle when the backend offers it and a window is known",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
            const backend = new ProvenBackend({ waitForSettle: true });
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
            const settleCalls = backend.callsFor("waitForSettle");
            expect(settleCalls).toHaveLength(1);
            expect(settleCalls[0]?.args[0]).toMatchObject({
              windowId: "fake-terminal",
              timeoutMs: 5_000,
              quietMs: 60,
            });
            // The observer answered the settle itself; no blind timer ran beside it.
            expect(sleeps.waitedFor(60)).toBe(false);
          }),
        ),
    );

    it.effect(
      "a busy verdict from the observer still ends the wait — the timeout already covered the bound",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
            const backend = new ProvenBackend({
              waitForSettle: () =>
                Effect.succeed({ settled: false, waitedMs: 5_000, eventsSeen: 14 }),
            });
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
            expect(backend.callsFor("waitForSettle")).toHaveLength(1);
            expect(sleeps.waitedFor(60)).toBe(false);
          }),
        ),
    );

    it.effect(
      "falls back to the fixed wait without a window hint, even when the observer exists",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
            const backend = new ProvenBackend({ waitForSettle: true });
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager));
            expect(backend.callsFor("waitForSettle")).toHaveLength(0);
            expect(sleeps.waitedFor(60)).toBe(true);
          }),
        ),
    );

    for (const refusalMessage of [
      "Unknown tool: wait_for_settle [effect=not-dispatched; automatic replay is forbidden]",
      "Unsupported computer host request.",
    ]) {
      it.effect(
        `a backend that cannot name the tool falls back once and is never probed again — ${refusalMessage}`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
              let probes = 0;
              const backend = new ProvenBackend({
                waitForSettle: () =>
                  Effect.suspend(() => {
                    probes += 1;
                    return refuseSettle(refusalMessage);
                  }),
              });
              const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
              const sleeps = yield* recordSleeps;
              yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
              expect(probes).toBe(1);
              expect(sleeps.waitedFor(60)).toBe(true);
              sleeps.clear();
              yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
              // The refusal is cached for the backend's life: the second action
              // goes straight to the fixed wait instead of paying a dead call.
              expect(probes).toBe(1);
              expect(backend.callsFor("waitForSettle")).toHaveLength(1);
              expect(sleeps.waitedFor(60)).toBe(true);
            }),
          ),
      );
    }

    it.effect(
      "a transient observer failure falls back for that call but does not poison the probe",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
            let fail = true;
            const backend = new ProvenBackend({
              waitForSettle: () =>
                Effect.suspend(() =>
                  fail
                    ? refuseSettle(
                        "wait_for_settle: window_id 42 is closed, stale, or unknown to WindowServer",
                      )
                    : Effect.succeed({ settled: true, waitedMs: 30 }),
                ),
            });
            const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
            const sleeps = yield* recordSleeps;
            yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
            expect(backend.callsFor("waitForSettle")).toHaveLength(1);
            expect(sleeps.waitedFor(60)).toBe(true);
            fail = false;
            sleeps.clear();
            yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
            // Not remembered as unsupported: the next action retries the observer
            // and this time it answers, so no fixed wait runs.
            expect(backend.callsFor("waitForSettle")).toHaveLength(2);
            expect(sleeps.waitedFor(60)).toBe(false);
          }),
        ),
    );

    it.effect("a proven effect still skips the wait entirely, observer included", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const backend = new ProvenBackend({ waitForSettle: true });
          backend.proof = { effect: "verified" };
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
          expect(backend.callsFor("waitForSettle")).toHaveLength(0);
          expect(sleeps.waitedFor(60)).toBe(false);
        }),
      ),
    );

    it.effect("an observer refusal mid-observation never replays the action", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", undefined);
          const backend = new ProvenBackend({
            waitForSettle: () => refuseSettle("Unknown tool: wait_for_settle"),
          });
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 60 });
          const sleeps = yield* recordSleeps;
          yield* sleeps.run(pressThenObserve(manager, "fake-terminal"));
          // The uncertain wait fell back and the observation still landed; the
          // action it observed ran exactly once.
          expect(backend.callsFor("pressKey")).toHaveLength(1);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
        }),
      ),
    );
  });

  it.effect("attributes every action event to the thread that drove it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);

        yield* manager.launchApp("thread-1", "kcalc");
        yield* manager.click("thread-1", { x: 10, y: 10 });
        yield* manager.doubleClick("thread-1", { x: 10, y: 10 });
        yield* manager.rightClick("thread-1", { x: 10, y: 10 });
        yield* manager.moveCursor("thread-1", { x: 10, y: 10 });
        yield* manager.drag("thread-1", { x: 10, y: 10 }, { x: 20, y: 20 });
        yield* manager.scroll("thread-1", null, 0, 12);
        yield* manager.typeText("thread-1", "hi");
        yield* manager.pressKey("thread-1", "enter");
        yield* manager.hotkey("thread-1", ["ctrl", "s"]);
        yield* manager.writeClipboard("thread-1", "clip");
        yield* manager.readClipboard("thread-1");
        yield* manager.setValue("thread-1", { label: "Display" }, "12");
        yield* manager.performAction(
          "thread-1",
          { label: "Calculate", role: "button" },
          "activate",
        );
        yield* manager.selectText("thread-1", { label: "Display" }, { start: 0, length: 1 });

        const actions = (yield* events.drain).flatMap((event) =>
          event.type === "computer.action"
            ? [
                {
                  action: event.action,
                  ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
                },
              ]
            : [],
        );
        expect(actions).toEqual([
          { action: "computer_launch_app", threadId: "thread-1" },
          { action: "computer_click", threadId: "thread-1" },
          { action: "computer_click", threadId: "thread-1" },
          { action: "computer_click", threadId: "thread-1" },
          { action: "computer_move_cursor", threadId: "thread-1" },
          { action: "computer_drag", threadId: "thread-1" },
          { action: "computer_scroll", threadId: "thread-1" },
          { action: "computer_type_text", threadId: "thread-1" },
          { action: "computer_press_key", threadId: "thread-1" },
          { action: "computer_press_key", threadId: "thread-1" },
          { action: "computer_write_clipboard", threadId: "thread-1" },
          { action: "computer_read_clipboard", threadId: "thread-1" },
          { action: "computer_set_value", threadId: "thread-1" },
          { action: "computer_perform_action", threadId: "thread-1" },
          { action: "computer_select_text", threadId: "thread-1" },
        ]);
      }),
    ),
  );

  it.effect(
    "carries clipboard text on the shared action result, and refuses it without backend support",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend });

          yield* manager.writeClipboard("thread-1", "shared text");
          expect(yield* manager.readClipboard("thread-1")).toMatchObject({
            action: "computer_read_clipboard",
            value: "shared text",
          });

          // Reads are bounded by the contract limit on `value`; writes are not, so a
          // large paste is fine but cannot come back through the result field.
          yield* manager.writeClipboard("thread-1", "x".repeat(16 * 1024 + 1));
          expect((yield* Effect.flip(manager.readClipboard("thread-1"))).message).toMatch(
            /more than the 16384/,
          );

          const withoutClipboard = yield* ComputerManager.make({
            backend: new Proxy(new FakeComputerBackend(), {
              get: (target, property, receiver) =>
                property === "readClipboard" || property === "writeClipboard"
                  ? undefined
                  : Reflect.get(target, property, receiver),
            }),
          });
          expect((yield* Effect.flip(withoutClipboard.readClipboard("thread-1"))).message).toMatch(
            /does not support clipboard access/,
          );
          expect(
            (yield* Effect.flip(withoutClipboard.writeClipboard("thread-1", "nope"))).message,
          ).toMatch(/does not support clipboard access/);
        }),
      ),
  );

  it.effect("tells the backend which thread is driving, so the agent cursor can name it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const names: Array<string | null> = [];
        const drivable = Object.assign(backend, {
          setDrivingAgent: (name: string | null) =>
            Effect.sync(() => {
              names.push(name);
            }),
        });
        const manager = yield* ComputerManager.make({ backend: drivable });

        // Pane input belongs to the human, who is not an agent and takes no lease.
        yield* manager.click(undefined, { x: 10, y: 10 });
        expect(names).toEqual([]);

        manager.setThreadLabel("thread-1", "Luna");
        yield* manager.click("thread-1", { x: 10, y: 10 });
        expect(names).toEqual(["Luna"]);

        // A rename while this thread is on screen reaches the badge immediately.
        manager.setThreadLabel("thread-1", "Luna · seat fix");
        yield* Effect.yieldNow;
        expect(names).toEqual(["Luna", "Luna · seat fix"]);

        // A thread the tool layer never named still takes the desktop; the plugin
        // falls back to a generic label rather than showing a thread id.
        yield* manager.releaseDesktopControl("thread-1");
        yield* manager.click("thread-2", { x: 10, y: 10 });
        expect(names).toEqual(["Luna", "Luna · seat fix", null, null]);

        // Labelling a thread that is not driving records it without touching the
        // badge the human is currently looking at.
        manager.setThreadLabel("thread-1", "Luna again");
        yield* Effect.yieldNow;
        expect(names).toHaveLength(4);
      }),
    ),
  );

  it.effect("asks the UI to open the pane once per thread, and only for agent actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);
        const openRequests = Effect.map(events.drain, openPaneRequests);

        // Pane input carries no thread and must never summon the pane.
        yield* manager.click(undefined, { x: 10, y: 10 });
        expect(yield* openRequests).toEqual([]);

        // The first attributed action surfaces the pane; the rest of the turn is
        // silent so a user who closed the pane is not yanked back per click.
        yield* manager.click("thread-1", { x: 10, y: 10 });
        yield* manager.typeText("thread-1", "hi");
        expect(yield* openRequests).toEqual(["thread-1"]);

        // Giving up the desktop ends the turn: the next attributed action
        // surfaces the pane once more, then goes silent again within the turn.
        yield* manager.releaseDesktopControl("thread-1");
        yield* manager.click("thread-1", { x: 20, y: 20 });
        expect(yield* openRequests).toEqual(["thread-1", "thread-1"]);
        yield* manager.typeText("thread-1", "again");
        expect(yield* openRequests).toEqual(["thread-1", "thread-1"]);

        // A second thread surfaces independently of the first.
        yield* manager.releaseDesktopControl("thread-1");
        yield* manager.pressKey("thread-2", "enter");
        expect(yield* openRequests).toEqual(["thread-1", "thread-1", "thread-2"]);

        // A removed thread must be explicitly restored before it may act again.
        yield* manager.handleThreadRemoved("thread-2");
        expect((yield* Effect.flip(manager.pressKey("thread-2", "enter"))).message).toContain(
          "revoked",
        );
        yield* manager.handleThreadRestored("thread-2");
        yield* manager.pressKey("thread-2", "enter");
        expect(yield* openRequests).toEqual(["thread-1", "thread-1", "thread-2", "thread-2"]);
      }),
    ),
  );

  it.effect("re-surfaces the pane for an evicted owner without waiting for its release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        yield* TestClock.setTime(0);
        const manager = yield* ComputerManager.make({ backend, leaseIdleMs: 1_000 });
        const events = yield* recordEvents(manager);
        const openRequests = Effect.map(events.drain, openPaneRequests);

        yield* manager.click("thread-a", { x: 10, y: 10 });
        expect(yield* openRequests).toEqual(["thread-a"]);

        // thread-a goes silent past idle and thread-b evicts its stale lease.
        yield* TestClock.setTime(2_000);
        yield* manager.click("thread-b", { x: 20, y: 20 });
        expect(yield* openRequests).toEqual(["thread-a", "thread-b"]);

        // thread-b goes idle too. thread-a drives again and must re-surface:
        // its release would have returned early on the lease-owner check, so a
        // flag that only cleared there could never fire again.
        yield* TestClock.setTime(4_000);
        yield* manager.click("thread-a", { x: 30, y: 30 });
        expect(yield* openRequests).toEqual(["thread-a", "thread-b", "thread-a"]);
      }),
    ),
  );

  it.effect("drives a second ordinary app without asking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The second-app boundary is gone: only the denylist can refuse a drive.
        // Two ordinary apps dispatch back to back with no prompt surface involved.
        const opened = yield* Queue.unbounded<ComputerApprovalPrompt>();
        const gate = yield* makeComputerApprovalGate().pipe(
          Effect.provideService(ComputerApprovalRequester, {
            open: (prompt) => Queue.offer(opened, prompt),
            resolve: (_prompt: ComputerApprovalPrompt, _decision: ProviderApprovalDecision) =>
              Effect.void,
          }),
        );
        let requests = 0;
        const approvals = {
          ...gate,
          request: (...args: Parameters<typeof gate.request>) => {
            requests += 1;
            return gate.request(...args);
          },
        };
        const backend = new FakeComputerBackend();
        yield* Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, approvals });
          yield* manager.launchApp("thread-1", "kcalc");
          yield* manager.launchApp("thread-1", "firefox");
          expect(backend.callsFor("launchApp")).toHaveLength(2);
          expect(requests).toBe(0);
          expect(yield* Queue.size(opened)).toBe(0);
        }).pipe(Effect.ensuring(gate.cancelThread("thread-1")), Effect.scoped);
      }),
    ),
  );

  it.effect("applies visibility writes to any non-denied app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        // Minimizing the terminal's window and hiding pid 1002 (the calculator)
        // are both ordinary drives, so both dispatch.
        yield* manager.setWindowMinimized("thread-1", "fake-terminal", true);
        yield* manager.setAppVisibility("thread-1", 1_002, true);
        expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
        // A pid nothing resolves to reaches the backend, whose own refusal is
        // what surfaces.
        expect(
          (yield* Effect.flip(manager.setAppVisibility("thread-1", 9_999, true))).message,
        ).toMatch(/No running application has pid 9999/);
      }),
    ),
  );

  it.effect("invokes a windowless menu target on the app name's live pid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          apps: [
            {
              pid: 6_001,
              name: "Helium",
              bundleId: "net.imput.helium",
              running: true,
              active: false,
            },
            {
              pid: 1_001,
              name: "Terminal",
              bundleId: "org.kde.konsole",
              running: true,
              active: true,
            },
          ],
        });
        const manager = yield* ComputerManager.make({ backend });
        const authorization = { userRequestedVisibleUse: true };
        expect(
          yield* Effect.flip(manager.invokeMenu("thread-1", { app: "Helium" }, ["File"])),
        ).toMatchObject({
          code: "foreground_not_requested",
          effect: "not-dispatched",
        });
        expect(backend.callsFor("invokeMenu")).toHaveLength(0);
        const result = yield* manager.invokeMenu(
          "thread-1",
          { app: "Helium" },
          ["File", "New Window"],
          authorization,
        );
        expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
          { pid: 6_001 },
          ["File", "New Window"],
        ]);
        // No window took part, so the result names no window.
        expect(result.windowId).toBeUndefined();
        // An unknown spelling refuses with the list_apps pointer rather than
        // guessing a process.
        expect(
          yield* Effect.flip(
            manager.invokeMenu("thread-1", { app: "Ghost" }, ["File"], authorization),
          ),
        ).toMatchObject({ code: "computer_target_not_found", notFound: true });
        expect(backend.callsFor("invokeMenu")).toHaveLength(1);
        // The pid form rides through to the backend, which refuses a pid that
        // is not running.
        expect(
          (yield* Effect.flip(
            manager.invokeMenu("thread-1", { pid: 9_999 }, ["File"], authorization),
          )).message,
        ).toMatch(/No running application has pid 9999/);
      }),
    ),
  );

  it.effect("says plainly when an unhide ran on an app with no windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          apps: [
            {
              pid: 6_001,
              name: "Helium",
              bundleId: "net.imput.helium",
              running: true,
              active: false,
            },
            {
              pid: 1_001,
              name: "Terminal",
              bundleId: "org.kde.konsole",
              running: true,
              active: true,
            },
            {
              pid: 1_002,
              name: "Calculator",
              bundleId: "org.kde.kcalc",
              running: true,
              active: false,
            },
          ],
        });
        const manager = yield* ComputerManager.make({ backend });
        // The listing the manager remembers holds windows, none for Helium.
        yield* manager.listWindows();
        const shown = yield* manager.setAppVisibility(undefined, 6_001, false);
        expect(shown.delivery?.verified).toBe("confirmed");
        expect(shown.note).toEqual(expect.stringContaining("no window"));
        expect(shown.note).toContain("computer_invoke_menu");
        expect(shown.note).toContain("computer_browser_prepare");
        expect(shown.note).toContain("computer_browser_state");
        expect(shown.note).not.toContain("allow_launch");
        // Hiding is not an unhide: no note, even with no window.
        const hidden = yield* manager.setAppVisibility(undefined, 6_001, true);
        expect(hidden.note).toBeUndefined();
        // An app whose window the listing holds earns no note either.
        const withWindow = yield* manager.setAppVisibility(undefined, 1_002, false);
        expect(withWindow.note).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps background launch separate from explicitly hiding the application", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        // Leave the backend default nonactivating launch intact.
        yield* manager.launchApp("thread-1", "kcalc");
        expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["kcalc", []]);
        // Hiding remains an explicit option.
        yield* manager.launchApp("thread-1", "kcalc", [], 0, { hidden: true });
        expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["kcalc", [], { hidden: true }]);
        // Unhidden windows still do not request foreground activation.
        yield* manager.launchApp("thread-1", "kcalc", [], 0, { hidden: false });
        expect(backend.callsFor("launchApp").at(-1)?.args).toEqual([
          "kcalc",
          [],
          { hidden: false },
        ]);
      }),
    ),
  );

  it.effect("still asks for the pane when the agent drives the human's visible desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The preview is wanted there too: the pane renders stills only on a shared
        // display, and the client gates the actual opening on its auto-open
        // preference — emitting costs a pref-off user nothing.
        const backend = new FakeComputerBackend({
          capabilities: {
            ...new FakeComputerBackend().capabilities(),
            visibleDesktop: true,
          },
        });
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);

        yield* manager.click("thread-1", { x: 10, y: 10 });
        yield* manager.typeText("thread-1", "hi");

        expect(openPaneRequests(yield* events.drain)).toEqual(["thread-1"]);
      }),
    ),
  );

  it.effect("leaves pane input unattributed instead of borrowing a thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);

        yield* manager.click(undefined, { x: 10, y: 10 });
        yield* manager.launchApp(undefined, "kcalc");
        // A whitespace-only caller is not a thread either.
        yield* manager.pressKey("  ", "enter");

        const actions = (yield* events.drain).filter((event) => event.type === "computer.action");
        expect(actions.every((action) => !("threadId" in action))).toBe(true);
        expect(actions).toHaveLength(3);
      }),
    ),
  );

  it.effect("gives the desktop to the first thread that drives it and refuses the second", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        yield* manager.click("thread-a", { x: 10, y: 10 });
        expect(yield* Effect.flip(manager.click("thread-b", { x: 20, y: 20 }))).toMatchObject({
          code: "computer_controlled_by_other_thread",
          retryable: false,
          message: expect.stringMatching(/another conversation; no input was sent\. Do not retry/),
        });

        // Watching is safe while someone else drives, so nothing read-only is gated
        // — including the blocked thread's own state.
        expect(yield* manager.listWindows()).toMatchObject({
          computerId: backend.computerId,
        });
        expect(yield* manager.getState({})).toMatchObject({
          computerId: backend.computerId,
        });
        expect(yield* manager.getScreenSize()).toMatchObject({
          computerId: backend.computerId,
        });
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });
        expect(yield* manager.getThreadState("thread-a")).toMatchObject({
          controlledByOtherThread: false,
        });

        // The human at the pane is not a competing agent: their input carries no
        // thread, and it neither waits for the lease nor takes it.
        expect(yield* manager.click(undefined, { x: 30, y: 30 })).toMatchObject({
          action: "computer_click",
        });
        expect(yield* Effect.flip(manager.click("thread-b", { x: 20, y: 20 }))).toMatchObject({
          code: "computer_controlled_by_other_thread",
        });

        // Both panels learned about the handover without polling.
        const states = threadStates(yield* events.drain);
        expect(
          states.some((state) => state.threadId === "thread-b" && state.controlledByOtherThread),
        ).toBe(true);
        expect(
          states.findLast((state) => state.threadId === "thread-a")?.controlledByOtherThread,
        ).toBe(false);
      }),
    ),
  );

  it.effect("allows different threads to overlap exact-window semantic text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const bothActive = yield* Deferred.make<void>();
        let active = 0;
        let peak = 0;
        const windowIds = ["editor-a", "editor-b"];
        const windows = windowIds.map(
          (id, index): ComputerWindow => ({
            id,
            title: `Editor ${index + 1}`,
            bounds: { x: index * 400, y: 0, width: 360, height: 300 },
            focused: false,
            minimized: false,
            visible: true,
          }),
        );
        const backend = Object.assign(
          new FakeComputerBackend({
            windows,
            root: semanticTextRoot(windowIds),
          }),
          {
            focusNeutralSemanticText: true,
            typeText: () =>
              Effect.gen(function* () {
                active += 1;
                peak = Math.max(peak, active);
                if (peak === 2) yield* Deferred.succeed(bothActive, undefined);
                yield* Deferred.await(release);
                active -= 1;
                return {};
              }),
          },
        );
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const first = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            manager.typeText("thread-a", "alpha", "editor-a"),
            undefined,
            "turn-a",
            "editor-a",
          ),
        );
        const second = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-b",
            manager.typeText("thread-b", "bravo", "editor-b"),
            undefined,
            "turn-b",
            "editor-b",
          ),
        );
        yield* Deferred.await(bothActive);
        expect(peak).toBe(2);
        yield* Deferred.succeed(release, undefined);

        expect(yield* Fiber.joinAll([first, second])).toHaveLength(2);
        expect(backend.callsFor("clearFocusWindow")).toHaveLength(0);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect("hands the desktop to the next thread when the owner's turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        yield* manager.launchApp("thread-a", "kcalc");
        expect((yield* Effect.flip(manager.typeText("thread-b", "hi"))).message).toMatch(
          /another conversation/,
        );

        // What provider runtime ingestion calls on turn.completed / turn.aborted /
        // session.exited.
        yield* manager.releaseDesktopControl("thread-a");
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });

        expect(yield* manager.typeText("thread-b", "hi")).toMatchObject({
          action: "computer_type_text",
        });
        // A's next turn now waits on B, and a release from a thread that no longer
        // owns the desktop cannot take it away from B.
        expect((yield* Effect.flip(manager.click("thread-a", { x: 10, y: 10 }))).message).toMatch(
          /another conversation/,
        );
        yield* manager.releaseDesktopControl("thread-a");
        expect((yield* Effect.flip(manager.click("thread-a", { x: 10, y: 10 }))).message).toMatch(
          /another conversation/,
        );
        expect(yield* manager.getThreadState("thread-a")).toMatchObject({
          controlledByOtherThread: true,
        });

        // Removing the owning thread frees the desktop the same way.
        yield* manager.handleThreadRemoved("thread-b");
        expect(yield* manager.click("thread-a", { x: 10, y: 10 })).toMatchObject({
          action: "computer_click",
        });
      }),
    ),
  );

  it.effect("releases desktop control even when preview cleanup is delayed or fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Deferred.make<void>();
        const endTaskCalls: Array<readonly [string, string | undefined]> = [];
        const backend = Object.assign(new FakeComputerBackend(), {
          endTask: (threadId: string, turnId?: string) =>
            Effect.gen(function* () {
              endTaskCalls.push([threadId, turnId]);
              yield* Deferred.await(pending);
              return yield* new ComputerBackendError({ message: "Preview cleanup failed" });
            }),
        });
        const manager = yield* ComputerManager.make({ backend });
        const events = yield* recordEvents(manager);
        yield* manager.launchApp("thread-a", "kcalc");
        const cleared = backend.callsFor("clearFocusWindow").length;
        // The release must settle while endTask remains pending, so it cannot
        // wedge lifecycle ingestion or the owning action's finalizer.
        yield* manager.releaseDesktopControl("thread-a", "turn-one");
        expect(backend.callsFor("clearFocusWindow")).toHaveLength(cleared + 1);
        expect((yield* manager.getThreadState("thread-b")).controlledByOtherThread).toBe(false);
        expect(yield* manager.typeText("thread-b", "hi")).toMatchObject({
          action: "computer_type_text",
        });
        yield* Deferred.succeed(pending, undefined);
        expect(endTaskCalls).toContainEqual(["thread-a", "turn-one"]);
        // The failure is still evidence: a stale preview is reported on the
        // owner's state rather than silently leaked.
        yield* events.waitFor(
          (event) =>
            event.type === "computer.thread-state" &&
            event.state.threadId === "thread-a" &&
            (event.state.lastError?.includes("Preview cleanup failed") ?? false),
        );
      }),
    ),
  );

  it.effect(
    "records lease transitions without text or cursor labels and discourages blocked retries",
    () => {
      const entries: Array<Record<string, unknown>> = [];
      const logger = Logger.make(({ fiber, message }) => {
        const text = Array.isArray(message) ? message[0] : message;
        if (text !== "[computer] desktop lease") return;
        entries.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
      });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            leaseIdleMs: 1_000,
          });
          manager.setThreadLabel("thread-a", "Private window title");
          yield* manager.withAgentActivity(
            "thread-a",
            manager.typeText("thread-a", "private typed value"),
            undefined,
            "turn-a",
          );
          expect(yield* Effect.flip(manager.typeText("thread-b", "blocked text"))).toMatchObject({
            code: "computer_controlled_by_other_thread",
            retryable: false,
            message: expect.stringContaining("Do not retry"),
          });
          yield* TestClock.setTime(2_000);
          yield* manager.withAgentActivity(
            "thread-b",
            manager.click("thread-b", { x: 10, y: 10 }),
            undefined,
            "turn-b",
          );
          yield* manager.releaseDesktopControl("thread-b", "turn-b");
          expect(entries).toEqual([
            {
              ts: isoAt(0),
              event: "acquired",
              threadId: "thread-a",
              turnId: "turn-a",
            },
            {
              ts: isoAt(2_000),
              event: "stale-reclaimed",
              threadId: "thread-a",
              turnId: "turn-a",
              nextThreadId: "thread-b",
              idleMs: 2_000,
            },
            {
              ts: isoAt(2_000),
              event: "acquired",
              threadId: "thread-b",
              turnId: "turn-b",
            },
            {
              ts: isoAt(2_000),
              event: "released",
              threadId: "thread-b",
              turnId: "turn-b",
            },
          ]);
          const recorded = entries.flatMap((entry) => [
            ...Object.keys(entry),
            ...Object.values(entry).map(String),
          ]);
          expect(recorded.filter((text) => /private|blocked|title/i.test(text))).toEqual([]);
        }),
      ).pipe(Effect.provide(Logger.layer([logger])));
    },
  );

  /**
   * The release runtime ingestion sends on session.exited can land while the
   * dead session's last call is still executing — a gateway call cannot be
   * aborted. Handing the desktop over at that moment would put two threads on
   * the same pointer, so the release waits for the call to drain.
   */
  it.effect("defers a release until the owner's in-flight call drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }),
          ),
        );
        yield* Deferred.await(started);

        yield* manager.releaseDesktopControl("thread-a");
        // Still A's desktop: the release is recorded, not applied.
        expect((yield* Effect.flip(manager.typeText("thread-b", "hi"))).message).toMatch(
          /another conversation/,
        );
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });

        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);
        // The drain completed the release, and told every thread so.
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
        expect(yield* manager.typeText("thread-b", "hi")).toMatchObject({
          action: "computer_type_text",
        });
        expect((yield* Effect.flip(manager.click("thread-a", { x: 10, y: 10 }))).message).toMatch(
          /another conversation/,
        );
      }),
    ),
  );

  it.effect("keeps a deferred release when the owner renews the lease mid-drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        const started = yield* Deferred.make<void>();
        const releaseRecorded = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(releaseRecorded);
              // The dead session's operation keeps acting after the release was
              // recorded. Renewing the lease must not forget that release.
              yield* manager.click("thread-a", { x: 11, y: 11 });
            }),
          ),
        );
        yield* Deferred.await(started);
        yield* manager.releaseDesktopControl("thread-a");
        yield* Deferred.succeed(releaseRecorded, undefined);
        yield* Fiber.join(inFlight);

        expect(backend.callsFor("click")).toHaveLength(2);
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
        expect(yield* manager.typeText("thread-b", "hi")).toMatchObject({
          action: "computer_type_text",
        });
      }),
    ),
  );
});
