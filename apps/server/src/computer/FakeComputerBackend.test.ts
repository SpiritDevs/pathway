import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { ComputerBackendEvent, ComputerStreamFrame } from "./ComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/**
 * Collects the next `count` events from the fake. Forked to start immediately
 * so the subscription exists before the caller publishes anything.
 */
const collectEvents = (backend: FakeComputerBackend, count: number) =>
  backend.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
  );

const frameOf = (event: ComputerBackendEvent | undefined): ComputerStreamFrame | undefined =>
  event?.type === "frame" ? event.frame : undefined;

describe("FakeComputerBackend", () => {
  it.effect("records the full snapshot and action surface without a display", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const firstEvent = yield* collectEvents(backend, 1);

      yield* backend.availability();
      yield* backend.listWindows();
      yield* backend.getScreenSize();
      yield* backend.getState({ includeScreenshot: true, includeTree: true });
      yield* backend.launchApp("org.example.Editor", ["--new"]);
      yield* backend.click({ x: 20, y: 20 });
      yield* backend.doubleClick({ x: 20, y: 20 });
      yield* backend.rightClick({ x: 20, y: 20 });
      yield* backend.moveCursor({ x: 20, y: 20 });
      yield* backend.drag({ x: 20, y: 20 }, { x: 30, y: 30 }, 100);
      yield* backend.scroll(null, 0, 500);
      yield* backend.typeText("hello");
      yield* backend.pressKey("Enter");
      yield* backend.hotkey(["Control", "L"]);

      expect(backend.calls.map((call) => call.method)).toEqual([
        "availability",
        "listWindows",
        "getScreenSize",
        "getState",
        "listWindows",
        "launchApp",
        "click",
        "doubleClick",
        "rightClick",
        "moveCursor",
        "drag",
        "scroll",
        "typeText",
        "pressKey",
        "hotkey",
      ]);
      expect((yield* Fiber.join(firstEvent)).map((event) => event.type)).toEqual([
        "windows-changed",
      ]);
    }),
  );

  it.effect("selects an exact range by slicing the target element's own value", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const state = yield* backend.getState({ includeTree: true });
      // desktop -> window -> [Calculate button, Display text-field (value "0")]
      const display = state.root!.children[0]!.children[1]!;
      yield* backend.setValue(
        { target: { label: "Display" }, node: display, point: display.activationPoint! },
        "4680",
      );

      const refreshed = yield* backend.getState({ includeTree: true });
      const updated = refreshed.root!.children[0]!.children[1]!;
      const result = yield* backend.selectText(
        { target: { label: "Display" }, node: updated, point: updated.activationPoint! },
        { start: 1, length: 2 },
      );

      // The emulated read-back is exactly the substring the range covers.
      expect(result).toMatchObject({ value: "68" });
      expect(backend.callsFor("selectText")).toHaveLength(1);
      expect(backend.callsFor("selectText")[0]?.args[1]).toEqual({ start: 1, length: 2 });
    }),
  );

  it.effect("emits deterministic codec-config and keyframe frames and supports failures", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const attached = yield* collectEvents(backend, 4);

      yield* backend.attachStream();

      backend.failNext("click", new ComputerBackendError({ message: "synthetic click failure" }));
      const failure = yield* Effect.flip(backend.click({ x: 1, y: 1 }));
      expect(failure.message).toBe("synthetic click failure");
      expect(yield* backend.click({ x: 1, y: 1 })).toEqual({ point: { x: 1, y: 1 } });

      yield* backend.requestKeyframe();
      const frames = (yield* Fiber.join(attached)).map(frameOf);
      expect(frames).toEqual([
        expect.objectContaining({ sequence: 1, keyframe: true, codecConfig: true }),
        expect.objectContaining({ sequence: 2, keyframe: true, codecConfig: false }),
        expect.objectContaining({ sequence: 3, keyframe: true, codecConfig: true }),
        expect.objectContaining({ sequence: 4, keyframe: true, codecConfig: false }),
      ]);

      // After detach a frame goes nowhere: the next event anyone sees is the
      // health change published after it.
      yield* backend.detachStream();
      const afterDetach = yield* collectEvents(backend, 1);
      yield* backend.emitFrame(true, true);
      backend.emitHealthChanged(backend.health());
      expect((yield* Fiber.join(afterDetach)).map((event) => event.type)).toEqual([
        "health-changed",
      ]);
    }),
  );

  /**
   * A long-running server must not grow the call log forever; the oldest
   * entries fall off once the cap is reached.
   */
  it.effect("caps recorded calls at a bounded recent window", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      for (let index = 0; index < 1_500; index += 1) {
        yield* backend.pressKey(`key-${index}`);
      }
      expect(backend.calls.length).toBe(1_000);
      expect(backend.calls[0]?.args).toEqual(["key-500"]);
      expect(backend.calls.at(-1)?.args).toEqual(["key-1499"]);
    }),
  );

  it.effect("runs Effect-shaped hooks and ends its events when disposed", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend({
        waitForSettle: () =>
          Effect.fail(new ComputerBackendError({ message: "Unknown tool: wait_for_settle" })),
        shield: () => Effect.void,
      });

      const refusal = yield* Effect.flip(
        backend.waitForSettle!({ windowId: "fake-calculator", timeoutMs: 100, quietMs: 10 }),
      );
      expect(refusal.message).toBe("Unknown tool: wait_for_settle");
      const shieldTarget = {
        shieldId: "shield-1",
        windowId: "fake-calculator",
        frame: { x: 0, y: 0, width: 10, height: 10 },
        label: "Pathway",
      };
      expect(yield* backend.engageShield!(shieldTarget)).toBe("shield-1");
      expect(backend.activeShields()).toEqual(["shield-1"]);

      const drained = yield* backend.events.pipe(
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* backend.dispose();
      expect(yield* Fiber.join(drained)).toEqual([]);
    }),
  );
});
