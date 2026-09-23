import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeCuaComputerBackend, type CuaComputerBackend } from "./CuaComputerBackend.ts";

const PNG_400x200 = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();
const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

interface LockableControls {
  /** Bump the desktop generation, as a lock/resume does. */
  readonly lock: () => void;
  /**
   * Run one OS interruption cycle: bump the generation AND the interruption
   * count, with `pauses` as the reasons still active at observation time —
   * `[]` models a lock that already released before the next reply.
   */
  readonly interrupt: (pauses: string[]) => void;
  /** Lift every pause reason while keeping the interruption count. */
  readonly resumeDesktop: () => void;
  /** Hold click replies until released, to straddle the lock. */
  readonly holdClicks: () => void;
  readonly releaseClicks: () => void;
}

/** Scripted Cua stub: no Fake — Fake enforces no epoch or grounding. */
const lockableFixture = Effect.fn(function* () {
  const calls: Array<{ name?: string }> = [];
  /** Completed the first time a click request reaches the host. */
  const clickSeen = yield* Deferred.make<void>();
  let desktopEpoch = 0;
  let interruptions = 0;
  let pauses: string[] = [];
  let clickGate: Promise<void> | undefined;
  let releaseClick = () => {};
  const request = async (_endpoint: string, raw: unknown) => {
    const req = raw as Record<string, unknown>;
    calls.push(typeof req.name === "string" ? { name: req.name } : {});
    const method = req.method as string | undefined;
    const state = () => ({
      // The simulated native host is macOS regardless of the CI runner OS.
      hostPlatform: "darwin",
      desktopEpoch,
      desktopInterruptions: interruptions,
      desktopPauses: pauses,
    });
    if (method === "probe" || method === "stop") return { ok: true, ...state() };
    // The host refuses every call while a pause is active.
    if (method === "call" && pauses.length > 0)
      return {
        ok: true,
        ...state(),
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: "desktop_input_paused",
            message: "Desktop is locked.",
          },
        },
      };
    if (req.name === "check_permissions")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { accessibility: true, screen_recording: true } },
      };
    if (req.name === "list_windows")
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            windows: [
              {
                pid: 10,
                window_id: 20,
                title: "Owned fixture",
                bounds: BOUNDS,
                is_on_screen: true,
                on_current_space: true,
                z_index: 1,
              },
            ],
          },
        },
      };
    if (req.name === "get_screen_size")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { width: 1000, height: 800, scale_factor: 2 } },
      };
    if (req.name === "check_input_ready")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { ready: true, pid: 10, window_id: 20 } },
      };
    if (req.name === "get_window_state")
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            pid: 10,
            window_id: 20,
            window_bounds: BOUNDS,
            screenshot_frame_valid: true,
            elements: [],
          },
          content: [{ type: "image", mimeType: "image/png", data: PNG_400x200 }],
        },
      };
    if (req.name === "click") {
      Deferred.doneUnsafe(clickSeen, Effect.void);
      if (clickGate) await clickGate;
      // The reply carries the generation current at delivery, not at dispatch.
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            route: "synthetic_events",
            delivery: { mode: "background" },
            effect: "unverifiable",
          },
        },
      };
    }
    return { ok: true, ...state(), result: { structuredContent: {} } };
  };
  const backend = yield* makeCuaComputerBackend({ endpoint: "/lock-resume", request });
  const controls: LockableControls = {
    lock: () => {
      desktopEpoch += 1;
    },
    interrupt: (active) => {
      desktopEpoch += 1;
      interruptions += 1;
      pauses = active;
    },
    resumeDesktop: () => {
      pauses = [];
    },
    holdClicks: () => {
      clickGate = new Promise<void>((resolve) => {
        releaseClick = resolve;
      });
    },
    releaseClicks: () => releaseClick(),
  };
  return { backend, calls, controls, clickSeen };
});

const clickCount = (calls: Array<{ name?: string }>) =>
  calls.filter((call) => call.name === "click").length;

/** Every `desktop-interrupted` event, queued in order from the moment this returns. */
const interruptionEvents = Effect.fn(function* (backend: CuaComputerBackend) {
  const queue = yield* Queue.unbounded<{ type: string; pauses?: readonly string[] }>();
  yield* backend.events.pipe(
    Stream.runForEach((event) =>
      event.type === "desktop-interrupted" ? Queue.offer(queue, event) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return queue;
});

it.layer(NodeServices.layer)("computer lock/resume", (it) => {
  it.effect("refuses an in-flight reply that straddles a lock without replaying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, calls, controls, clickSeen } = yield* lockableFixture();
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        controls.holdClicks();
        const inFlight = yield* Effect.forkChild(backend.click({ x: 50, y: 50 }, "cua:10:20"));
        yield* Deferred.await(clickSeen);
        expect(calls.some((call) => call.name === "click")).toBe(true);
        // The desktop locks and resumes while the click is in flight; a metadata
        // read observes the new generation before the reply lands.
        controls.lock();
        yield* backend.checkInputReady("cua:10:20");
        controls.releaseClicks();
        expect(yield* Effect.flip(Fiber.join(inFlight))).toMatchObject({
          effect: "dispatched-unknown",
          code: "stale_desktop_epoch",
        });
        // Uncertain delivery is never replayed automatically.
        expect(clickCount(calls)).toBe(1);
      }),
    ),
  );

  it.effect("requires a fresh observation after resume and never auto-resumes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, calls, controls } = yield* lockableFixture();
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        controls.lock();
        // The resume invalidates the pre-lock grounding: stale, refused, nothing sent.
        expect(yield* Effect.flip(backend.click({ x: 50, y: 50 }, "cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "stale_geometry",
        });
        expect(clickCount(calls)).toBe(0);
        // Read-only observation stays available but heals nothing: the next input
        // is still refused until a fresh observation re-grounds it.
        expect(yield* backend.getState({ windowId: "cua:10:20" })).toMatchObject({
          computerId: "desktop",
        });
        expect(yield* Effect.flip(backend.click({ x: 50, y: 50 }, "cua:10:20"))).toMatchObject({
          code: "stale_geometry",
        });
        expect(clickCount(calls)).toBe(0);
        // A fresh observation re-grounds, and only then does input flow again.
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        expect(yield* backend.click({ x: 50, y: 50 }, "cua:10:20")).toBeDefined();
        expect(clickCount(calls)).toBe(1);
      }),
    ),
  );

  it.effect("announces an interruption cycle once, even when it ended between replies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, controls } = yield* lockableFixture();
        const events = yield* interruptionEvents(backend);
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        // The first observed count only sets the baseline: consent cannot
        // predate first contact, so nothing is announced.
        yield* Effect.yieldNow;
        expect(yield* Queue.size(events)).toBe(0);
        // A lock that engaged and released entirely between two replies still
        // advanced the count — the cycle is reported exactly once, with the
        // pauses already empty.
        controls.interrupt([]);
        yield* backend.checkInputReady("cua:10:20");
        expect(yield* Queue.take(events)).toEqual({ type: "desktop-interrupted", pauses: [] });
        // A steady count reports nothing further.
        yield* backend.checkInputReady("cua:10:20");
        yield* Effect.yieldNow;
        expect(yield* Queue.size(events)).toBe(0);
      }),
    ),
  );

  it.effect("reports a still-active pause on the refusal reply it produces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, controls } = yield* lockableFixture();
        const events = yield* interruptionEvents(backend);
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        controls.interrupt(["screen-lock"]);
        // New admissions refuse while the desktop is locked, and the refusal
        // reply itself is what carries the interruption news.
        expect(yield* Effect.flip(backend.checkInputReady("cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "computer_input_paused",
        });
        expect(yield* Queue.take(events)).toEqual({
          type: "desktop-interrupted",
          pauses: ["screen-lock"],
        });
        // The pause lifting changes no count — resume is not an interruption.
        controls.resumeDesktop();
        yield* backend.checkInputReady("cua:10:20");
        yield* Effect.yieldNow;
        expect(yield* Queue.size(events)).toBe(0);
      }),
    ),
  );
});
