import type { ComputerState, ComputerUiNode } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { waitForControl } from "./waitForControl.ts";

const target = { windowId: "fake-calculator", label: "Display" };

const CALCULATOR_BOUNDS = { x: 1_050, y: 120, width: 420, height: 620 };

/** The fake desktop's default calculator window, whose display is labelled "Display". */
const STATE: ComputerState = {
  computerId: "desktop",
  windows: [
    {
      id: "fake-terminal",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 1_001,
      bounds: { x: 40, y: 40, width: 960, height: 720 },
      focused: true,
      minimized: false,
      visible: true,
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      appName: "org.kde.kcalc",
      pid: 1_002,
      bounds: CALCULATOR_BOUNDS,
      focused: false,
      minimized: false,
      visible: true,
    },
  ],
  screenSize: { width: 1_920, height: 1_080, scale: 1 },
  root: uiNode({
    role: "desktop",
    description: "Fake desktop",
    frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
    children: [
      uiNode({
        role: "window",
        label: "Calculator",
        frame: CALCULATOR_BOUNDS,
        windowId: "fake-calculator",
        children: [
          uiNode({
            role: "button",
            label: "Calculate",
            description: "Calculate",
            frame: { x: 1_090, y: 200, width: 180, height: 56 },
            windowId: "fake-calculator",
          }),
          uiNode({
            role: "text-field",
            label: "Display",
            value: "0",
            description: "Calculator display",
            frame: { x: 1_090, y: 140, width: 280, height: 48 },
            activationPoint: { x: 1_230, y: 164 },
            windowId: "fake-calculator",
          }),
        ],
      }),
    ],
  }),
  capturedAt: "2026-09-05T00:00:00.000Z",
};

function uiNode(partial: Partial<ComputerUiNode> & { readonly role: string }): ComputerUiNode {
  return {
    role: partial.role,
    label: partial.label ?? null,
    value: partial.value ?? null,
    description: partial.description ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 1, height: 1 },
    activationPoint: partial.activationPoint ?? null,
    onScreen: partial.onScreen ?? true,
    windowId: partial.windowId ?? null,
    ...(partial.truncated === undefined ? {} : { truncated: partial.truncated }),
    children: partial.children ?? [],
  };
}

const ROOT = STATE.root!;
const EMPTY_ROOT: ComputerState = { ...STATE, root: { ...ROOT, children: [] } };
const DUPLICATED: ComputerState = {
  ...STATE,
  root: { ...ROOT, children: [...ROOT.children, ...ROOT.children] },
};

/** A read that answers each state in turn, then keeps answering the last, counting calls. */
function reads(...states: readonly [ComputerState, ...ComputerState[]]) {
  let calls = 0;
  const read = Effect.sync(() => {
    const state = states[Math.min(calls, states.length - 1)]!;
    calls += 1;
    return state;
  });
  return { read, calls: () => calls };
}

describe("waiting for a control", () => {
  it.effect("returns immediately for an existing control without waiting the timeout", () =>
    Effect.gen(function* () {
      const { read, calls } = reads(STATE);
      expect(yield* waitForControl(read, target, 10_000)).toMatchObject({ status: "ready" });
      expect(calls()).toBe(1);
    }),
  );

  it.effect("polls until a delayed control appears", () =>
    Effect.gen(function* () {
      const { read, calls } = reads(EMPTY_ROOT, STATE);
      const fiber = yield* Effect.forkChild(waitForControl(read, target, 1_000));
      yield* TestClock.adjust("100 millis");
      expect(yield* Fiber.join(fiber)).toEqual({ status: "ready", waitedMs: 100 });
      expect(calls()).toBe(2);
    }),
  );

  it.effect("stops at timeout and never invents readiness", () =>
    Effect.gen(function* () {
      const { read } = reads(STATE);
      expect(yield* waitForControl(read, { ...target, label: "Missing" }, 0)).toMatchObject({
        status: "timeout",
      });
    }),
  );

  it.effect("does not poll unavailable windows or incomplete trees", () =>
    Effect.gen(function* () {
      for (const unavailable of [
        {
          ...STATE,
          accessibility: { status: "partial" as const, unavailableWindowIds: [target.windowId] },
        },
        { ...STATE, root: { ...ROOT, children: [], truncated: true } },
      ]) {
        const { read, calls } = reads(unavailable);
        expect(yield* waitForControl(read, target, 10_000)).toMatchObject({
          status: "unavailable",
        });
        expect(calls()).toBe(1);
      }
    }),
  );

  it.effect("does not wait for a closed window", () =>
    Effect.gen(function* () {
      const { read, calls } = reads({ ...STATE, windows: [] });
      expect(yield* waitForControl(read, target, 10_000)).toMatchObject({ status: "closed" });
      expect(calls()).toBe(1);
    }),
  );

  it.effect("does not claim a duplicate label is ready", () =>
    Effect.gen(function* () {
      const { read, calls } = reads(DUPLICATED);
      expect(yield* waitForControl(read, target, 10_000)).toMatchObject({ status: "ambiguous" });
      expect(calls()).toBe(1);
    }),
  );

  it.effect("stops polling when its turn is cancelled", () =>
    Effect.gen(function* () {
      const polled = yield* Deferred.make<void>();
      let calls = 0;
      const read = Effect.sync(() => (calls += 1)).pipe(
        Effect.andThen(Deferred.succeed(polled, undefined)),
        Effect.as(EMPTY_ROOT),
      );
      const fiber = yield* Effect.forkChild(waitForControl(read, target, 10_000));
      yield* Deferred.await(polled);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(1);
    }),
  );
});

describe("waiting for a control to disappear", () => {
  it.effect("is ready immediately when the control is already absent", () =>
    Effect.gen(function* () {
      const { read, calls } = reads(STATE);
      expect(
        yield* waitForControl(read, { ...target, label: "Missing" }, 10_000, { absent: true }),
      ).toMatchObject({ status: "ready" });
      expect(calls()).toBe(1);
    }),
  );

  it.effect(
    "keeps polling while the control is still present, then readies after it vanishes",
    () =>
      Effect.gen(function* () {
        const { read, calls } = reads(STATE, EMPTY_ROOT);
        const fiber = yield* Effect.forkChild(
          waitForControl(read, target, 10_000, { absent: true }),
        );
        yield* TestClock.adjust("100 millis");
        expect(yield* Fiber.join(fiber)).toMatchObject({ status: "ready" });
        expect(calls()).toBe(2);
      }),
  );

  it.effect("is ready when the target window closes", () =>
    Effect.gen(function* () {
      const { read, calls } = reads({ ...STATE, windows: [] });
      expect(yield* waitForControl(read, target, 10_000, { absent: true })).toMatchObject({
        status: "ready",
      });
      expect(calls()).toBe(1);
    }),
  );

  it.effect("does not call disappearance while duplicates remain or the tree is incomplete", () =>
    Effect.gen(function* () {
      const duplicated = reads(DUPLICATED);
      expect(yield* waitForControl(duplicated.read, target, 0, { absent: true })).toMatchObject({
        status: "timeout",
      });
      const truncated = reads({ ...STATE, root: { ...ROOT, truncated: true } });
      expect(yield* waitForControl(truncated.read, target, 10_000, { absent: true })).toMatchObject(
        { status: "unavailable" },
      );
    }),
  );
});
