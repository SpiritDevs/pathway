import {
  COMPUTER_DELIVERY_PATH_MAX_LENGTH,
  COMPUTER_MESSAGE_MAX_LENGTH,
  type ComputerAccessibilityTreeApp,
  type ComputerAccessibilityTreeWindow,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerCursorPosition,
  type ComputerDeliveryVerification,
  type ComputerHealth,
  type ComputerId,
  type ComputerInputModifier,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerScreenshot,
  type ComputerSpaceInventory,
  type ComputerState,
  type ComputerTarget,
  type ComputerUiNode,
  type ComputerVerifyStateResult,
  type ComputerWindow,
  type ComputerZoomResult,
} from "@spiritdevs/contracts";
import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@spiritdevs/shared/modelImageBudget";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";

/**
 * The longest side, in pixels, of any screenshot handed to a model.
 *
 * This is a correctness bound before it is a cost one. Vision APIs downscale an
 * image whose long edge exceeds roughly 1568 px before the model ever sees it,
 * and the model then reads coordinates off a picture the server never produced.
 * Nothing in this pipeline may depend on API-side resizing: Pathway does the
 * downscale itself, records the resulting frame, and maps the model's pixels
 * through the frame it actually delivered.
 *
 * 1536 rather than something smaller because image tokens scale with area but a
 * smaller budget loses the precision needed to read a dense form or aim at a
 * small field; the real savings come from the byte-identical dedupe that never
 * resends an unchanged frame at all.
 */
export const COMPUTER_AGENT_IMAGE_MAX_DIMENSION = MODEL_SCREEN_IMAGE_MAX_DIMENSION;
/** Longest screenshot side in pixels before a capture is downscaled. */
export const DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** The budget a post-action observation spends. */
export const COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** Native per-side image limit enforced by the KWin capture path. */
export const MAX_COMPUTER_CAPTURE_MAX_DIMENSION = 16_384;
/**
 * Largest clipboard payload a backend moves in either direction. Clipboards
 * hold whole documents, so both directions need a ceiling.
 */
export const MAX_COMPUTER_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * The id every real desktop backend reports for the one computer it drives.
 * Shared because the frame socket, the pane, and the thread state all address
 * that desktop by it.
 */
export const DEFAULT_COMPUTER_ID = "desktop";

/** Refuses a clipboard write past `MAX_COMPUTER_CLIPBOARD_BYTES`, for every backend. */
export function computerClipboardWriteError(text: string): ComputerBackendError | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_COMPUTER_CLIPBOARD_BYTES) return undefined;
  return new ComputerBackendError({
    message: `Clipboard text is ${bytes} bytes, past the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte limit this tool writes.`,
  });
}

/**
 * A zoomed capture request: one window, or one rect of the global desktop
 * coordinate space that window bounds and pointer actions already use.
 */
export type ComputerCaptureRequest =
  | { readonly kind: "window"; readonly windowId: string; readonly maxDimension?: number }
  | { readonly kind: "region"; readonly region: ComputerRect; readonly maxDimension?: number };

export interface ComputerStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export interface ComputerResolvedTarget {
  readonly target: ComputerTarget;
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

/**
 * An exact character range on a text element's value. `start` is the
 * zero-based character offset and `length` the number of characters; `0`
 * collapses the selection to a caret at `start`.
 */
export interface ComputerTextRange {
  readonly start: number;
  readonly length: number;
}

/**
 * How a menu invocation names its target. `windowId` walks one window's owning
 * app; `app`/`pid` select the application-level menu bar without resolving,
 * focusing, or raising any window. A caller names exactly one.
 */
export type ComputerMenuTarget =
  | { readonly windowId: string }
  | { readonly app: string }
  | { readonly pid: number };

/**
 * What a backend receives: the window form, or the process form the manager's
 * app resolution already settled on.
 */
export type ComputerMenuBackendTarget = { readonly windowId: string } | { readonly pid: number };

export interface ComputerBackendActionResult {
  readonly point?: ComputerPoint;
  /**
   * Set when the display server refused the requested point and moved the
   * pointer elsewhere (multi-monitor layouts with gaps between outputs).
   */
  readonly clampedTo?: ComputerPoint;
  readonly windowId?: string;
  readonly value?: string;
  /**
   * Which rung of a backend's delivery ladder actually ran, and what the backend
   * could establish about the outcome. `verified` is three-valued: `confirmed`
   * means the effect was read back, `unconfirmed` that the read-back did not
   * show it, and `unverifiable` that the surface exposes nothing to check.
   */
  readonly deliveryPath?: string;
  readonly verified?: ComputerDeliveryVerification;
  readonly effect?: "not-dispatched" | "dispatched-unknown" | "verified";
  /** Native wheel units converted to injected pixel deltas, before app handling. */
  readonly scrollDelta?: { readonly deltaX: number; readonly deltaY: number };
}

export type ComputerBackendEvent =
  | { readonly type: "windows-changed"; readonly windows: readonly ComputerWindow[] }
  | { readonly type: "health-changed"; readonly health: ComputerHealth }
  | { readonly type: "capabilities-changed"; readonly capabilities: ComputerCapabilities }
  /**
   * The host proved a desktop availability interruption (screen lock, system
   * sleep, or a session switch) ran since the previous reply. Consent granted
   * before the interruption must not silently authorize the post-interruption
   * desktop, so the manager revokes standing task grants on this event.
   */
  | {
      readonly type: "desktop-interrupted";
      /** The pause reasons the host reported active at reply time. */
      readonly pauses: readonly string[];
    }
  | { readonly type: "frame"; readonly frame: ComputerStreamFrame };

/**
 * What one masked-activation shield should cover. `shieldId` is caller-minted
 * so a lost engage reply still leaves a releasable handle; `label` is painted on
 * the shield as the operator-facing disclosure.
 */
export interface ComputerShieldTarget {
  readonly shieldId: string;
  readonly windowId: string;
  readonly frame: ComputerRect;
  readonly label: string;
}

/**
 * One call into the driver's CDP browser surface. `name` is a driver tool name,
 * `args` the sanitized model arguments. `task` is the trusted local attribution.
 * `mutation` marks calls whose loss mid-dispatch must be reported as an
 * uncertain effect rather than retried. Cancellation is fiber interruption.
 */
export interface ComputerBrowserCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly task: { readonly threadId: string; readonly turnId?: string; readonly label?: string };
  readonly mutation: boolean;
}

/** The driver's MCP-shaped reply, carried verbatim. */
export interface ComputerBrowserCallResult {
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/**
 * The browser half of a desktop backend. Absent means "no browser surface":
 * callers must not advertise the tools.
 */
export interface ComputerBrowserBackend {
  readonly call: (
    call: ComputerBrowserCall,
  ) => Effect.Effect<ComputerBrowserCallResult, ComputerOperationError>;
  /** End every driver browser session attributed to this thread. */
  readonly endThread?: (threadId: string) => Effect.Effect<void, ComputerOperationError>;
}

/**
 * What a backend that does not exist can do, which is nothing. An absent
 * capability set reads as a fully capable one, so state payloads with no
 * backend behind them carry this instead.
 */
export const NO_COMPUTER_CAPABILITIES: ComputerCapabilities = {
  windows: false,
  windowBounds: false,
  stacking: false,
  capture: false,
  input: false,
  clipboard: false,
  focus: false,
  raise: false,
  ghostCursor: false,
  visibleDesktop: false,
};

/**
 * Which desktop vocabulary a backend speaks: what a keyboard shortcut may
 * contain, which semantic action names the accessibility layer accepts, and
 * what an application identifier looks like.
 */
export type ComputerAgentDialect = "linux" | "macos";

type BackendEffect<A> = Effect.Effect<A, ComputerOperationError>;
export type ComputerBackendAction = BackendEffect<ComputerBackendActionResult | undefined>;

/**
 * Provider-side contract shared by real display backends and the CI fake.
 *
 * Every native call is an Effect that fails with a typed computer error and is
 * cancelled by interruption. Synchronous members stay synchronous because the
 * contract promises they are free reads of what the backend already knows.
 */
export interface ComputerBackend {
  /** Absent means `"linux"`: the evdev + AT-SPI pair. */
  readonly agentDialect?: ComputerAgentDialect;
  readonly computerId: ComputerId;
  /**
   * Whether this host could drive a desktop, answered without doing anything to
   * it: no session is started, nothing is installed, no connection outlives the
   * call. Boot and thread-state seeding read this. Optimism is the intended
   * failure mode.
   */
  readonly probeAvailability: () => BackendEffect<ComputerAvailability>;
  /**
   * Availability as established, not as guessed: this may connect, install, and
   * load whatever the backend needs. `refresh` bypasses an established snapshot.
   */
  readonly availability: (options?: {
    readonly refresh?: boolean;
  }) => BackendEffect<ComputerAvailability>;
  /** Install whatever this backend needs, on explicit request; one sentence back. */
  readonly provision?: () => BackendEffect<string>;
  /** Live supervision health. Synchronous and side-effect free. */
  readonly health: () => ComputerHealth;
  /** What this backend can do once it is up. Synchronous and cheap. */
  readonly capabilities: () => ComputerCapabilities;
  /**
   * OS privacy grants this backend needs and does not have, established rather
   * than remembered. Empty means nothing is missing or nothing has looked yet.
   */
  readonly missingPermissions?: () => BackendEffect<readonly ComputerPermission[]>;
  /** How this build is code-signed, as the last probe read it. */
  readonly buildSignature?: () => ComputerBuildSignature | undefined;
  readonly listWindows: () => BackendEffect<readonly ComputerWindow[]>;
  /** Optional real managed-display inventory, including empty Spaces. Never changes the desktop. */
  readonly listSpaces?: () => BackendEffect<ComputerSpaceInventory>;
  readonly getScreenSize: () => BackendEffect<ComputerScreenSize>;
  readonly getState: (options: {
    readonly includeScreenshot?: boolean;
    /** Walk the accessibility tree and return it as `root`. */
    readonly includeTree?: boolean;
    readonly windowId?: string;
    /**
     * Internal target resolution may reuse a tree observed moments ago. The
     * agent-facing state tools never set this: what the model reads stays fresh.
     */
    readonly reuseRecentTree?: boolean;
  }) => BackendEffect<ComputerState>;
  /** Zoomed perception of one window or region. */
  readonly captureScreenshot: (
    request: ComputerCaptureRequest,
  ) => BackendEffect<ComputerScreenshot>;
  /** Pin or release the per-seat target window when supported. */
  readonly focusWindow?: (windowId: string) => BackendEffect<void>;
  /** Restack a window above the ones covering it, without moving keyboard focus. */
  readonly raiseWindow?: (windowId: string) => BackendEffect<void>;
  readonly clearFocusWindow?: () => BackendEffect<void>;
  /** Names the thread holding the desktop, for an agent-cursor label. Best effort. */
  readonly setDrivingAgent?: (name: string | null) => BackendEffect<void>;
  /** Cosmetic activity only: never activates a window or sends input. */
  readonly setCursorActivity?: (text: string | null) => BackendEffect<void>;
  readonly launchApp: (
    app: string,
    args: readonly string[],
    options?: {
      /** Request a hidden, non-activating launch. */
      readonly hidden?: boolean;
    },
  ) => BackendEffect<ComputerLaunchAppResult>;
  /** Fresh exact-window readiness only; never focus, raise, or send input. */
  readonly checkInputReady?: (windowId: string) => BackendEffect<void>;
  /**
   * Driver-observed UI settle for the exact window: resolves once no
   * accessibility notification arrives for `quietMs`, bounded by `timeoutMs`.
   */
  readonly waitForSettle?: (options: {
    readonly windowId: string;
    readonly timeoutMs: number;
    readonly quietMs: number;
  }) => BackendEffect<{
    readonly settled: boolean;
    readonly waitedMs: number;
    readonly eventsSeen?: number;
  }>;
  /** The process-level app list, for backends that can enumerate it. */
  readonly listApps?: () => BackendEffect<readonly ComputerApp[]>;
  /** Move and resize the exact window to `frame` in desktop coordinates. */
  readonly setWindowFrame?: (windowId: string, frame: ComputerRect) => ComputerBackendAction;
  /** Invoke a menu-bar path such as `["File", "Save"]`. */
  readonly invokeMenu?: (
    target: ComputerMenuBackendTarget,
    path: readonly string[],
  ) => ComputerBackendAction;
  /** Assert a predicate set against the exact window's live state. Pure read. */
  readonly verifyState?: (
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ) => BackendEffect<ComputerVerifyStateResult>;
  /** A magnified capture of a window-local rect inside the exact window. */
  readonly zoomWindow?: (
    windowId: string,
    region: ComputerRect,
  ) => BackendEffect<ComputerZoomResult>;
  /** The driver's desktop-wide inventory, optionally scoped to one window's app. */
  readonly getAccessibilityTree?: (windowId?: string) => BackendEffect<{
    readonly apps: readonly ComputerAccessibilityTreeApp[];
    readonly windows: readonly ComputerAccessibilityTreeWindow[];
    readonly truncated: boolean;
  }>;
  /** The human cursor's position in desktop points; a read, never a move. */
  readonly getCursorPosition?: (
    windowId?: string,
  ) => BackendEffect<Omit<ComputerCursorPosition, "computerId" | "availability">>;
  /** Minimize or restore the exact window without activating it. */
  readonly setWindowMinimized?: (windowId: string, minimized: boolean) => ComputerBackendAction;
  /** Hide or unhide a running application by pid without activating it. */
  readonly setAppVisibility?: (pid: number, hidden: boolean) => ComputerBackendAction;
  /** Force-terminate a process by pid. */
  readonly killApp?: (pid: number) => ComputerBackendAction;
  /** True only when this fresh target advertises the native semantic action. */
  readonly supportsAction?: (target: ComputerResolvedTarget, action: string) => boolean;
  /**
   * `windowId` is the window the caller resolved this point to. A backend that
   * posts to a window by id uses it as the delivery target.
   */
  readonly click: (
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ) => ComputerBackendAction;
  readonly doubleClick: (
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ) => ComputerBackendAction;
  /**
   * One gesture with click count three. Optional because a backend that cannot
   * express it must refuse rather than approximate it with three clicks.
   */
  readonly tripleClick?: (
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ) => ComputerBackendAction;
  readonly rightClick: (
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ) => ComputerBackendAction;
  readonly moveCursor: (point: ComputerPoint, windowId?: string) => ComputerBackendAction;
  readonly drag: (
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ) => ComputerBackendAction;
  readonly scroll: (
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
    target?: ComputerResolvedTarget,
  ) => ComputerBackendAction;
  /** Whether an exact semantic text target can be mutated without activation. */
  readonly focusNeutralSemanticText?: boolean;
  /** Exact targets are revalidated and background input never falls back to global input. */
  readonly exactTargetBackgroundInput?: boolean;
  readonly typeText: (
    text: string,
    windowId?: string,
    target?: ComputerResolvedTarget,
  ) => ComputerBackendAction;
  readonly pressKey: (
    key: string,
    windowId?: string,
    target?: ComputerResolvedTarget,
  ) => ComputerBackendAction;
  readonly hotkey: (
    keys: readonly string[],
    windowId?: string,
    target?: ComputerResolvedTarget,
  ) => ComputerBackendAction;
  /** The system clipboard the human shares, not an agent-private one. */
  readonly readClipboard?: () => BackendEffect<string>;
  /** Writes the same shared system clipboard `readClipboard` reads. */
  readonly writeClipboard?: (text: string) => BackendEffect<void>;
  readonly setValue: (target: ComputerResolvedTarget, value: string) => ComputerBackendAction;
  readonly performAction: (target: ComputerResolvedTarget, action: string) => ComputerBackendAction;
  /** Select an exact character range through the accessibility layer. */
  readonly selectText: (
    target: ComputerResolvedTarget,
    range: ComputerTextRange,
  ) => ComputerBackendAction;
  /** Backend notifications, frames included. Absent for a backend with nothing to say. */
  readonly events?: Stream.Stream<ComputerBackendEvent>;
  /** Start publishing `frame` events on `events`. */
  readonly attachStream: () => BackendEffect<void>;
  readonly detachStream: () => BackendEffect<void>;
  readonly requestKeyframe?: () => BackendEffect<void>;
  /**
   * The masked-activation shield. `engageShield` resolves once the shield is on
   * screen and must fail rather than degrade. Release calls are idempotent.
   */
  readonly engageShield?: (target: ComputerShieldTarget) => BackendEffect<string>;
  readonly releaseShield?: (shieldId: string) => BackendEffect<void>;
  readonly releaseAllShields?: () => BackendEffect<void>;
  readonly stopInput?: (task?: {
    readonly threadId: string;
    readonly turnId?: string;
  }) => BackendEffect<void>;
  /** Release task-owned observation resources, including read-only turns. */
  readonly endTask?: (threadId: string, turnId?: string) => BackendEffect<void>;
  /** The CDP browser surface this backend exposes, if any. */
  readonly browser?: ComputerBrowserBackend;
  readonly dispose: () => Effect.Effect<void>;
}

/**
 * Overlap of two desktop rects, or `undefined` when they do not overlap. Both
 * backends clip a capture request to what actually exists on the workspace.
 */
export function intersectComputerRects(
  first: ComputerRect,
  second: ComputerRect,
): ComputerRect | undefined {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Message text that satisfies the contract's bound on availability and health
 * strings. Both are built from error text the backend does not control, so an
 * empty or oversized message degrades here rather than failing the payload.
 */
export function clampComputerMessage(text: string, fallback: string): string {
  const trimmed = text.trim();
  const message = trimmed.length > 0 ? trimmed : fallback;
  return message.length > COMPUTER_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, COMPUTER_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

export function computerBackendActionResult(
  computerId: string,
  action: string,
  result: ComputerBackendActionResult | undefined,
): ComputerActionResult {
  return {
    computerId,
    action,
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.clampedTo ? { clampedTo: result.clampedTo } : {}),
    ...(result?.windowId ? { windowId: result.windowId } : {}),
    ...(result?.value !== undefined ? { value: result.value } : {}),
    // Both halves or neither: a path with no verdict cannot tell a caller
    // whether the input landed. The path is clamped here because it is copied
    // verbatim out of a helper reply.
    ...(result?.deliveryPath !== undefined && result.verified !== undefined
      ? {
          delivery: {
            path: result.deliveryPath.slice(0, COMPUTER_DELIVERY_PATH_MAX_LENGTH),
            verified: result.verified,
            ...(result.effect ? { effect: result.effect } : {}),
          },
        }
      : {}),
  } as ComputerActionResult;
}
