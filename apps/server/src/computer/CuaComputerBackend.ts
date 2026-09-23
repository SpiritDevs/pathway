/**
 * The Cua backend. Cua owns native actions; Pathway owns admission, session
 * authority, explicit delivery policy and the provider result.
 *
 * Every request goes to the Pathway desktop host over its socket (`request`,
 * `cuaRequest` by default). Desktop and browser calls race the operation's
 * desktop signal, so an aborted operation fails with the abort reason; cleanup
 * paths (stop, end task, shield release) never race it, so they still land
 * while their own operation is being cancelled.
 *
 * Build one with `makeCuaComputerBackend` in the layer scope. The still-frame
 * loop, the snapshot refresh, and the semantic text lanes are fibers in that
 * scope; closing it disposes the backend.
 *
 * @module computer/CuaComputerBackend
 */
import {
  COMPUTER_WINDOW_LIST_MAX_LENGTH,
  type ComputerAccessibilityTreeApp,
  type ComputerAccessibilityTreeWindow,
  type ComputerApp,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerCursorPosition,
  type ComputerHealth,
  type ComputerInputModifier,
  type ComputerInputPause,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerScreenshot,
  type ComputerState,
  type ComputerUiNode,
  type ComputerVerifyStateResult,
  type ComputerWindow,
  type ComputerZoomResult,
} from "@spiritdevs/contracts";
import {
  computerPermissionSetupMessage,
  listComputerPermissions,
} from "@spiritdevs/shared/computerGrants";
import { parseCuaActionDiagnostics } from "@spiritdevs/shared/cuaActionDiagnostics";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import {
  CUA_HOST_SOCKET_ENV,
  CUA_SETUP_TIMEOUT_MS,
  CuaTransportError,
  cuaComputerTaskKey,
  cuaRequest,
  type CuaComputerTask,
  type CuaEffect,
  type CuaReply,
  type CuaToolResult,
} from "@spiritdevs/shared/cuaDriverProtocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { jpegDimensions } from "../jpegHeader.ts";
import { pngDimensions } from "../pngHeader.ts";
import {
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  computerClipboardWriteError,
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
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
  ComputerSpaceError,
  CuaActionError,
  errorMessage,
  isCuaActionError,
  type ComputerOperationError,
} from "./computerErrors.ts";
import {
  cuaPreviewStillMsOverride,
  currentComputerCall,
  timedComputerLeg,
} from "./computerCallContext.ts";
import {
  observedComputerTargetNode,
  registerNativeComputerElement,
} from "./computerElementIdentity.ts";
import { currentComputerTask } from "./computerTaskContext.ts";
import { cuaSpaceInventory } from "./cuaSpaceInventory.ts";
import {
  assertDesktopOperationActive,
  awaitDesktopSignal,
  checkDesktopSignal,
  desktopDeliveryMode,
  desktopOperationSignal,
  desktopSignal,
  isDesktopSignalAborted,
  makeDesktopAbort,
  raceDesktopSignal,
} from "./DesktopOperationQueue.ts";
import { isModelDesktopObservationActive } from "./modelDesktopObservation.ts";
import { makeStillFramePublisher, resolveStillIntervalMs } from "./stillFramePublisher.ts";

export { CuaActionError } from "./computerErrors.ts";

type Failure = ComputerOperationError;
type BackendEffect<A> = Effect.Effect<A, Failure>;

/** The socket client seam: `cuaRequest` in production, a fixture in tests. */
export type CuaRequest = (
  socketPath: string,
  request: unknown,
  options?: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number;
    readonly mutation?: boolean;
  },
) => Promise<unknown>;

export interface CuaComputerBackendOptions {
  /** The desktop host socket; defaults to `PATHWAY_CUA_HOST_SOCKET`. */
  readonly endpoint?: string | undefined;
  readonly capability?: string | undefined;
  readonly request?: CuaRequest;
  /** Test injection so lane tests do not wait out the real hold. */
  readonly semanticTextLaneHoldMs?: number;
  /** Test injection so lane tests do not wait out the real gap. */
  readonly semanticTextLaneGapMs?: number;
  /**
   * Still-capture cadence for the pane preview; defaults to
   * `PATHWAY_CUA_PREVIEW_STILL_MS`, then 1000 ms.
   */
  readonly stillIntervalMs?: number;
}

const actionError = (
  message: string,
  effect: CuaEffect,
  code?: string,
  inputPause?: ComputerInputPause,
): Effect.Effect<never, CuaActionError> =>
  Effect.fail(new CuaActionError(message, effect, code, inputPause));

/** Synara's bare `Error` throws: a fault with no delivery verdict. */
const plainError = (message: string): Effect.Effect<never, ComputerBackendError> =>
  Effect.fail(new ComputerBackendError({ message }));

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 1024): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : NaN;

const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)),
);

function captureAccessAvailable(permission: Record<string, unknown>, platform: string): boolean {
  if (platform !== "linux" || typeof permission.screen_recording === "boolean")
    return permission.screen_recording === true;
  // These are display prerequisites, not proof that every compositor exposes
  // capture. A failed real capture still marks capture health unavailable.
  return (
    permission.x11 === true || (permission.wayland === true && permission.wayland_enabled === true)
  );
}

function missingComputerPermissions(
  permission: Record<string, unknown>,
  platform: string,
): ComputerPermission[] {
  const missing: ComputerPermission[] = [];
  const accessibility =
    platform === "linux"
      ? (permission.atspi ?? permission.accessibility)
      : permission.accessibility;
  if (accessibility !== true) missing.push("accessibility");
  if (!captureAccessAvailable(permission, platform)) missing.push("screenRecording");
  // Only the macOS host with a physical input listener reports this grant.
  // Legacy/standalone drivers must not acquire an invented macOS requirement.
  if (platform === "darwin" && permission.input_monitoring === false)
    missing.push("inputMonitoring");
  return missing;
}

function optionalRect(value: unknown): ComputerRect | undefined {
  const r = record(value);
  const out = {
    x: number(r.x),
    y: number(r.y),
    width: number(r.width ?? r.w),
    height: number(r.height ?? r.h),
  };
  return Object.values(out).every(Number.isFinite) && out.width > 0 && out.height > 0
    ? out
    : undefined;
}

const sameRect = (a: ComputerRect, b: ComputerRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Structural equality for the plain JSON health record. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return (
    keys.length === otherKeys.length &&
    keys.every((key, index) => key === otherKeys[index] && sameValue(left[key], right[key]))
  );
}

/**
 * The driver's proof a visibility mutation landed: `effect: confirmed` backed
 * by a `value_readback` evidence row — the AXMinimized/isHidden re-read the
 * native tool itself took. The bare success text is never trusted on its own,
 * and the window list exposes no minimized flag to check against, so this
 * record is the only evidence the verdict can stand on.
 */
function confirmedValueReadback(data: Record<string, unknown>): boolean {
  return (
    data.effect === "confirmed" &&
    Array.isArray(data.evidence) &&
    data.evidence.some((item) => text(record(item).kind) === "value_readback")
  );
}

/**
 * The one tab a browser bind can point a pane still at: the only tab, or the
 * only active one. An ambiguous bind mints no still target — the pane waits
 * for the tab the next call names rather than guessing.
 */
function resolvableStillTab(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const tabs = value.flatMap((entry) => {
    const tab = record(entry);
    const id = text(tab.tab_id);
    return id ? [{ id, active: tab.active === true }] : [];
  });
  if (tabs.length === 1) return tabs[0]!.id;
  const active = tabs.filter((tab) => tab.active);
  return active.length === 1 ? active[0]!.id : undefined;
}

/** Longest a semantic text caller may wait, including its lane admission,
 * before failing honestly. The underlying write still drains so lane order
 * survives the timeout and nothing is replayed. Same-window writes serialize
 * because the native semantic lease is per (pid, window): a second concurrent
 * lease for one exact window is refused outright (driver rev 12), and AX
 * insertions plus their readback verification on one element must not
 * interleave. Different windows — same pid included — overlap. */
export const CUA_SEMANTIC_TEXT_LANE_HOLD_MS = 15_000;
/** Settle gap the lane holds after each semantic text write, so the next
 * same-window insertion starts after AX quiesces. Bounded and inside the lane. */
export const CUA_SEMANTIC_TEXT_LANE_GAP_MS = 100;
/** How long an observed element tree may serve internal target resolution.
 * Native dispatch still validates the element token, so expiry is the drift
 * bound for a control that survives but moved or changed meaning. */
const RECENT_TREE_TTL_MS = 5_000;
/**
 * Pane preview still cadence when nothing overrides it. Slower than the
 * Tier-1 default: each tick re-observes the exact window or browser tab the
 * task is using, and the pane reads as live at one hertz.
 * `PATHWAY_CUA_PREVIEW_STILL_MS` replaces it; the factory option replaces it
 * in tests.
 */
const CUA_STILL_FRAME_INTERVAL_MS = 1_000;
/** Ordinary host round-trip bound. */
const CUA_HOST_TIMEOUT_MS = 35_000;

/**
 * The semantic element actions this integration admits, what the pinned
 * driver's `click` element path performs for each (`action` argument, mapped
 * in `ax_actions::map_action`), and the AX action the element must advertise
 * for Pathway to dispatch it.
 *
 * The driver's `map_action` silently defaults any unknown spelling to
 * AXPress, so names are mapped here explicitly: an unlisted request refuses
 * before dispatch rather than becoming a press the caller never asked for.
 */
const CUA_ELEMENT_ACTIONS: Readonly<
  Record<string, { readonly driverAction: string; readonly axAction: string }>
> = {
  axpress: { driverAction: "press", axAction: "AXPress" },
  press: { driverAction: "press", axAction: "AXPress" },
  open: { driverAction: "open", axAction: "AXOpen" },
  show_menu: { driverAction: "show_menu", axAction: "AXShowMenu" },
  menu: { driverAction: "show_menu", axAction: "AXShowMenu" },
  pick: { driverAction: "pick", axAction: "AXPick" },
  confirm: { driverAction: "confirm", axAction: "AXConfirm" },
  cancel: { driverAction: "cancel", axAction: "AXCancel" },
};

function cuaElementAction(
  name: string,
): { readonly driverAction: string; readonly axAction: string } | undefined {
  return Object.hasOwn(CUA_ELEMENT_ACTIONS, name.toLowerCase())
    ? CUA_ELEMENT_ACTIONS[name.toLowerCase()]
    : undefined;
}

// Pathway-side spellings that already resolve to a driver keyname. Only
// entries whose target the pinned keymap accepts may live here: a name with
// no driver mapping (keypad keys, f13-f20, menu, help) passes through
// untouched so the driver's own "Unknown key name" refusal stays the honest
// gate and an extended keymap revision lights them up without a Pathway
// change. Left-side modifier spellings resolve to the one physical code the
// driver posts for that modifier; right-side spellings stay refused until
// the keymap carries the right-key codes.
const CUA_KEY_ALIASES: Readonly<Record<string, string>> = {
  meta: "command",
  super: "command",
  super_l: "command",
  win: "command",
  delete: "forward_delete",
  del: "forward_delete",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  " ": "space",
  page_up: "pageup",
  pgup: "pageup",
  prior: "pageup",
  page_down: "pagedown",
  pgdn: "pagedown",
  next: "pagedown",
  caps_lock: "capslock",
  shift_l: "shift",
  ctrl_l: "ctrl",
  control_l: "ctrl",
  alt_l: "alt",
  option_l: "alt",
};

const HOTKEY_MODIFIERS = new Set([
  "command",
  "cmd",
  "shift",
  "option",
  "alt",
  "ctrl",
  "control",
  "fn",
]);

/** Driver keynames for `values`, refusing before dispatch when one has no mapping. */
function cuaKeys(values: readonly string[]): Effect.Effect<string[], CuaActionError> {
  const keys: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (key === "insert" || key === "ins")
      return actionError(
        "Cua 0.28.2 has no Insert key mapping on macOS.",
        "not-dispatched",
        "unsupported_operation",
      );
    keys.push(Object.hasOwn(CUA_KEY_ALIASES, key) ? CUA_KEY_ALIASES[key]! : key);
  }
  return Effect.succeed(keys);
}

interface ResolvedWindow {
  readonly pid: number;
  readonly window_id: number;
  readonly window: ComputerWindow;
  readonly baseline: number | undefined;
}

type StillTarget =
  | { readonly kind: "window"; readonly windowId: string }
  | {
      readonly kind: "browser";
      readonly targetId: string;
      readonly tabId: string | undefined;
      readonly task: CuaComputerTask;
    };

type WebField = { readonly token: string; readonly index: number; readonly value: string | null };

/**
 * Builds the Cua backend. The still loop, snapshot refreshes and semantic text
 * lanes run in the current scope; closing it disposes the backend.
 */
export const makeCuaComputerBackend = (options: CuaComputerBackendOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const events = yield* PubSub.unbounded<ComputerBackendEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));

    const localPlatform = yield* HostProcessPlatform;
    const endpoint = options.endpoint ?? process.env[CUA_HOST_SOCKET_ENV];
    const capability = options.capability;
    const request: CuaRequest = options.request ?? cuaRequest;
    const semanticTextLaneHoldMs = options.semanticTextLaneHoldMs ?? CUA_SEMANTIC_TEXT_LANE_HOLD_MS;
    const semanticTextLaneGapMs = options.semanticTextLaneGapMs ?? CUA_SEMANTIC_TEXT_LANE_GAP_MS;

    const state = {
      windows: [] as readonly ComputerWindow[],
      size: { width: 1, height: 1 } as ComputerScreenSize,
      permissions: [] as ComputerPermission[],
      currentAvailability: {
        kind: "backend-unavailable",
        message: "Computer has not connected to the Pathway desktop app.",
      } as ComputerAvailability,
      currentHealth: {
        status: "unavailable",
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: false,
      } as ComputerHealth,
      captureFailed: false,
      snapshotAt: 0,
      hadMissingPermissions: false,
      /** The refresh in flight; every concurrent caller awaits the same one. */
      snapshot: undefined as Deferred.Deferred<void, Failure> | undefined,
      selectedWindow: undefined as string | undefined,
      desktopEpoch: undefined as number | undefined,
      /**
       * The host's interruption count as of the newest reply observed. Unlike
       * `desktopEpoch` it moves only on real OS interruptions (lock, sleep,
       * session switch), so an advance — even with the pauses already back to
       * empty — is the proof a lock/resume cycle ran since consent was last
       * granted, and what drives the `desktop-interrupted` event.
       */
      desktopInterruptions: undefined as number | undefined,
      /**
       * The Pathway native revision the live driver reported through host
       * replies — `undefined` until the first reply carrying it, `0` on an
       * unpatched upstream driver. Capabilities that exist only in the patch
       * are advertised only while this is nonzero or unknown.
       */
      driverNativeRevision: undefined as number | undefined,
      /** The driver's host platform as last reported by a reply. */
      hostPlatform: undefined as string | undefined,
      /**
       * What the pane still mirrors: the last exact window the task aimed at,
       * or the last bound browser tab. The stills loop publishes nothing while
       * this is undefined — a display-wide capture is never a pane frame.
       */
      stillTarget: undefined as StillTarget | undefined,
      disposed: false,
    };
    const elementTokens = new WeakMap<ComputerUiNode, string>();
    /**
     * The AX action names the element advertised in the snapshot that produced
     * it — the same `actions` list the driver's own dispatch checks. Nodes are
     * recreated on every observation, so this is always the freshest claim.
     */
    const elementActions = new WeakMap<ComputerUiNode, ReadonlySet<string>>();
    /**
     * Elements living inside Chromium-family web content. AXSelectedText
     * inserts never reach their DOM (verified against Electron 43), so text
     * writes to these route through `set_value` with an independent re-read
     * instead of the semantic-insert path native controls honour.
     */
    const webContentElements = new WeakSet<ComputerUiNode>();
    /**
     * Element trees observed within the last few seconds, keyed by window id.
     * Internal target resolution reuses them: the element tokens bound to these
     * nodes are validated natively at dispatch, so an aged-out element refuses
     * rather than pressing the wrong control. Retaining the root keeps every
     * child node alive for the WeakMap token lookups.
     */
    const recentTrees = new Map<string, { at: number; root: ComputerUiNode }>();
    const observedGeometry = new Map<string, ComputerRect>();
    const previewTasks = new Map<string, CuaComputerTask>();
    /**
     * One drain signal per (pid, window) lane. A lane's drain only ever
     * succeeds, so a failed write never wedges its lane-mates; entries are
     * pruned when their owner settles.
     */
    const semanticTextLanes = new Map<string, Deferred.Deferred<void>>();

    const hostPlatform = () => state.hostPlatform ?? localPlatform;

    const setHealth = (health: ComputerHealth): void => {
      if (sameValue(health, state.currentHealth)) return;
      state.currentHealth = health;
      PubSub.publishUnsafe(events, { type: "health-changed", health });
    };

    /**
     * One unusable capture flips health unavailable. The action verdict stands —
     * this never rewrites an input result — and inputs keep working: nothing on
     * the input path gates on health, and the next granted refresh heals this.
     */
    const markCaptureFailed = (error: Failure) =>
      Effect.map(nowIso, (at) => {
        state.captureFailed = true;
        setHealth({
          ...state.currentHealth,
          status: "unavailable",
          captureAvailable: false,
          consecutiveFailures: state.currentHealth.consecutiveFailures + 1,
          lastFailure: { at, message: error.message.slice(0, 2048) },
        });
      });

    /**
     * One socket request. A transport verdict keeps its effect; any other
     * rejection is uncertain for a mutation and a clean miss otherwise.
     * `abortable` requests stop (and abort the socket) when interrupted;
     * cleanup requests ride on without the caller's cancellation, as Synara's
     * signal-less requests do.
     */
    const transport = (
      socket: string,
      body: Record<string, unknown>,
      requestOptions: { readonly timeoutMs?: number; readonly mutation?: boolean } | undefined,
      settings: { readonly abortable: boolean; readonly code?: string },
    ): BackendEffect<CuaReply> =>
      Effect.tryPromise({
        try: (signal) =>
          request(
            socket,
            body,
            settings.abortable ? { signal, ...requestOptions } : requestOptions,
          ) as Promise<CuaReply>,
        catch: (error) =>
          error instanceof CuaTransportError
            ? new CuaActionError(error.message, error.effect, settings.code)
            : new CuaActionError(
                errorMessage(error),
                requestOptions?.mutation ? "dispatched-unknown" : "not-dispatched",
                settings.code,
              ),
      });

    /**
     * Adopt the host's interruption count from a reply and announce a real
     * change once. The first observed count only sets the baseline — consent
     * cannot predate first contact — while every later difference (an advance,
     * or a reset from a host that restarted) proves the desktop went through
     * an interruption boundary consent must not silently cross. Called before
     * the epoch staleness checks so a reply that is about to be rejected still
     * reports the interruption it observed. Replies missing the field (an
     * older host) degrade to no tracking rather than false interruptions.
     */
    const observeDesktopInterruption = (reply: CuaReply): void => {
      const interruptions = reply.desktopInterruptions;
      if (
        typeof interruptions !== "number" ||
        !Number.isSafeInteger(interruptions) ||
        interruptions < 0
      )
        return;
      if (
        state.desktopInterruptions !== undefined &&
        interruptions !== state.desktopInterruptions
      ) {
        const pauses = Array.isArray(reply.desktopPauses)
          ? reply.desktopPauses.filter((reason): reason is string => typeof reason === "string")
          : [];
        PubSub.publishUnsafe(events, { type: "desktop-interrupted", pauses });
      }
      state.desktopInterruptions = interruptions;
    };

    /**
     * Registers a dispatching task as preview-live. Both entry points that
     * attribute work to a task — `host` for desktop calls, `browserCall` for
     * the CDP surface — share it, so an endTask from either path reaches the
     * host and the eviction bound holds across both.
     */
    const trackPreviewTask = (task: CuaComputerTask): void => {
      const currentKey = cuaComputerTaskKey(task);
      // Refresh recency: Map.set alone does not reorder, so a task that keeps
      // dispatching would otherwise age out while live. Delete first.
      if (previewTasks.has(currentKey)) previewTasks.delete(currentKey);
      previewTasks.set(currentKey, task);
      // Evict oldest first, but never the task dispatching right now: evicting
      // it would break the taskKey lock the preview helper relies on and
      // silently drop its later endTask (preview leak).
      while (previewTasks.size > 256) {
        const oldest = [...previewTasks.keys()].find((key) => key !== currentKey);
        if (oldest === undefined) break;
        previewTasks.delete(oldest);
      }
    };

    const guiHostRequired = () =>
      actionError(
        "Open this session in a supported Pathway desktop app to use Computer.",
        "not-dispatched",
        "gui_host_required",
      );

    const host = (
      body: Record<string, unknown>,
      mutation = false,
      allowModelObservation = true,
    ): BackendEffect<CuaReply> =>
      Effect.gen(function* () {
        if (state.disposed || !endpoint) return yield* guiHostRequired();
        yield* assertDesktopOperationActive;
        const isCall = body.method === "call";
        const task = isCall ? yield* currentComputerTask : undefined;
        if (task) trackPreviewTask(task);
        // Per-operation baseline, captured at dispatch. A newer desktop
        // generation observed while this call is in flight means the reply
        // predates an interruption (lock/resume) — even when the reply itself
        // carries the new generation — so it is rejected rather than trusted.
        const sendBaseline = state.desktopEpoch;
        // The socket round trip, counted and timed on the active call's timing
        // record when timing is on — durations only, never the payloads.
        (yield* currentComputerCall)?.timing?.count("host_calls");
        // Host admission uses the server-authorized mode, never a model's
        // native arguments. Linux does not implement the macOS background
        // input contract and must refuse those routes before dispatch.
        const deliveryMode = isCall ? yield* desktopDeliveryMode : undefined;
        const observes =
          isCall && (body.name === "get_window_state" || body.name === "get_desktop_state");
        const modelObservation = observes
          ? allowModelObservation && (yield* isModelDesktopObservationActive)
          : undefined;
        const signal = yield* desktopOperationSignal;
        const reply = yield* timedComputerLeg(
          "host",
          raceDesktopSignal(
            transport(
              endpoint,
              {
                ...body,
                ...(deliveryMode !== undefined ? { deliveryMode } : {}),
                ...(task ? { task } : {}),
                ...(modelObservation !== undefined ? { modelObservation } : {}),
                capability,
              },
              {
                mutation,
                timeoutMs: body.method === "setup" ? CUA_SETUP_TIMEOUT_MS : CUA_HOST_TIMEOUT_MS,
              },
              { abortable: true },
            ),
            signal,
          ),
        );
        observeDesktopInterruption(reply);
        if (
          typeof reply.driverNativeRevision === "number" &&
          Number.isSafeInteger(reply.driverNativeRevision) &&
          reply.driverNativeRevision >= 0
        )
          state.driverNativeRevision = reply.driverNativeRevision;
        if (typeof reply.hostPlatform === "string" && reply.hostPlatform.length > 0)
          state.hostPlatform = reply.hostPlatform;
        const epoch = reply.desktopEpoch;
        if (epoch !== undefined && Number.isSafeInteger(epoch) && epoch >= 0) {
          if (
            sendBaseline !== undefined &&
            ((state.desktopEpoch !== undefined && state.desktopEpoch !== sendBaseline) ||
              epoch < sendBaseline)
          )
            return yield* actionError(
              "The desktop changed while this operation was in flight. Observe again before continuing.",
              mutation ? "dispatched-unknown" : "not-dispatched",
              "stale_desktop_epoch",
            );
          if (epoch !== state.desktopEpoch) {
            state.desktopEpoch = epoch;
            observedGeometry.clear();
            state.snapshotAt = 0;
          }
        }
        if (!reply.ok)
          return yield* actionError(
            reply.error ?? "Cua host failed.",
            reply.effect ?? "not-dispatched",
          );
        return reply;
      });

    const call = (
      name: string,
      args: Record<string, unknown> = {},
      mutation = false,
      allowModelObservation = true,
    ): BackendEffect<CuaToolResult> =>
      Effect.gen(function* () {
        // The native operation itself, on the call's timing record — the name
        // is a fixed driver vocabulary, and nothing from `args` is recorded.
        (yield* currentComputerCall)?.timing?.count("native_calls");
        const reply = yield* timedComputerLeg(
          "call",
          host({ method: "call", name, args }, mutation, allowModelObservation),
        );
        const result = reply.result ?? {};
        if (
          !result.isError &&
          result.structuredContent?.effect !== "refused" &&
          result.structuredContent?.status !== "refused"
        )
          return result;
        const structured = result.structuredContent ?? {};
        // Only an explicit native pre-dispatch verdict proves no input. The
        // host taxonomy also uses `not-dispatched`; legacy menu tools instead
        // publish status/refusal without an effect. An explicit uncertain
        // effect wins over conflicting legacy status or a refusal-looking code.
        const refused =
          structured.effect === "refused" ||
          structured.effect === "not-dispatched" ||
          (structured.effect === undefined && structured.status === "refused");
        const refusal = record(structured.refusal);
        let message =
          (result.content ?? [])
            .map((c) => c.text ?? "")
            .join("\n")
            .slice(0, 2048) ||
          text(structured.message) ||
          text(refusal.message) ||
          text(structured.reason) ||
          "The native operation could not complete.";
        const nativeCode =
          text(structured.code) ||
          text(refusal.code) ||
          (refused ? "cua_refusal" : "cua_action_failed");
        // Older driver hosts used a second spelling for the same pause latch.
        const code = nativeCode === "desktop_input_paused" ? "computer_input_paused" : nativeCode;
        if (code === "same_pid_keyboard_ambiguity") {
          message +=
            " Inspect computer_get_state for this exact window_id, then use computer_type_text with an observed ref (or label and role), or computer_set_value to replace the field. " +
            "These semantic writes do not send keydown/keyup events. Do not retry physical keys or activate the app without the user's visible-use request.";
        }
        if (refused && ["stale_element_token", "stale_geometry", "stale_target"].includes(code)) {
          message +=
            " The original element or coordinate frame is no longer valid. Read fresh state and select the intended control again; do not substitute another same-label control or replay uncertain input.";
        }
        if (refused && code === "computer_input_paused") observedGeometry.clear();
        const pid = args.pid;
        const inputPause =
          ((refused &&
            (code === "target_not_on_active_space" ||
              code === "computer_input_paused" ||
              code === "auth_sheet_focused")) ||
            code === "focus_restore_failed") &&
          typeof pid === "number" &&
          Number.isSafeInteger(pid) &&
          Number.isSafeInteger(args.window_id)
            ? {
                windowId: `cua:${pid}:${String(args.window_id)}`,
                // `ComputerInputPause.pid` is a positive int32; a pid outside it
                // would turn this typed refusal into a constructor defect.
                ...((code === "computer_input_paused" ||
                  code === "target_not_on_active_space" ||
                  code === "focus_restore_failed") &&
                pid >= 1 &&
                pid <= 0x7fffffff
                  ? { pid }
                  : {}),
                message,
              }
            : undefined;
        return yield* new CuaActionError(
          message,
          mutation && !refused ? "dispatched-unknown" : "not-dispatched",
          code,
          inputPause,
          parseCuaActionDiagnostics(structured),
          structured.layer === "driver-host" || nativeCode === "desktop_input_paused"
            ? "driver-host"
            : "native-driver",
          refused &&
            code === "computer_input_paused" &&
            typeof structured.wait_seconds === "number" &&
            Number.isFinite(structured.wait_seconds)
            ? Math.min(60, Math.max(0, structured.wait_seconds))
            : undefined,
        );
      });

    const readWindows = (includeKeyboardFocus = false): BackendEffect<readonly ComputerWindow[]> =>
      Effect.gen(function* () {
        const data =
          (yield* call(
            "list_windows",
            hostPlatform() === "darwin" &&
              (state.driverNativeRevision ?? 0) >= 37 &&
              includeKeyboardFocus
              ? { include_keyboard_focus: true }
              : {},
          )).structuredContent ?? {};
        if (!Array.isArray(data.windows)) return yield* plainError("Invalid Cua window list.");
        const rows = data.windows
          .map(record)
          .sort((a, b) => (number(b.z_index) || 0) - (number(a.z_index) || 0));
        state.windows = rows
          .flatMap((w, i): ComputerWindow[] => {
            const pid = number(w.pid),
              windowId = number(w.window_id),
              bounds = optionalRect(w.bounds);
            const currentSpaceId = number(w.current_space_id);
            const spaceIds =
              Array.isArray(w.space_ids) &&
              w.space_ids.length <= COMPUTER_WINDOW_LIST_MAX_LENGTH &&
              w.space_ids.every(
                (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
              )
                ? (w.space_ids as number[])
                : undefined;
            // WindowServer can return zero-area placeholders. They are not
            // input targets and must not make every other application unavailable.
            if (
              !Number.isInteger(pid) ||
              pid <= 0 ||
              !Number.isInteger(windowId) ||
              windowId <= 0 ||
              !bounds
            )
              return [];
            return [
              {
                id: `cua:${pid}:${windowId}`,
                pid,
                title: text(w.title),
                appName: text(w.app_name),
                bounds,
                focused: state.selectedWindow === `cua:${pid}:${windowId}`,
                ...(typeof w.keyboard_focused === "boolean"
                  ? { keyboardFocused: w.keyboard_focused }
                  : {}),
                // A minimized window drops out of the screen list but keeps its
                // Space membership; a hidden app's windows report no membership
                // at all; an off-Space window reports on_current_space === false.
                minimized:
                  w.is_on_screen === false &&
                  w.on_current_space !== false &&
                  Array.isArray(w.space_ids) &&
                  w.space_ids.length > 0,
                visible: w.is_on_screen === true && w.on_current_space !== false,
                ...(spaceIds !== undefined ? { spaceIds } : {}),
                ...(Number.isSafeInteger(currentSpaceId) && currentSpaceId > 0
                  ? { currentSpaceId }
                  : {}),
                ...(typeof w.on_current_space === "boolean"
                  ? { onCurrentSpace: w.on_current_space }
                  : {}),
                ...(Number.isInteger(w.z_index) ? { stackingIndex: i } : {}),
              },
            ];
          })
          .slice(0, 512);
        return state.windows;
      });

    /** One snapshot: permissions (with transient re-probes), windows, screen size. */
    const takeSnapshot = (includeKeyboardFocus: boolean): BackendEffect<void> =>
      Effect.gen(function* () {
        let permission =
          (yield* call("check_permissions", { prompt: false })).structuredContent ?? {};
        const platform = hostPlatform();
        // tccd can report a transient negative for a freshly spawned session
        // while it maps the running app to its grants — observed to outlive a
        // single 400ms re-probe at turn start. A missing report that follows a
        // granted or unread state gets up to four delayed re-probes before it
        // is published; a steady missing state converges on the last call and
        // a granted answer short-circuits the remaining probes.
        if (
          missingComputerPermissions(permission, platform).length > 0 &&
          !state.hadMissingPermissions
        ) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            yield* Effect.sleep(Duration.millis(600));
            permission =
              (yield* call("check_permissions", { prompt: false })).structuredContent ?? {};
            if (missingComputerPermissions(permission, platform).length === 0) break;
          }
        }
        state.permissions = missingComputerPermissions(permission, platform);
        state.hadMissingPermissions = state.permissions.length > 0;
        // A capture failure clears only on an observed Screen Recording grant:
        // neither a previous-missing transition nor an explicit setup proves
        // pixels flow again, only a fresh probe saying so does. Only macOS's
        // fresh grant proves its capture prerequisite recovered; a Linux
        // compositor connection alone must not erase a capture failure.
        if (platform !== "linux" && permission.screen_recording === true)
          state.captureFailed = false;
        const bundleId = text(record(permission.source).host_bundle_id, 256);
        const signature: ComputerBuildSignature = "unknown";
        const monitorUnavailable =
          platform === "darwin" &&
          permission.input_monitoring === true &&
          permission.input_monitor_ready === false;
        const monitorMessage =
          "Computer control is paused because the Escape and human-input listener could not start. " +
          "Reopen Pathway, then check Computer settings again.";
        const at = yield* nowIso;
        setHealth({
          ...state.currentHealth,
          status: state.captureFailed || monitorUnavailable ? "unavailable" : "connected",
          captureAvailable: captureAccessAvailable(permission, platform) && !state.captureFailed,
          consecutiveFailures: state.captureFailed ? state.currentHealth.consecutiveFailures : 0,
          ...(monitorUnavailable ? { lastFailure: { at, message: monitorMessage } } : {}),
        });
        // TCC's setup surface is macOS-only: on other platforms the driver's
        // own probe reports what it found, and the message names the access
        // mechanism that platform actually has.
        state.currentAvailability = state.permissions.length
          ? {
              kind: "permission-required",
              missing: state.permissions,
              buildSignature: signature,
              ...(bundleId ? { bundleId } : {}),
              message:
                platform === "darwin"
                  ? computerPermissionSetupMessage(
                      state.permissions,
                      signature,
                      bundleId || undefined,
                    )
                  : `Pathway's driver host reports missing ${listComputerPermissions(
                      state.permissions,
                    )} access. Grant it at the OS level the platform uses — display-server access on Linux, integrity/UIAccess on Windows — then try again.`,
            }
          : monitorUnavailable
            ? { kind: "backend-unavailable", message: monitorMessage }
            : { kind: "available", backend: "cua" };
        if (state.currentAvailability.kind === "available") {
          yield* readWindows(includeKeyboardFocus);
          const geometry = (yield* call("get_screen_size")).structuredContent ?? {};
          const width = number(geometry.width),
            height = number(geometry.height);
          if (!(width > 0 && height > 0))
            return yield* plainError("Cua returned no primary display geometry.");
          state.size = { width, height, scale: number(geometry.scale_factor) };
        }
        state.snapshotAt = yield* Clock.currentTimeMillis;
      }).pipe(
        Effect.tapError((error) =>
          Effect.map(nowIso, (at) => {
            const message = error.message.slice(0, 2048);
            state.currentAvailability = { kind: "backend-unavailable", message };
            setHealth({
              ...state.currentHealth,
              status: "unavailable",
              captureAvailable: false,
              consecutiveFailures: state.currentHealth.consecutiveFailures + 1,
              lastFailure: { at, message },
            });
          }),
        ),
      );

    /**
     * The shared snapshot. It runs in the backend scope rather than the
     * caller's fiber, so every concurrent caller awaits one refresh and a
     * caller that gives up does not cancel it for the others.
     */
    const refresh = (force = false, includeKeyboardFocus = false): BackendEffect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        if (state.snapshot) return Deferred.await(state.snapshot);
        if (!force && now - state.snapshotAt < 1_000) return Effect.void;
        const snapshot = Deferred.makeUnsafe<void, Failure>();
        state.snapshot = snapshot;
        return takeSnapshot(includeKeyboardFocus).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (state.snapshot === snapshot) state.snapshot = undefined;
              Deferred.doneUnsafe(snapshot, exit);
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.andThen(Deferred.await(snapshot)),
        );
      });

    /** Waits out a snapshot already in flight, whatever it concludes. */
    const settleSnapshot = Effect.suspend(() =>
      state.snapshot ? Effect.ignore(Deferred.await(state.snapshot)) : Effect.void,
    );

    const probeAvailability = (): BackendEffect<ComputerAvailability> => {
      if (!endpoint)
        return Effect.succeed({
          kind: "backend-unavailable",
          message:
            "Computer requires a connected Pathway desktop host, which owns native access on that computer.",
        });
      return host({ method: "probe" }).pipe(
        Effect.map(
          (): ComputerAvailability =>
            state.currentAvailability.kind === "backend-unavailable" &&
            state.snapshotAt === 0 &&
            state.currentHealth.consecutiveFailures === 0 &&
            state.currentHealth.lastFailure === undefined
              ? { kind: "available", backend: "cua" }
              : state.currentAvailability,
        ),
        Effect.catch((error) =>
          Effect.succeed<ComputerAvailability>({
            kind: "backend-unavailable",
            message: error.message.slice(0, 2048),
          }),
        ),
      );
    };

    const availability = (availabilityOptions?: {
      readonly refresh?: boolean;
    }): Effect.Effect<ComputerAvailability> =>
      Effect.gen(function* () {
        // A grant notification can arrive while an earlier snapshot is still
        // settling. Explicit status refreshes must read again after that snapshot.
        if (availabilityOptions?.refresh) yield* settleSnapshot;
        // refresh records the failed native prerequisite in both availability
        // and health. Status must carry that diagnosis instead of failing.
        yield* Effect.ignore(refresh(availabilityOptions?.refresh === true));
        return state.currentAvailability;
      });

    const capabilities = (): ComputerCapabilities => {
      const nativeInputAvailable = hostPlatform() !== "linux";
      return {
        ...NO_COMPUTER_CAPABILITIES,
        windows: true,
        windowBounds: true,
        stacking: true,
        capture: true,
        input: nativeInputAvailable,
        clipboard: true,
        focus: nativeInputAvailable,
        raise: nativeInputAvailable,
        // The compact agent cursor is a Pathway-patch rendering path. Unknown
        // (no handshake yet) reads as the patched default; `0` is the
        // unpatched upstream driver's honest answer.
        ghostCursor: hostPlatform() === "darwin" && state.driverNativeRevision !== 0,
        visibleDesktop: true,
      };
    };

    const provision = (): BackendEffect<string> =>
      Effect.gen(function* () {
        // Let a pre-setup status read settle before invalidating it. Its missing
        // grants must not win the refresh after the user requests permissions.
        yield* settleSnapshot;
        yield* host({ method: "setup" });
        state.snapshotAt = 0;
        // No unconditional capture-failure reset here: only an observed
        // screen_recording grant clears it, in the snapshot, so a setup that
        // did not actually restore capture cannot launder the health away.
        yield* refresh(true);
        if (state.currentAvailability.kind === "backend-unavailable")
          return state.currentAvailability.message;
        if (!state.permissions.length)
          return "Computer permissions are ready. Send a message to continue; no action is retried automatically.";
        const missing = listComputerPermissions(state.permissions);
        // The setup surface is macOS TCC; other platforms report through the
        // driver's own probe, and the guidance names what the platform uses
        // rather than a settings pane that does not exist there.
        return hostPlatform() === "darwin"
          ? `Allow ${missing} for this copy of Pathway in System Settings. Return here to check again; if macOS asks you to quit and reopen the app, do so.`
          : `The driver host reports missing ${missing} access. Grant it at the OS level the platform uses (display-server access on Linux, integrity/UIAccess on Windows), then check again; no action is retried automatically.`;
      });

    const target = (windowId?: string, fresh = true): BackendEffect<ResolvedWindow> =>
      Effect.gen(function* () {
        const id = windowId ?? state.selectedWindow;
        if (!id || !/^cua:[1-9]\d*:[1-9]\d*$/.test(id))
          return yield* actionError(
            "Select an exact window before acting.",
            "not-dispatched",
            "window_required",
          );
        const windows = fresh ? yield* readWindows() : state.windows;
        const window = windows.find((w) => w.id === id);
        if (!window?.bounds || !window.pid)
          return yield* actionError(
            "The target window closed or its identity changed.",
            "not-dispatched",
            "stale_target",
          );
        // The desktop generation this resolution is grounded in. Checked again
        // at inject: anything that moved the generation in between (a
        // lock/resume the reads above did not yet see) must refuse before
        // dispatch, never after.
        return {
          pid: window.pid,
          window_id: Number(id.split(":")[2]),
          window,
          baseline: state.desktopEpoch,
        };
      });

    const screenshot = (
      result: CuaToolResult,
      fallback?: ComputerRect,
    ): BackendEffect<ComputerScreenshot> =>
      Effect.gen(function* () {
        const data = result.structuredContent ?? {};
        if (data.screenshot_frame_freshness === "unverified_off_space")
          return yield* actionError(
            "The exact window is on another macOS Space. Cua returned pixels, but their freshness cannot be proven without switching Spaces, so Pathway will not present them as a live observation.",
            "not-dispatched",
            "off_space_capture_unverified",
          );
        const image = result.content?.find(
          (c) => c.type === "image" && c.mimeType === "image/png" && c.data,
        );
        if (!image?.data || data.screenshot_frame_valid === false)
          return yield* actionError(
            "Cua could not establish the screenshot geometry.",
            "not-dispatched",
            "capture_unavailable",
          );
        // The PNG header contains the dimensions; do not decode the full image
        // until its bytes are needed by the preview transport.
        const dimensions = pngDimensions(Buffer.from(image.data.slice(0, 32), "base64"));
        let region = fallback;
        if (data.window_bounds) {
          region = optionalRect(data.window_bounds);
          if (!region)
            return yield* actionError(
              "Cua returned invalid geometry.",
              "not-dispatched",
              "invalid_geometry",
            );
        }
        if (!dimensions || !region)
          return yield* plainError("Cua screenshot is missing its coordinate frame.");
        const scale = dimensions.width / region.width;
        if (Math.abs(dimensions.height / region.height - scale) > 0.01)
          return yield* plainError("Cua screenshot dimensions disagree with its geometry.");
        // Linux has no TCC grant that proves capture recovered. A validated
        // frame does; a mere connection to the compositor must not clear a
        // prior failure.
        if (hostPlatform() === "linux" && state.captureFailed) {
          state.captureFailed = false;
          setHealth({
            ...state.currentHealth,
            status: "connected",
            captureAvailable: true,
            consecutiveFailures: 0,
          });
        }
        return {
          mimeType: "image/png",
          ...dimensions,
          sizeBytes: Buffer.byteLength(image.data, "base64"),
          bytesBase64: image.data,
          region,
          scale,
          capturedAt: yield* nowIso,
        };
      });

    /**
     * The model's whole-desktop observation, returned by an unscoped
     * `getState`. This is a model picture, never a pane frame: the preview
     * stills are window/tab captures only.
     */
    const captureOverview = (allowModelObservation = true): BackendEffect<ComputerScreenshot> =>
      Effect.gen(function* () {
        const result = yield* call("get_desktop_state", {}, false, allowModelObservation);
        const data = result.structuredContent ?? {};
        const image = yield* screenshot(result, {
          x: 0,
          y: 0,
          width: number(data.screen_width),
          height: number(data.screen_height),
        });
        // No capture-failure reset here: only an observed Screen Recording
        // grant (in the snapshot) proves capture is back, so only it clears it.
        setHealth({
          ...state.currentHealth,
          status: "connected",
          captureAvailable: true,
          consecutiveFailures: 0,
        });
        return image;
      }).pipe(Effect.tapError(markCaptureFailed));

    const assertObservedWindow = (
      result: CuaToolResult,
      pid: number,
      windowId: number,
    ): BackendEffect<void> => {
      const data = result.structuredContent ?? {};
      return number(data.pid) !== pid || number(data.window_id) !== windowId
        ? actionError("Cua observation belongs to a different window.", "not-dispatched")
        : Effect.void;
    };

    /** A failed capture flips health, except a frame refused only for being off-Space. */
    const markUnlessOffSpace = (error: Failure) =>
      isCuaActionError(error) && error.code === "off_space_capture_unverified"
        ? Effect.void
        : markCaptureFailed(error);

    const captureScreenshot = (
      captureRequest: ComputerCaptureRequest,
    ): BackendEffect<ComputerScreenshot> =>
      Effect.gen(function* () {
        if (captureRequest.kind === "region")
          return yield* actionError(
            "Region capture is not supported by this pinned Cua backend. Capture an exact window; the overview covers the primary display only.",
            "not-dispatched",
            "unsupported_operation",
          );
        const { pid, window_id, window } = yield* target(captureRequest.windowId);
        // Targeting failures above never reach the handler below; anything
        // failing past the target produced no usable pixels, so health flips
        // while the failure — and any input verdict — stands exactly as before.
        return yield* Effect.gen(function* () {
          const result = yield* call("get_window_state", {
            pid,
            window_id,
            include_accessibility_tree: false,
            include_screenshot: true,
            max_dimension: captureRequest.maxDimension ?? 1536,
          });
          yield* assertObservedWindow(result, pid, window_id);
          const image = { ...(yield* screenshot(result)), windowId: window.id };
          observedGeometry.set(window.id, image.region!);
          return image;
        }).pipe(Effect.tapError(markUnlessOffSpace));
      });

    /**
     * The window's preview image, or a note when only the preview failed. A
     * preview-only failure must not fail the observation: the tree still
     * stands and input is unaffected — reselecting (observing) the window
     * resumes previews.
     */
    const previewImage = (
      result: CuaToolResult,
      windowId: string,
    ): BackendEffect<
      { readonly screenshot: ComputerScreenshot } | { readonly previewNote: string }
    > =>
      screenshot(result).pipe(
        Effect.map((image) => ({ screenshot: { ...image, windowId } })),
        Effect.catch((error) => {
          if (
            !isCuaActionError(error) ||
            !["capture_unavailable", "off_space_capture_unverified"].includes(error.code)
          )
            return Effect.fail(error);
          if (error.code === "off_space_capture_unverified")
            return Effect.succeed({
              previewNote:
                "This window is on another macOS Space. Its preview is paused because frame freshness cannot be proven without switching Spaces; exact retained semantic text may still continue.",
            });
          return Effect.as(markCaptureFailed(error), {
            previewNote:
              "The preview for this window failed; input is unaffected. Reselect the window to resume.",
          });
        }),
      );

    const getState = (stateOptions: {
      readonly includeScreenshot?: boolean;
      readonly includeTree?: boolean;
      readonly windowId?: string;
      readonly reuseRecentTree?: boolean;
    }): BackendEffect<ComputerState> =>
      Effect.gen(function* () {
        // Focus metadata is optional observation work, never part of each
        // input's cheap WindowServer identity/geometry revalidation.
        yield* refresh(
          false,
          stateOptions.reuseRecentTree !== true && (yield* isModelDesktopObservationActive),
        );
        let observed: ComputerState = {
          computerId: DEFAULT_COMPUTER_ID,
          windows: state.windows,
          screenSize: state.size,
          availability: state.currentAvailability,
          capturedAt: yield* nowIso,
        };
        if (state.permissions.length) return observed;
        if (!stateOptions.windowId)
          return {
            ...observed,
            ...(stateOptions.includeScreenshot ? { screenshot: yield* captureOverview() } : {}),
            accessibility: {
              status: "partial",
              unavailableWindowIds: state.windows.map((w) => w.id),
            },
          };
        // The snapshot already enumerated the windows. Native observation also
        // verifies PID/window ownership, so a second enumeration buys nothing.
        const windowId = stateOptions.windowId;
        const { pid, window_id, window } = yield* target(windowId, false);
        observed = { ...observed, windows: [window] };
        if (!stateOptions.includeTree && !stateOptions.includeScreenshot) return observed;
        if (
          stateOptions.includeTree &&
          stateOptions.reuseRecentTree &&
          !stateOptions.includeScreenshot
        ) {
          const cached = recentTrees.get(windowId);
          if (cached && (yield* Clock.currentTimeMillis) - cached.at < RECENT_TREE_TTL_MS)
            return {
              ...observed,
              root: cached.root,
              accessibility: { status: "partial", unavailableWindowIds: [] },
            };
        }
        // A read that did not ask for pixels skips capture, encode, and image
        // delivery — but only because the flag travels on the wire: the driver
        // treats an ABSENT include_screenshot as true, so explicit false is the
        // pinned no-capture contract.
        const wantsPixels = stateOptions.includeScreenshot === true;
        // Past the target, a read that asked for pixels produced no frame, so
        // capture health flips. A tree-only failure never touched capture — a
        // timed-out AX walk on a heavy app must not mark it unavailable.
        const result = yield* Effect.gen(function* () {
          const read = yield* call("get_window_state", {
            pid,
            window_id,
            include_screenshot: wantsPixels,
            max_dimension: 1536,
            include_accessibility_tree: stateOptions.includeTree === true,
            max_elements: 1024,
            max_depth: 25,
          });
          yield* assertObservedWindow(read, pid, window_id);
          return read;
        }).pipe(Effect.tapError((error) => (wantsPixels ? markCaptureFailed(error) : Effect.void)));
        const data = result.structuredContent ?? {};
        const children: ComputerUiNode[] = [];
        if (Array.isArray(data.elements))
          for (const value of data.elements.slice(0, 1024)) {
            const element = record(value);
            if (!element.frame) continue;
            const frame = optionalRect(element.frame);
            if (!frame) continue;
            const node: ComputerUiNode = {
              role: text(element.role, 128),
              label: text(element.label) || null,
              value: typeof element.value === "string" ? text(element.value, 16384) : null,
              description: text(element.value_description) || null,
              frame,
              activationPoint: {
                x: frame.x + frame.width / 2,
                y: frame.y + frame.height / 2,
              },
              onScreen: window.visible,
              windowId: window.id,
              children: [],
            };
            if (typeof element.element_token === "string") {
              elementTokens.set(node, element.element_token);
              registerNativeComputerElement(node, element.element_token);
              if (element.in_web_content === true) webContentElements.add(node);
              if (Array.isArray(element.actions))
                elementActions.set(
                  node,
                  new Set(
                    element.actions.filter(
                      (action): action is string => typeof action === "string",
                    ),
                  ),
                );
            }
            children.push(node);
          }
        const root: ComputerUiNode = {
          role: "AXWindow",
          label: window.title,
          value: null,
          description: null,
          frame: window.bounds!,
          activationPoint: null,
          onScreen: window.visible,
          windowId: window.id,
          truncated: data.elements_complete !== true,
          children,
        };
        recentTrees.delete(windowId);
        recentTrees.set(windowId, { at: yield* Clock.currentTimeMillis, root });
        while (recentTrees.size > 8) recentTrees.delete(recentTrees.keys().next().value!);
        const image = stateOptions.includeScreenshot
          ? yield* previewImage(result, window.id)
          : undefined;
        if (image && "screenshot" in image && image.screenshot.region)
          observedGeometry.set(window.id, image.screenshot.region);
        return {
          ...observed,
          root,
          accessibility: { status: "partial", unavailableWindowIds: [] },
          ...(image && "screenshot" in image ? { screenshot: image.screenshot } : {}),
          ...(image && "previewNote" in image ? { previewNote: image.previewNote } : {}),
        };
      });

    const inputDispatch = (
      name: string,
      args: Record<string, unknown>,
      point: ComputerPoint | undefined,
      preparedBounds: ComputerRect | undefined,
      exactSemanticTarget: boolean,
      resolved: ResolvedWindow,
      admitMutation?: BackendEffect<void>,
    ): BackendEffect<ComputerBackendActionResult> =>
      Effect.gen(function* () {
        const { pid, window_id, window, baseline } = resolved;
        const linux = hostPlatform() === "linux";
        const deliveryMode = yield* desktopDeliveryMode;
        let nativeArgs = args;
        if (linux) {
          // The unpatched Linux token actuators are not the macOS semantic
          // contract: several rewalk the PID tree by ordinal and can GrabFocus.
          // Do not turn a requested exact write into generic focused typing.
          if (
            name === "set_value" ||
            name === "select_text" ||
            args.semantic_only === true ||
            args.element_token !== undefined ||
            args.element_index !== undefined
          )
            return yield* actionError(
              "This Linux route cannot preserve the observed semantic element's exact identity. " +
                "Native input is unavailable until cancellation cleanup is supported; use observation or an existing debuggable browser when appropriate.",
              "not-dispatched",
              "linux_semantic_target_unproven",
            );
          if (deliveryMode !== "foreground")
            return yield* actionError(
              "This Linux native route cannot guarantee background input without moving desktop focus or the human pointer. " +
                "Foreground input is also unavailable until cancellation cleanup is supported; use observation or an existing debuggable browser when appropriate.",
              "not-dispatched",
              "linux_background_unavailable",
            );
          if (args.action !== undefined)
            return yield* actionError(
              "This Linux driver does not implement the requested accessibility action.",
              "not-dispatched",
              "unsupported_linux_operation",
            );
          // These keys select/validate Pathway's patched macOS routes and are
          // rejected by Linux's strict native schemas. The visible-use gate
          // above runs first so removing them cannot relax a background-only
          // promise.
          const {
            force_synthetic: _forceSynthetic,
            coordinate_space: _coordinateSpace,
            expected_window_bounds: _expectedWindowBounds,
            ...linuxArgs
          } = args;
          nativeArgs = linuxArgs;
          if (name === "scroll") {
            const dx = typeof linuxArgs.delta_x === "number" ? linuxArgs.delta_x : 0;
            const dy = typeof linuxArgs.delta_y === "number" ? linuxArgs.delta_y : 0;
            if (
              (dx !== 0 && dy !== 0) ||
              (Array.isArray(linuxArgs.modifiers) && linuxArgs.modifiers.length > 0)
            )
              return yield* actionError(
                "This Linux driver supports one unmodified scroll axis per gesture. " +
                  "Diagonal and modified scroll gestures are unavailable.",
                "not-dispatched",
                "unsupported_linux_operation",
              );
            const {
              delta_x: _deltaX,
              delta_y: _deltaY,
              modifiers: _modifiers,
              ...scrollArgs
            } = linuxArgs;
            nativeArgs =
              dx !== 0 || dy !== 0
                ? { ...scrollArgs, amount: Math.abs(dx || dy), by: "line" }
                : scrollArgs;
          }
        }
        if (!window.visible && !exactSemanticTarget) {
          const message =
            "The target window is not on the current Space or not on screen. Only exact retained semantic text or advertised AX actions may operate there without activation; pointer and synthetic keyboard input require an available window and fresh state.";
          return yield* actionError(message, "not-dispatched", "target_not_on_active_space", {
            windowId: window.id,
            message,
          });
        }
        const bounds = window.bounds!;
        if (preparedBounds && !sameRect(preparedBounds, bounds))
          return yield* actionError(
            "Target moved after drag preparation; obtain a new screenshot.",
            "not-dispatched",
            "stale_geometry",
          );
        const observed = observedGeometry.get(window.id);
        if (point && (!observed || !sameRect(observed, bounds)))
          return yield* actionError(
            "Window geometry changed since observation; obtain a new screenshot.",
            "not-dispatched",
            "stale_geometry",
          );
        // Fence the dispatch against the generation the target was resolved
        // in. The operative guard for a generation that moves mid-flight lives
        // in `host`; this refuses before dispatch whenever resolution and
        // injection straddle a suspension.
        if (
          baseline !== undefined &&
          state.desktopEpoch !== undefined &&
          state.desktopEpoch !== baseline
        )
          return yield* actionError(
            "The desktop changed after this target was resolved. Observe again before continuing.",
            "not-dispatched",
            "stale_desktop_epoch",
          );
        let pixel: Record<string, unknown> = {};
        if (point) {
          // Model image pixels have already been mapped to desktop logical
          // points. Native revision 3 validates the exact current target and
          // converts these local logical points without capturing another PNG.
          const x = point.x - bounds.x,
            y = point.y - bounds.y;
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < 0 ||
            y < 0 ||
            x >= bounds.width ||
            y >= bounds.height
          )
            return yield* actionError("Point is outside the target window.", "not-dispatched");
          pixel = { x, y, ...(!linux ? { coordinate_space: "window_points" } : {}) };
        }
        yield* assertDesktopOperationActive;
        if (admitMutation) yield* admitMutation;
        const result = yield* call(
          name,
          {
            pid,
            window_id,
            // Always-background semantic AX writes take no delivery_mode —
            // there is no foreground/background split for an attribute write.
            ...(name !== "set_value" && name !== "select_text"
              ? { delivery_mode: deliveryMode }
              : {}),
            ...nativeArgs,
            ...pixel,
            ...(!linux && (point || preparedBounds)
              ? { expected_window_bounds: preparedBounds ?? bounds }
              : {}),
          },
          true,
        ).pipe(
          // A revoke, abort, or uncertain delivery can follow partial input, so
          // the grounding the next input would check against cannot survive
          // it. Clean refusals (nothing dispatched) keep it, so a pause
          // recovery does not pay for a recapture it does not need.
          Effect.onError((cause) =>
            Effect.flatMap(desktopOperationSignal, (signal) =>
              Effect.sync(() => {
                const failure = Cause.findErrorOption(cause);
                if (
                  isDesktopSignalAborted(signal) ||
                  Cause.hasInterrupts(cause) ||
                  (failure._tag === "Some" &&
                    isCuaActionError(failure.value) &&
                    failure.value.effect === "dispatched-unknown")
                )
                  observedGeometry.clear();
              }),
            ),
          ),
          // An error can follow partial input, so any earlier observation is stale.
          Effect.ensuring(
            Effect.sync(() => {
              state.snapshotAt = 0;
            }),
          ),
        );
        const data = result.structuredContent ?? {};
        // Cua 0.24 publishes ActionResult, replacing internal `path` with
        // `route` and delivery metadata. Confirmed effects require its public
        // evidence.
        const confirmed =
          data.effect === "confirmed" &&
          Array.isArray(data.evidence) &&
          data.evidence.some((item) =>
            ["value_readback", "window_change"].includes(text(record(item).kind)),
          );
        const mode = text(record(data.delivery).mode, 32) || "unknown";
        // Most tools report `route`; a few (scroll among them) still report `path`.
        const route = text(data.route, 64) || text(data.path, 64);
        return {
          windowId: window.id,
          ...(point ? { point } : {}),
          deliveryPath: `cua-${route || "unknown"}-${mode}`,
          verified: confirmed
            ? "confirmed"
            : data.effect === "unconfirmed" || data.effect === "suspected_noop"
              ? "unconfirmed"
              : "unverifiable",
          effect: confirmed ? "verified" : "dispatched-unknown",
        };
      });

    /**
     * Serialize background semantic text writes that share one exact window.
     * The native semantic lease is per (pid, window): a second concurrent lease
     * on the same window is refused outright, and a web element's
     * compose-set_value-reread sequence must not interleave with a sibling
     * write on the same element. Keying the lane on the window — not the pid —
     * lets distinct windows of one app type truly concurrently while the exact
     * target keeps ordering.
     *
     * The write runs in the backend scope, not the caller's fiber: the hold
     * timeout or a cancellation fails the caller honestly while the lane drains
     * in order behind it, and nothing is replayed. A cancelled caller also
     * aborts the native request in flight, as Synara's shared abort signal did;
     * the lane still waits out the gap behind it.
     */
    const semanticTextInLane = (
      pid: number,
      window_id: number,
      write: (admitMutation: BackendEffect<void>) => BackendEffect<ComputerBackendActionResult>,
    ): BackendEffect<ComputerBackendActionResult> =>
      Effect.gen(function* () {
        const key = `semantic-text:${pid}:${window_id}`;
        const predecessor = semanticTextLanes.get(key);
        const signal = yield* desktopOperationSignal;
        yield* checkDesktopSignal(signal);
        const laneWaitStarted = yield* Clock.currentTimeMillis;
        const deadline = laneWaitStarted + semanticTextLaneHoldMs;
        const lane = { dispatched: false, abandoned: false };
        // Fails the write's native request when the caller stops waiting.
        const cancel = makeDesktopAbort();
        const assertAdmission = Effect.gen(function* () {
          // An overdue timer may lose a turn to the read's completion.
          if (lane.abandoned || (yield* Clock.currentTimeMillis) >= deadline)
            return yield* actionError(
              "Semantic text admission expired; nothing was sent.",
              "not-dispatched",
            );
          yield* checkDesktopSignal(signal);
        });
        const drained = Deferred.makeUnsafe<void>();
        semanticTextLanes.set(key, drained);
        const release = (dispatched: boolean) =>
          Effect.andThen(
            dispatched ? Effect.sleep(Duration.millis(semanticTextLaneGapMs)) : Effect.void,
            Effect.sync(() => {
              if (semanticTextLanes.get(key) === drained) semanticTextLanes.delete(key);
              Deferred.doneUnsafe(drained, Effect.void);
            }),
          );
        const writeResult = Effect.gen(function* () {
          if (predecessor) yield* Deferred.await(predecessor);
          // Check both queue admission and the actual mutation boundary: a web
          // field read can outlive the caller before it has sent any input.
          yield* assertAdmission;
          const deliveryStarted = yield* Clock.currentTimeMillis;
          const laneWaitMs = deliveryStarted - laneWaitStarted;
          const result = yield* raceDesktopSignal(
            write(
              Effect.andThen(
                assertAdmission,
                Effect.sync(() => {
                  lane.dispatched = true;
                }),
              ),
            ),
            desktopSignal(cancel),
          );
          const deliveryMs = (yield* Clock.currentTimeMillis) - deliveryStarted;
          yield* Effect.logDebug("[computer] semantic text lane write", {
            pid,
            windowId: `cua:${pid}:${window_id}`,
            laneWaitMs,
            deliveryMs,
            verified: result.verified,
            effect: result.effect,
          });
          return result;
        }).pipe(
          // Keep the lane tied to the actual write, never to the caller's
          // shorter wait. Both late success and late failure release it only
          // after the gap; a write torn down with the backend releases at once.
          Effect.onExit((exit) =>
            release(lane.dispatched && !(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))),
          ),
        );
        const fiber = yield* Effect.forkIn(writeResult, scope, { startImmediately: true });
        const abandon = Effect.suspend(() => {
          lane.abandoned = true;
          return Deferred.fail(
            cancel,
            new CuaActionError(
              lane.dispatched
                ? "Semantic text write was cancelled after it may have dispatched."
                : "Semantic text write was cancelled; nothing was sent.",
              lane.dispatched ? "dispatched-unknown" : "not-dispatched",
            ),
          );
        });
        const timedOut = Effect.andThen(
          Effect.sleep(Duration.millis(semanticTextLaneHoldMs)),
          Effect.suspend(() => {
            lane.abandoned = true;
            return lane.dispatched
              ? actionError(
                  "Semantic text delivery timed out; the write may have partially dispatched. " +
                    "Observe the target before acting; never retype blindly.",
                  "dispatched-unknown",
                )
              : actionError(
                  "Semantic text timed out before delivery; nothing was sent.",
                  "not-dispatched",
                );
          }),
        );
        return yield* Effect.raceAllFirst([
          Fiber.join(fiber),
          timedOut,
          awaitDesktopSignal(signal).pipe(Effect.tapError(() => abandon)),
        ]).pipe(Effect.onInterrupt(() => abandon));
      });

    const input = (
      name: string,
      args: Record<string, unknown>,
      windowId?: string,
      point?: ComputerPoint,
      preparedBounds?: ComputerRect,
    ): BackendEffect<ComputerBackendActionResult> =>
      Effect.gen(function* () {
        const resolved = yield* target(windowId);
        const deliveryMode = yield* desktopDeliveryMode;
        // `select_text` shares the lane with semantic text writes on the same
        // window: the native semantic lease is per (pid, window) and refuses a
        // second concurrent lease, so a lane-unaware selection would race — or
        // refuse against — a type_text write aimed at the same element. It is
        // also a pure AX attribute write, so it carries no visibility
        // requirement either. `set_value` is the same class of exact semantic
        // mutation: the driver admits it on the same per-(pid, window) lease,
        // and an element-token write is permitted on minimized, hidden and
        // off-Space windows. Every server-side set_value is element-addressed,
        // so the lane condition mirrors the driver's own check.
        const semanticLaneWrite =
          name === "select_text" ||
          (name === "set_value" &&
            (args.element_token !== undefined || args.element_index !== undefined)) ||
          (name === "type_text" &&
            args.semantic_only === true &&
            deliveryMode !== "foreground" &&
            point === undefined);
        if (semanticLaneWrite)
          return yield* semanticTextInLane(resolved.pid, resolved.window_id, (admitMutation) =>
            inputDispatch(name, args, point, preparedBounds, true, resolved, admitMutation),
          );
        // A retained AX action may operate off-Space. Any native pixel fallback
        // still has to pass WindowPointer admission, which refuses that surface.
        const exactSemanticAction =
          exactTargetBackgroundInput() &&
          name === "click" &&
          typeof args.element_token === "string" &&
          typeof args.action === "string" &&
          point === undefined &&
          deliveryMode !== "foreground";
        return yield* inputDispatch(
          name,
          args,
          point,
          preparedBounds,
          exactSemanticAction,
          resolved,
        );
      });

    // Focus-neutral semantic writes are a Pathway-patch guarantee. Unknown
    // (pre-handshake) reads as the patched default; `0` is the unpatched
    // upstream driver, where the property is unverified and unclaimed.
    const focusNeutralSemanticText = () =>
      hostPlatform() === "darwin" && state.driverNativeRevision !== 0;
    const exactTargetBackgroundInput = () =>
      hostPlatform() === "darwin" && (state.driverNativeRevision ?? 0) >= 36;

    const modifierArgs = (modifiers: readonly ComputerInputModifier[] | undefined) =>
      modifiers?.length
        ? Effect.map(cuaKeys(modifiers), (modifier) => ({ modifier }))
        : Effect.succeed({});

    const clickWith = (
      args: Record<string, unknown>,
      point: ComputerPoint,
      windowId: string | undefined,
      modifiers: readonly ComputerInputModifier[] | undefined,
    ) =>
      Effect.flatMap(modifierArgs(modifiers), (modifier) =>
        input("click", { ...args, ...modifier }, windowId, point),
      );

    /**
     * Re-observe one window and return the record for the same web element.
     * Tokens are snapshot-scoped, so identity matches on role + label + frame,
     * the stable tuple an unchanged element keeps across driver snapshots.
     * Retained provider refs bypass this compatibility route and dispatch on
     * their original token without another snapshot.
     */
    const resolveWebField = (
      windowId: string,
      node: ComputerUiNode,
    ): BackendEffect<WebField | undefined> =>
      Effect.gen(function* () {
        const { pid, window_id } = yield* target(windowId);
        const result = yield* call("get_window_state", {
          pid,
          window_id,
          include_screenshot: false,
          include_accessibility_tree: true,
          max_elements: 1024,
          max_depth: 25,
        });
        const elements = result.structuredContent?.elements;
        if (!Array.isArray(elements)) return undefined;
        let match: WebField | undefined;
        for (const value of elements) {
          const element = record(value);
          if (element.in_web_content !== true) continue;
          if (text(element.role, 128) !== node.role) continue;
          if ((text(element.label) || null) !== node.label) continue;
          const frame = optionalRect(element.frame);
          if (!frame || !sameRect(frame, node.frame)) continue;
          if (typeof element.element_token !== "string") continue;
          const index = number(element.element_index);
          if (match) return undefined;
          match = {
            token: element.element_token,
            index: Number.isFinite(index) ? index : 0,
            value: typeof element.value === "string" ? element.value : null,
          };
        }
        return match;
      });

    /**
     * Write an `AXValue` into a web element and confirm it on a fresh read. The
     * driver's own read-back runs before Chromium publishes the new value and
     * so reports `unverifiable` on writes that landed; verification here
     * re-resolves the element and compares its DOM-visible value.
     */
    const webSetValue = (
      node: ComputerUiNode,
      windowId: string,
      field: WebField,
      value: string,
      admitMutation: BackendEffect<void>,
    ): BackendEffect<ComputerBackendActionResult> =>
      Effect.gen(function* () {
        const result = yield* inputDispatch(
          "set_value",
          { element_token: field.token, element_index: field.index, value },
          undefined,
          undefined,
          true,
          yield* target(windowId),
          admitMutation,
        );
        yield* assertDesktopOperationActive;
        const after = yield* resolveWebField(windowId, node);
        if (after?.value === value) return { ...result, verified: "confirmed", effect: "verified" };
        return { ...result, verified: "unconfirmed", effect: "dispatched-unknown" };
      });

    const missingWebField = () =>
      actionError(
        "The web text element is no longer present; observe fresh state.",
        "not-dispatched",
        "stale_target",
      );

    /**
     * Type into a Chromium-family web element. `AXSelectedText` writes dispatch
     * successfully yet never reach the DOM (verified: Electron 43, inactive and
     * frontmost alike), so the write composes `existing + text` through an
     * `AXValue` set — which lands, fires `input`, and leaves the operator's
     * front process untouched — then confirms the DOM value on a fresh read
     * instead of trusting the dispatch reply.
     */
    const webContentTypeText = (
      node: ComputerUiNode,
      value: string,
    ): BackendEffect<ComputerBackendActionResult> =>
      Effect.gen(function* () {
        const windowId = node.windowId!;
        const { pid, window_id } = yield* target(windowId);
        return yield* semanticTextInLane(pid, window_id, (admitMutation) =>
          Effect.gen(function* () {
            const before = yield* resolveWebField(windowId, node);
            if (!before) return yield* missingWebField();
            const composed = (before.value ?? "") + value;
            yield* assertDesktopOperationActive;
            return yield* webSetValue(node, windowId, before, composed, admitMutation);
          }),
        );
      });

    const keyboardTarget = (
      resolvedTarget: ComputerResolvedTarget | undefined,
      windowId?: string,
    ): BackendEffect<Record<string, unknown>> => {
      if (!resolvedTarget) return Effect.succeed({});
      const token = elementTokens.get(resolvedTarget.node);
      if (
        !token ||
        !resolvedTarget.node.windowId ||
        (windowId && resolvedTarget.node.windowId !== windowId)
      )
        return actionError(
          "The keyboard target is not bound to a live element in the requested window; observe fresh state.",
          "not-dispatched",
          "stale_target",
        );
      return Effect.succeed({ element_token: token });
    };

    const staleAxTarget = () =>
      actionError(
        "The AX text target is not bound to a live Cua token.",
        "not-dispatched",
        "stale_target",
      );

    const listApps = (): BackendEffect<readonly ComputerApp[]> =>
      Effect.gen(function* () {
        const result = yield* call("list_apps");
        const rows = result.structuredContent?.apps;
        if (!Array.isArray(rows))
          return yield* actionError(
            "Cua returned an invalid app list.",
            "not-dispatched",
            "invalid_response",
          );
        const apps: ComputerApp[] = [];
        for (const value of rows) {
          const row = record(value);
          // pid is 0 for installed-but-not-running apps — those rows are the
          // "is X installed?" half of the tool and must not be dropped.
          const pid = number(row.pid);
          const name = text(row.name, 512) || text(row.app_name, 512);
          if (!Number.isSafeInteger(pid) || pid < 0 || !name) continue;
          const bundleId = text(row.bundle_id, 512);
          // The driver's signature read, when it has one: durable consent
          // grants pin to bundle id + team id, so a missing team id only ever
          // narrows what a grant can match — it never invents an identity.
          const teamId = text(row.team_id, 128) || text(row.signing_team_id, 128);
          const launchPath = text(row.launch_path, 4_096);
          const lastUsed = text(row.last_used, 64);
          apps.push({
            pid,
            name: name.slice(0, 256),
            running: row.running === true || pid > 0,
            active: row.active === true || row.is_active === true,
            ...(bundleId ? { bundleId } : {}),
            ...(teamId ? { teamId } : {}),
            ...(launchPath ? { launchPath } : {}),
            ...(Array.isArray(row.windows) ? { windowCount: row.windows.length } : {}),
            ...(lastUsed ? { lastUsed } : {}),
          });
        }
        return apps.slice(0, 1_024);
      });

    const verdictPath = (data: Record<string, unknown>, fallbackRoute: string) =>
      `cua-${text(data.route, 64) || fallbackRoute}-${text(record(data.delivery).mode, 32) || "background"}`;

    /**
     * One pane still of whatever the task is using: the exact window, or the
     * tab of a bound driver-owned browser. No target means no frame — the pane
     * shows its waiting state rather than a whole-desktop picture.
     */
    const captureStill: BackendEffect<Uint8Array | undefined> = Effect.suspend(() => {
      const still = state.stillTarget;
      if (!still || state.disposed) return Effect.succeed(undefined);
      return still.kind === "browser"
        ? captureBrowserStill(still)
        : captureWindowStill(still.windowId);
    });

    /**
     * The pane still of one exact window: the driver's window capture with the
     * same validation the model's screenshot path applies, but never marked as
     * a model observation — the pane is not the model. A window that moved off
     * the current Space fails through the shared validation, so unverified
     * pixels never become a pane frame.
     */
    const captureWindowStill = (windowId: string): BackendEffect<Uint8Array> =>
      Effect.gen(function* () {
        const { pid, window_id } = yield* target(windowId);
        const result = yield* call(
          "get_window_state",
          {
            pid,
            window_id,
            include_screenshot: true,
            include_accessibility_tree: false,
            max_dimension: 1536,
          },
          false,
          false,
        );
        return Buffer.from((yield* screenshot(result)).bytesBase64, "base64");
      });

    /**
     * The tab still through the driver's CDP screenshot route. The snapshot is
     * read-only and carries the task attribution browser calls require; a
     * refusal (an ended session, a target that no longer resolves) is "nothing
     * to publish", not a retry-worthy failure.
     */
    const captureBrowserStill = (still: {
      readonly targetId: string;
      readonly tabId: string | undefined;
      readonly task: CuaComputerTask;
    }): BackendEffect<Uint8Array | undefined> => {
      if (!endpoint) return Effect.succeed(undefined);
      return transport(
        endpoint,
        {
          method: "call",
          name: "get_browser_state",
          args: {
            target_id: still.targetId,
            ...(still.tabId !== undefined ? { tab_id: still.tabId } : {}),
            include_screenshot: true,
          },
          task: still.task,
          capability,
        },
        { mutation: false, timeoutMs: 20_000 },
        { abortable: true },
      ).pipe(
        Effect.map((reply) => {
          if (!reply.ok) return undefined;
          const image = (reply.result?.content ?? []).find(
            (part) =>
              part.type === "image" && typeof part.data === "string" && part.data.length > 0,
          );
          return image?.data !== undefined ? Buffer.from(image.data, "base64") : undefined;
        }),
      );
    };

    /**
     * Remembers the browser tab the pane should mirror. A bind result mints the
     * target id; a snapshot call names it directly. The tab id comes from the
     * call, or from a bind whose tabs resolve to one — an ambiguous bind leaves
     * the still target unset until a call names the tab. The tab id is sticky:
     * a reply carrying neither an explicit tab nor resolvable tabs keeps the
     * prior tab for the same target instead of clearing it.
     */
    const noteBrowserStillTarget = (
      args: Record<string, unknown>,
      result: CuaToolResult,
      task: CuaComputerTask,
    ): void => {
      const structured = result.structuredContent ?? {};
      const targetId = text(structured.target_id) || text(args.target_id);
      if (!targetId) return;
      const resolved = text(args.tab_id) || resolvableStillTab(structured.tabs);
      const prior =
        state.stillTarget?.kind === "browser" && state.stillTarget.targetId === targetId
          ? state.stillTarget.tabId
          : undefined;
      state.stillTarget = {
        kind: "browser",
        targetId,
        tabId: resolved || prior || undefined,
        task,
      };
    };

    const stills = yield* makeStillFramePublisher({
      capture: () => captureStill,
      prepare: Effect.asVoid(availability()),
      isCaptureAvailable: () => !state.disposed && !state.permissions.includes("screenRecording"),
      emit: (frame) => Effect.asVoid(PubSub.publish(events, { type: "frame", frame })),
      // Still cadence is 1 s unless PATHWAY_CUA_PREVIEW_STILL_MS overrides it;
      // the publisher floor keeps an aggressive value from queueing captures
      // faster than one encode can finish.
      intervalMs: resolveStillIntervalMs(
        options.stillIntervalMs ?? cuaPreviewStillMsOverride() ?? CUA_STILL_FRAME_INTERVAL_MS,
      ),
    });

    const stopInput = (task?: {
      readonly threadId: string;
      readonly turnId?: string;
    }): BackendEffect<void> =>
      Effect.gen(function* () {
        if (task) {
          for (const [key, owned] of previewTasks) {
            if (owned.threadId === task.threadId && (!task.turnId || owned.turnId === task.turnId))
              previewTasks.delete(key);
          }
          const still = state.stillTarget;
          // Native window stills have no task attribution. Stop that preview
          // until a fresh observation supplies a target, rather than reuse a
          // cancelled task's window for a surviving subscriber.
          if (
            still?.kind === "window" ||
            (still?.kind === "browser" &&
              still.task.threadId === task.threadId &&
              (!task.turnId || still.task.turnId === task.turnId))
          )
            state.stillTarget = undefined;
        } else {
          previewTasks.clear();
          state.stillTarget = undefined;
        }
        if (endpoint) {
          const result = yield* transport(
            endpoint,
            { method: "stop", ...(task ? { task } : {}), capability },
            undefined,
            { abortable: false },
          );
          observeDesktopInterruption(result);
          if (!result.ok)
            return yield* actionError(
              result.error ?? "Computer stop was not acknowledged.",
              "dispatched-unknown",
            );
        }
        observedGeometry.clear();
        state.snapshotAt = 0;
      });

    const endTask = (threadId: string, turnId?: string): BackendEffect<void> =>
      Effect.gen(function* () {
        if (!endpoint || state.disposed) return;
        const matches = [...previewTasks].filter(
          ([, task]) =>
            task.threadId === threadId && (turnId === undefined || task.turnId === turnId),
        );
        if (matches.length === 0) return;
        const reply = yield* transport(
          endpoint,
          {
            method: "end_task",
            task: { threadId, ...(turnId ? { turnId } : {}) },
            capability,
          },
          undefined,
          { abortable: false },
        );
        observeDesktopInterruption(reply);
        if (!reply.ok) return yield* plainError(reply.error ?? "Computer preview did not stop.");
        for (const [key] of matches) previewTasks.delete(key);
        // A pane still must never revive an ended browser session: drop the
        // target the moment its task ends.
        const still = state.stillTarget;
        if (
          still?.kind === "browser" &&
          still.task.threadId === threadId &&
          (turnId === undefined || still.task.turnId === turnId)
        )
          state.stillTarget = undefined;
        // Task-owned grounding ends with the task: a revoked task's window
        // pixels must not ground a later claim, so the next input re-observes.
        observedGeometry.clear();
      });

    /**
     * Release paths ride `request` directly — never the operation signal — so
     * they still land while their own operation is being cancelled. That is
     * the whole point: a shield outlives nothing.
     */
    const releaseShieldRequest = (args: Record<string, unknown>, failure: string) =>
      Effect.gen(function* () {
        if (!endpoint || state.disposed) return;
        const reply = yield* transport(
          endpoint,
          { method: "shield", args, capability },
          { timeoutMs: 5_000 },
          { abortable: false },
        );
        if (!reply.ok) return yield* actionError(reply.error ?? failure, "not-dispatched");
      });

    /**
     * The CDP browser surface. Deliberately NOT routed through `call`: the
     * desktop path converts `isError`/`status:"refused"` replies into typed
     * failures, but a browser refusal IS the result the model must branch on.
     * The host checks fresh browser observations against the exact CDP target
     * after interruption; they do not update desktop window geometry.
     */
    const browserCall = (browser: ComputerBrowserCall): BackendEffect<ComputerBrowserCallResult> =>
      Effect.gen(function* () {
        if (state.disposed || !endpoint) return yield* guiHostRequired();
        yield* assertDesktopOperationActive;
        const task: CuaComputerTask = {
          threadId: browser.task.threadId,
          ...(browser.task.turnId ? { turnId: browser.task.turnId } : {}),
          ...(browser.task.label ? { label: browser.task.label } : {}),
        };
        // Browser work is a live preview task too: an endTask must still reach
        // the host (frame tap, shields), and a bind call carrying the bound
        // window's pid/window_id is what points the frame tap at it.
        trackPreviewTask(task);
        const deliveryMode = yield* desktopDeliveryMode;
        const modelObservation =
          browser.name === "get_browser_state" ? yield* isModelDesktopObservationActive : undefined;
        const signal = yield* desktopOperationSignal;
        const reply = yield* timedComputerLeg(
          "host",
          raceDesktopSignal(
            transport(
              endpoint,
              {
                method: "call",
                name: browser.name,
                args: browser.args,
                deliveryMode,
                ...(modelObservation !== undefined ? { modelObservation } : {}),
                task,
                capability,
              },
              { mutation: browser.mutation, timeoutMs: CUA_HOST_TIMEOUT_MS },
              { abortable: true },
            ),
            signal,
          ),
        );
        // Desktop-epoch bookkeeping stays skipped on the CDP surface, but the
        // interruption count is host state, not reply semantics: a browser
        // reply proving a lock ran still invalidates pre-interruption consent.
        observeDesktopInterruption(reply);
        if (!reply.ok)
          return yield* actionError(
            reply.error ?? "Cua host failed.",
            reply.effect ?? "not-dispatched",
          );
        const result = reply.result ?? {};
        noteBrowserStillTarget(browser.args, result, task);
        return result;
      });

    /**
     * Thread-scoped browser teardown. Thread removal is reversible (archive →
     * unarchive), but the session-end hooks are the driver's authoritative
     * cleanup — endpoints, grants, and owned browsers release now, and a
     * revived thread's next call reopens the same label via `start_session`.
     */
    const endBrowserThread = (threadId: string): BackendEffect<void> =>
      Effect.gen(function* () {
        if (!endpoint || state.disposed) return;
        const reply = yield* transport(
          endpoint,
          { method: "end_browser_thread", task: { threadId }, capability },
          undefined,
          { abortable: false },
        );
        observeDesktopInterruption(reply);
        if (!reply.ok)
          return yield* plainError(reply.error ?? "Browser session teardown was not acknowledged.");
      });

    const dispose = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (state.disposed) return;
        yield* stills.detach;
        // Teardown cannot depend on the host still answering: an unreachable
        // endpoint means the input path it owned is already gone, so a
        // transport failure here confirms rather than defeats the stop.
        yield* Effect.ignore(stopInput());
        state.disposed = true;
      });

    yield* Effect.addFinalizer(dispose);

    const backend = {
      computerId: DEFAULT_COMPUTER_ID,
      // The AXPress/meta-key dialect is macOS semantics; Windows and Linux
      // drivers speak the generic desktop dialect (press, ctrl+chords). The
      // host reports its own platform on every reply — a remote endpoint on
      // another OS overrides the local assumption.
      get agentDialect(): ComputerAgentDialect {
        return hostPlatform() === "darwin" ? "macos" : "linux";
      },
      get focusNeutralSemanticText(): boolean {
        return focusNeutralSemanticText();
      },
      get exactTargetBackgroundInput(): boolean {
        return exactTargetBackgroundInput();
      },
      events: Stream.fromPubSub(events),
      probeAvailability,
      availability,
      provision,
      health: (): ComputerHealth => state.currentHealth,
      capabilities,
      missingPermissions: (): BackendEffect<readonly ComputerPermission[]> =>
        Effect.sync(() => state.permissions),
      /**
       * How this build is code-signed, for the stale-grant advice. The helper
       * only reports the responsible bundle id, never the signature itself, so
       * the honest stable answer is `unknown`.
       */
      buildSignature: (): ComputerBuildSignature => "unknown",
      listWindows: (): BackendEffect<readonly ComputerWindow[]> =>
        Effect.as(refresh(), state.windows).pipe(Effect.map(() => state.windows)),
      listSpaces: () =>
        call("list_spaces").pipe(
          Effect.catch((error) =>
            Effect.andThen(
              assertDesktopOperationActive,
              Effect.fail(
                new ComputerSpaceError(
                  "computer_spaces_unavailable",
                  `Managed Space inventory is unavailable: ${error.message}. Drive an exact existing window in place instead.`,
                ),
              ),
            ),
          ),
          Effect.flatMap((result) => cuaSpaceInventory(result.structuredContent ?? {})),
        ),
      getScreenSize: (): BackendEffect<ComputerScreenSize> =>
        Effect.map(refresh(), () => state.size),
      getState,
      captureScreenshot,
      focusWindow: (windowId: string): BackendEffect<void> =>
        Effect.gen(function* () {
          // Selection sends no input. The actual actuator revalidates the exact
          // window immediately before dispatch; reuse the just-observed identity.
          yield* target(windowId, !state.windows.some((window) => window.id === windowId));
          state.selectedWindow = windowId;
          // The pane still follows the window the task aims at, so a watching
          // pane mirrors the work without a per-action capture request.
          state.stillTarget = { kind: "window", windowId };
        }),
      checkInputReady: (windowId: string): BackendEffect<void> =>
        Effect.gen(function* () {
          const { pid, window_id, window } = yield* target(windowId);
          if (state.hostPlatform === "linux") {
            // The Linux artifact has no native readiness gate. A fresh
            // exact-window observation can clear a stale target pause, but does
            // not certify input delivery: host admission still refuses
            // unsupported background routes.
            if (!window.visible)
              return yield* actionError(
                "The Linux target is not visible in the current desktop session.",
                "not-dispatched",
                "target_not_on_active_space",
              );
            return;
          }
          const data =
            (yield* call("check_input_ready", { pid, window_id })).structuredContent ?? {};
          if (
            data.ready !== true ||
            number(data.pid) !== pid ||
            number(data.window_id) !== window_id
          )
            return yield* actionError(
              "Cua did not confirm input readiness for the exact target window.",
              "not-dispatched",
              "invalid_readiness",
            );
        }),
      /**
       * The driver's AX-observer settle: `wait_for_settle` is a read-only tool
       * — no input admission, no mutation lease — so this call runs through the
       * ordinary read path. An older or refusing driver fails through `call`'s
       * normal error path and the caller falls back to the fixed settle.
       */
      waitForSettle: (settleOptions: {
        readonly windowId: string;
        readonly timeoutMs: number;
        readonly quietMs: number;
      }) =>
        Effect.gen(function* () {
          const { pid, window_id } = yield* target(settleOptions.windowId);
          const data =
            (yield* call("wait_for_settle", {
              pid,
              window_id,
              timeout_ms: Math.max(0, Math.min(30_000, Math.floor(settleOptions.timeoutMs))),
              quiet_ms: Math.max(0, Math.min(5_000, Math.floor(settleOptions.quietMs))),
            })).structuredContent ?? {};
          if (typeof data.settled !== "boolean")
            return yield* actionError(
              "Cua did not return a settle verdict for the exact target window.",
              "not-dispatched",
              "invalid_settle_read",
            );
          const waited = number(data.waited_ms);
          return {
            settled: data.settled,
            waitedMs: Number.isFinite(waited) ? waited : 0,
            ...(typeof data.events_seen === "number" ? { eventsSeen: data.events_seen } : {}),
          };
        }),
      raiseWindow: (windowId: string): BackendEffect<void> =>
        Effect.gen(function* () {
          if ((yield* desktopDeliveryMode) !== "foreground")
            return yield* actionError(
              "Window activation requires foreground delivery within an authorized Computer task.",
              "not-dispatched",
              "foreground_required",
            );
          const { pid, window_id } = yield* target(windowId);
          const result = yield* call("bring_to_front", { pid, window_id }, true);
          if (result.structuredContent?.activated !== true)
            return yield* actionError(
              "Cua could not verify that the exact window became foreground. Do not repeat the activation blindly.",
              "dispatched-unknown",
            );
          state.snapshotAt = 0;
        }),
      clearFocusWindow: (): BackendEffect<void> =>
        Effect.sync(() => {
          state.selectedWindow = undefined;
          state.stillTarget = undefined;
        }),
      launchApp: (
        app: string,
        args: readonly string[],
        launchOptions?: { readonly hidden?: boolean },
      ): BackendEffect<ComputerLaunchAppResult> =>
        Effect.gen(function* () {
          // A standalone endpoint can run on a different OS than the server.
          // Learn that OS before choosing a launch schema or dispatching input.
          if (state.hostPlatform === undefined) yield* host({ method: "probe" });
          const linux = hostPlatform() === "linux";
          if (linux && launchOptions?.hidden !== false)
            return yield* actionError(
              "This Linux driver cannot guarantee a hidden app launch. Use an already open app, " +
                "or request a visible launch only when the user's task asks to see the app.",
              "not-dispatched",
              "unsupported_operation",
            );
          if (!linux && app.startsWith("/"))
            return yield* actionError(
              "Use an installed app's name or bundle identifier with Cua.",
              "not-dispatched",
              "unsupported_operation",
            );
          // Upstream splits launch_path on whitespace. Passing a path containing
          // spaces could execute a different prefix, so use an installed app ID.
          if (linux && app.startsWith("/") && /\s/.test(app))
            return yield* actionError(
              "This Linux driver cannot launch an executable path containing whitespace. " +
                "Use the installed application's desktop ID and pass arguments separately.",
              "not-dispatched",
              "unsupported_operation",
            );
          const result = yield* call(
            "launch_app",
            {
              ...(linux
                ? app.startsWith("/")
                  ? { launch_path: app }
                  : { name: app }
                : /^[a-zA-Z][\w-]*(\.[\w-]+)+$/.test(app)
                  ? { bundle_id: app }
                  : { name: app }),
              ...(args.length ? { additional_arguments: args } : {}),
              // hidden is a Pathway macOS extension, absent from upstream
              // Linux's strict schema. Linux visible consent is checked by the
              // tool layer.
              ...(!linux && launchOptions?.hidden === true ? { hidden: true } : {}),
            },
            true,
          );
          const structured = result.structuredContent ?? {};
          const pid = number(structured.pid);
          const nativeReason = structured.window_reason;
          const windowReason =
            nativeReason === "hidden" ||
            nativeReason === "off_space" ||
            nativeReason === "no_window" ||
            nativeReason === "input_unavailable"
              ? nativeReason
              : undefined;
          const unavailable =
            structured.window_status === "no_usable_window" && windowReason !== undefined;
          return {
            computerId: DEFAULT_COMPUTER_ID,
            app,
            window: null,
            ...(typeof structured.focus_changed_during_launch === "boolean"
              ? { focusChangedDuringLaunch: structured.focus_changed_during_launch }
              : {}),
            windowStatus: unavailable ? "no_usable_window" : "not_checked",
            ...(unavailable ? { windowReason } : {}),
            ...(Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? { pid } : {}),
          };
        }),
      listApps,
      setWindowFrame: (windowId: string, frame: ComputerRect) =>
        Effect.gen(function* () {
          if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)
            return yield* actionError(
              "A window frame needs finite coordinates and a positive size.",
              "not-dispatched",
              "invalid_geometry",
            );
          const { pid, window_id, window } = yield* target(windowId);
          const result = yield* call(
            "set_window_frame",
            { pid, window_id, x: frame.x, y: frame.y, width: frame.width, height: frame.height },
            true,
          );
          const data = result.structuredContent ?? {};
          // The driver's own `effect: confirmed` + value_readback is not the
          // verification. A mutation was already dispatched, so the only honest
          // confirmation is a fresh list_windows read showing the exact frame
          // on the exact window; a readback that cannot be taken or disagrees
          // leaves the outcome unknown — never a silent success.
          const observed = yield* readWindows().pipe(
            Effect.map(
              (windows) => windows.find((candidate) => candidate.id === window.id)?.bounds,
            ),
            Effect.orElseSucceed(() => undefined),
          );
          const confirmed = observed !== undefined && sameRect(observed, frame);
          // Ground the next input on what the read-back actually saw, not on
          // the requested frame: when the move did not land, `observed` is
          // still the true geometry; when the read-back failed, nothing stays.
          if (observed !== undefined) observedGeometry.set(window.id, observed);
          else observedGeometry.delete(window.id);
          state.snapshotAt = 0;
          return {
            windowId: window.id,
            deliveryPath: verdictPath(data, "window_frame"),
            verified: confirmed ? "confirmed" : "unconfirmed",
            effect: confirmed ? "verified" : "dispatched-unknown",
          } satisfies ComputerBackendActionResult;
        }),
      invokeMenu: (menuTarget: ComputerMenuBackendTarget, path: readonly string[]) =>
        Effect.gen(function* () {
          // Fail closed rather than truncate: a sliced path can resolve to a
          // different menu item than the caller named, which is worse than a
          // refusal.
          if (
            path.length === 0 ||
            path.length > 6 ||
            path.some((segment) => segment.trim().length === 0)
          )
            return yield* actionError(
              "A menu path needs one to six non-empty titles.",
              "not-dispatched",
              "invalid_arguments",
            );
          // Two routes, one potentially activating driver tool. The manager
          // gates both on visible-use authorization. The windowless form names
          // only the application's AXMenuBar, so its result must not fabricate
          // a window id.
          let result: CuaToolResult;
          let windowId: string | undefined;
          if ("windowId" in menuTarget) {
            const resolved = yield* target(menuTarget.windowId);
            windowId = resolved.window.id;
            result = yield* call(
              "invoke_menu",
              { pid: resolved.pid, window_id: resolved.window_id, path: [...path] },
              true,
            );
          } else {
            if (!Number.isSafeInteger(menuTarget.pid) || menuTarget.pid <= 0)
              return yield* actionError(
                "invoke_menu needs a positive integer pid for the windowless form.",
                "not-dispatched",
                "invalid_arguments",
              );
            result = yield* call("invoke_menu", { pid: menuTarget.pid, path: [...path] }, true);
          }
          const data = result.structuredContent ?? {};
          const confirmed = data.effect === "confirmed";
          // A menu command can open or close windows (a Save dialog, a Quit),
          // so any earlier observation of the desktop no longer describes it.
          state.snapshotAt = 0;
          return {
            ...(windowId !== undefined ? { windowId } : {}),
            deliveryPath: verdictPath(data, "menu"),
            verified: confirmed
              ? "confirmed"
              : data.effect === "unconfirmed"
                ? "unconfirmed"
                : "unverifiable",
            effect: confirmed ? "verified" : "dispatched-unknown",
          } satisfies ComputerBackendActionResult;
        }),
      setWindowMinimized: (windowId: string, minimized: boolean) =>
        Effect.gen(function* () {
          // Fail closed rather than coerce: a non-boolean flag cannot be
          // honored exactly, and guessing a direction hides the caller's mistake.
          if (typeof minimized !== "boolean")
            return yield* actionError(
              "set_window_minimized needs a boolean minimized flag.",
              "not-dispatched",
              "invalid_arguments",
            );
          const { pid, window_id, window } = yield* target(windowId);
          const result = yield* call("set_window_minimized", { pid, window_id, minimized }, true);
          const data = result.structuredContent ?? {};
          const confirmed = confirmedValueReadback(data);
          // A minimize or restore changes what is on screen; retained geometry
          // no longer describes it.
          state.snapshotAt = 0;
          return {
            windowId: window.id,
            deliveryPath: verdictPath(data, "window_minimized"),
            verified: confirmed
              ? "confirmed"
              : data.effect === "unconfirmed" || data.effect === "suspected_noop"
                ? "unconfirmed"
                : "unverifiable",
            effect: confirmed ? "verified" : "dispatched-unknown",
          } satisfies ComputerBackendActionResult;
        }),
      setAppVisibility: (pid: number, hidden: boolean) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(pid) || pid <= 0 || typeof hidden !== "boolean")
            return yield* actionError(
              "set_app_visibility needs a positive integer pid and a boolean hidden flag.",
              "not-dispatched",
              "invalid_arguments",
            );
          const result = yield* call("set_app_visibility", { pid, hidden }, true);
          const data = result.structuredContent ?? {};
          const confirmed = confirmedValueReadback(data);
          state.snapshotAt = 0;
          return {
            deliveryPath: verdictPath(data, "app_visibility"),
            verified: confirmed
              ? "confirmed"
              : data.effect === "unconfirmed" || data.effect === "suspected_noop"
                ? "unconfirmed"
                : "unverifiable",
            effect: confirmed ? "verified" : "dispatched-unknown",
          } satisfies ComputerBackendActionResult;
        }),
      verifyState: (
        windowId: string,
        expect: readonly Record<string, unknown>[],
      ): BackendEffect<ComputerVerifyStateResult> =>
        Effect.gen(function* () {
          // Fail closed rather than truncate: a sliced predicate set can answer
          // a different question than the caller asked.
          if (
            expect.length === 0 ||
            expect.length > 8 ||
            expect.some((item) => !item || typeof item !== "object" || Array.isArray(item))
          )
            return yield* actionError(
              "verify_state needs one to eight object predicates.",
              "not-dispatched",
              "invalid_arguments",
            );
          const { pid, window_id } = yield* target(windowId);
          const data =
            (yield* call("verify_state", { pid, window_id, expect: [...expect] }))
              .structuredContent ?? {};
          // `unknown` is a verdict, not a failure shape: the driver could not
          // prove the predicate either way, which must never collapse into
          // `unsatisfied`.
          const status =
            data.status === "satisfied" ||
            data.status === "unsatisfied" ||
            data.status === "unknown"
              ? data.status
              : "unknown";
          return {
            status,
            stable: data.stable === true,
            samples: Math.max(0, Math.trunc(number(data.samples) || 0)),
            elapsedMs: Math.max(0, Math.trunc(number(data.elapsed_ms) || 0)),
            predicates: Array.isArray(data.predicates) ? data.predicates.slice(0, 8) : [],
          };
        }),
      zoomWindow: (windowId: string, region: ComputerRect): BackendEffect<ComputerZoomResult> =>
        Effect.gen(function* () {
          if (
            !Object.values(region).every(Number.isFinite) ||
            region.width <= 0 ||
            region.height <= 0
          )
            return yield* actionError(
              "The zoom region needs finite geometry and positive size.",
              "not-dispatched",
              "invalid_geometry",
            );
          const { pid, window_id, window } = yield* target(windowId);
          const bounds = window.bounds!;
          if (
            region.x < 0 ||
            region.y < 0 ||
            region.x + region.width > bounds.width ||
            region.y + region.height > bounds.height
          )
            return yield* actionError(
              "The zoom region lies outside the target window.",
              "not-dispatched",
              "invalid_geometry",
            );
          // The driver crops in "screenshot pixels" — the pixel space of its
          // own get_window_state capture for this exact window, which is the
          // window's display backing factor, not necessarily the main
          // display's. Read that scale from a fresh capture-only state call (no
          // max_dimension, so the returned image is the driver's
          // native-resolution space) rather than assuming the desktop scale.
          const captured = yield* Effect.gen(function* () {
            const read = yield* call("get_window_state", {
              pid,
              window_id,
              include_accessibility_tree: false,
              include_screenshot: true,
            });
            yield* assertObservedWindow(read, pid, window_id);
            return read;
          }).pipe(Effect.tapError(markUnlessOffSpace));
          const stateData = captured.structuredContent ?? {};
          const freshBounds = stateData.window_bounds
            ? optionalRect(stateData.window_bounds)
            : undefined;
          if (!freshBounds || !sameRect(freshBounds, bounds))
            return yield* actionError(
              "The target window moved before the zoom capture.",
              "not-dispatched",
              "stale_target",
            );
          const reportedScale = number(stateData.screenshot_scale);
          const fallback = yield* screenshot(captured, freshBounds);
          const scale =
            Number.isFinite(reportedScale) && reportedScale > 0
              ? reportedScale
              : (fallback.scale ?? 0);
          if (!(scale > 0))
            return yield* actionError(
              "Cua could not establish the window's screenshot scale.",
              "not-dispatched",
              "capture_unavailable",
            );
          const result = yield* call("zoom", {
            pid,
            window_id,
            x1: region.x * scale,
            y1: region.y * scale,
            x2: (region.x + region.width) * scale,
            y2: (region.y + region.height) * scale,
          });
          const image = result.content?.find(
            (c) => c.type === "image" && c.mimeType === "image/jpeg" && c.data,
          );
          const data = result.structuredContent ?? {};
          if (!image?.data)
            return yield* actionError(
              "Cua returned no zoom image.",
              "not-dispatched",
              "capture_unavailable",
            );
          const bytes = Buffer.from(image.data, "base64");
          // Dimensions come from the JPEG's own headers; the structured fields
          // are only a fallback for a driver that omits them, and both must be
          // sane before the result is trusted enough to hand a model.
          const dimensions = jpegDimensions(bytes) ?? {
            width: Math.trunc(number(data.width) || 0),
            height: Math.trunc(number(data.height) || 0),
          };
          if (dimensions.width <= 0 || dimensions.height <= 0)
            return yield* actionError(
              "Cua returned a zoom image without readable dimensions.",
              "not-dispatched",
              "invalid_response",
            );
          return {
            mimeType: "image/jpeg" as const,
            width: dimensions.width,
            height: dimensions.height,
            sizeBytes: bytes.byteLength,
            bytesBase64: image.data,
            windowId: window.id,
            capturedAt: yield* nowIso,
          };
        }),
      getAccessibilityTree: (windowId?: string) =>
        Effect.gen(function* () {
          // The driver's snapshot is desktop-wide and takes no arguments at all
          // — the named tool is the fast no-grant inventory, not a per-window
          // AX walk. `window_id` scoping is therefore a Pathway-side filter to
          // the app that owns the exact window, resolved through the same fresh
          // target every window read uses.
          const scopedPid = windowId === undefined ? undefined : (yield* target(windowId)).pid;
          const data = (yield* call("get_accessibility_tree")).structuredContent ?? {};
          if (!Array.isArray(data.apps) || !Array.isArray(data.windows))
            return yield* actionError(
              "Cua returned an invalid desktop inventory.",
              "not-dispatched",
              "invalid_response",
            );
          const apps: ComputerAccessibilityTreeApp[] = [];
          for (const value of data.apps) {
            const row = record(value);
            const pid = number(row.pid);
            const name = text(row.name);
            // This inventory only ever lists running apps, so a non-positive
            // pid is a malformed row, not the not-running marker list_apps uses.
            if (!Number.isSafeInteger(pid) || pid <= 0 || name.length === 0) continue;
            if (scopedPid !== undefined && pid !== scopedPid) continue;
            const bundleId = text(row.bundle_id, 512);
            apps.push({ pid, name, ...(bundleId ? { bundleId } : {}) });
          }
          const windows: ComputerAccessibilityTreeWindow[] = [];
          for (const value of data.windows) {
            const row = record(value);
            const pid = number(row.pid);
            const wid = number(row.window_id);
            // Without the driver id pair no Pathway window id can be formed, so
            // the row is unresolvable rather than merely thin.
            if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(wid) || wid <= 0)
              continue;
            if (scopedPid !== undefined && pid !== scopedPid) continue;
            const appName = text(row.app_name);
            const bounds = optionalRect(row.bounds);
            const zIndex = number(row.z_index);
            windows.push({
              id: `cua:${pid}:${wid}`,
              pid,
              ...(appName ? { appName } : {}),
              title: text(row.title),
              ...(bounds ? { bounds } : {}),
              ...(typeof row.is_on_screen === "boolean" ? { onScreen: row.is_on_screen } : {}),
              ...(Number.isInteger(zIndex) && zIndex >= 0 ? { zIndex } : {}),
            });
          }
          const truncated = apps.length > 1_024 || windows.length > COMPUTER_WINDOW_LIST_MAX_LENGTH;
          return {
            apps: apps.slice(0, 1_024),
            windows: windows.slice(0, COMPUTER_WINDOW_LIST_MAX_LENGTH),
            truncated,
          };
        }),
      getCursorPosition: (
        windowId?: string,
      ): BackendEffect<Omit<ComputerCursorPosition, "computerId" | "availability">> =>
        Effect.gen(function* () {
          // A scoped read also answers "is the cursor inside this window": the
          // position itself is desktop-global either way, so scoping resolves
          // the window's current bounds rather than changing what the driver
          // returns.
          const window = windowId === undefined ? undefined : (yield* target(windowId)).window;
          const data = (yield* call("get_cursor_position")).structuredContent ?? {};
          const x = number(data.x);
          const y = number(data.y);
          if (!Number.isFinite(x) || !Number.isFinite(y))
            return yield* actionError(
              "Cua returned no cursor position.",
              "not-dispatched",
              "invalid_response",
            );
          const bounds = window?.bounds;
          return {
            x,
            y,
            capturedAt: yield* nowIso,
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
        }),
      killApp: (pid: number) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(pid) || pid <= 0)
            return yield* actionError(
              "kill_app needs a positive integer pid.",
              "not-dispatched",
              "invalid_arguments",
            );
          // kill_app is not an action-result tool: success is a bare "sent
          // SIGKILL" text reply, so the only honest confirmation is an
          // independent check that the process is actually gone afterwards.
          yield* call("kill_app", { pid }, true);
          // The window set is stale the moment the signal lands: drop every
          // retained geometry for the dead pid before the read-back, so nothing
          // grounds a later call on a window that no longer exists.
          state.snapshotAt = 0;
          for (const key of observedGeometry.keys())
            if (key.startsWith(`cua:${pid}:`)) observedGeometry.delete(key);
          // A killed process can linger in the app list for a beat while the OS
          // reaps it — poll briefly before admitting the kill is unconfirmed.
          let gone = false;
          for (let attempt = 0; attempt < 4 && !gone; attempt += 1) {
            if (attempt > 0) yield* Effect.sleep(Duration.millis(250));
            gone = !(yield* listApps()).some((app) => app.pid === pid && app.running);
          }
          return {
            deliveryPath: "cua-process_signal-background",
            verified: gone ? "confirmed" : "unconfirmed",
            effect: gone ? "verified" : "dispatched-unknown",
          } satisfies ComputerBackendActionResult;
        }),
      supportsAction: (resolvedTarget: ComputerResolvedTarget, action: string): boolean => {
        const spec = cuaElementAction(action);
        return (
          spec !== undefined && elementActions.get(resolvedTarget.node)?.has(spec.axAction) === true
        );
      },
      click: (
        point: ComputerPoint,
        windowId?: string,
        modifiers?: readonly ComputerInputModifier[],
      ) =>
        clickWith(
          {
            // Revision 34 checks advertised AXPress and suppresses activation
            // on hit-test clicks. Older/unknown drivers retain the previous
            // route. A modified click stays physical because AXPress would lose
            // its keys.
            ...((state.driverNativeRevision ?? 0) < 34 || modifiers?.length
              ? { force_synthetic: true }
              : {}),
            count: 1,
          },
          point,
          windowId,
          modifiers,
        ),
      doubleClick: (
        point: ComputerPoint,
        windowId?: string,
        modifiers?: readonly ComputerInputModifier[],
      ) => clickWith({ force_synthetic: true, count: 2 }, point, windowId, modifiers),
      tripleClick: (
        point: ComputerPoint,
        windowId?: string,
        modifiers?: readonly ComputerInputModifier[],
      ) => clickWith({ force_synthetic: true, count: 3 }, point, windowId, modifiers),
      rightClick: (
        point: ComputerPoint,
        windowId?: string,
        modifiers?: readonly ComputerInputModifier[],
      ) => clickWith({ force_synthetic: true, button: "right" }, point, windowId, modifiers),
      moveCursor: (point: ComputerPoint, windowId?: string) =>
        Effect.gen(function* () {
          if (windowId) yield* target(windowId);
          yield* call("move_cursor", { x: point.x, y: point.y }, true);
          return {
            point,
            deliveryPath: "cua-overlay-only",
            verified: "unverifiable",
          } satisfies ComputerBackendActionResult;
        }),
      drag: (from: ComputerPoint, to: ComputerPoint, durationMs: number, windowId?: string) =>
        Effect.gen(function* () {
          // Both scopes are admitted: a drag is exact-target by construction —
          // `target` requires a live `cua:<pid>:<window_id>` and `local` refuses
          // any endpoint outside its bounds. In background mode the native
          // driver applies its own WindowPointer admission before posting the
          // window-local CGEvent gesture, and reports `unverifiable` for
          // surfaces that drop the events, so the caller still verifies the
          // drop from a fresh screenshot. A driver build that predates
          // background drag support refuses with `background_unavailable`;
          // foreground stays the explicit fallback.
          if (durationMs > 10_000)
            return yield* actionError(
              "Cua drag duration is limited to 10 seconds.",
              "not-dispatched",
              "unsupported_operation",
            );
          const resolved = yield* target(windowId);
          const bounds = resolved.window.bounds!;
          const observed = observedGeometry.get(resolved.window.id);
          if (!observed || !sameRect(observed, bounds))
            return yield* actionError(
              "Window geometry changed since observation; obtain a new screenshot.",
              "not-dispatched",
              "stale_geometry",
            );
          const local = (p: ComputerPoint) => {
            const x = p.x - bounds.x,
              y = p.y - bounds.y;
            return !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              x < 0 ||
              y < 0 ||
              x >= bounds.width ||
              y >= bounds.height
              ? undefined
              : { x, y };
          };
          const start = local(from),
            end = local(to);
          if (!start || !end)
            return yield* actionError("Drag crosses outside its target window.", "not-dispatched");
          return yield* input(
            "drag",
            {
              from_x: start.x,
              from_y: start.y,
              to_x: end.x,
              to_y: end.y,
              duration_ms: durationMs,
              coordinate_space: "window_points",
            },
            resolved.window.id,
            undefined,
            bounds,
          );
        }),
      /**
       * A scroll is one wheel gesture at the target point. Two axes and held
       * modifiers ride the same gesture: native rev 16 takes signed per-axis
       * ticks plus a modifier list and posts them as one pixel-unit wheel
       * stream, so a diagonal or ctrl-scroll no longer splits into two
       * dispatches.
       *
       * When the target carries an element token and the request is an
       * unmodified vertical scroll, the driver can try its quietest route first
       * — AppKit scroll-bar AX presses, which never touch the pointer at all —
       * before falling back to the wheel. Signed-tick mode deliberately skips
       * that path: the deltas describe a wheel gesture, and mixing AX travel
       * into wheel gearing would teach the calibration loop a ratio that is
       * neither.
       */
      scroll: (
        point: ComputerPoint | null,
        dx: number,
        dy: number,
        windowId?: string,
        modifiers?: readonly ComputerInputModifier[],
        resolvedTarget?: ComputerResolvedTarget,
      ): BackendEffect<ComputerBackendActionResult> =>
        Effect.gen(function* () {
          if (!point)
            return yield* actionError(
              "Scroll requires a screenshot target point.",
              "not-dispatched",
            );
          if (!dx && !dy)
            return {
              ...(windowId ? { windowId } : {}),
              scrollDelta: { deltaX: 0, deltaY: 0 },
              deliveryPath: "cua-no-op",
              verified: "unverifiable",
              effect: "not-dispatched",
            };
          // Pinned macOS source defines one targeted line-notch as 120 wheel
          // pixels. Expose the quantization per axis; never multiply a
          // requested pixel into a notch. A nonzero axis still delivers at
          // least one notch.
          const ticksX = dx ? Math.max(1, Math.round(Math.abs(dx) / 120)) : 0;
          const ticksY = dy ? Math.max(1, Math.round(Math.abs(dy) / 120)) : 0;
          if (ticksX > 50 || ticksY > 50)
            return yield* actionError(
              "Scroll exceeds Cua's 50-notch limit.",
              "not-dispatched",
              "unsupported_operation",
            );
          const mods = modifiers?.length ? yield* cuaKeys(modifiers) : undefined;
          // CGEvent wheel ticks use negative values for down/right, opposite to
          // the public pixel deltas. Linux receives named directions.
          const wheelSign = hostPlatform() === "darwin" ? -1 : 1;
          const token = resolvedTarget ? elementTokens.get(resolvedTarget.node) : undefined;
          if (
            resolvedTarget &&
            observedComputerTargetNode(resolvedTarget.target) &&
            (!token || dx || mods)
          )
            return yield* actionError(
              "This observed element only supports exact unmodified vertical scrolling. Use an explicit current screenshot target for other wheel gestures; no coordinate fallback was sent.",
              "not-dispatched",
              "unsupported_operation",
            );
          const args: Record<string, unknown> =
            token !== undefined && !dx && mods === undefined
              ? // AX-first: the driver resolves the token, tries scroll-bar
                // presses, then falls back to a wheel at the element's centre.
                {
                  direction: dy > 0 ? "down" : "up",
                  amount: ticksY,
                  by: "line",
                  element_token: token,
                }
              : {
                  // Wheel gesture: `direction` stays the schema-required
                  // dominant axis while the signed ticks carry the real
                  // per-axis amounts — including a two-axis diagonal in one
                  // dispatch.
                  direction: ticksY ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : "left",
                  delta_x: ticksX ? wheelSign * Math.sign(dx) * ticksX : 0,
                  delta_y: ticksY ? wheelSign * Math.sign(dy) * ticksY : 0,
                  ...(mods ? { modifiers: mods } : {}),
                };
          const result = yield* input("scroll", args, windowId, point);
          return {
            ...result,
            scrollDelta: {
              deltaX: ticksX ? Math.sign(dx) * ticksX * 120 : 0,
              deltaY: ticksY ? Math.sign(dy) * ticksY * 120 : 0,
            },
          };
        }),
      typeText: (
        value: string,
        windowId?: string,
        resolvedTarget?: ComputerResolvedTarget,
      ): BackendEffect<ComputerBackendActionResult> =>
        Effect.gen(function* () {
          const token = resolvedTarget ? elementTokens.get(resolvedTarget.node) : undefined;
          if (resolvedTarget && (!token || !resolvedTarget.node.windowId))
            return yield* staleAxTarget();
          if (token && resolvedTarget && webContentElements.has(resolvedTarget.node)) {
            if (observedComputerTargetNode(resolvedTarget.target)) {
              if ((state.driverNativeRevision ?? 0) < 37)
                return yield* actionError(
                  "This driver cannot append through a retained web element. Use computer_set_value to replace its complete value, or update the driver; no input was sent.",
                  "not-dispatched",
                  "unsupported_operation",
                );
              // Snapshot reads rotate native tokens. Compose and verify on the
              // original retained element inside the driver's semantic lease.
              return yield* input(
                "set_value",
                { element_token: token, value, append: true },
                resolvedTarget.node.windowId!,
              );
            }
            return yield* webContentTypeText(resolvedTarget.node, value);
          }
          // Without an exact element the macOS driver inserts the whole string
          // in one AXSelectedText write into the field the target window has
          // focused, reads it back, and only then falls back to native key
          // events. Forcing key events skipped that instant route and typed
          // every sentence character by character. The driver's 30ms default
          // gap is also overridden: exact semantic insertion is one
          // acknowledged, cancellable write per character, so its pause is pure
          // delay, while the key-event fallback keeps a short gap so apps do not
          // drop characters. Other platforms run the strict upstream schema and
          // keep their key-event route.
          const macos = hostPlatform() === "darwin";
          const foreground = (yield* desktopDeliveryMode) === "foreground";
          return yield* input(
            "type_text",
            {
              text: value,
              ...(token
                ? { element_token: token, semantic_only: true, ...(macos ? { delay_ms: 0 } : {}) }
                : macos && !foreground
                  ? { delay_ms: 10 }
                  : // Approved foreground delivery is visible typing by request.
                    { force_synthetic: true }),
            },
            resolvedTarget?.node.windowId ?? windowId,
          );
        }),
      pressKey: (key: string, windowId?: string, resolvedTarget?: ComputerResolvedTarget) =>
        Effect.gen(function* () {
          const [native] = yield* cuaKeys([key]);
          const element = yield* keyboardTarget(resolvedTarget, windowId);
          return yield* input(
            "press_key",
            { key: native, ...element },
            windowId ?? resolvedTarget?.node.windowId ?? undefined,
          );
        }),
      hotkey: (
        keys: readonly string[],
        windowId?: string,
        resolvedTarget?: ComputerResolvedTarget,
      ) =>
        Effect.gen(function* () {
          const native = yield* cuaKeys(keys);
          if (native.length < 2 || native.filter((key) => !HOTKEY_MODIFIERS.has(key)).length !== 1)
            return yield* actionError(
              "A shortcut requires modifiers and exactly one other key.",
              "not-dispatched",
              "invalid_chord",
            );
          const element = yield* keyboardTarget(resolvedTarget, windowId);
          return yield* input(
            "hotkey",
            { keys: native, ...element },
            windowId ?? resolvedTarget?.node.windowId ?? undefined,
          );
        }),
      readClipboard: (): BackendEffect<string> =>
        Effect.gen(function* () {
          const data =
            (yield* call("clipboard_read", { include_text: true }, true)).structuredContent ?? {};
          if (typeof data.text !== "string")
            return yield* plainError("The clipboard does not contain readable text.");
          if (data.text.length > 16384)
            return yield* plainError("Clipboard exceeds the tool's text limit.");
          return data.text;
        }),
      writeClipboard: (value: string): BackendEffect<void> =>
        Effect.suspend(() => {
          const tooLarge = computerClipboardWriteError(value);
          return tooLarge
            ? Effect.fail(tooLarge)
            : Effect.asVoid(call("clipboard_write", { text: value }, true));
        }),
      setValue: (
        resolvedTarget: ComputerResolvedTarget,
        value: string,
      ): BackendEffect<ComputerBackendActionResult> =>
        Effect.gen(function* () {
          const token = elementTokens.get(resolvedTarget.node);
          const windowId = resolvedTarget.node.windowId;
          if (!token || !windowId)
            return yield* actionError(
              "The AX target is not bound to a live Cua token.",
              "not-dispatched",
              "stale_target",
            );
          if (observedComputerTargetNode(resolvedTarget.target))
            return yield* input("set_value", { element_token: token, value }, windowId);
          if (webContentElements.has(resolvedTarget.node)) {
            // The web path composes read → set_value → re-read on the same
            // native semantic lease, so the whole compose takes the lane — the
            // same shape webContentTypeText uses — instead of racing a
            // same-window sibling.
            const { pid, window_id } = yield* target(windowId);
            return yield* semanticTextInLane(pid, window_id, (admitMutation) =>
              Effect.gen(function* () {
                const field = yield* resolveWebField(windowId, resolvedTarget.node);
                if (!field) return yield* missingWebField();
                return yield* webSetValue(
                  resolvedTarget.node,
                  windowId,
                  field,
                  value,
                  admitMutation,
                );
              }),
            );
          }
          return yield* input("set_value", { element_token: token, value }, windowId);
        }),
      performAction: (
        resolvedTarget: ComputerResolvedTarget,
        action: string,
      ): BackendEffect<ComputerBackendActionResult> =>
        Effect.gen(function* () {
          const spec = cuaElementAction(action);
          if (spec === undefined)
            return yield* actionError(
              `Cua does not expose ${action} through this integration.`,
              "not-dispatched",
              "unsupported_operation",
            );
          const token = elementTokens.get(resolvedTarget.node);
          if (!token || !resolvedTarget.node.windowId)
            return yield* actionError(
              "The AX target is no longer valid.",
              "not-dispatched",
              "stale_target",
            );
          // Past AXPress the driver would submit an action the element never
          // advertised and report the outcome as merely suspected_noop; refuse
          // instead so an unsupported action is a clean non-dispatch. AXPress
          // itself keeps its long-standing dispatch — the driver degrades it to
          // a verified AXSelected write on collection items that never
          // advertised it.
          if (
            spec.axAction !== "AXPress" &&
            elementActions.get(resolvedTarget.node)?.has(spec.axAction) !== true
          )
            return yield* actionError(
              `The resolved element does not advertise ${spec.axAction}; ${action} was not dispatched.`,
              "not-dispatched",
              "unsupported_operation",
            );
          return yield* input(
            "click",
            { element_token: token, action: spec.driverAction },
            resolvedTarget.node.windowId,
          );
        }),
      /**
       * Exact-range selection through `AXSelectedTextRange`: the native tool
       * writes a CFRange on the fresh element token and verifies by reading the
       * attribute back. Web content is deliberately not special-cased — the
       * driver refuses a marker-range-only target pre-dispatch rather than
       * approximating it with gestures.
       */
      selectText: (
        resolvedTarget: ComputerResolvedTarget,
        range: ComputerTextRange,
      ): BackendEffect<ComputerBackendActionResult> =>
        Effect.gen(function* () {
          const token = elementTokens.get(resolvedTarget.node);
          if (!token || !resolvedTarget.node.windowId) return yield* staleAxTarget();
          return yield* input(
            "select_text",
            { element_token: token, start: range.start, length: range.length },
            resolvedTarget.node.windowId,
          );
        }),
      attachStream: (): BackendEffect<void> => stills.attach,
      detachStream: (): BackendEffect<void> => stills.detach,
      requestKeyframe: (): BackendEffect<void> => stills.requestKeyframe,
      /**
       * The masked-activation shield, answered by the GUI host itself — the
       * driver never sees these requests. Engage deliberately bypasses `host`:
       * it runs inside the activation call's serialized slot already, and its
       * failure must refuse that call rather than be queued behind it. The
       * request is bounded tighter than an ordinary host call — a shield that
       * cannot confirm in five seconds is a wedged helper.
       *
       * `mutation: true` because a lost engage reply is dispatched-unknown: the
       * shield may be up. The server-minted `shield_id` survives exactly that
       * case — the caller releases by id even when the reply never arrived.
       */
      engageShield: (shield: ComputerShieldTarget): BackendEffect<string> =>
        Effect.gen(function* () {
          if (state.disposed || !endpoint)
            return yield* actionError(
              "Open this session in the Pathway macOS desktop app to use Computer.",
              "not-dispatched",
              "gui_host_required",
            );
          yield* assertDesktopOperationActive;
          const match = /^cua:([1-9]\d*):([1-9]\d*)$/.exec(shield.windowId);
          if (!match)
            return yield* actionError(
              `The activation shield cannot cover window ${shield.windowId}: it is not a native window id.`,
              "not-dispatched",
              "invalid_target",
            );
          const task = yield* currentComputerTask;
          // Same attribution the `call` path records: the host's end_task reply
          // releases shields by it, so a task ending mid-engage still cleans up.
          if (task) trackPreviewTask(task);
          const signal = yield* desktopOperationSignal;
          const reply = yield* timedComputerLeg(
            "host",
            raceDesktopSignal(
              transport(
                endpoint,
                {
                  method: "shield",
                  ...(task ? { task } : {}),
                  args: {
                    action: "engage",
                    shield_id: shield.shieldId,
                    frame: shield.frame,
                    window_id: Number(match[2]),
                    pid: Number(match[1]),
                    label: shield.label,
                  },
                  capability,
                },
                { mutation: true, timeoutMs: 5_000 },
                { abortable: true, code: "mask_unavailable" },
              ),
              signal,
            ),
          );
          if (!reply.ok)
            return yield* actionError(
              reply.error ?? "The activation shield was refused.",
              "not-dispatched",
              "mask_unavailable",
            );
          return shield.shieldId;
        }),
      releaseShield: (shieldId: string): BackendEffect<void> =>
        releaseShieldRequest(
          { action: "release", shield_id: shieldId },
          "The activation shield did not release.",
        ),
      /** The forced-release escape hatch; safe in every host state. */
      releaseAllShields: (): BackendEffect<void> =>
        releaseShieldRequest({ action: "release_all" }, "The activation shields did not release."),
      stopInput,
      endTask,
      /**
       * Present whenever this backend exists — the GUI host admits the
       * driver's browser family — so the gateway can advertise
       * `computer_browser_*` whenever the computer surface is supported.
       */
      browser: {
        call: browserCall,
        endThread: endBrowserThread,
      },
      dispose,
    } satisfies ComputerBackend;
    return backend;
  });

export type CuaComputerBackend = Effect.Success<ReturnType<typeof makeCuaComputerBackend>>;

/** The factory's requirement, spelled out for layer wiring. */
export type CuaComputerBackendScope = Scope.Scope;
