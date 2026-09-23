import { describe, expect, it } from "@effect/vitest";
import type { ComputerWindow } from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { waitForWindow } from "./waitForWindow.ts";

const window: ComputerWindow = {
  id: "7",
  title: "Draft",
  appName: "Helium",
  focused: false,
  minimized: false,
  visible: true,
};

const windows = (list: readonly ComputerWindow[]) => Effect.succeed(list);

/** A readiness probe that records whether it ran. */
const probe = () => {
  const calls: string[] = [];
  return {
    calls,
    checkInputReady: (windowId: string) => Effect.sync(() => void calls.push(windowId)),
  };
};

describe("launch window readiness", () => {
  it.effect("bounds a hung native window read and interrupts its observation", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const hung = Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(interrupted, void 0)),
      );
      const result = yield* Effect.forkChild(waitForWindow(hung, "Helium", 500));
      yield* TestClock.adjust("500 millis");
      expect(yield* Fiber.join(result)).toMatchObject({
        windowStatus: "no_usable_window",
        windowReason: "input_unavailable",
      });
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("returns an existing matching app window immediately", () =>
    Effect.gen(function* () {
      expect(yield* waitForWindow(windows([window]), "/Applications/Helium.app", 2_000)).toEqual({
        window,
        windowStatus: "ready",
      });
    }),
  );

  it.effect("observes again when launch has not produced a window yet", () =>
    Effect.gen(function* () {
      let reads = 0;
      const read = Effect.sync(() => (++reads === 1 ? [] : [window]));
      const result = yield* Effect.forkChild(waitForWindow(read, "Helium", 500));
      yield* TestClock.adjust("150 millis");
      expect(yield* Fiber.join(result)).toEqual({ window, windowStatus: "ready" });
      expect(reads).toBe(2);
    }),
  );

  it.effect("does not infer a primary Notes window from accessory sizes", () =>
    Effect.gen(function* () {
      const notes = {
        ...window,
        title: "Notes",
        appName: "Notes",
        bounds: { x: 0, y: 0, width: 1000, height: 660 },
      };
      const { calls, checkInputReady } = probe();
      expect(
        yield* waitForWindow(
          windows([
            {
              ...notes,
              id: "8",
              title: "",
              visible: false,
              bounds: { x: 0, y: 0, width: 500, height: 500 },
            },
            { ...notes, id: "9", title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } },
            notes,
          ]),
          "Notes",
          0,
          { checkInputReady },
        ),
      ).toEqual({ window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" });
      expect(calls).toEqual([]);
    }),
  );

  it.effect.each([
    { title: "", bounds: { x: 0, y: 0, width: 1000, height: 660 } },
    { title: "Document", bounds: { x: 0, y: 0, width: 0, height: 0 } },
  ])("does not bind a titled inspector over a document with $title", (document) =>
    Effect.gen(function* () {
      const { calls, checkInputReady } = probe();
      const list = [
        { ...window, ...document },
        { ...window, id: "8", title: "Inspector", bounds: { x: 0, y: 0, width: 240, height: 160 } },
      ];
      for (const candidates of [list, list.toReversed()]) {
        expect(yield* waitForWindow(windows(candidates), "Helium", 0, { checkInputReady })).toEqual(
          { window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" },
        );
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect("keeps two real titled windows ambiguous regardless of size or order", () =>
    Effect.gen(function* () {
      const first = { ...window, bounds: { x: 0, y: 0, width: 120, height: 80 } };
      const second = {
        ...first,
        id: "8",
        title: "Other",
        bounds: { x: 0, y: 0, width: 1000, height: 660 },
      };
      expect(yield* waitForWindow(windows([first, second]), "Helium", 0)).toEqual({
        window: null,
        windowStatus: "no_usable_window",
        windowReason: "ambiguous",
      });
    }),
  );

  it.effect("keeps multiple hidden windows ambiguous", () =>
    Effect.gen(function* () {
      expect(
        yield* waitForWindow(
          windows([
            { ...window, visible: false },
            { ...window, id: "8", visible: false },
          ]),
          "Helium",
          0,
        ),
      ).toEqual({ window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" });
    }),
  );

  it.effect("keeps a single untitled window without bounds usable", () =>
    Effect.gen(function* () {
      const untitled = { ...window, title: "" };
      expect(yield* waitForWindow(windows([untitled]), "Helium", 0)).toEqual({
        window: untitled,
        windowStatus: "ready",
      });
    }),
  );

  it.effect("does not choose between multiple app windows or unrelated apps", () =>
    Effect.gen(function* () {
      expect(
        yield* waitForWindow(windows([window, { ...window, id: "8" }]), "Helium", 0),
      ).toMatchObject({ window: null, windowStatus: "no_usable_window" });
      expect(yield* waitForWindow(windows([window]), "Other", 0)).toMatchObject({
        window: null,
        windowStatus: "no_usable_window",
      });
    }),
  );

  it.effect("stops without another observation when interrupted", () =>
    Effect.gen(function* () {
      let reads = 0;
      const readDone = yield* Deferred.make<void>();
      const read = Effect.sync(() => {
        reads += 1;
        return [];
      }).pipe(Effect.tap(() => Deferred.succeed(readDone, void 0)));
      const result = yield* Effect.forkChild(waitForWindow(read, "Helium", 500));
      yield* Deferred.await(readDone);
      yield* Fiber.interrupt(result);
      yield* TestClock.adjust("500 millis");
      expect(Exit.hasInterrupts(yield* Fiber.await(result))).toBe(true);
      expect(reads).toBe(1);
    }),
  );

  it.effect("uses the launched pid rather than a same-name process", () =>
    Effect.gen(function* () {
      const launched = { ...window, pid: 20 };
      expect(
        yield* waitForWindow(windows([{ ...window, pid: 10 }, launched]), "com.vendor.Helium", 0, {
          pid: 20,
        }),
      ).toEqual({ window: launched, windowStatus: "ready" });
    }),
  );

  it.effect.each([
    [{ visible: false }, "hidden"],
    [{ minimized: true }, "hidden"],
    [{ onCurrentSpace: false }, "off_space"],
  ] as const)("does not bind an unusable window: %j", ([state, reason]) =>
    Effect.gen(function* () {
      expect(yield* waitForWindow(windows([{ ...window, ...state }]), "Helium", 0)).toEqual({
        window: null,
        windowStatus: "no_usable_window",
        windowReason: reason,
      });
    }),
  );

  it.effect("does not mistake a listed window for native input readiness", () =>
    Effect.gen(function* () {
      expect(
        yield* waitForWindow(windows([window]), "Helium", 0, {
          checkInputReady: () => Effect.fail("ax_window_unresolved"),
        }),
      ).toEqual({
        window: null,
        windowStatus: "no_usable_window",
        windowReason: "input_unavailable",
      });
    }),
  );

  it.effect("does not return readiness if Stop arrives during the probe", () =>
    Effect.gen(function* () {
      const probing = yield* Deferred.make<void>();
      const result = yield* Effect.forkChild(
        waitForWindow(windows([window]), "Helium", 0, {
          checkInputReady: () =>
            Deferred.succeed(probing, void 0).pipe(Effect.andThen(Effect.never)),
        }),
      );
      yield* Deferred.await(probing);
      yield* Fiber.interrupt(result);
      expect(Exit.hasInterrupts(yield* Fiber.await(result))).toBe(true);
    }),
  );
});
