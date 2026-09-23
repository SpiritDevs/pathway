/**
 * The desktop backend CI runs against, and the fixture the manager and tool
 * suites drive.
 *
 * It keeps an in-memory desktop: a window list with bounds and focus, a
 * process list, one accessibility tree, a clipboard, and a pointer. Every call
 * is recorded in `calls` so a test can prove what reached the "display
 * server", and `failNext` fails the next call of one method with a typed error.
 *
 * Members are prototype methods rather than arrow properties so a test can
 * subclass the fake and override one call while still delegating to
 * `super.method(...)`. Callers must invoke them on the backend
 * (`backend.click(...)`), never detached. Events, frames included, go out on
 * `events`; a consumer that must see an event published right after it starts
 * should fork with `{ startImmediately: true }` so its subscription exists
 * before the publish.
 *
 * @module computer/FakeComputerBackend
 */
import type {
  ComputerAccessibilityTreeApp,
  ComputerAccessibilityTreeWindow,
  ComputerApp,
  ComputerAvailability,
  ComputerBuildSignature,
  ComputerCapabilities,
  ComputerCursorPosition,
  ComputerHealth,
  ComputerId,
  ComputerInputModifier,
  ComputerLaunchAppResult,
  ComputerPermission,
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerState,
  ComputerUiNode,
  ComputerVerifyStateResult,
  ComputerWindow,
  ComputerZoomResult,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  DEFAULT_COMPUTER_ID,
  intersectComputerRects,
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBrowserBackend,
  type ComputerBrowserCall,
  type ComputerBrowserCallResult,
  type ComputerCaptureRequest,
  type ComputerMenuBackendTarget,
  type ComputerResolvedTarget,
  type ComputerShieldTarget,
  type ComputerTextRange,
} from "./ComputerBackend.ts";
import {
  ComputerBackendError,
  ComputerTargetError,
  type ComputerOperationError,
} from "./computerErrors.ts";
import { requireWindowBounds } from "./computerGeometry.ts";

const FAKE_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** A real 1×1 JPEG: zoom returns JPEG, not the PNG the ordinary captures carry. */
const FAKE_ZOOM_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKwA//9k=";

/**
 * How many calls the fake remembers. A long-running server that leaves the
 * fake wired in would otherwise grow this array for the life of the process;
 * tests only ever look at recent calls, so the oldest entries are dropped.
 */
const MAX_RECORDED_CALLS = 1_000;

/**
 * What the fake actually simulates. It enumerates windows with bounds and a
 * stacking order, captures, takes input, holds a clipboard, and focuses and
 * raises — so those are all true. `ghostCursor` is true because the fake moves
 * a pointer nothing else shares. `visibleDesktop` is false — a fake desktop
 * renders nowhere, so the pane is its only view, which also keeps the pane
 * auto-open path exercised under this backend.
 */
const DEFAULT_FAKE_CAPABILITIES: ComputerCapabilities = {
  windows: true,
  windowBounds: true,
  stacking: true,
  capture: true,
  input: true,
  clipboard: true,
  focus: true,
  raise: true,
  ghostCursor: true,
  visibleDesktop: false,
};

type FakeEffect<A> = Effect.Effect<A, ComputerOperationError>;

export interface FakeComputerCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeSettleOptions {
  readonly windowId: string;
  readonly timeoutMs: number;
  readonly quietMs: number;
}

export interface FakeSettleResult {
  readonly settled: boolean;
  readonly waitedMs: number;
  readonly eventsSeen?: number;
}

export interface FakeComputerBackendOptions {
  readonly computerId?: string;
  readonly availability?: ComputerAvailability;
  readonly health?: ComputerHealth;
  /**
   * Overrides what the fake claims to be able to do, so a test can drive the
   * capability-gated refusals a less capable backend produces without
   * standing up a real display server.
   */
  readonly capabilities?: ComputerCapabilities;
  readonly screenSize?: ComputerScreenSize;
  readonly windows?: readonly ComputerWindow[];
  /**
   * The process list `listApps` answers. Defaults to one running app per
   * default window, so the fixture mirrors what the real driver reports
   * without a test having to name any.
   */
  readonly apps?: readonly ComputerApp[];
  readonly root?: ComputerUiNode;
  /** The ISO timestamp every capture reports. Defaults to the Effect clock. */
  readonly now?: () => string;
  /**
   * Opts the fake into the browser surface. `true` uses the built-in handler
   * (a minted `target_id` for `get_browser_state`, `status:"completed"` for
   * everything else); a function answers calls itself, and an answer of
   * nothing falls back to the built-in reply. Absent or `false` means the fake
   * speaks no browser tools — `browser` stays undefined, which is how a
   * desktop-only backend truthfully reports that.
   */
  readonly browser?:
    | boolean
    | ((call: ComputerBrowserCall) => FakeEffect<ComputerBrowserCallResult | void>);
  /**
   * Opts the fake into driver-observed settling. `true` answers every
   * `waitForSettle` call `{settled:true}` immediately; a function answers
   * itself, so a test can return a busy surface or fail with the
   * "Unknown tool:" refusal an older driver produces. Absent or `false`
   * means the backend truthfully has no observer — the method stays
   * undefined and callers must take the fixed-settle fallback.
   */
  readonly waitForSettle?: boolean | ((options: FakeSettleOptions) => FakeEffect<FakeSettleResult>);
  /**
   * Opts the fake into the activation-shield surface. `true` answers every
   * `engageShield` with the caller's id; a function runs before the engage
   * lands, so a test can refuse (fail) or wedge (never resolve) the way a
   * real host can. Absent or `false` means the backend has no shield surface —
   * the methods stay undefined, which is what makes an armed
   * masked-activation flag fail closed.
   */
  readonly shield?: boolean | ((target: ComputerShieldTarget) => FakeEffect<void>);
  /**
   * What the fake reports as its input dialect. The real CUA backend reports
   * `"macos"`; the fake defaults to absent (the manager reads that as
   * `"linux"`) so existing fixtures keep their dialect-gated behavior, and a
   * test that needs the macOS paths — masked activation among them — opts in.
   */
  readonly agentDialect?: ComputerAgentDialect;
}

const refuse = (message: string) => Effect.fail(new ComputerBackendError({ message }));

const missingWindow = (windowId: string) => `No desktop window has id ${JSON.stringify(windowId)}.`;

const noWindow = (windowId: string) => refuse(missingWindow(windowId));

export class FakeComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;
  readonly calls: FakeComputerCall[] = [];
  /** Every backend notification, frames included. Ends when the fake is disposed. */
  readonly events: Stream.Stream<ComputerBackendEvent>;

  private readonly pubsub: PubSub.PubSub<ComputerBackendEvent>;
  private currentAvailability: ComputerAvailability;
  private currentMissingPermissions: readonly ComputerPermission[] = [];
  private currentBuildSignature: ComputerBuildSignature | undefined;
  private currentHealth: ComputerHealth;
  private readonly currentCapabilities: ComputerCapabilities;
  private currentScreenSize: ComputerScreenSize;
  private currentWindows: ComputerWindow[];
  private currentApps: ComputerApp[];
  private currentRoot: ComputerUiNode;
  private readonly timestamp: Effect.Effect<string>;
  private streamAttached = false;
  private nextSequence = 1;
  private nextPid = 5_000;
  private clipboardText = "";
  private readonly failures = new Map<string, ComputerOperationError>();
  private readonly queuedScreenshots: string[] = [];
  /**
   * When false the frame call still succeeds but the window keeps its old
   * bounds — the readback-mismatch shape a driver that dispatched without the
   * move landing produces.
   */
  private frameApplies = true;
  private readonly refusedMenuPaths = new Map<string, ComputerOperationError>();
  private verifySatisfied = true;
  private cursorPosition: ComputerPoint = { x: 0, y: 0 };
  private disposed = false;
  readonly browser?: ComputerBrowserBackend;
  /**
   * Present only when `options.waitForSettle` opted the fake into the
   * observer capability — exactly like a real backend that either exposes
   * the driver's `wait_for_settle` read or does not. `NonNullable` because
   * `exactOptionalPropertyTypes` makes the interface's optional member
   * present-or-absent, never undefined.
   */
  readonly waitForSettle?: NonNullable<ComputerBackend["waitForSettle"]>;
  /**
   * Present only when `options.shield` opted the fake into the shield
   * surface — exactly like a real backend that either exposes the host's
   * shield command or does not. Engage still echoes the caller's id back:
   * the manager mints it, so a fake that "lost the reply" is simulated with
   * `failNext("engageShield")`, not by withholding the id.
   */
  readonly engageShield?: NonNullable<ComputerBackend["engageShield"]>;
  readonly releaseShield?: NonNullable<ComputerBackend["releaseShield"]>;
  readonly releaseAllShields?: NonNullable<ComputerBackend["releaseAllShields"]>;
  private readonly liveShields = new Set<string>();
  readonly agentDialect?: ComputerAgentDialect;

  constructor(options: FakeComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.pubsub = Effect.runSync(PubSub.unbounded<ComputerBackendEvent>());
    this.events = Stream.fromPubSub(this.pubsub);
    this.currentAvailability = options.availability ?? {
      kind: "available",
      backend: "fake",
    };
    this.currentHealth = options.health ?? {
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 0,
      captureAvailable: true,
    };
    this.currentCapabilities = options.capabilities ?? DEFAULT_FAKE_CAPABILITIES;
    this.currentScreenSize = options.screenSize ?? { width: 1_920, height: 1_080, scale: 1 };
    this.currentWindows = [...(options.windows ?? defaultWindows())];
    this.currentApps = [...(options.apps ?? defaultApps(this.currentWindows))];
    this.currentRoot = options.root ?? defaultRoot(this.currentScreenSize, this.currentWindows);
    this.timestamp = options.now
      ? Effect.sync(options.now)
      : Effect.map(Clock.currentTimeMillis, (millis) =>
          DateTime.formatIso(DateTime.makeUnsafe(millis)),
        );
    if (options.agentDialect) this.agentDialect = options.agentDialect;
    if (options.browser) {
      const handler = typeof options.browser === "function" ? options.browser : undefined;
      this.browser = {
        call: (call) =>
          Effect.gen({ self: this }, function* () {
            yield* this.takeFailure(`browser.${call.name}`);
            const answered = handler ? yield* handler(call) : undefined;
            const result = answered ?? {
              content: [{ type: "text", text: `fake browser ${call.name}` }],
              structuredContent:
                call.name === "get_browser_state"
                  ? { target_id: `fake-browser-${call.task.threadId}`, tabs: [] }
                  : { status: "completed" },
            };
            this.record(`browser.${call.name}`, call.args);
            return result;
          }),
        endThread: (threadId) => Effect.sync(() => this.record("browser.endThread", threadId)),
      };
    }
    if (options.waitForSettle) {
      const handler =
        typeof options.waitForSettle === "function" ? options.waitForSettle : undefined;
      this.waitForSettle = (settleOptions) =>
        Effect.gen({ self: this }, function* () {
          this.record("waitForSettle", settleOptions);
          yield* this.takeFailure("waitForSettle");
          if (!this.currentWindows.some((entry) => entry.id === settleOptions.windowId)) {
            return yield* new ComputerTargetError({
              code: "computer_target_not_found",
              message: missingWindow(settleOptions.windowId),
            });
          }
          return handler ? yield* handler(settleOptions) : { settled: true, waitedMs: 0 };
        });
    }
    if (options.shield) {
      const handler = typeof options.shield === "function" ? options.shield : undefined;
      this.engageShield = (target) =>
        Effect.gen({ self: this }, function* () {
          this.record("engageShield", target);
          yield* this.takeFailure("engageShield");
          if (handler) yield* handler(target);
          this.liveShields.add(target.shieldId);
          return target.shieldId;
        });
      this.releaseShield = (shieldId) =>
        Effect.gen({ self: this }, function* () {
          this.record("releaseShield", shieldId);
          yield* this.takeFailure("releaseShield");
          this.liveShields.delete(shieldId);
        });
      this.releaseAllShields = () =>
        Effect.sync(() => {
          this.record("releaseAllShields");
          this.liveShields.clear();
        });
    }
  }

  availability(): FakeEffect<ComputerAvailability> {
    return Effect.gen({ self: this }, function* () {
      this.record("availability");
      yield* this.takeFailure("availability");
      return this.currentAvailability;
    });
  }

  /**
   * Recorded under its own name so a test can prove which of the two a caller
   * used: the whole point of the passive probe is that the paths which must not
   * touch the display server can be shown not to.
   */
  probeAvailability(): FakeEffect<ComputerAvailability> {
    return Effect.gen({ self: this }, function* () {
      this.record("probeAvailability");
      yield* this.takeFailure("probeAvailability");
      return this.currentAvailability;
    });
  }

  /** Not recorded as a call: reading health is a getter, not a backend operation. */
  health(): ComputerHealth {
    return this.currentHealth;
  }

  /** Not recorded either, and for the same reason. */
  capabilities(): ComputerCapabilities {
    return this.currentCapabilities;
  }

  /**
   * No OS withholds anything from the fake. Declared rather than omitted so a
   * test can substitute a backend that *is* missing a grant without the type
   * complaining about a property the interface only optionally has.
   */
  missingPermissions(): FakeEffect<readonly ComputerPermission[]> {
    return Effect.sync(() => this.currentMissingPermissions);
  }

  setMissingPermissions(permissions: readonly ComputerPermission[]): void {
    this.currentMissingPermissions = [...permissions];
  }

  /**
   * Undefined by default: the fake is not a signed binary and has no signature
   * to report, and reporting `signed` would be a lie a card could act on.
   * Declared for the same reason `missingPermissions` is — so a test can
   * substitute a build that *is* ad-hoc.
   */
  buildSignature(): ComputerBuildSignature | undefined {
    return this.currentBuildSignature;
  }

  setBuildSignature(signature: ComputerBuildSignature | undefined): void {
    this.currentBuildSignature = signature;
  }

  listWindows(): FakeEffect<readonly ComputerWindow[]> {
    return Effect.gen({ self: this }, function* () {
      this.record("listWindows");
      yield* this.takeFailure("listWindows");
      return this.currentWindows.map((window) => ({
        ...window,
        ...(window.bounds ? { bounds: { ...window.bounds } } : {}),
      }));
    });
  }

  getScreenSize(): FakeEffect<ComputerScreenSize> {
    return Effect.gen({ self: this }, function* () {
      this.record("getScreenSize");
      yield* this.takeFailure("getScreenSize");
      return { ...this.currentScreenSize };
    });
  }

  getState(options: Parameters<ComputerBackend["getState"]>[0]): FakeEffect<ComputerState> {
    return Effect.gen({ self: this }, function* () {
      this.record("getState", options);
      yield* this.takeFailure("getState");
      const screenshot = options.includeScreenshot
        ? yield* this.screenshotOfRegion(this.workspaceRect())
        : undefined;
      const windows = yield* this.listWindows();
      return {
        computerId: this.computerId,
        windows,
        screenSize: { ...this.currentScreenSize },
        root: this.currentRoot,
        ...(screenshot ? { screenshot } : {}),
        capturedAt: yield* this.timestamp,
      } as ComputerState;
    });
  }

  captureScreenshot(request: ComputerCaptureRequest): FakeEffect<ComputerScreenshot> {
    return Effect.gen({ self: this }, function* () {
      this.record("captureScreenshot", request);
      yield* this.takeFailure("captureScreenshot");
      const region = intersectComputerRects(yield* this.captureRect(request), this.workspaceRect());
      if (!region) {
        return yield* refuse("The capture request does not overlap the fake workspace.");
      }
      return yield* this.screenshotOfRegion(region, request.maxDimension);
    });
  }

  launchApp(
    app: string,
    args: readonly string[],
    options?: { readonly hidden?: boolean },
  ): FakeEffect<ComputerLaunchAppResult> {
    return Effect.gen({ self: this }, function* () {
      // Recorded only when present, so every existing assertion on a plain
      // launch keeps matching its two-argument shape.
      if (options !== undefined) this.record("launchApp", app, args, options);
      else this.record("launchApp", app, args);
      yield* this.takeFailure("launchApp");
      const hidden = options?.hidden === true;
      const id = `fake-window-${this.currentWindows.length + 1}`;
      const window: ComputerWindow = {
        id,
        title: app,
        appName: app,
        pid: this.nextPid++,
        bounds: { x: 120, y: 80, width: 900, height: 700 },
        // A hidden launch renders nothing and takes no focus: frontmost is
        // unchanged, which the fake models by leaving every existing flag alone.
        focused: false,
        minimized: false,
        visible: !hidden,
      };
      this.currentWindows = [...this.currentWindows, window];
      this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
      this.emit({ type: "windows-changed", windows: this.currentWindows });
      return { computerId: this.computerId, app, window } as ComputerLaunchAppResult;
    });
  }

  listApps(): FakeEffect<readonly ComputerApp[]> {
    return Effect.gen({ self: this }, function* () {
      this.record("listApps");
      yield* this.takeFailure("listApps");
      return this.currentApps.map((app) => ({ ...app }));
    });
  }

  /**
   * The fake's readback is its own window list: applying the frame is what a
   * confirmed verification looks like, and `setFrameApplies(false)` produces
   * the dispatched-but-unverified result a real backend reports when the move
   * did not land.
   */
  setWindowFrame(windowId: string, frame: ComputerRect): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("setWindowFrame", windowId, frame);
      yield* this.takeFailure("setWindowFrame");
      if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
        return yield* refuse("Window frame needs finite geometry and positive size.");
      }
      const index = this.currentWindows.findIndex((window) => window.id === windowId);
      if (index === -1) return yield* noWindow(windowId);
      if (!this.frameApplies) {
        return {
          windowId,
          deliveryPath: "fake-frame",
          verified: "unconfirmed",
          effect: "dispatched-unknown",
        };
      }
      this.currentWindows[index] = { ...this.currentWindows[index]!, bounds: { ...frame } };
      this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
      this.emit({ type: "windows-changed", windows: this.currentWindows });
      return {
        windowId,
        deliveryPath: "fake-frame",
        verified: "confirmed",
        effect: "verified",
      };
    });
  }

  invokeMenu(
    target: ComputerMenuBackendTarget,
    path: readonly string[],
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("invokeMenu", target, path);
      yield* this.takeFailure("invokeMenu");
      if ("windowId" in target) {
        if (!this.currentWindows.some((window) => window.id === target.windowId)) {
          return yield* noWindow(target.windowId);
        }
      } else if (!this.currentApps.some((app) => app.pid === target.pid && app.running)) {
        // The windowless form proves the process, not a window — the same
        // refusal the real driver raises for a pid that is not running.
        return yield* refuse(`No running application has pid ${target.pid}.`);
      }
      if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
        return yield* refuse("A menu path needs at least one non-empty title.");
      }
      const refusal = this.refusedMenuPaths.get(path.join("\u0000"));
      if (refusal) return yield* refusal;
      return {
        ...("windowId" in target ? { windowId: target.windowId } : {}),
        deliveryPath: "fake-menu",
        verified: "confirmed",
        effect: "verified",
      };
    });
  }

  setWindowMinimized(
    windowId: string,
    minimized: boolean,
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("setWindowMinimized", windowId, minimized);
      yield* this.takeFailure("setWindowMinimized");
      const index = this.currentWindows.findIndex((window) => window.id === windowId);
      if (index === -1) return yield* noWindow(windowId);
      // A minimized window renders nothing; a restored one shows again. The
      // window stays in the list either way — like the real driver, the fake
      // keeps it addressable for semantic reads while it is off screen.
      const window = this.currentWindows[index]!;
      this.currentWindows[index] = { ...window, minimized, visible: !minimized };
      this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
      this.emit({ type: "windows-changed", windows: this.currentWindows });
      return {
        windowId,
        deliveryPath: "fake-minimize",
        verified: "confirmed",
        effect: "verified",
      };
    });
  }

  setAppVisibility(pid: number, hidden: boolean): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("setAppVisibility", pid, hidden);
      yield* this.takeFailure("setAppVisibility");
      if (!this.currentApps.some((candidate) => candidate.pid === pid && candidate.running)) {
        return yield* refuse(`No running application has pid ${pid}.`);
      }
      // A hidden app renders none of its windows; unhiding restores whatever
      // is not still minimized.
      this.currentWindows = this.currentWindows.map((window) =>
        window.pid === pid ? { ...window, visible: !hidden && !window.minimized } : window,
      );
      this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
      this.emit({ type: "windows-changed", windows: this.currentWindows });
      return {
        deliveryPath: "fake-app-visibility",
        verified: "confirmed",
        effect: "verified",
      };
    });
  }

  verifyState(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): FakeEffect<ComputerVerifyStateResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("verifyState", windowId, expect);
      yield* this.takeFailure("verifyState");
      if (!this.currentWindows.some((window) => window.id === windowId)) {
        return yield* noWindow(windowId);
      }
      const status = this.verifySatisfied ? "satisfied" : "unsatisfied";
      return {
        status,
        stable: true,
        samples: 1,
        elapsedMs: 0,
        predicates: expect.map((_, index) => ({
          index,
          status,
          unknown_reason: null,
          observed_json: "{}",
        })),
      };
    });
  }

  zoomWindow(windowId: string, region: ComputerRect): FakeEffect<ComputerZoomResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("zoomWindow", windowId, region);
      yield* this.takeFailure("zoomWindow");
      const window = this.currentWindows.find((candidate) => candidate.id === windowId);
      if (!window) return yield* noWindow(windowId);
      const bounds = yield* requireWindowBounds(window, "a zoom capture");
      if (
        !Object.values(region).every(Number.isFinite) ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x < 0 ||
        region.y < 0 ||
        region.x + region.width > bounds.width ||
        region.y + region.height > bounds.height
      ) {
        return yield* refuse("The zoom region lies outside the target window.");
      }
      return {
        mimeType: "image/jpeg" as const,
        width: 1,
        height: 1,
        sizeBytes: Buffer.from(FAKE_ZOOM_BASE64, "base64").byteLength,
        bytesBase64: FAKE_ZOOM_BASE64,
        windowId,
        capturedAt: yield* this.timestamp,
      };
    });
  }

  killApp(pid: number): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("killApp", pid);
      yield* this.takeFailure("killApp");
      const owned = this.currentWindows.filter((window) => window.pid === pid);
      if (owned.length === 0) return yield* refuse(`No desktop window belongs to pid ${pid}.`);
      this.currentWindows = this.currentWindows.filter((window) => window.pid !== pid);
      this.currentApps = this.currentApps.map((app) =>
        app.pid === pid ? { ...app, running: false, active: false, pid: 0 } : app,
      );
      this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
      this.emit({ type: "windows-changed", windows: this.currentWindows });
      return {
        windowId: owned[0]!.id,
        deliveryPath: "fake-kill",
        verified: "confirmed",
        effect: "verified",
      };
    });
  }

  /**
   * Mirrors the driver's grant-free snapshot: only running apps and the
   * on-screen window subset appear there, so minimized and hidden windows are
   * filtered out rather than reported as a different "not visible" flag.
   */
  getAccessibilityTree(windowId?: string): FakeEffect<{
    readonly apps: readonly ComputerAccessibilityTreeApp[];
    readonly windows: readonly ComputerAccessibilityTreeWindow[];
    readonly truncated: boolean;
  }> {
    return Effect.gen({ self: this }, function* () {
      if (windowId === undefined) this.record("getAccessibilityTree");
      else this.record("getAccessibilityTree", windowId);
      yield* this.takeFailure("getAccessibilityTree");
      let scopedPid: number | undefined;
      if (windowId !== undefined) {
        const window = this.currentWindows.find((candidate) => candidate.id === windowId);
        if (!window) return yield* noWindow(windowId);
        scopedPid = window.pid;
      }
      const apps = this.currentApps
        .filter(
          (app) => app.running && app.pid > 0 && (scopedPid === undefined || app.pid === scopedPid),
        )
        .map(
          (app): ComputerAccessibilityTreeApp => ({
            pid: app.pid,
            name: app.name,
            ...(app.bundleId ? { bundleId: app.bundleId } : {}),
          }),
        )
        .slice(0, 1_024);
      const windows = this.currentWindows
        .filter(
          (window) =>
            window.visible &&
            !window.minimized &&
            window.pid !== undefined &&
            window.pid > 0 &&
            (scopedPid === undefined || window.pid === scopedPid),
        )
        .map(
          (window): ComputerAccessibilityTreeWindow => ({
            id: window.id,
            pid: window.pid!,
            ...(window.appName ? { appName: window.appName } : {}),
            title: window.title,
            ...(window.bounds ? { bounds: { ...window.bounds } } : {}),
            onScreen: true,
            ...(window.stackingIndex !== undefined ? { zIndex: window.stackingIndex } : {}),
          }),
        )
        .slice(0, 512);
      return { apps, windows, truncated: false };
    });
  }

  /**
   * The fake tracks where its own pointer actions last left the cursor, so a
   * `moveCursor` followed by this read round-trips the way the real driver
   * does.
   */
  getCursorPosition(
    windowId?: string,
  ): FakeEffect<Omit<ComputerCursorPosition, "computerId" | "availability">> {
    return Effect.gen({ self: this }, function* () {
      if (windowId === undefined) this.record("getCursorPosition");
      else this.record("getCursorPosition", windowId);
      yield* this.takeFailure("getCursorPosition");
      const window =
        windowId === undefined
          ? undefined
          : this.currentWindows.find((candidate) => candidate.id === windowId);
      if (windowId !== undefined && !window) return yield* noWindow(windowId);
      const { x, y } = this.cursorPosition;
      const bounds = window?.bounds;
      return {
        x,
        y,
        capturedAt: yield* this.timestamp,
        ...(window ? { windowId: window.id } : {}),
        ...(bounds
          ? {
              insideWindow:
                x >= bounds.x &&
                x < bounds.x + bounds.width &&
                y >= bounds.y &&
                y < bounds.y + bounds.height,
            }
          : {}),
      };
    });
  }

  /** Places the fake cursor directly, for tests that need a known point. */
  setCursorPosition(point: ComputerPoint): void {
    this.cursorPosition = { ...point };
  }

  /** Makes the next setWindowFrame report the dispatched-unverified shape. */
  setFrameApplies(applies: boolean): void {
    this.frameApplies = applies;
  }

  /** Configures a persistent refusal for one menu path, like a disabled item. */
  refuseMenuPath(path: readonly string[], error: ComputerOperationError): void {
    this.refusedMenuPaths.set(path.join("\u0000"), error);
  }

  setVerifySatisfied(satisfied: boolean): void {
    this.verifySatisfied = satisfied;
  }

  raiseWindow(windowId: string): FakeEffect<void> {
    return Effect.suspend(() => {
      this.record("raiseWindow", windowId);
      return this.takeFailure("raiseWindow");
    });
  }

  focusWindow(windowId: string): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("focusWindow", windowId);
      yield* this.takeFailure("focusWindow");
      // The pinned target is the only window that reports focused, so
      // clearing and re-pinning behave like the real seat.
      this.currentWindows = this.currentWindows.map((item) => ({
        ...item,
        focused: item.id === windowId,
      }));
    });
  }

  clearFocusWindow(): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("clearFocusWindow");
      yield* this.takeFailure("clearFocusWindow");
      // No pinned target means no window reports focused — the blind spot
      // behind the untargeted-scroll regression.
      this.currentWindows = this.currentWindows.map((item) => ({ ...item, focused: false }));
    });
  }

  click(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return this.pointerAction("click", point, modifiers);
  }

  doubleClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return this.pointerAction("doubleClick", point, modifiers);
  }

  tripleClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return this.pointerAction("tripleClick", point, modifiers);
  }

  rightClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return this.pointerAction("rightClick", point, modifiers);
  }

  moveCursor(point: ComputerPoint): FakeEffect<ComputerBackendActionResult> {
    return this.pointerAction("moveCursor", point);
  }

  drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    _windowId?: string,
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("drag", from, to, durationMs);
      yield* this.takeFailure("drag");
      yield* this.validatePoint(from);
      yield* this.validatePoint(to);
      this.cursorPosition = { ...to };
      return { point: to };
    });
  }

  scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      // Recorded only when present, so every existing assertion on a plain
      // scroll keeps matching its three-argument shape.
      if (modifiers && modifiers.length > 0)
        this.record("scroll", point, deltaX, deltaY, modifiers);
      else this.record("scroll", point, deltaX, deltaY);
      yield* this.takeFailure("scroll");
      if (point) yield* this.validatePoint(point);
      return point ? { point } : {};
    });
  }

  typeText(text: string): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("typeText", text);
      yield* this.takeFailure("typeText");
      return { value: text };
    });
  }

  pressKey(key: string): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("pressKey", key);
      yield* this.takeFailure("pressKey");
      return {};
    });
  }

  hotkey(keys: readonly string[]): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("hotkey", keys);
      yield* this.takeFailure("hotkey");
      return {};
    });
  }

  /** One in-memory string stands in for the shared system clipboard. */
  readClipboard(): FakeEffect<string> {
    return Effect.gen({ self: this }, function* () {
      this.record("readClipboard");
      yield* this.takeFailure("readClipboard");
      return this.clipboardText;
    });
  }

  writeClipboard(text: string): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("writeClipboard", text);
      yield* this.takeFailure("writeClipboard");
      this.clipboardText = text;
    });
  }

  setValue(target: ComputerResolvedTarget, value: string): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("setValue", target, value);
      yield* this.takeFailure("setValue");
      this.currentRoot = replaceNodeValue(this.currentRoot, target.node, value);
      return { point: target.point, value };
    });
  }

  performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("performAction", target, action);
      yield* this.takeFailure("performAction");
      return { point: target.point, value: action };
    });
  }

  /**
   * The fake's selection is the slice of the element's own value: its
   * "read-back" is exactly the substring the requested range covers, which
   * is the honest emulation of a driver that confirmed the write.
   */
  selectText(
    target: ComputerResolvedTarget,
    range: ComputerTextRange,
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      this.record("selectText", target, range);
      yield* this.takeFailure("selectText");
      return {
        point: target.point,
        value: (target.node.value ?? "").slice(range.start, range.start + range.length),
      };
    });
  }

  /** Starts publishing frames on `events`, opening with codec config and a keyframe. */
  attachStream(): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("attachStream");
      yield* this.takeFailure("attachStream");
      this.streamAttached = true;
      yield* this.emitFrame(true, true);
      yield* this.emitFrame(true, false);
    });
  }

  detachStream(): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("detachStream");
      yield* this.takeFailure("detachStream");
      this.streamAttached = false;
    });
  }

  requestKeyframe(): FakeEffect<void> {
    return Effect.gen({ self: this }, function* () {
      this.record("requestKeyframe");
      yield* this.takeFailure("requestKeyframe");
      if (!this.streamAttached) return;
      yield* this.emitFrame(true, true);
      yield* this.emitFrame(true, false);
    });
  }

  /** Ends `events` for every subscriber; later emits go nowhere. */
  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.record("dispose");
      this.disposed = true;
      this.streamAttached = false;
      return PubSub.shutdown(this.pubsub);
    });
  }

  /**
   * Publishes one frame while a stream is attached; a no-op otherwise. An
   * Effect because the frame's timestamp is read from the Effect clock.
   */
  emitFrame(
    keyframe = false,
    codecConfig = false,
    data = Uint8Array.of(0x01),
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!this.streamAttached || this.disposed) return;
      const timestampMs = yield* Clock.currentTimeMillis;
      this.emit({
        type: "frame",
        frame: { sequence: this.nextSequence++, timestampMs, keyframe, codecConfig, data },
      });
    });
  }

  emitWindowsChanged(windows: readonly ComputerWindow[]): void {
    this.currentWindows = [...windows];
    this.emit({ type: "windows-changed", windows: this.currentWindows });
  }

  /** Drives a supervision transition for tests. */
  emitHealthChanged(health: ComputerHealth): void {
    this.currentHealth = health;
    this.emit({ type: "health-changed", health });
  }

  /**
   * Reports a desktop lock/sleep/session interruption the way the real
   * backend does when a reply's `desktopInterruptions` count advances —
   * `pauses` are the reasons still active at observation time, empty when
   * the cycle already ended.
   */
  emitDesktopInterrupted(pauses: readonly string[] = []): void {
    this.emit({ type: "desktop-interrupted", pauses });
  }

  setAvailability(availability: ComputerAvailability): void {
    this.currentAvailability = availability;
  }

  setScreenSize(screenSize: ComputerScreenSize): void {
    this.currentScreenSize = screenSize;
  }

  /** Fails the next call of `method` (`"browser.<tool>"` for browser calls) with `error`. */
  failNext(
    method: string,
    error: ComputerOperationError = new ComputerBackendError({ message: `${method} failed` }),
  ): void {
    this.failures.set(method, error);
  }

  /**
   * Hands the next captures these exact PNG bytes, in order, so a test can make
   * two captures of one window differ — which is what any before/after
   * comparison needs and what the single fixed fixture cannot express. Captures
   * past the end of the queue return the fixture again.
   */
  queueScreenshots(bytesBase64List: readonly string[]): void {
    this.queuedScreenshots.push(...bytesBase64List);
  }

  callsFor(method: string): readonly FakeComputerCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * The shield ids the fake still considers up: engage adds, release removes.
   * Lets a test prove a stranded shield was actually cleaned rather than
   * trusting the call log alone.
   */
  activeShields(): readonly string[] {
    return [...this.liveShields];
  }

  private captureRect(request: ComputerCaptureRequest): FakeEffect<ComputerRect> {
    if (request.kind !== "window") return Effect.succeed(request.region);
    const window = this.currentWindows.find((candidate) => candidate.id === request.windowId);
    if (!window) return noWindow(request.windowId);
    return requireWindowBounds(window, "a window screenshot");
  }

  private workspaceRect(): ComputerRect {
    return {
      x: 0,
      y: 0,
      width: this.currentScreenSize.width,
      height: this.currentScreenSize.height,
    };
  }

  /**
   * Mirrors the real backend's contract: the reported region is the rect that
   * was captured, and the scale is the screenshot's pixels per logical pixel
   * after `maxDimension` downscaling.
   */
  private screenshotOfRegion(
    region: ComputerRect,
    maxDimension?: number,
  ): Effect.Effect<ComputerScreenshot> {
    return Effect.gen({ self: this }, function* () {
      const limit = maxDimension ?? DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION;
      const scale = Math.min(1, limit / Math.max(region.width, region.height));
      const bytesBase64 = this.queuedScreenshots.shift() ?? FAKE_SCREENSHOT_BASE64;
      return {
        mimeType: "image/png" as const,
        width: Math.max(1, Math.round(region.width * scale)),
        height: Math.max(1, Math.round(region.height * scale)),
        sizeBytes: Buffer.from(bytesBase64, "base64").byteLength,
        bytesBase64,
        region,
        scale,
        capturedAt: yield* this.timestamp,
      };
    });
  }

  private pointerAction(
    method: "click" | "doubleClick" | "tripleClick" | "rightClick" | "moveCursor",
    point: ComputerPoint,
    modifiers?: readonly ComputerInputModifier[],
  ): FakeEffect<ComputerBackendActionResult> {
    return Effect.gen({ self: this }, function* () {
      // Recorded only when present, so every existing assertion on a plain
      // pointer call keeps matching its two-argument shape.
      if (modifiers && modifiers.length > 0) this.record(method, point, modifiers);
      else this.record(method, point);
      yield* this.takeFailure(method);
      yield* this.validatePoint(point);
      this.cursorPosition = { ...point };
      return { point };
    });
  }

  private validatePoint(point: ComputerPoint): FakeEffect<void> {
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= this.currentScreenSize.width ||
      point.y >= this.currentScreenSize.height
    ) {
      return refuse(`Point (${point.x}, ${point.y}) is outside the fake screen`);
    }
    return Effect.void;
  }

  private record(method: string, ...args: readonly unknown[]): void {
    this.calls.push({ method, args });
    if (this.calls.length > MAX_RECORDED_CALLS) {
      this.calls.splice(0, this.calls.length - MAX_RECORDED_CALLS);
    }
  }

  /** Consumes the failure `failNext` armed for `method`, if any. */
  private takeFailure(method: string): FakeEffect<void> {
    return Effect.suspend(() => {
      const error = this.failures.get(method);
      if (!error) return Effect.void;
      this.failures.delete(method);
      return Effect.fail(error);
    });
  }

  private emit(event: ComputerBackendEvent): void {
    PubSub.publishUnsafe(this.pubsub, event);
  }
}

function defaultWindows(): ComputerWindow[] {
  return [
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
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
    },
  ];
}

function defaultApps(windows: readonly ComputerWindow[]): ComputerApp[] {
  return windows.flatMap((window) => {
    if (window.pid === undefined || !window.appName) return [];
    return [
      {
        pid: window.pid,
        name: window.title || window.appName,
        bundleId: window.appName,
        running: true,
        active: window.focused,
        windowCount: 1,
      },
    ];
  });
}

function defaultRoot(
  screenSize: ComputerScreenSize,
  windows: readonly ComputerWindow[],
): ComputerUiNode {
  const calculator = windows.find((window) => window.id === "fake-calculator") ?? windows[0];
  const windowId = calculator?.id ?? null;
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "Fake desktop",
    frame: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: [
      {
        role: "window",
        label: calculator?.title ?? "Calculator",
        value: null,
        description: null,
        frame: calculator?.bounds ?? { x: 20, y: 20, width: 400, height: 400 },
        activationPoint: null,
        onScreen: true,
        windowId,
        children: [
          {
            role: "button",
            label: "Calculate",
            value: null,
            description: "Calculate",
            frame: {
              x: (calculator?.bounds?.x ?? 20) + 40,
              y: (calculator?.bounds?.y ?? 20) + 80,
              width: 180,
              height: 56,
            },
            activationPoint: null,
            onScreen: true,
            windowId,
            children: [],
          },
          {
            role: "text-field",
            label: "Display",
            value: "0",
            description: "Calculator display",
            frame: {
              x: (calculator?.bounds?.x ?? 20) + 40,
              y: (calculator?.bounds?.y ?? 20) + 20,
              width: 280,
              height: 48,
            },
            activationPoint: {
              x: (calculator?.bounds?.x ?? 20) + 180,
              y: (calculator?.bounds?.y ?? 20) + 44,
            },
            onScreen: true,
            windowId,
            children: [],
          },
        ],
      },
    ],
  };
}

function replaceNodeValue(
  root: ComputerUiNode,
  target: ComputerUiNode,
  value: string,
): ComputerUiNode {
  return {
    ...root,
    value: root === target ? value : root.value,
    children: root.children.map((child) => replaceNodeValue(child, target, value)),
  };
}
