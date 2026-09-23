import { describe, expect, it, vi } from "@effect/vitest";
import { ComputerAvailability, ComputerScreenshot, ComputerState } from "@spiritdevs/contracts";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import {
  CUA_SETUP_TIMEOUT_MS,
  CuaTransportError,
  type CuaComputerTask,
} from "@spiritdevs/shared/cuaDriverProtocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerBackendEvent, ComputerStreamFrame } from "./ComputerBackend.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import {
  CuaActionError,
  makeCuaComputerBackend,
  type CuaComputerBackend,
  type CuaRequest,
} from "./CuaComputerBackend.ts";
import {
  abortDesktop,
  desktopSignal,
  makeDesktopAbort,
  withDesktopDeliveryMode,
  withDesktopOperationSignal,
} from "./DesktopOperationQueue.ts";
import { withModelDesktopObservation } from "./modelDesktopObservation.ts";

/**
 * Ported from Synara's `CuaComputerBackend.test.ts`. The fake driver keeps its
 * Promise shape because it stands in for the socket client; everything that
 * waits on time runs on the TestClock through `run`.
 */

/** A realistic wall clock, so the one-second snapshot cache starts cold. */
const BASE_TIME = 1_767_225_600_000;

// Wire decoders, compiled once: the backend's payloads must stay contract-valid.
const decodeAvailability = Schema.decodeUnknownEffect(ComputerAvailability);
const decodeScreenshot = Schema.decodeUnknownEffect(ComputerScreenshot);
const decodeState = Schema.decodeUnknownEffect(ComputerState);

const isTyping = (name?: string) => name === "type_text";

interface HostCall {
  readonly method?: string;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly modelObservation?: boolean;
  readonly deliveryMode?: string;
  readonly task?: CuaComputerTask;
}

/**
 * Runs a backend effect to completion, advancing the TestClock only while it
 * is blocked on time (permission re-probes, lane gaps, kill polls). Promise
 * work in the fake driver settles between scheduler yields.
 */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect, { startImmediately: true });
    for (let step = 0; step < 4_000; step += 1) {
      for (let tick = 0; tick < 8; tick += 1) {
        if (fiber.pollUnsafe()) return yield* Fiber.join(fiber);
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("25 millis");
    }
    return yield* Fiber.join(fiber);
  });

/** The typed failure of a backend effect. */
const fails = <A>(effect: Effect.Effect<A, ComputerOperationError>) => run(Effect.flip(effect));

/** Lets forked work and the fake driver's promises settle without moving time. */
const settle = (ticks = 16) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < ticks; tick += 1) yield* Effect.yieldNow;
  });

/** Waits (without moving time) until `predicate` holds. */
const waitUntil = (predicate: () => boolean, ticks = 2_000) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < ticks && !predicate(); tick += 1) yield* Effect.yieldNow;
    expect(predicate()).toBe(true);
  });

function gate() {
  let open!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => {
    open = resolve;
    reject = fail;
  });
  return { promise, open, reject };
}

/** Starts `effect` as a child fiber that runs until its first suspension now. */
const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

interface FixtureOptions {
  readonly semanticTextLaneHoldMs?: number;
  readonly semanticTextLaneGapMs?: number;
  readonly stillIntervalMs?: number;
  readonly hostPlatform?: string;
  readonly nativeRevision?: number | null;
  /** The server's own platform, before any host reply names one. */
  readonly localPlatform?: NodeJS.Platform;
  readonly endpoint?: string | null;
}

const fixture = (options?: FixtureOptions) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(BASE_TIME);
    const calls: HostCall[] = [];
    let bounds = { x: -300, y: 20, width: 200, height: 100 };
    let live = true;
    let elements: Record<string, unknown>[] = [];
    let failure: Error | undefined;
    let nativeRefusal = false;
    let desktopPaused = false;
    let desktopEpoch = 0;
    let missingPermissions = false;
    let screenRecordingMissing = false;
    let monitorPermissions: Record<string, unknown> = {};
    let permissionWait: Promise<void> | undefined;
    let overviewFailure = false;
    let captureWindowId = 20;
    let capturePid = 10;
    let captureFrameValid = true;
    let captureFrameFreshness = "captured_current_space";
    let visible = true;
    let ready: Record<string, unknown> = { ready: true, pid: 10, window_id: 20 };
    let afterCapture: (() => void) | undefined;
    let overviewWait: Promise<void> | undefined;
    let windowStateWait: Promise<void> | undefined;
    let typeGate: Promise<void> | undefined;
    // type_text requests the fake driver is holding at once, so lane tests can
    // prove writes overlapped at the native boundary rather than merely
    // resolving in some order.
    let typingInFlight = 0;
    let typingMaxInFlight = 0;
    let extraWindows: Array<Record<string, unknown>> = [];
    const toolHandlers: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> =
      {};
    let setValueSwallowed = false;
    let actionResult: Record<string, unknown> = {
      route: "synthetic_events",
      delivery: { mode: "background" },
      effect: "unverifiable",
    };
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write("IHDR", 12);
    header.writeUInt32BE(400, 16);
    header.writeUInt32BE(200, 20);
    const respond = async (_endpoint: unknown, request: HostCall): Promise<unknown> => {
      calls.push(request);
      const responseEpoch = desktopEpoch;
      if (request.method === "probe" || request.method === "stop")
        return {
          ok: true,
          desktopEpoch: responseEpoch,
          hostPlatform: options?.hostPlatform ?? "darwin",
        };
      if (desktopPaused && (request.name === "click" || isTyping(request.name)))
        return {
          ok: true,
          desktopEpoch: responseEpoch,
          result: {
            isError: true,
            structuredContent: {
              effect: "refused",
              code: "desktop_input_paused",
              message: "Desktop is locked.",
            },
          },
        };
      if (isTyping(request.name)) {
        typingInFlight += 1;
        typingMaxInFlight = Math.max(typingMaxInFlight, typingInFlight);
        try {
          if (failure) throw failure;
          if (typeGate) await typeGate;
        } finally {
          typingInFlight -= 1;
        }
        if (nativeRefusal)
          return {
            ok: true,
            desktopEpoch: responseEpoch,
            result: {
              isError: true,
              structuredContent: {
                effect: "refused",
                code: "same_pid_keyboard_ambiguity",
              },
              content: [{ type: "text", text: "No actuator ran." }],
            },
          };
      }
      let data: unknown = {};
      if (request.name === "check_permissions") {
        data = {
          accessibility: !missingPermissions,
          screen_recording: !missingPermissions && !screenRecordingMissing,
          ...monitorPermissions,
          source: { host_bundle_id: "com.pathway.test" },
        };
        await permissionWait;
      }
      if (request.name === "list_windows")
        data = {
          windows: live
            ? [
                {
                  pid: 10,
                  window_id: 20,
                  title: "Owned fixture",
                  bounds,
                  is_on_screen: visible,
                  on_current_space: visible,
                  z_index: 1,
                },
                ...extraWindows,
                {
                  pid: 20,
                  window_id: 30,
                  bounds: { x: 0, y: 0, width: 0, height: 0 },
                },
              ]
            : [],
        };
      if (request.name === "check_input_ready") data = ready;
      if (request.name === "get_screen_size") data = { width: 1000, height: 800, scale_factor: 2 };
      if (request.name === "get_desktop_state") {
        if (overviewFailure) throw new Error("Capture denied before permission recovery");
        await overviewWait;
        return {
          ok: true,
          desktopEpoch: responseEpoch,
          result: {
            structuredContent: { screen_width: 200, screen_height: 100 },
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: header.toString("base64"),
              },
            ],
          },
        };
      }
      if (request.name === "get_window_state") {
        if (windowStateWait) await windowStateWait;
        const result = {
          structuredContent: {
            pid: capturePid,
            window_id: captureWindowId,
            window_bounds: bounds,
            screenshot_frame_valid: captureFrameValid,
            screenshot_frame_freshness: captureFrameFreshness,
            elements,
          },
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: header.toString("base64"),
            },
          ],
        };
        afterCapture?.();
        return { ok: true, result, desktopEpoch: responseEpoch };
      }
      if (request.name === "set_value" && !setValueSwallowed) {
        const token = request.args?.element_token;
        const written = request.args?.value;
        const target = elements.find((element) => element.element_token === token);
        if (target && typeof written === "string")
          target.value =
            request.args?.append === true ? `${String(target.value ?? "")}${written}` : written;
      }
      if (isTyping(request.name)) data = actionResult;
      const toolHandler = request.name ? toolHandlers[request.name] : undefined;
      if (toolHandler)
        return {
          ok: true,
          result: toolHandler(request.args ?? {}),
          desktopEpoch: responseEpoch,
          hostPlatform: options?.hostPlatform ?? "darwin",
        };
      return {
        ok: true,
        result: { structuredContent: data },
        desktopEpoch: responseEpoch,
        hostPlatform: options?.hostPlatform ?? "darwin",
      };
    };
    const request = vi.fn(async (endpoint: string, body: unknown) => ({
      ...((await respond(endpoint, body as HostCall)) as Record<string, unknown>),
      ...(options?.nativeRevision === null
        ? {}
        : { driverNativeRevision: options?.nativeRevision ?? 34 }),
    }));
    const backend = yield* makeCuaComputerBackend({
      endpoint: options?.endpoint === null ? undefined : (options?.endpoint ?? "/fixture-only"),
      request: request as CuaRequest,
      ...(options?.semanticTextLaneHoldMs !== undefined
        ? { semanticTextLaneHoldMs: options.semanticTextLaneHoldMs }
        : {}),
      ...(options?.semanticTextLaneGapMs !== undefined
        ? { semanticTextLaneGapMs: options.semanticTextLaneGapMs }
        : {}),
      ...(options?.stillIntervalMs !== undefined
        ? { stillIntervalMs: options.stillIntervalMs }
        : {}),
    }).pipe(Effect.provideService(HostProcessPlatform, options?.localPlatform ?? "darwin"));
    return {
      backend,
      request,
      setElements: (value: Record<string, unknown>[]) => {
        elements = value;
      },
      swallowSetValue: () => {
        setValueSwallowed = true;
      },
      setWindows: (value: Array<Record<string, unknown>>) => {
        extraWindows = value;
      },
      setBounds: (value: typeof bounds) => {
        bounds = value;
      },
      onTool: (
        name: string,
        handler: (args: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        toolHandlers[name] = handler;
      },
      gateTypeText: (wait: Promise<void> | undefined) => {
        typeGate = wait;
      },
      typingMaxInFlight: () => typingMaxInFlight,
      pauseDesktop: (paused: boolean) => {
        desktopPaused = paused;
      },
      changeDesktop: () => {
        desktopEpoch += 1;
      },
      calls,
      delayOverview: (wait: Promise<void>) => {
        overviewWait = wait;
      },
      delayWindowState: (wait: Promise<void> | undefined) => {
        windowStateWait = wait;
      },
      setVisible: (value: boolean) => {
        visible = value;
      },
      readiness: (value: Record<string, unknown>) => {
        ready = value;
      },
      moveAfterCapture: () => {
        afterCapture = () => {
          bounds = { ...bounds, x: -250 };
        };
      },
      captureWindow: (value: number, pid = 10) => {
        captureWindowId = value;
        capturePid = pid;
      },
      invalidateCapture: () => {
        captureFrameValid = false;
      },
      markOffSpaceCaptureUnverified: () => {
        captureFrameFreshness = "unverified_off_space";
      },
      actionResult: (value: Record<string, unknown>) => {
        actionResult = value;
      },
      move: () => {
        bounds = { ...bounds, x: -250 };
      },
      close: () => {
        live = false;
      },
      fail: (error: Error) => {
        failure = error;
      },
      unfail: () => {
        failure = undefined;
      },
      refuse: () => {
        nativeRefusal = true;
      },
      denyPermissions: () => {
        missingPermissions = true;
      },
      grantPermissions: () => {
        missingPermissions = false;
        screenRecordingMissing = false;
      },
      denyScreenRecording: () => {
        screenRecordingMissing = true;
      },
      setInputMonitor: (granted: boolean, isReady: boolean) => {
        monitorPermissions = { input_monitoring: granted, input_monitor_ready: isReady };
      },
      waitForPermission: (wait: Promise<void>) => {
        permissionWait = wait;
      },
      failOverview: () => {
        overviewFailure = true;
      },
    };
  });

type Fixture = Effect.Success<ReturnType<typeof fixture>>;

/** Collects the backend's events from now on. */
const collectEvents = (backend: CuaComputerBackend) =>
  Effect.gen(function* () {
    const events: ComputerBackendEvent[] = [];
    yield* Stream.runForEach(backend.events, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* settle();
    return {
      events,
      frames: () =>
        events.flatMap((event): ComputerStreamFrame[] =>
          event.type === "frame" ? [event.frame] : [],
        ),
    };
  });

/** Observes the fixture window once so pixel input has grounding. */
const observe = (f: Fixture) =>
  run(f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }));

/** Reads a tree and returns the resolved target for its `index`th element. */
const observedTarget = (f: Fixture, label: string, index = 0) =>
  Effect.map(run(f.backend.getState({ windowId: "cua:10:20", includeTree: true })), (state) => {
    const node = state.root!.children[index]!;
    return { target: { label }, node, point: node.activationPoint! };
  });

const callsNamed = (f: Fixture, name: string) => f.calls.filter((call) => call.name === name);
const lastCall = (f: Fixture, name: string) => f.calls.findLast((call) => call.name === name);

const cancelled = () => new ComputerBackendError({ message: "Caller cancelled" });

/** A backend over a hand-rolled driver, for cases the fixture's fake cannot express. */
const bareBackend = (request: (endpoint: string, body: unknown) => Promise<unknown>) =>
  makeCuaComputerBackend({ endpoint: "/fixture-only", request: request as CuaRequest }).pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
  );

const messageField = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "AXTextField",
  label: "Message",
  frame: { x: -290, y: 30, width: 120, height: 20 },
  element_token: "message-token",
  ...overrides,
});

const webField = (overrides: Record<string, unknown> = {}) =>
  messageField({
    element_token: "web-token",
    element_index: 2,
    in_web_content: true,
    value: "seed",
    ...overrides,
  });

/** Reads `windowId`'s tree and returns an exact, window-scoped target. */
const exactTarget = (f: Fixture, label: string, windowId = "cua:10:20", index = 0) =>
  Effect.map(run(f.backend.getState({ windowId, includeTree: true })), (state) => {
    const node = state.root!.children[index]!;
    return { target: { label, windowId }, node, point: node.activationPoint! };
  });

describe("Cua native boundary", () => {
  it.effect(
    "requests AX keyboard focus only for explicit observations, not input revalidation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ nativeRevision: 37 });
        yield* run(
          withModelDesktopObservation(
            f.backend.getState({ windowId: "cua:10:20", includeTree: true }),
          ),
        );
        expect(f.calls.find((call) => call.name === "list_windows")?.args).toEqual({
          include_keyboard_focus: true,
        });
        f.calls.length = 0;
        yield* run(withModelDesktopObservation(f.backend.pressKey("enter", "cua:10:20")));
        expect(f.calls.find((call) => call.name === "list_windows")?.args).toEqual({});
      }),
  );

  // Synara's gateway-through-manager cases ("carries a provider's observed
  // field ref through the gateway…", the retained-ref it.each, the retained
  // web append refusals, and the bounded ref table eviction) drive
  // ComputerManager plus the agent gateway's computer tools. Those layers
  // are ported in later phases and own those cases.

  it.effect(
    "keeps advertised retained AX actions available off-Space without dispatching pointer input",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ nativeRevision: 37 });
        f.setElements([
          {
            role: "AXButton",
            label: "Import",
            frame: { x: -290, y: 30, width: 20, height: 20 },
            element_token: "import-token",
            actions: ["AXPress"],
          },
        ]);
        const target = yield* observedTarget(f, "Import");
        f.setVisible(false);
        yield* run(f.backend.performAction(target, "AXPress"));
        expect(lastCall(f, "click")?.args).toMatchObject({
          element_token: "import-token",
          action: "press",
          delivery_mode: "background",
        });
        expect(lastCall(f, "click")?.args).not.toHaveProperty("x");
        expect(yield* fails(f.backend.pressKey("enter", "cua:10:20"))).toMatchObject({
          code: "target_not_on_active_space",
          effect: "not-dispatched",
        });
      }),
  );

  it.effect("preserves actual native keyboard focus independently of the selected target", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setWindows([
        {
          pid: 10,
          window_id: 21,
          title: "Sheet",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          is_on_screen: true,
          keyboard_focused: true,
        },
      ]);
      yield* run(f.backend.focusWindow("cua:10:20"));
      const windows = yield* run(f.backend.listWindows());
      expect(windows.find((window) => window.id === "cua:10:20")).toMatchObject({ focused: true });
      expect(windows.find((window) => window.id === "cua:10:20")).not.toHaveProperty(
        "keyboardFocused",
      );
      expect(windows.find((window) => window.id === "cua:10:21")).toMatchObject({
        focused: false,
        keyboardFocused: true,
      });
    }),
  );

  it.effect("preserves app-initiated focus changes during a requested background launch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("launch_app", () => ({
        structuredContent: { pid: 10, focus_changed_during_launch: true },
      }));
      expect(yield* run(f.backend.launchApp("Resolve", []))).toMatchObject({
        pid: 10,
        focusChangedDuringLaunch: true,
      });
      expect(callsNamed(f, "launch_app")).toHaveLength(1);
    }),
  );

  it.effect.each([
    ["down", 0, 240, 0, -2],
    ["up", 0, -240, 0, 2],
    ["right", 240, 0, -2, 0],
    ["left", -240, 0, 2, 0],
  ] as const)(
    "maps public %s scrolling to Core Graphics wheel signs",
    ([direction, dx, dy, nativeX, nativeY]) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* observe(f);
        const result = yield* run(f.backend.scroll({ x: -275, y: 30 }, dx, dy, "cua:10:20"));
        expect(result.scrollDelta).toEqual({ deltaX: dx, deltaY: dy });
        expect(f.calls.find((call) => call.name === "scroll")?.args).toMatchObject({
          direction,
          delta_x: nativeX,
          delta_y: nativeY,
        });
      }),
  );

  it.effect("uses advertised AX actions and retains a fresh check at input dispatch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXButton",
          label: "Equals",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
          actions: ["AXPress"],
        },
        {
          role: "AXButton",
          label: "Canvas",
          frame: { x: -270, y: 30, width: 20, height: 20 },
          element_token: "canvas-token",
        },
      ]);
      const state = yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      const node = state.root!.children[0]!;
      const target = { target: { label: "Equals" }, node, point: node.activationPoint! };
      expect(callsNamed(f, "list_windows")).toHaveLength(1);
      expect(state.windows).toHaveLength(1);
      expect(f.backend.supportsAction(target, "AXPress")).toBe(true);
      expect(
        f.backend.supportsAction({ ...target, node: state.root!.children[1]! }, "AXPress"),
      ).toBe(false);
      yield* run(f.backend.focusWindow("cua:10:20"));
      expect(callsNamed(f, "list_windows")).toHaveLength(1);
      yield* run(f.backend.performAction(target, "AXPress"));
      expect(callsNamed(f, "list_windows")).toHaveLength(2);
      expect(f.calls.find((c) => c.name === "click")?.args).toMatchObject({
        element_token: "fresh-token",
        pid: 10,
        window_id: 20,
      });
      expect(f.calls.find((c) => c.name === "click")?.args).not.toHaveProperty("force_synthetic");
      f.close();
      expect(yield* fails(f.backend.performAction(target, "AXPress"))).toMatchObject({
        effect: "not-dispatched",
      });
      expect(callsNamed(f, "click")).toHaveLength(1);
    }),
  );

  it.effect("dispatches named secondary actions through the click element recipe", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXRow",
          label: "Document.txt",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "open-token",
          actions: ["AXPress", "AXOpen"],
        },
        {
          role: "AXButton",
          label: "Menu",
          frame: { x: -270, y: 30, width: 20, height: 20 },
          element_token: "menu-token",
          actions: ["AXPress", "AXShowMenu", "AXPick", "AXConfirm", "AXCancel"],
        },
      ]);
      const state = yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      const openNode = state.root!.children[0]!;
      const menuNode = state.root!.children[1]!;
      const openTarget = {
        target: { label: "Document.txt" },
        node: openNode,
        point: openNode.activationPoint!,
      };
      const menuTarget = {
        target: { label: "Menu" },
        node: menuNode,
        point: menuNode.activationPoint!,
      };

      expect(f.backend.supportsAction(openTarget, "open")).toBe(true);
      expect(f.backend.supportsAction(openTarget, "show_menu")).toBe(false);
      expect(f.backend.supportsAction(menuTarget, "menu")).toBe(true);
      expect(f.backend.supportsAction(menuTarget, "activate")).toBe(false);

      yield* run(f.backend.performAction(openTarget, "open"));
      for (const action of ["press", "show_menu", "menu", "pick", "confirm", "cancel"]) {
        yield* run(f.backend.performAction(menuTarget, action));
      }
      // Each admitted name lands on the token as the driver's `click` action
      // recipe; `menu` is the Pathway-side alias for the same AXShowMenu call.
      const dispatched = callsNamed(f, "click").map((c) => [c.args?.element_token, c.args?.action]);
      expect(dispatched).toEqual([
        ["open-token", "open"],
        ["menu-token", "press"],
        ["menu-token", "show_menu"],
        ["menu-token", "show_menu"],
        ["menu-token", "pick"],
        ["menu-token", "confirm"],
        ["menu-token", "cancel"],
      ]);
      // The legacy AXPress spelling rides the same recipe.
      yield* run(f.backend.performAction(openTarget, "AXPress"));
      expect(lastCall(f, "click")?.args).toMatchObject({
        element_token: "open-token",
        action: "press",
      });
    }),
  );

  it.effect("refuses a secondary action the element does not advertise, without dispatching", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXButton",
          label: "Plain",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "plain-token",
          actions: ["AXPress"],
        },
        {
          role: "AXStaticText",
          label: "Passive",
          frame: { x: -270, y: 30, width: 20, height: 20 },
          element_token: "passive-token",
        },
      ]);
      const state = yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      const target = {
        target: { label: "Plain" },
        node: state.root!.children[0]!,
        point: state.root!.children[0]!.activationPoint!,
      };
      const passive = {
        target: { label: "Passive" },
        node: state.root!.children[1]!,
        point: state.root!.children[1]!.activationPoint!,
      };

      for (const action of ["open", "show_menu", "menu", "pick", "confirm", "cancel"]) {
        expect(yield* fails(f.backend.performAction(target, action))).toMatchObject({
          effect: "not-dispatched",
          code: "unsupported_operation",
        });
      }
      // An element that reported no action list at all refuses the same way.
      expect(yield* fails(f.backend.performAction(passive, "open"))).toMatchObject({
        effect: "not-dispatched",
        code: "unsupported_operation",
      });
      // And a name the integration never mapped never reaches the driver.
      expect(yield* fails(f.backend.performAction(target, "toggle"))).toMatchObject({
        effect: "not-dispatched",
        code: "unsupported_operation",
      });
      expect(callsNamed(f, "click")).toHaveLength(0);

      // AXPress keeps its historical dispatch on unadvertised elements — the
      // driver degrades it to a verified AXSelected write, so it is not gated.
      yield* run(f.backend.performAction(target, "press"));
      expect(callsNamed(f, "click")).toHaveLength(1);
    }),
  );

  it.effect("writes through a live token and refuses a stale one without a second dispatch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXTextField",
          label: "Display",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
        },
      ]);
      const target = yield* observedTarget(f, "Display");
      yield* run(f.backend.setValue(target, "1"));
      expect(f.calls.find((c) => c.name === "set_value")?.args).toMatchObject({
        element_token: "fresh-token",
        value: "1",
      });
      f.close();
      expect(yield* fails(f.backend.setValue(target, "2"))).toMatchObject({
        effect: "not-dispatched",
      });
      expect(callsNamed(f, "set_value")).toHaveLength(1);
    }),
  );

  it.effect("selects an exact text range on a live element and trusts only native read-back", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXTextField",
          label: "Display",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
        },
      ]);
      const target = yield* observedTarget(f, "Display");
      const node = target.node;

      // Only the driver's confirmed effect backed by read-back evidence marks
      // the selection verified; anything weaker is reported honestly.
      f.onTool("select_text", () => ({
        structuredContent: {
          route: "ax_semantic",
          delivery: { mode: "background" },
          effect: "confirmed",
          evidence: [{ kind: "value_readback" }],
        },
      }));
      expect(yield* run(f.backend.selectText(target, { start: 2, length: 4 }))).toMatchObject({
        verified: "confirmed",
        effect: "verified",
      });
      const call = f.calls.find((c) => c.name === "select_text");
      expect(call?.args).toMatchObject({
        pid: 10,
        window_id: 20,
        element_token: "fresh-token",
        start: 2,
        length: 4,
      });
      // An AX attribute write has no foreground/background delivery split.
      expect(call?.args).not.toHaveProperty("delivery_mode");

      // A structured refusal is the driver's proof nothing was written.
      f.onTool("select_text", () => ({
        isError: true,
        structuredContent: { effect: "refused", code: "attribute_not_settable" },
        content: [{ type: "text", text: "AXSelectedTextRange is not settable." }],
      }));
      expect(yield* fails(f.backend.selectText(target, { start: 0, length: 1 }))).toMatchObject({
        effect: "not-dispatched",
        code: "attribute_not_settable",
      });

      // An inconclusive write reports dispatched-unknown exactly once — an
      // uncertain AX write is never replayed by the backend.
      f.onTool("select_text", () => ({
        structuredContent: {
          route: "ax_semantic",
          delivery: { mode: "background" },
          effect: "unconfirmed",
        },
      }));
      expect(yield* run(f.backend.selectText(target, { start: 0, length: 1 }))).toMatchObject({
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });
      expect(callsNamed(f, "select_text")).toHaveLength(3);

      // A node the backend never observed has no token: refuse before dispatch
      // rather than sending the driver a token it does not own.
      const unobserved = {
        target: { label: "Display" },
        node: { ...node, children: [] },
        point: node.activationPoint!,
      };
      expect(yield* fails(f.backend.selectText(unobserved, { start: 0, length: 1 }))).toMatchObject(
        {
          effect: "not-dispatched",
          code: "stale_target",
        },
      );

      f.close();
      expect(yield* fails(f.backend.selectText(target, { start: 0, length: 1 }))).toMatchObject({
        effect: "not-dispatched",
      });
      expect(callsNamed(f, "select_text")).toHaveLength(3);
    }),
  );

  it.effect("uses semantic-only text delivery for an exact live control", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");

      yield* run(f.backend.typeText("hello", "cua:10:20", target));
      expect(lastCall(f, "type_text")?.args).toMatchObject({
        text: "hello",
        pid: 10,
        window_id: 20,
        element_token: "message-token",
        semantic_only: true,
        // Overrides the driver's 30ms-per-character default pacing.
        delay_ms: 0,
      });
      expect(lastCall(f, "type_text")?.args).not.toHaveProperty("force_synthetic");

      yield* run(f.backend.typeText("keyboard", "cua:10:20"));
      // No element: the driver's atomic focused-field insertion runs first, so
      // key events are not forced.
      const focusedFieldCall = callsNamed(f, "type_text")[1]?.args;
      expect(focusedFieldCall).toMatchObject({ text: "keyboard", delay_ms: 10 });
      expect(focusedFieldCall).not.toHaveProperty("force_synthetic");
      expect(focusedFieldCall).not.toHaveProperty("semantic_only");
    }),
  );

  it.effect("types into web content through a composed set_value and verifies on re-read", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([webField()]);
      const target = yield* exactTarget(f, "Message");

      const result = yield* run(f.backend.typeText("-typed", "cua:10:20", target));
      // Chromium-family fields never honour AXSelectedText: the write must be a
      // composed AXValue set, not a semantic insert.
      expect(callsNamed(f, "type_text")).toHaveLength(0);
      expect(lastCall(f, "set_value")?.args).toMatchObject({
        element_token: "web-token",
        element_index: 2,
        value: "seed-typed",
        pid: 10,
        window_id: 20,
      });
      // The independent re-read saw the DOM value land.
      expect(result).toMatchObject({ verified: "confirmed", effect: "verified" });
      const reads = callsNamed(f, "get_window_state");
      expect(reads).toHaveLength(3);
      for (const read of reads) expect(read.args?.include_screenshot).toBe(false);
    }),
  );

  it.effect("refuses a stale semantic field when fresh state has two matching controls", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const field = webField({ element_token: "one" });
      f.setElements([field]);
      const target = yield* exactTarget(f, "Message");
      f.setElements([field, { ...field, element_token: "two", element_index: 3 }]);
      expect(yield* fails(f.backend.setValue(target, "replacement"))).toMatchObject({
        effect: "not-dispatched",
        code: "stale_target",
      });
      expect(callsNamed(f, "set_value")).toHaveLength(0);
    }),
  );

  it.effect("reports dispatched-unknown when a web set_value does not land", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([webField()]);
      const target = yield* exactTarget(f, "Message");

      // The driver accepts the write but the element's value never changes —
      // the re-read must catch that and refuse to call it verified.
      f.swallowSetValue();
      const result = yield* run(f.backend.typeText("-typed", "cua:10:20", target));
      expect(result).toMatchObject({ verified: "unconfirmed", effect: "dispatched-unknown" });
      const reads = callsNamed(f, "get_window_state");
      expect(reads).toHaveLength(3);
      for (const read of reads) expect(read.args?.include_screenshot).toBe(false);
    }),
  );

  it.effect.each([
    { action: "typeText", interruption: "timeout" },
    { action: "typeText", interruption: "cancellation" },
    { action: "typeText", interruption: "elapsed deadline" },
    { action: "setValue", interruption: "timeout" },
    { action: "setValue", interruption: "cancellation" },
    { action: "setValue", interruption: "elapsed deadline" },
  ] as const)(
    "never sends web $action after $interruption while its field read was pending",
    ({ action, interruption }) =>
      Effect.gen(function* () {
        const f = yield* fixture({
          semanticTextLaneGapMs: 0,
          semanticTextLaneHoldMs: interruption === "timeout" ? 80 : 1_000,
        });
        f.setElements([webField()]);
        const target = yield* exactTarget(f, "Message");
        const read = gate();
        f.delayWindowState(read.promise);
        const abort = makeDesktopAbort();
        const pending = yield* start(
          withDesktopOperationSignal(
            desktopSignal(abort),
            action === "typeText"
              ? f.backend.typeText("expired", "cua:10:20", target)
              : f.backend.setValue(target, "expired"),
          ),
        );
        yield* waitUntil(() => callsNamed(f, "get_window_state").length === 2);
        if (interruption === "cancellation") {
          yield* abortDesktop(abort, cancelled());
          expect((yield* fails(Fiber.join(pending))).message).toContain("Caller cancelled");
        } else if (interruption === "elapsed deadline") {
          // Synara models a blocked event loop by jumping `Date.now` past the
          // budget before the read resolves. On the TestClock the budget timer
          // fires on the same jump, so either guard refuses the write.
          yield* TestClock.adjust("2 seconds");
          read.open();
          expect(yield* fails(Fiber.join(pending))).toMatchObject({ effect: "not-dispatched" });
        } else {
          expect(yield* fails(Fiber.join(pending))).toMatchObject({ effect: "not-dispatched" });
        }
        expect(callsNamed(f, "set_value")).toHaveLength(0);

        // Let the abandoned read finish after its operation scope is closed.
        // A later write must drain that continuation without replaying its input.
        f.delayWindowState(undefined);
        read.open();
        expect(yield* run(f.backend.setValue(target, "allowed"))).toMatchObject({
          effect: "verified",
        });
        expect(callsNamed(f, "set_value").map((call) => call.args?.value)).toEqual(["allowed"]);
        expect(callsNamed(f, "type_text")).toHaveLength(0);
      }),
  );

  it.effect("semantic text lane serializes same-window writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 0 });
      // Two distinct elements in one window still share the lane: the native
      // semantic lease is per (pid, window), so a second concurrent write to the
      // window would be refused outright rather than queued.
      f.setElements([
        messageField(),
        messageField({
          label: "Notes",
          frame: { x: -290, y: 60, width: 120, height: 20 },
          element_token: "notes-token",
        }),
      ]);
      const firstTarget = yield* exactTarget(f, "Message");
      const secondTarget = yield* exactTarget(f, "Notes", "cua:10:20", 1);
      const typing = gate();
      f.gateTypeText(typing.promise);

      const first = yield* start(f.backend.typeText("alpha", "cua:10:20", firstTarget));
      yield* waitUntil(() => callsNamed(f, "type_text").length === 1);
      const second = yield* start(f.backend.typeText("bravo", "cua:10:20", secondTarget));
      yield* settle(64);
      expect(callsNamed(f, "type_text")).toHaveLength(1);
      expect(f.typingMaxInFlight()).toBe(1);
      typing.open();

      yield* run(Fiber.join(first));
      yield* run(Fiber.join(second));
      expect(callsNamed(f, "type_text").map((call) => call.args?.text)).toEqual(["alpha", "bravo"]);
    }),
  );

  it.effect.each([
    ["select_text", "selectText"],
    ["set_value", "setValue"],
  ] as const)("semantic text lane holds %s behind a same-window write", ([tool, method]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 0 });
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");
      const typing = gate();
      f.gateTypeText(typing.promise);

      const write = yield* start(f.backend.typeText("alpha", "cua:10:20", target));
      yield* waitUntil(() => callsNamed(f, "type_text").length === 1);
      const held = yield* start(
        method === "selectText"
          ? f.backend.selectText(target, { start: 0, length: 2 })
          : f.backend.setValue(target, "beta"),
      );
      yield* settle(64);
      // The native semantic lease is per (pid, window), and set_value takes the
      // same lease as type_text and select_text: the second action must not
      // reach the driver while the same-window write is still held, or the
      // lease refuses it outright (native_input_busy).
      expect(callsNamed(f, tool)).toHaveLength(0);
      typing.open();

      yield* run(Fiber.join(write));
      yield* run(Fiber.join(held));
      const order = f.calls
        .filter((call) => call.name === "type_text" || call.name === tool)
        .map((call) => call.name);
      expect(order).toEqual(["type_text", tool]);
    }),
  );

  it.effect("set_value dispatches to a window that is not on the current Space", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // A pure AX attribute write is exactly the mutation the driver's
      // StableMembership policy admits on a hidden, minimized or off-Space
      // window — the same admission semantic type_text and select_text get.
      // Only pointer, synthetic keyboard and generic window actions carry the
      // visibility requirement.
      f.setVisible(false);
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");
      expect(yield* run(f.backend.setValue(target, "beta"))).toBeDefined();
      // The driver still sees the element-addressed semantic write shape.
      expect(lastCall(f, "set_value")?.args).toMatchObject({
        element_token: "message-token",
        pid: 10,
        window_id: 20,
      });
    }),
  );

  it.effect.each([
    {
      name: "same-pid writes to different windows",
      windows: [[10, 21]],
    },
    {
      name: "different-pid writes",
      windows: [[11, 21]],
    },
    {
      // The three-window fixture case: three exact text targets in three
      // windows of one Electron pid. Only same-window writes serialize.
      name: "three same-pid windows truly concurrently",
      windows: [
        [10, 21],
        [10, 22],
      ],
    },
  ] as const)("semantic text lane overlaps $name", ({ windows }) =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 0 });
      f.setWindows(
        windows.map(([pid, windowId], index) => ({
          pid,
          window_id: windowId,
          title: `Owned fixture ${String.fromCharCode(66 + index)}`,
          bounds: { x: 100 + index * 400, y: 20, width: 200, height: 100 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 0,
        })),
      );
      f.setElements([messageField()]);
      const targets = [yield* exactTarget(f, "Message")];
      for (const [pid, windowId] of windows) {
        f.captureWindow(windowId, pid);
        targets.push(yield* exactTarget(f, "Message", `cua:${pid}:${windowId}`));
      }
      const typing = gate();
      f.gateTypeText(typing.promise);

      const texts = ["alpha", "bravo", "charlie"];
      const writes = [];
      for (const [index, target] of targets.entries())
        writes.push(
          yield* start(f.backend.typeText(texts[index]!, target.target.windowId, target)),
        );
      // Every write reaches the driver while the gate is still held — in flight
      // together at the native boundary, not queued one behind the other.
      yield* waitUntil(() => callsNamed(f, "type_text").length === targets.length);
      expect(f.typingMaxInFlight()).toBe(targets.length);
      typing.open();

      for (const write of writes) yield* run(Fiber.join(write));
      expect(callsNamed(f, "type_text").map((call) => call.args?.window_id)).toEqual([
        20,
        ...windows.map(([, windowId]) => windowId),
      ]);
    }),
  );

  it.effect("semantic text lane leaves synthetic keyboard writes alone", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 0 });
      const typing = gate();
      f.gateTypeText(typing.promise);

      const first = yield* start(f.backend.typeText("a", "cua:10:20"));
      const second = yield* start(f.backend.typeText("b", "cua:10:20"));
      yield* waitUntil(() => callsNamed(f, "type_text").length === 2);
      typing.open();

      yield* run(Fiber.join(first));
      yield* run(Fiber.join(second));
    }),
  );

  it.effect.each(["success", "failure"])(
    "keeps a timed-out semantic write in its lane until late %s",
    (outcome) =>
      Effect.gen(function* () {
        const f = yield* fixture({ semanticTextLaneGapMs: 0, semanticTextLaneHoldMs: 80 });
        f.setElements([messageField()]);
        const target = yield* exactTarget(f, "Message");
        const typing = gate();
        f.gateTypeText(typing.promise);

        expect(yield* fails(f.backend.typeText("alpha", "cua:10:20", target))).toMatchObject({
          effect: "dispatched-unknown",
        });
        const second = yield* start(f.backend.typeText("beta", "cua:10:20", target));
        yield* settle();
        expect(callsNamed(f, "type_text")).toHaveLength(1);
        expect(f.typingMaxInFlight()).toBe(1);

        f.gateTypeText(undefined);
        if (outcome === "success") typing.open();
        else typing.reject(new Error("Late native failure"));
        expect(yield* run(Fiber.join(second))).toMatchObject({ windowId: "cua:10:20" });
        expect(callsNamed(f, "type_text").map((call) => call.args?.text)).toEqual([
          "alpha",
          "beta",
        ]);
        expect(f.typingMaxInFlight()).toBe(1);
      }),
  );

  it.effect("expires a queued semantic write without dispatching it after the lane drains", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 0, semanticTextLaneHoldMs: 40 });
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");
      const typing = gate();
      f.gateTypeText(typing.promise);

      expect(yield* fails(f.backend.typeText("alpha", "cua:10:20", target))).toMatchObject({
        effect: "dispatched-unknown",
        code: "cua_action_failed",
      });
      expect(yield* fails(f.backend.typeText("expired", "cua:10:20", target))).toMatchObject({
        effect: "not-dispatched",
      });
      expect(callsNamed(f, "type_text")).toHaveLength(1);
      f.gateTypeText(undefined);
      typing.open();
      expect(yield* run(f.backend.typeText("beta", "cua:10:20", target))).toMatchObject({
        windowId: "cua:10:20",
      });
      expect(callsNamed(f, "type_text").map((call) => call.args?.text)).toEqual(["alpha", "beta"]);
      expect(f.typingMaxInFlight()).toBe(1);
    }),
  );

  it.effect(
    "cancels a queued semantic write without waiting for or bypassing its predecessor",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ semanticTextLaneGapMs: 0 });
        f.setElements([messageField()]);
        const target = yield* exactTarget(f, "Message");
        const typing = gate();
        f.gateTypeText(typing.promise);
        const first = yield* start(f.backend.typeText("alpha", "cua:10:20", target));
        yield* waitUntil(() => callsNamed(f, "type_text").length === 1);

        const abort = makeDesktopAbort();
        const second = yield* start(
          withDesktopOperationSignal(
            desktopSignal(abort),
            f.backend.typeText("cancelled", "cua:10:20", target),
          ),
        );
        yield* settle();
        yield* abortDesktop(abort, cancelled());
        expect((yield* fails(Fiber.join(second))).message).toContain("Caller cancelled");
        expect(callsNamed(f, "type_text")).toHaveLength(1);

        f.gateTypeText(undefined);
        typing.open();
        yield* run(Fiber.join(first));
        expect(yield* run(f.backend.typeText("beta", "cua:10:20", target))).toBeDefined();
        expect(callsNamed(f, "type_text").map((call) => call.args?.text)).toEqual([
          "alpha",
          "beta",
        ]);
        expect(f.typingMaxInFlight()).toBe(1);
      }),
  );

  it.effect("semantic text lane holds the gap between consecutive writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ semanticTextLaneGapMs: 60 });
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");
      // Consecutive writes to the same exact element: the second cannot start
      // until the first's settle gap has elapsed.
      const first = yield* start(f.backend.typeText("alpha", "cua:10:20", target));
      const second = yield* start(f.backend.typeText("bravo", "cua:10:20", target));
      yield* waitUntil(() => callsNamed(f, "type_text").length === 1);
      yield* settle(64);
      expect(callsNamed(f, "type_text")).toHaveLength(1);
      yield* TestClock.adjust("59 millis");
      yield* settle(64);
      expect(callsNamed(f, "type_text")).toHaveLength(1);
      yield* TestClock.adjust("1 millis");
      yield* run(Fiber.join(first));
      yield* run(Fiber.join(second));
      expect(callsNamed(f, "type_text")).toHaveLength(2);
    }),
  );

  it.effect("keeps retained semantic text available after its exact window moves off-Space", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([messageField()]);
      const target = yield* exactTarget(f, "Message");
      f.setVisible(false);

      expect(yield* run(f.backend.typeText("hello", "cua:10:20", target))).toMatchObject({
        windowId: "cua:10:20",
      });
      expect(lastCall(f, "type_text")?.args).toMatchObject({
        pid: 10,
        window_id: 20,
        text: "hello",
        element_token: "message-token",
        semantic_only: true,
      });
    }),
  );

  it.effect("serves internal target resolution from a recent tree instead of walking again", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXButton",
          label: "Equals",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
        },
      ]);
      const observed = yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      expect(callsNamed(f, "get_window_state")).toHaveLength(1);

      const resolved = yield* run(
        f.backend.getState({ windowId: "cua:10:20", includeTree: true, reuseRecentTree: true }),
      );
      expect(callsNamed(f, "get_window_state")).toHaveLength(1);
      expect(resolved.root).toBe(observed.root);

      // The freshness requirement stands on the agent-facing path: a second
      // observation without the reuse flag still pays for the walk.
      yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      expect(callsNamed(f, "get_window_state")).toHaveLength(2);
    }),
  );

  it.effect("scopes the recent tree to its window and re-walks after it ages out", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXButton",
          label: "Equals",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
        },
      ]);
      yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      expect(callsNamed(f, "get_window_state")).toHaveLength(1);

      // A window the cache never saw cannot borrow another window's tree: the
      // fresh identity check runs before any cached state is served.
      expect(
        yield* fails(
          f.backend.getState({ windowId: "cua:30:40", includeTree: true, reuseRecentTree: true }),
        ),
      ).toMatchObject({ effect: "not-dispatched" });
      expect(callsNamed(f, "get_window_state")).toHaveLength(1);

      yield* TestClock.adjust("10 seconds");
      yield* run(
        f.backend.getState({ windowId: "cua:10:20", includeTree: true, reuseRecentTree: true }),
      );
      expect(callsNamed(f, "get_window_state")).toHaveLength(2);
    }),
  );

  it.effect(
    "allows the bounded native permission request to finish without extending action deadlines",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ method: string; timeoutMs: number | undefined }> = [];
        const request: CuaRequest = async (_endpoint, body, options) => {
          requests.push({
            method: (body as { method: string }).method,
            timeoutMs: options?.timeoutMs,
          });
          return {
            ok: true,
            result: { structuredContent: { accessibility: false, screen_recording: false } },
          };
        };
        const backend = yield* makeCuaComputerBackend({ endpoint: "/fixture-only", request }).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        yield* run(backend.provision());
        expect(requests.find((entry) => entry.method === "setup")?.timeoutMs).toBe(
          CUA_SETUP_TIMEOUT_MS,
        );
        expect(
          requests
            .filter((entry) => entry.method === "call")
            .every((entry) => entry.timeoutMs === 35_000),
        ).toBe(true);
      }),
  );

  it.effect("reports only the current missing permission and the responsible app", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.denyScreenRecording();
      const availability = yield* run(f.backend.availability());
      expect(availability).toMatchObject({
        kind: "permission-required",
        missing: ["screenRecording"],
        bundleId: "com.pathway.test",
      });
      expect(availability.kind === "permission-required" && availability.message).not.toContain(
        "Accessibility",
      );
      expect(yield* run(f.backend.provision())).toContain("Allow Screen Recording");
    }),
  );

  it.effect(
    "an explicit status refresh consumes a newly granted permission without waiting for the action cache",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.denyPermissions();
        expect(yield* run(f.backend.availability())).toMatchObject({
          kind: "permission-required",
        });
        f.grantPermissions();
        expect(yield* run(f.backend.availability())).toMatchObject({
          kind: "permission-required",
        });
        expect(yield* run(f.backend.availability({ refresh: true }))).toMatchObject({
          kind: "available",
        });
      }),
  );

  it.effect(
    "does not reuse an in-flight permission denial for a grant-triggered status refresh",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.denyPermissions();
        yield* run(f.backend.availability());
        const previousChecks = callsNamed(f, "check_permissions").length;
        const permission = gate();
        f.waitForPermission(permission.promise);
        const old = yield* start(f.backend.availability({ refresh: true }));
        yield* waitUntil(() => callsNamed(f, "check_permissions").length === previousChecks + 1);
        const updated = yield* start(f.backend.availability({ refresh: true }));
        f.grantPermissions();
        permission.open();
        expect(yield* run(Fiber.join(old))).toMatchObject({ kind: "permission-required" });
        expect(yield* run(Fiber.join(updated))).toMatchObject({ kind: "available" });
      }),
  );

  it.effect(
    "refreshes after a pre-setup check settles and reports granted permissions accurately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.denyPermissions();
        const permission = gate();
        f.waitForPermission(permission.promise);
        const previous = yield* start(f.backend.availability());
        const provision = yield* start(f.backend.provision());
        f.grantPermissions();
        permission.open();
        yield* run(Fiber.join(previous));
        expect(yield* run(Fiber.join(provision))).toContain("permissions are ready");
        expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
      }),
  );

  it.effect("names Input Monitoring when the physical interruption listener lacks its grant", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hostPlatform: "darwin" });
      f.setInputMonitor(false, false);
      const availability = yield* run(f.backend.availability());
      expect(availability).toMatchObject({
        kind: "permission-required",
        missing: ["inputMonitoring"],
        message: expect.stringContaining("Input Monitoring"),
      });
      expect(yield* decodeAvailability(availability)).toEqual(availability);
      expect(yield* run(f.backend.provision())).toContain("Allow Input Monitoring");
    }),
  );

  it.effect(
    "reports a failed listener separately from permissions and recovers after it starts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "darwin" });
        f.setInputMonitor(true, false);
        expect(yield* run(f.backend.availability())).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("Escape and human-input listener"),
        });
        expect(f.backend.health()).toMatchObject({ status: "unavailable", captureAvailable: true });
        expect(yield* run(f.backend.provision())).not.toContain("permissions are ready");
        f.setInputMonitor(true, true);
        expect(yield* run(f.backend.provision())).toContain("permissions are ready");
        expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
        expect(f.backend.health().status).toBe("connected");
      }),
  );

  it.effect("does not impose macOS Input Monitoring on a remote Linux host", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hostPlatform: "linux" });
      f.setInputMonitor(false, false);
      expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
    }),
  );

  it.effect(
    "recognizes native Linux display and AT-SPI prerequisites without inventing TCC grants",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        f.onTool("check_permissions", () => ({
          structuredContent: { atspi: true, x11: true, wayland: false, wayland_enabled: false },
        }));
        expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
        expect(yield* run(f.backend.missingPermissions())).toEqual([]);
        expect(f.backend.health().captureAvailable).toBe(true);
        expect(f.backend.capabilities()).toMatchObject({
          input: false,
          focus: false,
          raise: false,
          capture: true,
          windows: true,
        });
      }),
  );

  it.effect(
    "reports unavailable Wayland geometry without failing status or concealing it behind a live socket",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        f.onTool("check_permissions", () => ({
          structuredContent: { atspi: true, x11: false, wayland: true, wayland_enabled: true },
        }));
        f.onTool("get_screen_size", () => {
          throw new Error("$DISPLAY variable not set and no value was provided explicitly");
        });
        const unavailable = yield* run(f.backend.availability());
        expect(unavailable).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("$DISPLAY"),
        });
        expect(f.backend.health()).toMatchObject({
          status: "unavailable",
          captureAvailable: false,
        });
        const beforeProbe = f.calls.length;
        expect(yield* run(f.backend.probeAvailability())).toEqual(unavailable);
        expect(f.calls.slice(beforeProbe).some((call) => call.name === "get_screen_size")).toBe(
          false,
        );
        expect((yield* fails(f.backend.getScreenSize())).message).toContain("$DISPLAY");
        f.onTool("get_screen_size", () => ({ structuredContent: { width: 1280, height: 800 } }));
        expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
        expect(yield* run(f.backend.getScreenSize())).toMatchObject({ width: 1280, height: 800 });
      }),
  );

  it.effect(
    "recovers Linux capture only after real pixels, not a compositor permission probe",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        f.onTool("check_permissions", () => ({
          structuredContent: { atspi: true, x11: true, wayland: false, wayland_enabled: false },
        }));
        yield* run(f.backend.availability());
        f.failOverview();
        expect((yield* fails(f.backend.getState({ includeScreenshot: true }))).message).toContain(
          "Capture denied",
        );
        expect(f.backend.health().captureAvailable).toBe(false);
        yield* run(f.backend.provision());
        expect(f.backend.health().captureAvailable).toBe(false);
        yield* observe(f);
        expect(f.backend.health()).toMatchObject({
          status: "connected",
          captureAvailable: true,
          consecutiveFailures: 0,
        });
      }),
  );

  it.effect("re-probes a transient missing report before publishing availability", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.denyPermissions();
      const permission = gate();
      f.waitForPermission(permission.promise);
      const pending = yield* start(f.backend.availability());
      // Park the first check_permissions on the gate long enough to have read
      // "missing", then flip to granted so the delayed re-probe sees the truth.
      yield* waitUntil(() => callsNamed(f, "check_permissions").length === 1);
      f.grantPermissions();
      permission.open();
      expect(yield* run(Fiber.join(pending))).toMatchObject({ kind: "available" });
    }),
  );

  it.effect("keeps re-probing until a delayed grant lands", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.denyPermissions();
      const arm = () => {
        const next = gate();
        f.waitForPermission(next.promise);
        return next;
      };
      const checks = () => callsNamed(f, "check_permissions").length;
      const initial = arm();
      const pending = yield* start(f.backend.availability());
      yield* waitUntil(() => checks() === 1);
      // Initial check reads missing; probe one reads missing too; the grant only
      // exists by probe two — matching the multi-second transient seen live.
      const probeOne = arm();
      initial.open();
      yield* settle();
      yield* TestClock.adjust("600 millis");
      yield* waitUntil(() => checks() === 2);
      const probeTwo = arm();
      probeOne.open();
      yield* settle();
      f.grantPermissions();
      yield* TestClock.adjust("600 millis");
      yield* waitUntil(() => checks() === 3);
      probeTwo.open();
      expect(yield* run(Fiber.join(pending))).toMatchObject({ kind: "available" });
      expect(checks()).toBe(3);
    }),
  );

  it.effect("clears an old capture failure after explicit setup so recovery can be retried", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failOverview();
      expect((yield* fails(f.backend.getState({ includeScreenshot: true }))).message).toContain(
        "Capture denied",
      );
      expect(f.backend.health().captureAvailable).toBe(false);
      yield* run(f.backend.provision());
      expect(f.backend.health()).toMatchObject({ status: "connected", captureAvailable: true });
      // Readiness recovery does not itself capture the screen to prove pixels.
      expect(callsNamed(f, "get_desktop_state")).toHaveLength(1);
    }),
  );

  it.effect(
    "marks scoped model state reads and never marks a pane still as a model observation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* observe(f);
        expect(f.calls.find((call) => call.name === "get_window_state")?.modelObservation).toBe(
          false,
        );
        yield* run(f.backend.focusWindow("cua:10:20"));
        f.calls.length = 0;
        yield* run(
          withModelDesktopObservation(
            Effect.gen(function* () {
              yield* f.backend.getState({ windowId: "cua:10:20", includeTree: true });
              yield* f.backend.getState({ includeScreenshot: true });
              yield* f.backend.attachStream();
            }),
          ),
        );
        // The scoped read is the model's picture; the pane still of the same
        // window is a preview leg and stays unmarked.
        expect(callsNamed(f, "get_window_state").map((call) => call.modelObservation)).toEqual([
          true,
          false,
        ]);
        // The unscoped read is the model's overview — and the only desktop
        // capture in the whole sequence.
        expect(callsNamed(f, "get_desktop_state").map((call) => call.modelObservation)).toEqual([
          true,
        ]);
        expect(
          f.calls
            .filter((call) => !["get_window_state", "get_desktop_state"].includes(call.name ?? ""))
            .every((call) => call.modelObservation === undefined),
        ).toBe(true);
        yield* f.backend.dispose();
      }),
  );

  it.effect(
    "invalidates old coordinate grounding when lock and resume occurred between requests",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* observe(f);
        f.changeDesktop();
        expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "stale_geometry",
        });
        expect(callsNamed(f, "click")).toHaveLength(0);
        yield* run(
          withModelDesktopObservation(
            f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
          ),
        );
        expect(yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toBeDefined();
      }),
  );

  it.effect("rejects a delayed observation from before a known desktop interruption", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const overview = gate();
      f.delayOverview(overview.promise);
      const observing = yield* start(f.backend.getState({ includeScreenshot: true }));
      yield* waitUntil(() => callsNamed(f, "get_desktop_state").length > 0);
      f.changeDesktop();
      yield* run(f.backend.checkInputReady("cua:10:20"));
      overview.open();
      expect(yield* fails(Fiber.join(observing))).toMatchObject({
        effect: "not-dispatched",
        code: "stale_desktop_epoch",
      });
    }),
  );

  it.effect("checks exact native input readiness without capturing or dispatching input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* run(f.backend.checkInputReady("cua:10:20"))).toBeUndefined();
      expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
      expect(f.calls[1]?.args).toEqual({ pid: 10, window_id: 20 });
      f.readiness({ ready: true, pid: 10, window_id: 21 });
      expect(yield* fails(f.backend.checkInputReady("cua:10:20"))).toMatchObject({
        code: "invalid_readiness",
        effect: "not-dispatched",
      });
      f.readiness({ ready: false });
      expect(yield* fails(f.backend.checkInputReady("cua:10:20"))).toMatchObject({
        code: "invalid_readiness",
      });
    }),
  );

  it.effect(
    "refreshes Linux readiness from exact visible window identity without a missing native tool",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        expect(yield* run(f.backend.checkInputReady("cua:10:20"))).toBeUndefined();
        expect(f.calls.map((call) => call.name)).toEqual(["list_windows"]);
        f.setVisible(false);
        expect(yield* fails(f.backend.checkInputReady("cua:10:20"))).toMatchObject({
          code: "target_not_on_active_space",
          effect: "not-dispatched",
        });
        f.close();
        expect(yield* fails(f.backend.checkInputReady("cua:10:20"))).toMatchObject({
          code: "stale_target",
          effect: "not-dispatched",
        });
        expect(f.calls.every((call) => call.name === "list_windows")).toBe(true);
      }),
  );

  it.effect("asks the driver to observe settle for the exact window without touching input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("wait_for_settle", (args) => ({
        structuredContent: {
          settled: true,
          waited_ms: 120,
          events_seen: 3,
          pid: args.pid,
          window_id: args.window_id,
          scope: "window",
        },
      }));
      expect(
        yield* run(
          f.backend.waitForSettle({ windowId: "cua:10:20", timeoutMs: 5_000, quietMs: 1_000 }),
        ),
      ).toEqual({ settled: true, waitedMs: 120, eventsSeen: 3 });
      expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "wait_for_settle"]);
      expect(f.calls[1]?.args).toEqual({
        pid: 10,
        window_id: 20,
        timeout_ms: 5_000,
        quiet_ms: 1_000,
      });
    }),
  );

  it.effect("clamps the settle bounds the driver caps, and refuses a malformed verdict", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("wait_for_settle", () => ({
        structuredContent: { settled: false, waited_ms: 30_000, events_seen: 41 },
      }));
      expect(
        yield* run(
          f.backend.waitForSettle({ windowId: "cua:10:20", timeoutMs: 999_999, quietMs: 999_999 }),
        ),
      ).toMatchObject({ settled: false, eventsSeen: 41 });
      expect(f.calls[1]?.args).toMatchObject({ timeout_ms: 30_000, quiet_ms: 5_000 });
      f.onTool("wait_for_settle", () => ({ structuredContent: { waited_ms: 5 } }));
      expect(
        yield* fails(
          f.backend.waitForSettle({ windowId: "cua:10:20", timeoutMs: 1_000, quietMs: 100 }),
        ),
      ).toMatchObject({ code: "invalid_settle_read", effect: "not-dispatched" });
      f.onTool("wait_for_settle", () => ({
        isError: true,
        content: [{ type: "text", text: "Unknown tool: wait_for_settle" }],
      }));
      expect(
        yield* fails(
          f.backend.waitForSettle({ windowId: "cua:10:20", timeoutMs: 1_000, quietMs: 100 }),
        ),
      ).toMatchObject({ effect: "not-dispatched" });
    }),
  );

  it.effect("pauses input on another Space while leaving observation available", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setVisible(false);
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "target_not_on_active_space",
        inputPause: { windowId: "cua:10:20" },
      });
      expect(f.calls.some((call) => isTyping(call.name))).toBe(false);
      expect(yield* run(f.backend.getState({ windowId: "cua:10:20" }))).toMatchObject({
        computerId: "desktop",
      });
    }),
  );

  it.effect("preserves a native off-Space refusal during read-only readiness", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.readiness({
        ready: false,
        effect: "refused",
        code: "target_not_on_active_space",
        pid: 10,
        window_id: 20,
        reason: "The target is on another Space.",
      });
      expect(yield* fails(f.backend.checkInputReady("cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "target_not_on_active_space",
        inputPause: { windowId: "cua:10:20", message: "The target is on another Space." },
      });
      expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
    }),
  );

  it.effect("maps only proven native Space refusals to recoverable pause", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.actionResult({
        effect: "refused",
        code: "target_not_on_active_space",
        message: "Target is on another Space.",
      });
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        inputPause: { windowId: "cua:10:20" },
      });
      f.fail(new CuaTransportError("Space changed after dispatch", "dispatched-unknown"));
      const error = yield* fails(f.backend.typeText("abc", "cua:10:20"));
      expect(error).toMatchObject({ effect: "dispatched-unknown" });
      expect(error).not.toHaveProperty("inputPause");
      expect(f.calls.filter((call) => isTyping(call.name))).toHaveLength(2);
    }),
  );

  it.effect("rejects a drag if its prepared window moves before input admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      f.move();
      expect(
        yield* fails(
          withDesktopDeliveryMode(
            "foreground",
            f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
          ),
        ),
      ).toMatchObject({ effect: "not-dispatched", code: "stale_geometry" });
      expect(callsNamed(f, "drag")).toHaveLength(0);
    }),
  );

  it.effect("binds foreground drag pixels to the exact observed native bounds", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      yield* run(
        withDesktopDeliveryMode(
          "foreground",
          f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
        ),
      );
      expect(callsNamed(f, "drag")).toEqual([
        expect.objectContaining({
          args: {
            pid: 10,
            window_id: 20,
            delivery_mode: "foreground",
            from_x: 25,
            from_y: 10,
            to_x: 75,
            to_y: 30,
            coordinate_space: "window_points",
            duration_ms: 500,
            expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
          },
        }),
      ]);
    }),
  );

  it.effect("preserves capture identity and rejects a different native window", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const image = yield* observe(f);
      expect(yield* decodeScreenshot(image)).toMatchObject({
        windowId: "cua:10:20",
      });
      expect(
        yield* run(f.backend.getState({ windowId: "cua:10:20", includeScreenshot: true })),
      ).toMatchObject({ screenshot: { windowId: "cua:10:20" } });
      f.captureWindow(21);
      expect(
        yield* fails(f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" })),
      ).toMatchObject({ effect: "not-dispatched" });
      expect(
        yield* fails(f.backend.getState({ windowId: "cua:10:20", includeTree: true })),
      ).toMatchObject({ effect: "not-dispatched" });
      expect(callsNamed(f, "click")).toHaveLength(0);
    }),
  );

  it.effect("clears targeting after desktop pause and requires a fresh observation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      f.pauseDesktop(true);
      expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "computer_input_paused",
        layer: "driver-host",
        inputPause: { windowId: "cua:10:20" },
      });
      f.pauseDesktop(false);
      expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
        code: "stale_geometry",
      });
      yield* observe(f);
      expect(yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toBeDefined();
    }),
  );

  it.effect("dispatches logical coordinate input without a preparation PNG", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      f.calls.length = 0;
      yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"));
      yield* run(f.backend.scroll({ x: -275, y: 30 }, 0, 120, "cua:10:20"));
      yield* run(
        withDesktopDeliveryMode(
          "foreground",
          f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
        ),
      );
      expect(callsNamed(f, "get_window_state")).toHaveLength(0);
      for (const call of f.calls.filter((c) =>
        ["click", "scroll", "drag"].includes(c.name ?? ""),
      )) {
        expect(call.args).toMatchObject({
          pid: 10,
          window_id: 20,
          coordinate_space: "window_points",
          expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
        });
      }
    }),
  );

  it.effect(
    "permits advertised AXPress for plain clicks and preserves physical click gestures",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const point = { x: -275, y: 30 };
        yield* observe(f);
        yield* run(f.backend.click(point, "cua:10:20"));
        yield* run(f.backend.click(point, "cua:10:20", ["shift"]));
        yield* run(f.backend.doubleClick(point, "cua:10:20"));
        yield* run(f.backend.tripleClick(point, "cua:10:20"));
        yield* run(f.backend.rightClick(point, "cua:10:20"));
        const clicks = callsNamed(f, "click");
        expect(clicks).toHaveLength(5);
        expect(clicks[0]?.args).not.toHaveProperty("force_synthetic");
        for (const click of clicks.slice(1)) expect(click.args?.force_synthetic).toBe(true);
        expect(clicks[1]?.args).toMatchObject({ modifier: ["shift"] });
        expect(clicks[2]?.args).toMatchObject({ count: 2 });
        expect(clicks[3]?.args).toMatchObject({ count: 3 });
        expect(clicks[4]?.args).toMatchObject({ button: "right" });
      }),
  );

  it.effect.each([0, 33, null])(
    "keeps plain clicks synthetic for older or unknown native revision %s",
    (nativeRevision) =>
      Effect.gen(function* () {
        const f = yield* fixture({ nativeRevision });
        yield* observe(f);
        yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"));
        expect(lastCall(f, "click")?.args).toMatchObject({ force_synthetic: true });
      }),
  );

  it.effect("carries safe actuator diagnostics for uncertain clicks without replaying", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      f.onTool("click", () => ({
        isError: true,
        structuredContent: {
          diagnostics: {
            delivery_path: "ax",
            actuator: "ax_press",
            error_code: "ax_dispatch_failed",
            ax_error: -25202,
            message: "private focused content",
            text: "private typed text",
          },
        },
      }));
      const failure = yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"));
      expect(failure).toBeInstanceOf(CuaActionError);
      expect(failure).toMatchObject({
        code: "cua_action_failed",
        effect: "dispatched-unknown",
        diagnostics: {
          delivery_path: "ax",
          actuator: "ax_press",
          error_code: "ax_dispatch_failed",
          ax_error: -25202,
        },
      });
      const diagnostics = "diagnostics" in failure ? failure.diagnostics : undefined;
      expect(Object.values(diagnostics ?? {}).join(" ")).not.toContain("private");
      expect(callsNamed(f, "click")).toHaveLength(1);
    }),
  );

  it.effect(
    "preserves an explicit not-dispatched error and retains usable observation geometry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* observe(f);
        f.onTool("click", () => ({
          isError: true,
          structuredContent: {
            effect: "not-dispatched",
            code: "ax_action_refused",
            diagnostics: { error_code: "ax_action_refused", delivery_path: "ax" },
          },
        }));
        expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "ax_action_refused",
        });
        f.onTool("click", () => ({ structuredContent: { effect: "unverifiable" } }));
        // Nothing was sent, so a corrected target may use the same observation.
        expect(yield* run(f.backend.click({ x: -270, y: 30 }, "cua:10:20"))).toMatchObject({
          effect: "dispatched-unknown",
        });
        expect(callsNamed(f, "click")).toHaveLength(2);
      }),
  );

  it.effect.each(["dispatched-unknown", "unverifiable", "confirmed"])(
    "never downgrades explicit %s input to a legacy status refusal",
    (effect) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.onTool("press_key", () => ({
          isError: true,
          structuredContent: { effect, status: "refused", code: "ax_action_refused" },
        }));
        expect(yield* fails(f.backend.pressKey("enter", "cua:10:20"))).toMatchObject({
          effect: "dispatched-unknown",
        });
        expect(callsNamed(f, "press_key")).toHaveLength(1);
      }),
  );

  it.effect("keeps explicitly approved foreground text on the native foreground tool", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(withDesktopDeliveryMode("foreground", f.backend.typeText("abc", "cua:10:20")));
      expect(f.calls.find((call) => isTyping(call.name))).toMatchObject({
        name: "type_text",
        args: { delivery_mode: "foreground", force_synthetic: true },
      });
    }),
  );

  it.effect("sends background hotkey by default and keeps approved foreground hotkey", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.hotkey(["meta", "a"], "cua:10:20"));
      expect(lastCall(f, "hotkey")?.args).toMatchObject({
        delivery_mode: "background",
        keys: ["command", "a"],
      });
      f.calls.length = 0;
      yield* run(
        withDesktopDeliveryMode("foreground", f.backend.hotkey(["meta", "a"], "cua:10:20")),
      );
      expect(lastCall(f, "hotkey")?.args).toMatchObject({
        delivery_mode: "foreground",
        keys: ["command", "a"],
      });
    }),
  );

  it.effect("keeps moveCursor as background overlay-only and unverifiable", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* run(
        withDesktopDeliveryMode("background", f.backend.moveCursor({ x: 10, y: 20 }, "cua:10:20")),
      );
      expect(result).toMatchObject({
        point: { x: 10, y: 20 },
        deliveryPath: "cua-overlay-only",
        verified: "unverifiable",
      });
      expect(lastCall(f, "move_cursor")?.args).toEqual({ x: 10, y: 20 });
    }),
  );

  it.effect("launches by name or bundle id without a delivery mode", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* run(f.backend.launchApp("Calculator", []))).toMatchObject({
        app: "Calculator",
        window: null,
      });
      expect(lastCall(f, "launch_app")?.args).toEqual({ name: "Calculator" });
      // The launch goes through the driver's background `launch_app` only —
      // never an activation tool that would make the app frontmost.
      expect(
        f.calls.filter((call) => call.name === "bring_to_front" || call.name === "activate"),
      ).toHaveLength(0);
      f.calls.length = 0;
      expect(
        yield* run(f.backend.launchApp("com.apple.Calculator", ["--new-window"])),
      ).toMatchObject({ app: "com.apple.Calculator", window: null });
      expect(lastCall(f, "launch_app")?.args).toEqual({
        bundle_id: "com.apple.Calculator",
        additional_arguments: ["--new-window"],
      });
      expect(yield* fails(f.backend.launchApp("/Applications/Calculator.app", []))).toMatchObject({
        effect: "not-dispatched",
        code: "unsupported_operation",
      });
    }),
  );

  it.effect(
    "preserves native launch readiness failures instead of polling a hidden window again",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.onTool("launch_app", () => ({
          structuredContent: {
            pid: 321,
            window_status: "no_usable_window",
            window_reason: "hidden",
          },
        }));
        expect(yield* run(f.backend.launchApp("TextEdit", []))).toMatchObject({
          pid: 321,
          window: null,
          windowStatus: "no_usable_window",
          windowReason: "hidden",
        });
      }),
  );

  it.effect("pauses after focus restoration failure without laundering uncertain delivery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("press_key", () => ({
        isError: true,
        structuredContent: {
          effect: "unverifiable",
          code: "focus_restore_failed",
          diagnostics: {
            focus_mutation: "without_raise",
            restore_status: "unobservable",
            error_code: "focus_restore_failed",
          },
        },
      }));
      expect(yield* fails(f.backend.pressKey("enter", "cua:10:20"))).toMatchObject({
        code: "focus_restore_failed",
        effect: "dispatched-unknown",
        inputPause: { windowId: "cua:10:20", pid: 10 },
        diagnostics: { restore_status: "unobservable" },
      });
      expect(callsNamed(f, "press_key")).toHaveLength(1);
    }),
  );

  it.effect("preserves bounded cooldown hints and scopes native pause recovery to the app", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("press_key", () => ({
        isError: true,
        structuredContent: {
          effect: "refused",
          code: "computer_input_paused",
          layer: "driver-host",
          wait_seconds: 0.75,
        },
      }));
      expect(yield* fails(f.backend.pressKey("enter", "cua:10:20"))).toMatchObject({
        code: "computer_input_paused",
        waitSeconds: 0.75,
        inputPause: { windowId: "cua:10:20", pid: 10 },
        effect: "not-dispatched",
      });
    }),
  );

  it.effect("preserves the launched process identity without claiming window readiness", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("launch_app", () => ({
        structuredContent: {
          pid: 10,
          launch_state: { process_running: true, window_ready: false },
        },
      }));
      expect(yield* run(f.backend.launchApp("com.apple.Calculator", []))).toMatchObject({
        pid: 10,
        window: null,
        windowStatus: "not_checked",
      });
    }),
  );

  it.effect("uses the Linux launch schema after discovering a remote host's platform", () =>
    Effect.gen(function* () {
      const request = vi.fn(async (_endpoint: string, _request: unknown) => ({
        ok: true,
        hostPlatform: "linux",
        driverNativeRevision: 0,
        result: { structuredContent: {} },
      }));
      const backend = yield* bareBackend(request);
      yield* run(
        backend.launchApp("/usr/bin/gnome-calculator", ["--mode=basic"], { hidden: false }),
      );
      expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "probe" });
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
        name: "launch_app",
        args: {
          launch_path: "/usr/bin/gnome-calculator",
          additional_arguments: ["--mode=basic"],
        },
      });
      yield* run(backend.launchApp("org.gnome.Calculator.desktop", [], { hidden: false }));
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
        name: "launch_app",
        args: { name: "org.gnome.Calculator.desktop" },
      });
      expect(
        (request.mock.calls.at(-1)![1] as { args: Record<string, unknown> }).args,
      ).not.toHaveProperty("hidden");
      expect(
        request.mock.calls.filter(([, call]) => (call as { method: string }).method === "probe"),
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "refuses unsupported Linux hidden launches and ambiguous executable paths before dispatch",
    () =>
      Effect.gen(function* () {
        const request = vi.fn(async (_endpoint: string, _request: unknown) => ({
          ok: true,
          hostPlatform: "linux",
          driverNativeRevision: 0,
        }));
        const backend = yield* bareBackend(request);
        for (const options of [undefined, { hidden: true }]) {
          expect(
            yield* fails(backend.launchApp("org.gnome.Calculator", [], options)),
          ).toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
        }
        expect(
          yield* fails(backend.launchApp("/opt/My App/bin/calculator", [], { hidden: false })),
        ).toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "probe" });
      }),
  );

  it.effect("lists apps with pid, name, bundle id, running and active state", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("list_apps", () => ({
        structuredContent: {
          apps: [
            {
              pid: 42,
              name: "TextEdit",
              bundle_id: "com.apple.TextEdit",
              active: true,
              running: true,
              launch_path: "/System/Applications/TextEdit.app",
              windows: [{}, {}],
              last_used: "2026-09-17T00:00:00Z",
            },
            { pid: 43, name: "NoBundle", active: false, running: true },
            // Installed but not running: pid 0 is the "is X installed?" row the
            // tool exists for, so it must survive rather than be filtered out.
            {
              pid: 0,
              name: "Chess",
              bundle_id: "com.apple.Chess",
              running: false,
              active: false,
              launch_path: "/System/Applications/Chess.app",
            },
            { pid: -1, name: "bogus" },
            { pid: 44 },
          ],
        },
      }));
      expect(yield* run(f.backend.listApps())).toEqual([
        {
          pid: 42,
          name: "TextEdit",
          bundleId: "com.apple.TextEdit",
          active: true,
          running: true,
          launchPath: "/System/Applications/TextEdit.app",
          windowCount: 2,
          lastUsed: "2026-09-17T00:00:00Z",
        },
        { pid: 43, name: "NoBundle", active: false, running: true },
        {
          pid: 0,
          name: "Chess",
          bundleId: "com.apple.Chess",
          running: false,
          active: false,
          launchPath: "/System/Applications/Chess.app",
        },
      ]);
    }),
  );

  it.effect("verifies a moved window through an independent list_windows readback", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // The driver claims the move landed — but Pathway only reports verified
      // once its own list_windows re-read shows the requested frame.
      f.onTool("set_window_frame", (args) => {
        f.setBounds({
          x: Number(args.x),
          y: Number(args.y),
          width: Number(args.width),
          height: Number(args.height),
        });
        return {
          structuredContent: {
            effect: "confirmed",
            route: "ax_window_frame",
            delivery: { mode: "background" },
            evidence: [{ kind: "value_readback" }],
          },
        };
      });
      const frame = { x: 0, y: 0, width: 640, height: 480 };
      expect(yield* run(f.backend.setWindowFrame("cua:10:20", frame))).toMatchObject({
        windowId: "cua:10:20",
        verified: "confirmed",
        effect: "verified",
      });
      expect(lastCall(f, "set_window_frame")?.args).toEqual({ pid: 10, window_id: 20, ...frame });
      // The driver reports its own readback confirmed, but the independent
      // window list disagrees — the mutation is reported unknown, never
      // silently promoted to verified on the driver's word alone.
      f.setBounds({ x: -300, y: 20, width: 200, height: 100 });
      f.onTool("set_window_frame", () => ({
        structuredContent: {
          effect: "confirmed",
          route: "ax_window_frame",
          evidence: [{ kind: "value_readback" }],
        },
      }));
      expect(yield* run(f.backend.setWindowFrame("cua:10:20", frame))).toMatchObject({
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });
    }),
  );

  it.effect("invokes a menu path and preserves the status-coded refusal dialect", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("invoke_menu", () => ({
        structuredContent: {
          effect: "unverifiable",
          route: "ax_action",
          delivery: { mode: "foreground" },
        },
      }));
      expect(
        yield* run(f.backend.invokeMenu({ windowId: "cua:10:20" }, ["File", "Save"])),
      ).toMatchObject({
        windowId: "cua:10:20",
        verified: "unverifiable",
        effect: "dispatched-unknown",
      });
      expect(lastCall(f, "invoke_menu")?.args).toEqual({
        pid: 10,
        window_id: 20,
        path: ["File", "Save"],
      });
      f.onTool("invoke_menu", () => ({
        isError: true,
        structuredContent: {
          status: "refused",
          refusal: { code: "menu_path_unavailable", message: "The menu item is disabled." },
        },
        content: [{ type: "text", text: "The menu item is disabled." }],
      }));
      expect(
        yield* fails(f.backend.invokeMenu({ windowId: "cua:10:20" }, ["Edit", "Undo"])),
      ).toMatchObject({ effect: "not-dispatched", code: "menu_path_unavailable" });
    }),
  );

  it.effect("invokes the application-level menu on a windowless app with no window id", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("invoke_menu", () => ({
        structuredContent: {
          effect: "confirmed",
          route: "ax_menu_bar",
          delivery: { mode: "background" },
        },
      }));
      expect(yield* run(f.backend.invokeMenu({ pid: 44 }, ["File", "New Window"]))).toMatchObject({
        verified: "confirmed",
        effect: "verified",
      });
      // The driver's windowless contract: pid and path, and no window_id to
      // misread as an exact-window request.
      expect(lastCall(f, "invoke_menu")?.args).toEqual({ pid: 44, path: ["File", "New Window"] });
      // No window took part, so the result must not fabricate one.
      const result = yield* run(f.backend.invokeMenu({ pid: 44 }, ["File", "New Window"]));
      expect(result).not.toHaveProperty("windowId");
      // The pid form fails closed on a malformed pid before any dispatch.
      expect(yield* fails(f.backend.invokeMenu({ pid: 0 }, ["File"]))).toMatchObject({
        code: "invalid_arguments",
      });
    }),
  );

  it.effect("verifies window state from the driver's per-predicate outcome", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const predicates = [
        { index: 0, status: "satisfied", unknown_reason: null, observed_json: "{}" },
      ];
      f.onTool("verify_state", () => ({
        structuredContent: { status: "satisfied", stable: true, samples: 2, predicates },
      }));
      expect(
        yield* run(
          f.backend.verifyState("cua:10:20", [
            { element: { selector: { role: "AXButton" }, exists: true } },
          ]),
        ),
      ).toEqual({ status: "satisfied", stable: true, samples: 2, elapsedMs: 0, predicates });
      expect(lastCall(f, "verify_state")?.args).toEqual({
        pid: 10,
        window_id: 20,
        expect: [{ element: { selector: { role: "AXButton" }, exists: true } }],
      });
      f.onTool("verify_state", () => ({
        structuredContent: {
          status: "unsatisfied",
          stable: true,
          samples: 1,
          predicates: [
            { index: 0, status: "unsatisfied", unknown_reason: null, observed_json: "{}" },
          ],
        },
      }));
      expect(
        yield* run(f.backend.verifyState("cua:10:20", [{ window: { bounds: { x: 0 } } }])),
      ).toMatchObject({ status: "unsatisfied", stable: true });
      // An unparseable status is "unknown", never collapsed to unsatisfied.
      f.onTool("verify_state", () => ({ structuredContent: { status: "weird" } }));
      expect(
        yield* run(f.backend.verifyState("cua:10:20", [{ window: { bounds: { x: 0 } } }])),
      ).toMatchObject({ status: "unknown" });
    }),
  );

  it.effect("captures a zoom region in window-local points scaled to pixels", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("zoom", () => ({
        structuredContent: { width: 168, height: 140, mime_type: "image/jpeg" },
        content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }],
      }));
      const zoom = yield* run(
        f.backend.zoomWindow("cua:10:20", { x: 10, y: 20, width: 50, height: 50 }),
      );
      expect(zoom).toMatchObject({
        mimeType: "image/jpeg",
        width: 168,
        height: 140,
        windowId: "cua:10:20",
        bytesBase64: "/9j/4AAQ",
      });
      // scale_factor 2 in the fixture: window-local points become screenshot px.
      expect(lastCall(f, "zoom")?.args).toEqual({
        pid: 10,
        window_id: 20,
        x1: 20,
        y1: 40,
        x2: 120,
        y2: 140,
      });
      expect(
        yield* fails(f.backend.zoomWindow("cua:10:20", { x: 150, y: 0, width: 100, height: 50 })),
      ).toMatchObject({ effect: "not-dispatched", code: "invalid_geometry" });
    }),
  );

  it.effect("reports a killed app verified only once it leaves the app list", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let apps: Array<Record<string, unknown>> = [
        { pid: 10, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true },
      ];
      f.onTool("list_apps", () => ({ structuredContent: { apps } }));
      f.onTool("kill_app", () => {
        apps = [];
        return { content: [{ type: "text", text: "Sent SIGKILL to pid 10." }] };
      });
      expect(yield* run(f.backend.killApp(10))).toMatchObject({
        verified: "confirmed",
        effect: "verified",
      });
      expect(lastCall(f, "kill_app")?.args).toEqual({ pid: 10 });
      f.onTool("kill_app", () => ({
        content: [{ type: "text", text: "Sent SIGKILL to pid 10." }],
      }));
      apps = [{ pid: 10, name: "TextEdit", active: true }];
      expect(yield* run(f.backend.killApp(10))).toMatchObject({
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });
    }),
  );

  it.effect("sends the hidden launch flag only when the caller asks for it", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.launchApp("TextEdit", [], { hidden: true }));
      expect(lastCall(f, "launch_app")?.args).toEqual({ name: "TextEdit", hidden: true });
      f.calls.length = 0;
      // Absent or false is the ordinary background launch — no flag on the wire.
      yield* run(f.backend.launchApp("TextEdit", [], { hidden: false }));
      expect(lastCall(f, "launch_app")?.args).toEqual({ name: "TextEdit" });
      f.calls.length = 0;
      yield* run(f.backend.launchApp("TextEdit", []));
      expect(lastCall(f, "launch_app")?.args).toEqual({ name: "TextEdit" });
    }),
  );

  it.effect("minimizes the exact window and trusts only the driver's readback evidence", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("set_window_minimized", () => ({
        structuredContent: {
          effect: "confirmed",
          route: "ax_window_minimized",
          delivery: { mode: "background" },
          evidence: [{ kind: "value_readback" }],
        },
      }));
      expect(yield* run(f.backend.setWindowMinimized("cua:10:20", true))).toMatchObject({
        windowId: "cua:10:20",
        verified: "confirmed",
        effect: "verified",
      });
      expect(lastCall(f, "set_window_minimized")?.args).toEqual({
        pid: 10,
        window_id: 20,
        minimized: true,
      });
      // The same bare confirmed claim without the readback row is not evidence.
      f.onTool("set_window_minimized", () => ({
        structuredContent: { effect: "confirmed", route: "ax_window_minimized" },
      }));
      expect(yield* run(f.backend.setWindowMinimized("cua:10:20", true))).toMatchObject({
        verified: "unverifiable",
        effect: "dispatched-unknown",
      });
      f.onTool("set_window_minimized", () => ({ structuredContent: { effect: "unconfirmed" } }));
      expect(yield* run(f.backend.setWindowMinimized("cua:10:20", false))).toMatchObject({
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });
    }),
  );

  it.effect("hides and unhides an app by pid on the driver's own readback", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("set_app_visibility", () => ({
        structuredContent: {
          effect: "confirmed",
          route: "ax_app_visibility",
          delivery: { mode: "background" },
          evidence: [{ kind: "value_readback" }],
        },
      }));
      expect(yield* run(f.backend.setAppVisibility(10, true))).toMatchObject({
        verified: "confirmed",
        effect: "verified",
      });
      expect(lastCall(f, "set_app_visibility")?.args).toEqual({ pid: 10, hidden: true });
      f.onTool("set_app_visibility", () => ({ structuredContent: { effect: "suspected_noop" } }));
      expect(yield* run(f.backend.setAppVisibility(10, false))).toMatchObject({
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });
      // A target that is not a live pid, or a flag that is not a boolean, fails
      // closed before the driver is ever asked.
      expect(yield* fails(f.backend.setAppVisibility(0, true))).toMatchObject({
        effect: "not-dispatched",
        code: "invalid_arguments",
      });
      expect(
        yield* fails(f.backend.setAppVisibility(10, "yes" as unknown as boolean)),
      ).toMatchObject({ effect: "not-dispatched", code: "invalid_arguments" });
      expect(callsNamed(f, "set_app_visibility")).toHaveLength(2);
    }),
  );

  it.effect("reads the desktop inventory and scopes it to the scoped window's app", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("get_accessibility_tree", () => ({
        structuredContent: {
          apps: [
            { pid: 10, name: "TextEdit", bundle_id: "com.apple.TextEdit" },
            { pid: 20, name: "Finder" },
            { pid: -3, name: "bogus" },
            { pid: 30 },
          ],
          windows: [
            {
              window_id: 20,
              pid: 10,
              app_name: "TextEdit",
              title: "Untitled",
              bounds: { x: -300, y: 20, width: 200, height: 100 },
              is_on_screen: true,
              z_index: 0,
            },
            { window_id: 21, pid: 10, app_name: "TextEdit", title: "Second", is_on_screen: false },
            { window_id: 40, pid: 20, app_name: "Finder", title: "" },
            { window_id: 0, pid: 10, title: "bogus" },
          ],
        },
      }));
      const untitled = {
        id: "cua:10:20",
        pid: 10,
        appName: "TextEdit",
        title: "Untitled",
        bounds: { x: -300, y: 20, width: 200, height: 100 },
        onScreen: true,
        zIndex: 0,
      };
      const second = {
        id: "cua:10:21",
        pid: 10,
        appName: "TextEdit",
        title: "Second",
        onScreen: false,
      };
      expect(yield* run(f.backend.getAccessibilityTree())).toEqual({
        apps: [
          { pid: 10, name: "TextEdit", bundleId: "com.apple.TextEdit" },
          { pid: 20, name: "Finder" },
        ],
        windows: [untitled, second, { id: "cua:20:40", pid: 20, appName: "Finder", title: "" }],
        truncated: false,
      });
      // The driver call is argument-free: window scoping is Pathway-side, to the
      // app that owns the exact window resolved through list_windows.
      expect(yield* run(f.backend.getAccessibilityTree("cua:10:20"))).toEqual({
        apps: [{ pid: 10, name: "TextEdit", bundleId: "com.apple.TextEdit" }],
        windows: [untitled, second],
        truncated: false,
      });
      expect(f.calls.find((call) => call.name === "get_accessibility_tree")?.args).toEqual({});
    }),
  );

  it.effect("caps the inventory rows and refuses a malformed snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const manyWindows = Array.from({ length: 600 }, (_, i) => ({
        window_id: i + 1,
        pid: 10,
        app_name: "TextEdit",
        title: `w${i}`,
      }));
      f.onTool("get_accessibility_tree", () => ({
        structuredContent: { apps: [{ pid: 10, name: "TextEdit" }], windows: manyWindows },
      }));
      const capped = yield* run(f.backend.getAccessibilityTree());
      expect(capped.windows).toHaveLength(512);
      expect(capped.truncated).toBe(true);
      // A snapshot without the row arrays is a malformed driver response, not an
      // empty desktop — fail closed rather than report nothing.
      f.onTool("get_accessibility_tree", () => ({ structuredContent: { windows: [] } }));
      expect(yield* fails(f.backend.getAccessibilityTree())).toMatchObject({
        effect: "not-dispatched",
        code: "invalid_response",
      });
      // A scoped read for a dead window refuses before the driver is asked.
      f.onTool("get_accessibility_tree", () => ({ structuredContent: { apps: [], windows: [] } }));
      expect(yield* fails(f.backend.getAccessibilityTree("cua:999:1"))).toMatchObject({
        effect: "not-dispatched",
        code: "stale_target",
      });
    }),
  );

  it.effect("reads the cursor position in desktop points and reports window containment", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("get_cursor_position", () => ({ structuredContent: { x: -200, y: 60 } }));
      expect(yield* run(f.backend.getCursorPosition())).toEqual({
        x: -200,
        y: 60,
        capturedAt: expect.any(String),
      });
      // The fixture window spans x -300..-100, y 20..120: (-200, 60) is inside.
      expect(yield* run(f.backend.getCursorPosition("cua:10:20"))).toMatchObject({
        x: -200,
        y: 60,
        windowId: "cua:10:20",
        insideWindow: true,
      });
      f.onTool("get_cursor_position", () => ({ structuredContent: { x: 50, y: 60 } }));
      expect(yield* run(f.backend.getCursorPosition("cua:10:20"))).toMatchObject({
        insideWindow: false,
      });
      f.onTool("get_cursor_position", () => ({ structuredContent: { x: "left", y: 60 } }));
      expect(yield* fails(f.backend.getCursorPosition())).toMatchObject({
        effect: "not-dispatched",
        code: "invalid_response",
      });
      expect(f.calls.find((call) => call.name === "get_cursor_position")?.args).toEqual({});
    }),
  );

  it.effect("reads the published action route and requires public verification evidence", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.actionResult({
        route: "accessibility",
        delivery: { mode: "background" },
        effect: "confirmed",
      });
      expect(yield* run(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "dispatched-unknown",
        deliveryPath: "cua-accessibility-background",
      });
      f.actionResult({
        route: "accessibility",
        delivery: { mode: "background" },
        effect: "confirmed",
        evidence: [{ kind: "value_readback" }],
      });
      expect(yield* run(f.backend.typeText("def", "cua:10:20"))).toMatchObject({
        effect: "verified",
        verified: "confirmed",
      });
    }),
  );

  it.effect("preserves public action refusals even without the outer error flag", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.actionResult({ route: "accessibility", effect: "refused" });
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
      });
      expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
    }),
  );

  it.effect(
    "preserves status refusals and gives a semantic recovery route for keyboard ambiguity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.onTool("press_key", () => ({
          structuredContent: {
            status: "refused",
            refusal: { code: "same_pid_keyboard_ambiguity" },
          },
        }));
        const failure = yield* fails(f.backend.pressKey("enter", "cua:10:20"));
        expect(failure).toMatchObject({
          effect: "not-dispatched",
          code: "same_pid_keyboard_ambiguity",
        });
        expect(failure.message).toContain("computer_type_text with an observed ref");
        expect(failure.message).toContain("do not send keydown/keyup");
        expect(callsNamed(f, "press_key")).toHaveLength(1);
      }),
  );

  it.effect("encodes missing grants with the public permission schema", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.denyPermissions();
      const availability = yield* run(f.backend.availability());
      expect(yield* decodeAvailability(availability)).toMatchObject({
        kind: "permission-required",
        missing: ["accessibility", "screenRecording"],
      });
    }),
  );

  it.effect("ignores non-actionable zero-area windows", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* run(f.backend.listWindows())).toHaveLength(1);
    }),
  );

  it.effect("reports minimized and hidden workspace windows honestly", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const rect = { x: 10, y: 10, width: 200, height: 100 };
      f.setWindows([
        {
          pid: 10,
          window_id: 21,
          title: "Minimized",
          bounds: rect,
          is_on_screen: false,
          on_current_space: true,
          space_ids: [3],
          z_index: 2,
        },
        {
          pid: 11,
          window_id: 22,
          title: "Hidden app window",
          bounds: rect,
          is_on_screen: false,
          on_current_space: null,
          space_ids: null,
          z_index: 3,
        },
      ]);
      const windows = yield* run(f.backend.listWindows());
      const byId = new Map(windows.map((w) => [w.id, w]));
      // Minimized: off the screen list but still claimed by its Space.
      expect(byId.get("cua:10:21")).toMatchObject({ minimized: true, visible: false });
      // Hidden-app windows are detached from every Space — not minimized, but
      // still listed so the hidden workspace remains targetable.
      expect(byId.get("cua:11:22")).toMatchObject({ minimized: false, visible: false });
    }),
  );

  it.effect(
    "preserves observed Space membership without inventing missing or unsafe identifiers",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const base = {
          pid: 10,
          bounds: { x: 10, y: 10, width: 200, height: 100 },
          is_on_screen: false,
        };
        f.setWindows([
          {
            ...base,
            window_id: 21,
            space_ids: [3, 8],
            current_space_id: 8,
            on_current_space: true,
          },
          { ...base, window_id: 22, space_ids: [3], current_space_id: 8, on_current_space: false },
          {
            ...base,
            window_id: 23,
            space_ids: null,
            current_space_id: null,
            on_current_space: null,
          },
          {
            ...base,
            window_id: 24,
            space_ids: [3, Number.MAX_SAFE_INTEGER + 1],
            current_space_id: 0,
          },
          { ...base, window_id: 25, space_ids: [], current_space_id: 8, on_current_space: false },
        ]);
        const byId = new Map(
          (yield* run(f.backend.listWindows())).map((window) => [window.id, window]),
        );
        expect(byId.get("cua:10:21")).toMatchObject({
          spaceIds: [3, 8],
          currentSpaceId: 8,
          onCurrentSpace: true,
        });
        expect(byId.get("cua:10:22")).toMatchObject({
          spaceIds: [3],
          currentSpaceId: 8,
          onCurrentSpace: false,
        });
        for (const window of [byId.get("cua:10:23"), byId.get("cua:10:24")]) {
          expect(window).not.toHaveProperty("spaceIds");
          expect(window).not.toHaveProperty("currentSpaceId");
          expect(window).not.toHaveProperty("onCurrentSpace");
        }
        expect(byId.get("cua:10:25")).toMatchObject({
          spaceIds: [],
          currentSpaceId: 8,
          onCurrentSpace: false,
        });
      }),
  );

  it.effect("distinguishes a native admission refusal from an uncertain delivery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.refuse();
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "same_pid_keyboard_ambiguity",
      });
      expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
    }),
  );

  it.effect("translates DOM key names without turning Delete into Backspace", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.pressKey("Delete", "cua:10:20"));
      yield* run(f.backend.hotkey(["meta", "arrowleft"], "cua:10:20"));
      expect(lastCall(f, "press_key")?.args).toMatchObject({ key: "forward_delete" });
      expect(lastCall(f, "hotkey")?.args).toMatchObject({ keys: ["command", "left"] });
      // Synara throws synchronously here; the port fails the effect instead.
      expect((yield* fails(f.backend.hotkey(["meta", "a", "s"], "cua:10:20"))).message).toContain(
        "exactly one",
      );
    }),
  );

  it.effect("maps xdotool-style key spellings onto driver keynames", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const mapped: Array<readonly [string, string]> = [
        ["Page_Up", "pageup"],
        ["Prior", "pageup"],
        ["pgup", "pageup"],
        ["Page_Down", "pagedown"],
        ["Next", "pagedown"],
        ["pgdn", "pagedown"],
        ["Caps_Lock", "capslock"],
        ["Super_L", "command"],
        ["Win", "command"],
        ["Shift_L", "shift"],
        ["Control_L", "ctrl"],
        ["Alt_L", "alt"],
        ["Option_L", "alt"],
      ];
      for (const [name, driver] of mapped) {
        f.calls.length = 0;
        yield* run(f.backend.pressKey(name, "cua:10:20"));
        expect(lastCall(f, "press_key")?.args).toMatchObject({ key: driver });
      }
      // Names the pinned keymap lacks pass through untouched so the driver's own
      // "Unknown key name" refusal stays the gate until the keymap revision
      // lands them (native-keymap.diff: kp_*, f13-f20, menu, help).
      for (const name of ["kp_5", "KP_Enter", "F13", "Menu", "Help", "Shift_R"]) {
        f.calls.length = 0;
        yield* run(f.backend.pressKey(name, "cua:10:20"));
        expect(lastCall(f, "press_key")?.args).toMatchObject({ key: name.toLowerCase() });
      }
      f.calls.length = 0;
      yield* run(f.backend.hotkey(["meta", "Page_Up"], "cua:10:20"));
      expect(lastCall(f, "hotkey")?.args).toMatchObject({ keys: ["command", "pageup"] });
      f.calls.length = 0;
      yield* run(f.backend.hotkey(["Control_L", "c"], "cua:10:20"));
      expect(lastCall(f, "hotkey")?.args).toMatchObject({ keys: ["ctrl", "c"] });
    }),
  );

  it.effect("refuses Insert spellings and still refuses modifier-only chords", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const name of ["insert", "Insert", "ins"])
        expect((yield* fails(f.backend.pressKey(name, "cua:10:20"))).message).toContain(
          "no Insert key mapping",
        );
      expect((yield* fails(f.backend.hotkey(["meta", "ins"], "cua:10:20"))).message).toContain(
        "no Insert key mapping",
      );
      // A chord of nothing but modifiers still has no base key, whether the
      // modifier arrives under a driver or a left-side spelling.
      expect((yield* fails(f.backend.hotkey(["meta", "shift"], "cua:10:20"))).message).toContain(
        "exactly one",
      );
      expect((yield* fails(f.backend.hotkey(["meta", "shift_l"], "cua:10:20"))).message).toContain(
        "exactly one",
      );
      expect(f.calls.filter((c) => c.name === "press_key" || c.name === "hotkey")).toHaveLength(0);
    }),
  );

  it.effect("converts pixel deltas to one bounded wheel operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      const result = yield* run(f.backend.scroll({ x: -275, y: 30 }, 0, 250, "cua:10:20"));
      expect(result.scrollDelta).toEqual({ deltaX: 0, deltaY: 240 });
      expect(callsNamed(f, "scroll")).toHaveLength(1);
      expect(lastCall(f, "scroll")?.args).toMatchObject({
        delta_x: 0,
        delta_y: -2,
        direction: "down",
      });
    }),
  );

  it.effect("carries both axes and modifiers in one wheel gesture", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      const result = yield* run(
        f.backend.scroll({ x: -275, y: 30 }, -140, 250, "cua:10:20", ["meta", "shift"]),
      );
      expect(result.scrollDelta).toEqual({ deltaX: -120, deltaY: 240 });
      expect(callsNamed(f, "scroll")).toHaveLength(1);
      expect(lastCall(f, "scroll")?.args).toMatchObject({
        delta_x: 1,
        delta_y: -2,
        direction: "down",
        modifiers: ["command", "shift"],
      });
    }),
  );

  it.effect("refuses a single axis beyond the 50-notch bound before dispatch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      expect(
        yield* fails(f.backend.scroll({ x: -275, y: 30 }, 0, 61 * 120, "cua:10:20")),
      ).toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
      expect(
        yield* fails(f.backend.scroll({ x: -275, y: 30 }, 61 * 120, 0, "cua:10:20")),
      ).toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
      expect(callsNamed(f, "scroll")).toHaveLength(0);
    }),
  );

  it.effect("prefers the AX scroll-bar route for an unmodified vertical element scroll", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXScrollArea",
          label: "Content",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "scroll-token",
        },
      ]);
      const target = yield* exactTarget(f, "Content");
      // The point path is geometry-gated: a wheel scroll at a point still needs
      // a fresh observation of the window it lands in.
      yield* observe(f);
      yield* run(f.backend.scroll(target.point, 0, 250, "cua:10:20", undefined, target));
      expect(lastCall(f, "scroll")?.args).toMatchObject({
        element_token: "scroll-token",
        direction: "down",
        amount: 2,
        by: "line",
      });
      // A horizontal or modified request cannot ride the vertical AX rung.
      yield* run(f.backend.scroll(target.point, -140, 250, "cua:10:20", undefined, target));
      expect(callsNamed(f, "scroll")[1]?.args).toMatchObject({ delta_x: 1, delta_y: -2 });
      expect(callsNamed(f, "scroll")[1]?.args).not.toHaveProperty("element_token");
    }),
  );

  it.effect("coalesces physical state across concurrent thread projections", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(
        Effect.all(
          Array.from({ length: 12 }, () =>
            Effect.all(
              [f.backend.availability(), f.backend.listWindows(), f.backend.getScreenSize()],
              { concurrency: "unbounded" },
            ),
          ),
          { concurrency: "unbounded" },
        ),
      );
      expect(f.calls.map((c) => c.name)).toEqual([
        "check_permissions",
        "list_windows",
        "get_screen_size",
      ]);
    }),
  );

  it.effect("does not replay identical text when native readback is unverifiable", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.availability());
      yield* run(f.backend.focusWindow("cua:10:20"));
      expect(yield* run(f.backend.typeText("abc"))).toMatchObject({ verified: "unverifiable" });
      expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
      expect(f.calls.find((c) => isTyping(c.name))?.args).toMatchObject({
        delivery_mode: "background",
        text: "abc",
        pid: 10,
        window_id: 20,
      });
    }),
  );

  it.effect("preserves unknown dispatch on transport timeout without retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.availability());
      f.fail(new CuaTransportError("timeout", "dispatched-unknown"));
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "dispatched-unknown",
      });
      expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
    }),
  );

  it.effect("maps negative desktop coordinates using the captured geometry and scale", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.availability());
      expect(yield* observe(f)).toMatchObject({
        width: 400,
        height: 200,
        scale: 2,
        region: { x: -300, y: 20 },
      });
      yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"));
      expect(lastCall(f, "click")?.args).toMatchObject({
        x: 25,
        y: 10,
        coordinate_space: "window_points",
        expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
      });
    }),
  );

  it.effect("refuses a moved or closed window without injecting", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.availability());
      yield* observe(f);
      f.move();
      expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "stale_geometry",
      });
      f.close();
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "stale_target",
      });
      expect(f.calls.filter((c) => c.name === "click" || isTyping(c.name))).toHaveLength(0);
    }),
  );

  it.effect("sends an exact-target background drag as window-local points", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      yield* run(f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"));
      expect(callsNamed(f, "drag")).toEqual([
        expect.objectContaining({
          args: {
            pid: 10,
            window_id: 20,
            delivery_mode: "background",
            from_x: 25,
            from_y: 10,
            to_x: 75,
            to_y: 30,
            coordinate_space: "window_points",
            duration_ms: 500,
            expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
          },
        }),
      ]);
    }),
  );

  it.effect("refuses a background drag when no fresh observation grounds the frame", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // No captureScreenshot: the backend has no observed geometry to convert
      // screen points against, so the drag refuses rather than guess a frame.
      expect(
        yield* fails(f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20")),
      ).toMatchObject({ effect: "not-dispatched", code: "stale_geometry" });
      expect(callsNamed(f, "drag")).toHaveLength(0);
    }),
  );

  it.effect("refuses a background drag whose endpoint leaves the exact window", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      expect(
        yield* fails(f.backend.drag({ x: -275, y: 30 }, { x: -90, y: 50 }, 500, "cua:10:20")),
      ).toMatchObject({ effect: "not-dispatched" });
      expect(callsNamed(f, "drag")).toHaveLength(0);
    }),
  );

  it.effect("refuses a drag that names no exact window before reaching Cua", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* fails(f.backend.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 500))).toMatchObject({
        effect: "not-dispatched",
        code: "window_required",
      });
      expect(callsNamed(f, "drag")).toHaveLength(0);
    }),
  );

  it.effect("propagates the native background admission refusal without replay", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      // A driver that cannot admit the gesture (older builds report
      // `background_unavailable`; a stale target reports a WindowPointer refusal)
      // answers with a structured refusal. Pathway surfaces it as not-dispatched
      // and never replays — one native call, one rejection.
      f.onTool("drag", () => ({
        isError: true,
        structuredContent: {
          effect: "refused",
          code: "background_unavailable",
          pid: 10,
          window_id: 20,
        },
        content: [
          {
            type: "text",
            text: 'Background drag is unavailable on this driver; use delivery_mode:"foreground".',
          },
        ],
      }));
      expect(
        yield* fails(f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20")),
      ).toMatchObject({ effect: "not-dispatched", code: "background_unavailable" });
      expect(callsNamed(f, "drag")).toHaveLength(1);
    }),
  );

  it.effect("still sends a foreground drag as window-local points", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      yield* run(
        withDesktopDeliveryMode(
          "foreground",
          f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
        ),
      );
      expect(callsNamed(f, "drag")).toEqual([
        expect.objectContaining({
          args: expect.objectContaining({
            delivery_mode: "foreground",
            from_x: 25,
            from_y: 10,
            to_x: 75,
            to_y: 30,
          }),
        }),
      ]);
    }),
  );
});

describe("Cua hardening", () => {
  it.effect("reports a stable build signature on the backend and its availability", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(f.backend.buildSignature()).toBe("unknown");
      expect(f.backend.buildSignature()).toBe(f.backend.buildSignature());
      f.denyPermissions();
      const availability = yield* run(f.backend.availability());
      expect(availability.kind === "permission-required" && availability.buildSignature).toBe(
        "unknown",
      );
    }),
  );

  it.effect("pauses input while an auth sheet holds focus, keeping observation available", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.actionResult({
        effect: "refused",
        code: "auth_sheet_focused",
        message: "An authentication sheet has focus.",
      });
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "auth_sheet_focused",
        inputPause: { windowId: "cua:10:20" },
      });
      expect(yield* run(f.backend.getState({ windowId: "cua:10:20" }))).toMatchObject({
        computerId: "desktop",
      });
    }),
  );

  it.effect("flips health on capture failure without blocking input, and heals on refresh", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.captureWindow(21);
      expect(
        yield* fails(f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" })),
      ).toMatchObject({ effect: "not-dispatched" });
      expect(f.backend.health()).toMatchObject({
        status: "unavailable",
        captureAvailable: false,
      });
      expect(f.backend.health().consecutiveFailures).toBeGreaterThan(0);
      // Inputs keep working: health never gates dispatch.
      f.captureWindow(20);
      expect(yield* run(f.backend.typeText("abc", "cua:10:20"))).toBeDefined();
      // The next refresh re-reads the grants and heals.
      expect(yield* run(f.backend.availability())).toMatchObject({ kind: "available" });
      expect(f.backend.health()).toMatchObject({
        status: "connected",
        captureAvailable: true,
      });
    }),
  );

  it.effect("keeps capture health when a tree-only observation fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setElements([
        {
          role: "AXButton",
          label: "Equals",
          frame: { x: -290, y: 30, width: 20, height: 20 },
          element_token: "fresh-token",
        },
      ]);
      yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      expect(f.backend.health()).toMatchObject({ status: "connected", captureAvailable: true });
      // The observation answers a different window: a call-level failure past
      // the target, the same shape an AX walk timeout produces.
      f.captureWindow(999);
      // A tree-only read never asked for pixels: its failure is not a capture
      // failure and must not mark capture unavailable.
      expect(
        (yield* fails(f.backend.getState({ windowId: "cua:10:20", includeTree: true }))).message,
      ).toContain("belongs to a different window");
      expect(f.backend.health()).toMatchObject({
        status: "connected",
        captureAvailable: true,
        consecutiveFailures: 0,
      });
      // The same failure on a read that asked for pixels still flips health.
      expect(
        (yield* fails(
          f.backend.getState({
            windowId: "cua:10:20",
            includeTree: true,
            includeScreenshot: true,
          }),
        )).message,
      ).toContain("belongs to a different window");
      expect(f.backend.health()).toMatchObject({
        status: "unavailable",
        captureAvailable: false,
      });
    }),
  );

  it.effect(
    "returns a preview note instead of failing the observation on preview-only failure",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setElements([
          {
            role: "AXButton",
            label: "Equals",
            frame: { x: -290, y: 30, width: 20, height: 20 },
            element_token: "fresh-token",
            actions: ["AXPress"],
          },
        ]);
        f.invalidateCapture();
        const state = yield* run(
          f.backend.getState({
            windowId: "cua:10:20",
            includeTree: true,
            includeScreenshot: true,
          }),
        );
        expect(state.screenshot).toBeUndefined();
        expect(state.previewNote).toContain("Reselect the window to resume");
        expect(state.root?.children).toHaveLength(1);
        expect(yield* decodeState(state)).toMatchObject({
          previewNote: state.previewNote,
        });
        // Input is unaffected: targeting data survived the preview failure.
        expect(yield* run(f.backend.typeText("abc", "cua:10:20"))).toBeDefined();
        yield* f.backend.dispose();
      }),
  );

  it.effect(
    "pauses off-Space pixels instead of presenting freshness-unverified capture as live",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.markOffSpaceCaptureUnverified();
        const state = yield* run(
          f.backend.getState({
            windowId: "cua:10:20",
            includeTree: true,
            includeScreenshot: true,
          }),
        );
        expect(state.screenshot).toBeUndefined();
        expect(state.previewNote).toContain("another macOS Space");
        expect(f.backend.health()).toMatchObject({
          status: "connected",
          captureAvailable: true,
        });
        expect(
          yield* fails(f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" })),
        ).toMatchObject({
          code: "off_space_capture_unverified",
          effect: "not-dispatched",
        });
        expect(f.backend.health()).toMatchObject({
          status: "connected",
          captureAvailable: true,
        });
      }),
  );

  it.effect("clears window grounding when the owning task ends", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const task = { threadId: "thread", turnId: "turn" };
      yield* run(
        withComputerTask(
          task,
          f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
        ),
      );
      expect(
        yield* run(withComputerTask(task, f.backend.click({ x: -275, y: 30 }, "cua:10:20"))),
      ).toBeDefined();
      yield* run(f.backend.endTask("thread", "turn"));
      expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
        code: "stale_geometry",
      });
      yield* f.backend.dispose();
    }),
  );

  it.effect("degrades blind on a mid-task Screen Recording revoke without replaying input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // Grounded and driving before the revoke lands.
      yield* observe(f);
      expect(yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toBeDefined();
      const clicks = callsNamed(f, "click").length;

      // The revoke lands mid-task: the probe reports the grant missing...
      f.denyScreenRecording();
      expect(yield* run(f.backend.availability())).toMatchObject({
        kind: "permission-required",
        missing: ["screenRecording"],
      });
      // ...perception goes blind but stays available: no pixels, no failure, tree intact...
      const blind = yield* run(f.backend.getState({ includeScreenshot: true }));
      expect(blind.screenshot).toBeUndefined();
      expect(
        yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true })),
      ).toMatchObject({ computerId: "desktop" });
      expect(f.backend.health().captureAvailable).toBe(false);
      // ...and the desktop stays driveable: exactly one native input, never a replay.
      expect(yield* run(f.backend.typeText("abc", "cua:10:20"))).toBeDefined();
      expect(callsNamed(f, "click")).toHaveLength(clicks);
      expect(f.calls.filter((call) => isTyping(call.name))).toHaveLength(1);
      yield* f.backend.dispose();
    }),
  );

  it.effect("requires a fresh granted observation to recover from a failed capture", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // A capture that fails native-side flips health while dispatching zero input...
      f.failOverview();
      yield* fails(f.backend.getState({ includeScreenshot: true }));
      expect(f.backend.health()).toMatchObject({
        status: "unavailable",
        captureAvailable: false,
      });
      const overviews = callsNamed(f, "get_desktop_state").length;
      expect(f.calls.some((call) => call.name === "click" || isTyping(call.name))).toBe(false);
      // ...inputs keep working through the outage...
      expect(yield* run(f.backend.typeText("abc", "cua:10:20"))).toBeDefined();
      // ...and a latched heal is not enough: only a fresh successful observation
      // recovers, so a still-failing capture flips health right back.
      f.grantPermissions();
      yield* run(f.backend.provision());
      expect(f.backend.health()).toMatchObject({
        status: "connected",
        captureAvailable: true,
      });
      yield* fails(f.backend.getState({ includeScreenshot: true }));
      expect(f.backend.health()).toMatchObject({
        status: "unavailable",
        captureAvailable: false,
      });
      expect(callsNamed(f, "get_desktop_state")).toHaveLength(overviews + 1);
      yield* f.backend.dispose();
    }),
  );

  it.effect("drops grounding after uncertain delivery but keeps it after a clean refusal", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* observe(f);
      f.fail(new CuaTransportError("timeout", "dispatched-unknown"));
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "dispatched-unknown",
      });
      // Uncertain delivery may have moved the window: re-observe first.
      expect(yield* fails(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toMatchObject({
        code: "stale_geometry",
      });
      yield* observe(f);
      f.refuse();
      f.unfail();
      expect(yield* fails(f.backend.typeText("abc", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
      });
      // A clean refusal dispatched nothing, so the grounding still stands.
      expect(yield* run(f.backend.click({ x: -275, y: 30 }, "cua:10:20"))).toBeDefined();
      yield* f.backend.dispose();
    }),
  );
});

// Synara's "Computer authority" cases (archived admission, stale turn release,
// queued admission revocation) drive ComputerManager over FakeComputerBackend
// and never touch Cua; they belong to the manager suites.

describe("native preview task lifetime", () => {
  it.effect("does no host work when an ordinary turn ends", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.endTask("ordinary", "turn"));
      expect(f.calls).toHaveLength(0);
    }),
  );

  it.effect("attributes observations and ends only the matching turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const task = { threadId: "thread", turnId: "turn" };
      yield* run(
        withComputerTask(
          task,
          withModelDesktopObservation(
            f.backend.getState({ windowId: "cua:10:20", includeScreenshot: true }),
          ),
        ),
      );
      expect(f.calls).toContainEqual(
        expect.objectContaining({ name: "get_window_state", task, modelObservation: true }),
      );
      const before = f.calls.length;
      yield* run(f.backend.endTask("thread", "old"));
      expect(f.calls).toHaveLength(before);
      yield* run(f.backend.endTask("thread", "turn"));
      expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
      yield* run(f.backend.endTask("thread", "turn"));
      expect(f.calls).toHaveLength(before + 1);
    }),
  );
});

describe("preview stills target scope", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const imageReply = {
    structuredContent: { status: "ok" },
    content: [
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
    ],
  };

  it.effect("publishes nothing when no window or tab is the target", () =>
    Effect.gen(function* () {
      // No target means no frame: the pane shows its waiting state instead of a
      // whole-desktop picture.
      const f = yield* fixture();
      const collected = yield* collectEvents(f.backend);
      yield* run(f.backend.attachStream());
      yield* settle();
      expect(collected.frames()).toHaveLength(0);
      expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
      expect(f.calls.some((call) => call.name === "get_window_state")).toBe(false);
      yield* f.backend.dispose();
    }),
  );

  it.effect("captures the exact window the task aims at, never the desktop", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.focusWindow("cua:10:20"));
      f.calls.length = 0;
      const collected = yield* collectEvents(f.backend);
      yield* run(f.backend.attachStream());
      yield* settle();
      expect(collected.frames()).toHaveLength(1);
      expect(lastCall(f, "get_window_state")?.args).toMatchObject({
        pid: 10,
        window_id: 20,
        include_screenshot: true,
        include_accessibility_tree: false,
      });
      expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
      yield* f.backend.dispose();
    }),
  );

  it.effect("captures a bound browser tab through the driver's screenshot route", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("get_browser_state", (args) =>
        args.pid !== undefined
          ? {
              structuredContent: {
                status: "ok",
                target_id: "bt-1",
                tabs: [{ tab_id: "tab-1", active: true }],
              },
            }
          : imageReply,
      );
      yield* run(
        f.backend.browser.call({
          name: "get_browser_state",
          args: { pid: 42 },
          task,
          mutation: false,
        }),
      );
      f.calls.length = 0;
      const collected = yield* collectEvents(f.backend);
      yield* run(f.backend.attachStream());
      yield* settle();
      expect(collected.frames()).toHaveLength(1);
      // The bind minted the target and its one active tab; the still snapshots
      // exactly that tab, and the desktop is never captured.
      expect(f.calls.at(-1)).toMatchObject({
        method: "call",
        name: "get_browser_state",
        args: { target_id: "bt-1", tab_id: "tab-1", include_screenshot: true },
        task,
      });
      expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
      yield* f.backend.dispose();
    }),
  );

  it.effect("drops the browser still target when its task ends", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("get_browser_state", () => ({
        structuredContent: { status: "ok", target_id: "bt-1", tabs: [{ tab_id: "tab-1" }] },
      }));
      yield* run(
        f.backend.browser.call({
          name: "get_browser_state",
          args: { pid: 42 },
          task,
          mutation: false,
        }),
      );
      yield* run(f.backend.endTask("thread", "turn"));
      f.calls.length = 0;
      const collected = yield* collectEvents(f.backend);
      yield* run(f.backend.attachStream());
      yield* settle();
      // A pane still must never revive an ended browser session.
      expect(collected.frames()).toHaveLength(0);
      expect(f.calls.some((call) => call.name === "get_browser_state")).toBe(false);
      yield* f.backend.dispose();
    }),
  );

  it.effect("registers a browser task so endTask reaches the host", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(
        f.backend.browser.call({
          name: "get_browser_state",
          args: { pid: 10, window_id: 20 },
          task,
          mutation: false,
        }),
      );
      // The bound window releases the driver-side task surface: endTask
      // reaches the host instead of early-returning on an unknown task.
      yield* run(f.backend.endTask("thread", "turn"));
      expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
      yield* f.backend.dispose();
    }),
  );

  it.effect("a refused browser call still ends its task cleanly", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.onTool("get_browser_state", () => ({
        structuredContent: {
          status: "refused",
          refusal: { code: "browser_requires_setup", message: "Prepare a browser first." },
        },
        content: [{ type: "text", text: "refused (browser_requires_setup)" }],
      }));
      yield* run(
        f.backend.browser.call({
          name: "get_browser_state",
          args: { pid: 10, window_id: 20 },
          task,
          mutation: false,
        }),
      );
      // The task registered at dispatch, so its end still reaches the host —
      // anything the refused call did touch releases with it.
      yield* run(f.backend.endTask("thread", "turn"));
      expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
      yield* f.backend.dispose();
    }),
  );
});

describe("Cua workstream-C speed flags", () => {
  const STILL_ENV = "PATHWAY_CUA_PREVIEW_STILL_MS";

  /** Runs `effect` with the still-cadence override set (or unset), then restores it. */
  const withStillEnv = <A, E, R>(value: string | undefined, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = process.env[STILL_ENV];
        if (value === undefined) delete process.env[STILL_ENV];
        else process.env[STILL_ENV] = value;
        return saved;
      }),
      () => effect,
      (saved) =>
        Effect.sync(() => {
          if (saved === undefined) delete process.env[STILL_ENV];
          else process.env[STILL_ENV] = saved;
        }),
    );

  /**
   * Attaches the pane to the fixture window and proves the still loop's cadence
   * on the TestClock: no capture one millisecond early, one exactly on time.
   */
  const expectStillCadence = (f: Fixture, intervalMs: number) =>
    Effect.gen(function* () {
      yield* run(f.backend.focusWindow("cua:10:20"));
      yield* run(f.backend.attachStream());
      const captures = callsNamed(f, "get_window_state").length;
      yield* TestClock.adjust(intervalMs - 1);
      yield* settle();
      expect(callsNamed(f, "get_window_state")).toHaveLength(captures);
      yield* TestClock.adjust(1);
      yield* settle();
      expect(callsNamed(f, "get_window_state")).toHaveLength(captures + 1);
      yield* f.backend.dispose();
    });

  const windowStateArgs = (f: Fixture) => lastCall(f, "get_window_state")?.args ?? {};

  it.effect("sends explicit include_screenshot:false on a tree-only get_state", () =>
    Effect.gen(function* () {
      // The driver treats an absent include_screenshot as true, so the
      // no-capture contract has to be pinned explicitly on the wire.
      const f = yield* fixture();
      const state = yield* run(f.backend.getState({ windowId: "cua:10:20", includeTree: true }));
      expect(windowStateArgs(f)).toMatchObject({
        include_screenshot: false,
        max_dimension: 1536,
        include_accessibility_tree: true,
      });
      expect(state.screenshot).toBeUndefined();
      yield* f.backend.dispose();
    }),
  );

  it.effect("keeps the capture arguments a pixel read needs", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(
        f.backend.getState({
          windowId: "cua:10:20",
          includeTree: true,
          includeScreenshot: true,
        }),
      );
      expect(windowStateArgs(f)).toMatchObject({
        include_screenshot: true,
        max_dimension: 1536,
        include_accessibility_tree: true,
      });
      yield* f.backend.dispose();
    }),
  );

  it.effect("arms the still publisher at the compiled 1000 ms cadence by default", () =>
    Effect.gen(function* () {
      const f = yield* withStillEnv(undefined, fixture());
      yield* expectStillCadence(f, 1_000);
    }),
  );

  it.effect("PATHWAY_CUA_PREVIEW_STILL_MS overrides the still cadence", () =>
    Effect.gen(function* () {
      const f = yield* withStillEnv("4000", fixture());
      yield* expectStillCadence(f, 4_000);
    }),
  );

  it.effect("an unparsable PATHWAY_CUA_PREVIEW_STILL_MS falls back to the default", () =>
    Effect.gen(function* () {
      const f = yield* withStillEnv("fast", fixture());
      yield* expectStillCadence(f, 1_000);
    }),
  );

  it.effect("the constructor's stillIntervalMs wins and stays above the publisher floor", () =>
    Effect.gen(function* () {
      const f = yield* withStillEnv("4000", fixture({ stillIntervalMs: 750 }));
      yield* expectStillCadence(f, 750);
      // MIN_STILL_INTERVAL_MS keeps an aggressive value from queueing captures
      // faster than one encode can finish.
      const floored = yield* fixture({ stillIntervalMs: 5 });
      yield* expectStillCadence(floored, 100);
    }),
  );
});

describe("driver browser surface", () => {
  it.effect("exposes a browser route whenever the backend exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(f.backend.browser).toBeDefined();
    }),
  );

  it.effect(
    "forwards the driver's reply verbatim — a deliberate refusal is a result, not an error",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.onTool("get_browser_state", () => ({
          content: [{ type: "text", text: "refused (browser_requires_setup)" }],
          structuredContent: {
            status: "refused",
            refusal: {
              code: "browser_requires_setup",
              message: "Prepare a browser first.",
            },
          },
        }));
        const result = yield* run(
          f.backend.browser.call({
            name: "get_browser_state",
            args: { target_id: "bt-1", tab_id: "tab-1" },
            task: { threadId: "thread", turnId: "turn" },
            mutation: false,
          }),
        );
        // The desktop path converts the same payload into a CuaActionError
        // failure; the browser path must not — the refusal IS the result the
        // model reads.
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_requires_setup" },
        });
        expect(f.calls.at(-1)).toMatchObject({
          method: "call",
          name: "get_browser_state",
          args: { target_id: "bt-1", tab_id: "tab-1" },
          task: { threadId: "thread", turnId: "turn" },
        });
      }),
  );

  it.effect("fails closed without a GUI host instead of fabricating a route", () =>
    Effect.gen(function* () {
      const backend = yield* makeCuaComputerBackend({ endpoint: "" }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      expect(
        yield* fails(
          backend.browser.call({
            name: "browser_click",
            args: {},
            task: { threadId: "thread" },
            mutation: true,
          }),
        ),
      ).toMatchObject({ code: "gui_host_required" });
    }),
  );

  it.effect("ends the thread's driver browser session through the host", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* run(f.backend.browser.endThread("thread-1"));
      expect(f.calls.at(-1)).toMatchObject({
        method: "end_browser_thread",
        task: { threadId: "thread-1" },
      });
    }),
  );
});

describe("host-reported platform and native revision", () => {
  const hostReply = (reply: Record<string, unknown>) =>
    bareBackend(async () => ({ ok: true, ...reply }));

  it.effect(
    "adopts the host platform and narrows patched-only capabilities for an unpatched driver",
    () =>
      Effect.gen(function* () {
        // The server itself runs on macOS; the endpoint turns out to be elsewhere.
        const backend = yield* hostReply({ hostPlatform: "win32", driverNativeRevision: 0 });
        expect(backend.agentDialect).toBe("macos");
        expect(backend.focusNeutralSemanticText).toBe(true);
        expect(backend.capabilities().ghostCursor).toBe(true);

        yield* run(backend.probeAvailability());
        // The first reply teaches the backend what actually runs on the other
        // end: a Windows host speaks the generic desktop dialect, and an
        // unpatched upstream driver carries none of the Pathway-native surface.
        expect(backend.agentDialect).toBe("linux");
        expect(backend.focusNeutralSemanticText).toBe(false);
        expect(backend.capabilities().ghostCursor).toBe(false);
      }),
  );

  it.effect("keeps the patched surface for a driver that reports its revision", () =>
    Effect.gen(function* () {
      const backend = yield* hostReply({ hostPlatform: "darwin", driverNativeRevision: 20 });
      yield* run(backend.probeAvailability());
      expect(backend.agentDialect).toBe("macos");
      expect(backend.focusNeutralSemanticText).toBe(true);
      expect(backend.capabilities().ghostCursor).toBe(true);
    }),
  );

  it.effect("does not advertise macOS input guarantees for a patched Linux browser driver", () =>
    Effect.gen(function* () {
      const backend = yield* hostReply({ hostPlatform: "linux", driverNativeRevision: 32 });
      yield* run(backend.probeAvailability());
      expect(backend.focusNeutralSemanticText).toBe(false);
      expect(backend.capabilities()).toMatchObject({
        input: false,
        focus: false,
        raise: false,
        ghostCursor: false,
      });
    }),
  );
});

describe("Linux native input dialect", () => {
  it.effect(
    "uses the strict upstream pixel and keyboard schemas only in authorized foreground mode",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        yield* observe(f);
        yield* run(
          withDesktopDeliveryMode(
            "foreground",
            Effect.gen(function* () {
              yield* f.backend.click({ x: -275, y: 30 }, "cua:10:20");
              yield* f.backend.typeText("visible input", "cua:10:20");
              yield* f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20");
            }),
          ),
        );
        expect(lastCall(f, "click")).toMatchObject({
          deliveryMode: "foreground",
          args: { pid: 10, window_id: 20, delivery_mode: "foreground", count: 1, x: 25, y: 10 },
        });
        expect(lastCall(f, "type_text")?.args).toEqual({
          pid: 10,
          window_id: 20,
          delivery_mode: "foreground",
          text: "visible input",
        });
        expect(lastCall(f, "drag")?.args).toEqual({
          pid: 10,
          window_id: 20,
          delivery_mode: "foreground",
          from_x: 25,
          from_y: 10,
          to_x: 75,
          to_y: 30,
          duration_ms: 500,
        });
        for (const call of f.calls.filter((call) =>
          ["click", "type_text", "drag"].includes(call.name ?? ""),
        )) {
          expect(call.args).not.toHaveProperty("force_synthetic");
          expect(call.args).not.toHaveProperty("coordinate_space");
          expect(call.args).not.toHaveProperty("expected_window_bounds");
        }
      }),
  );

  it.effect("refuses default background input without dispatching a relaxed Linux request", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hostPlatform: "linux" });
      expect(yield* fails(f.backend.typeText("must not type", "cua:10:20"))).toMatchObject({
        effect: "not-dispatched",
        code: "linux_background_unavailable",
      });
      expect(f.calls.some((call) => call.name === "type_text")).toBe(false);
      expect(f.calls.every((call) => call.deliveryMode === "background")).toBe(true);
    }),
  );

  it.effect(
    "translates an unmodified single-axis scroll without dropping unsupported gesture semantics",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        yield* observe(f);
        const scroll = (dx: number, modifiers?: readonly ["ctrl"]) =>
          withDesktopDeliveryMode(
            "foreground",
            f.backend.scroll({ x: -275, y: 30 }, dx, 240, "cua:10:20", modifiers),
          );
        yield* run(scroll(0));
        expect(lastCall(f, "scroll")?.args).toEqual({
          pid: 10,
          window_id: 20,
          delivery_mode: "foreground",
          direction: "down",
          amount: 2,
          by: "line",
          x: 25,
          y: 10,
        });
        expect(yield* fails(scroll(120))).toMatchObject({
          effect: "not-dispatched",
          code: "unsupported_linux_operation",
        });
        expect(yield* fails(scroll(0, ["ctrl"]))).toMatchObject({
          effect: "not-dispatched",
          code: "unsupported_linux_operation",
        });
        expect(callsNamed(f, "scroll")).toHaveLength(1);
      }),
  );

  it.effect("does not downgrade an exact semantic text target to focused Linux typing", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ hostPlatform: "linux" });
      f.setElements([
        {
          role: "AXTextField",
          label: "Fixture input",
          element_token: "snapshot-token",
          frame: { x: -290, y: 30, width: 20, height: 20 },
        },
      ]);
      const target = yield* observedTarget(f, "Fixture input");
      expect(
        yield* fails(
          withDesktopDeliveryMode(
            "foreground",
            f.backend.typeText("must preserve identity", "cua:10:20", target),
          ),
        ),
      ).toMatchObject({ effect: "not-dispatched", code: "linux_semantic_target_unproven" });
      expect(f.calls.some((call) => call.name === "type_text" || call.name === "set_value")).toBe(
        false,
      );
    }),
  );

  it.effect(
    "keeps native arguments separate from the server's delivery authorization envelope",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ hostPlatform: "linux" });
        yield* run(
          f.backend.browser.call({
            name: "browser_click",
            args: { target_id: "fixture", delivery_mode: "foreground", deliveryMode: "foreground" },
            task: { threadId: "linux-envelope-test" },
            mutation: true,
          }),
        );
        expect(f.calls.at(-1)).toMatchObject({
          deliveryMode: "background",
          args: { delivery_mode: "foreground", deliveryMode: "foreground" },
        });
      }),
  );

  it.effect(
    "marks only active model browser observations as eligible for interruption recovery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const browserObservation = f.backend.browser.call({
          name: "get_browser_state",
          args: { target_id: "fixture", tab_id: "tab" },
          task: { threadId: "observation-test" },
          mutation: false,
        });
        yield* run(browserObservation);
        expect(f.calls.at(-1)?.modelObservation).toBe(false);
        yield* run(withModelDesktopObservation(browserObservation));
        expect(f.calls.at(-1)?.modelObservation).toBe(true);
        yield* run(browserObservation);
        expect(f.calls.at(-1)?.modelObservation).toBe(false);
      }),
  );
});
