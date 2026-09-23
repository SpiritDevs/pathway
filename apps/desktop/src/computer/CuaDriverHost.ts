// @effect-diagnostics nodeBuiltinImport:off -- the host socket, driver sockets and capability compare are Node primitives the driver protocol is defined over.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  cuaActionDiagnosticMessage,
  parseCuaActionDiagnostics,
} from "@spiritdevs/shared/cuaActionDiagnostics";
import {
  CUA_ACTION_TOOLS,
  CUA_BROWSER_MUTATION_TOOLS,
  CUA_BROWSER_TOOLS,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  CUA_READ_TOOLS,
  CUA_SETUP_TIMEOUT_MS,
  cuaCleanupAcknowledged,
  type CuaComputerTask,
  cuaComputerTaskKey,
  type CuaPreviewTarget,
  type CuaReply,
  cuaRequest,
  type CuaToolResult,
  parseCuaComputerTask,
  parseCuaShieldArgs,
} from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import {
  cuaHostProcessIsAlive,
  markCuaRuntimeDirectory,
  sweepOwnedCuaRuntimeDirectories,
} from "./CuaRuntimeOwnership.ts";
import { type HelperProcess, spawnHelper } from "./HelperProcess.ts";

export class CuaHostError extends Schema.TaggedErrorClass<CuaHostError>()("CuaHostError", {
  message: Schema.String,
}) {}

const isCuaHostError = Schema.is(CuaHostError);
const hostError = (message: string) => new CuaHostError({ message });
const toHostError = (cause: unknown) =>
  isCuaHostError(cause) ? cause : hostError(cause instanceof Error ? cause.message : String(cause));

/** Failures from the injected helper surfaces; only their message is kept. */
export interface SurfaceError {
  readonly message: string;
}

/** The Escape monitor's health, as the driver host reads it. */
export interface CuaInputMonitorState {
  readonly ready: boolean;
  readonly error?: string | undefined;
}

/** A physical pointer or key event the Escape monitor saw. */
export interface CuaPhysicalInput {
  readonly kind: string;
  readonly pid?: number | undefined;
  readonly windowId?: number | undefined;
}

export interface CuaHostPermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly inputMonitoring?: boolean | undefined;
}

/** The frame tap surface the host points at the task's window. */
export interface CuaFrameTapHost {
  readonly update: (target: CuaPreviewTarget) => Effect.Effect<void, SurfaceError>;
  readonly endTask: (task: CuaComputerTask) => Effect.Effect<void, SurfaceError>;
  readonly stop: Effect.Effect<void, SurfaceError>;
  readonly dispose: Effect.Effect<void, SurfaceError>;
}

export interface CuaShieldEngageRequest {
  readonly shieldId: string;
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly windowId: number;
  readonly pid: number;
  readonly label?: string;
}

/** The masked-activation shield surface. */
export interface CuaShieldHost {
  readonly engage: (
    request: CuaShieldEngageRequest,
    task: CuaComputerTask | undefined,
  ) => Effect.Effect<void, SurfaceError>;
  readonly release: (shieldId: string) => Effect.Effect<void, SurfaceError>;
  readonly releaseAll: Effect.Effect<number, SurfaceError>;
  readonly endTask: (task: CuaComputerTask) => Effect.Effect<void, SurfaceError>;
  readonly stop: Effect.Effect<void, SurfaceError>;
  readonly dispose: Effect.Effect<void, SurfaceError>;
}

/**
 * The agent cursor overlay's colors, pushed to the driver session as
 * `set_agent_cursor_style`. An omitted channel keeps the driver's stock
 * treatment; a style with no usable color means the stock cursor.
 */
export interface CuaCursorStyle {
  readonly fill?: string;
  readonly rim?: string;
  readonly shadow?: string;
}

export interface CuaDriverHostOptions {
  readonly binaryPath: string;
  readonly bundleId: string;
  readonly capability: string;
  readonly setup: Effect.Effect<void, SurfaceError>;
  readonly checkPermissions?: (options: {
    readonly force: boolean;
  }) => Effect.Effect<CuaHostPermissions, SurfaceError>;
  /** Posts OS-level releases for input a dead or unconfirmed driver may hold. Fails when unconfirmed. */
  readonly releaseHeldInput?: Effect.Effect<void, SurfaceError>;
  /** Bound on each post-handshake startup call; defaults to 5s. */
  readonly startupTimeoutMs?: number;
  readonly normalizeOverview?: (result: CuaToolResult) => CuaToolResult;
  readonly frameTap?: CuaFrameTapHost;
  /** Mirrors whether a live generation could dispatch input: the Escape monitor's arm/disarm. */
  readonly onInputMonitorArmedChange?: (armed: boolean) => void;
  /** Escape listener health; omitted on hosts without the listener. */
  readonly inputMonitorState?: Effect.Effect<CuaInputMonitorState>;
  readonly activateInputMonitor?: Effect.Effect<void>;
  /** Absent means `engage` is refused as unavailable. */
  readonly shield?: CuaShieldHost;
  /**
   * The `pathway_native_revision` the driver must report at handshake.
   * Defaults to {@link CUA_NATIVE_REVISION}; `null` expects an unpatched
   * upstream driver and skips the revision check and the patch-only flags.
   */
  readonly nativeRevision?: number | null;
  /** Where the host socket listens; defaults to a socket in the private session directory. */
  readonly hostEndpoint?: string;
  /** This application's own pids; browser calls may never target them. */
  readonly ownPids?: () => ReadonlySet<number>;
  /** The agent cursor's colors, read at each session open. */
  readonly cursorStyle?: () => CuaCursorStyle | null | undefined;
  /** `PATHWAY_CUA_WARM_ON_FIRST_TOUCH`: spawn and handshake on the first probe. */
  readonly warmOnFirstTouch?: boolean;
  /**
   * Linux admission rules. Provided by the Linux host port; without it the
   * host applies the macOS rules on every platform.
   */
  readonly linuxAdmission?: CuaLinuxAdmission;
}

export interface CuaLinuxAdmission {
  readonly browserCallIsReadOnly: (name: string, args: unknown) => boolean;
  readonly refusal: (
    name: string,
    args: unknown,
    deliveryMode: unknown,
    browserInputControl?: boolean,
  ) => CuaReply | undefined;
}

/** The Computer host the desktop main process owns. Every method is safe to call in any state. */
export interface CuaDriverHost {
  /** Listens on the host socket and returns its endpoint. */
  readonly listen: Effect.Effect<string, CuaHostError>;
  readonly isInputMonitorRequested: Effect.Effect<boolean>;
  /** Retires the driver generation and cancels admitted work. */
  readonly stop: Effect.Effect<void, CuaHostError>;
  /** Backend shutdown: rejects later requests until {@link resume}. */
  readonly suspend: Effect.Effect<void, CuaHostError>;
  readonly resume: Effect.Effect<void>;
  readonly pauseDesktop: (reason: string) => Effect.Effect<void, CuaHostError>;
  readonly resumeDesktop: (reason: string) => Effect.Effect<void>;
  /** Physical Escape. False when nothing was driving the desktop. */
  readonly emergencyStopInput: Effect.Effect<boolean>;
  readonly physicalInput: (event: CuaPhysicalInput) => Effect.Effect<boolean>;
  readonly inputMonitorStateChanged: (state: CuaInputMonitorState) => Effect.Effect<void>;
  readonly stopTaskByUser: (task: CuaComputerTask) => Effect.Effect<void, CuaHostError>;
  readonly setCursorStyle: (style: CuaCursorStyle | null | undefined) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void, CuaHostError>;
}

interface TaskCursor {
  task: CuaComputerTask;
  firstActionObserved: boolean;
  enabled: boolean;
}

interface TaskRequest {
  readonly task: CuaComputerTask;
  stopped: boolean;
}

/** A started, detached computation. Awaiting it never interrupts it. */
interface Task<A> {
  readonly await: Effect.Effect<A, CuaHostError>;
}

const doneTask: Task<void> = { await: Effect.void };

// Keep the marker through ordinary model turns, with a native expiry backstop
// if task-end cleanup cannot reach the overlay. This wait does not repaint.
export const CUA_CURSOR_IDLE_HIDE_MS = 60_000;
/** A raw ENOENT names a path, not a remedy; source builds stage the driver themselves. */
const CUA_DRIVER_MISSING_MESSAGE =
  "Cua Driver is not bundled. Run the provisioning script (`node apps/desktop/scripts/provision-cua-driver.mjs`, needs the pinned Rust toolchain) in this checkout, then relaunch Pathway.";

interface ControlledTarget {
  pid: number;
  windowId?: number;
  threadId?: string;
  browserTargetId?: string;
  browserTabId?: string;
}

interface Generation {
  nativeInputEpoch: number;
  browserInputControl: boolean;
  child: HelperProcess;
  socket: string;
  session: string;
  didExit: boolean;
  retired: boolean;
  cancellationReady: boolean;
  inputInFlight: boolean;
  /** Exact task owning input that has not yet acknowledged its release. */
  inputTask: CuaComputerTask | undefined;
  browserInputInFlight: boolean;
  /** Set once any action reached this generation, so a driver that wedged
   * before receiving input stays distinguishable from one that may hold it. */
  inputEverDispatched: boolean;
  /** The lazily opened session half of startup; assigning it makes setup once-only. */
  sessionOpening?: Task<void>;
  /**
   * The transport-owner id every browser call rides under. Its persistent
   * control connection opened with `session_begin`; that connection's EOF
   * reaps every lifecycle session this transport owns.
   */
  controlSession: string;
  controlSocket: NodeNet.Socket | undefined;
  /** Browser labels that ended; the next call revives them with `start_session`. */
  endedBrowserSessions: Set<string>;
  /** Labels dispatched under this generation's control session. */
  liveBrowserSessions: Set<string>;
  /** Per-task desktop session labels the driver reported ended. */
  endedTaskSessions: Set<string>;
  /** The normalized cursor style the shared session last acknowledged, `""` for stock. */
  appliedCursorStyle: string;
  /** Per task cursor session, the custom style last applied. */
  appliedSessionCursorStyles: Map<string, string>;
  /** Latest turn using each cursor label. A delayed old-turn end cannot hide it. */
  taskCursors: Map<string, TaskCursor>;
  retirement?: Task<void>;
}

/**
 * The driver-side lifecycle label for one thread's browser namespace:
 * deterministic, so `end_browser_thread` can name it and an ended label
 * revives in place.
 */
function browserSessionLabel(threadId: string): string {
  return `pathway-browser-${threadId}`;
}

/**
 * The driver-side label for one task's desktop session. The overlay keys
 * the cursor, its tint and its badge text by this string, so it leads with
 * the human label and ends with the full thread id. The `agent·` prefix
 * keeps task labels out of the browser, `default` and runtime namespaces.
 */
const AGENT_SESSION_LABEL_PREFIX = "agent·";
const AGENT_SESSION_LABEL_MAX_CHARS = 120;
const agentBadgeComponent = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
function agentSessionLabel(task: CuaComputerTask): string {
  const threadId = agentBadgeComponent(task.threadId) || "task";
  const label = [...agentBadgeComponent(task.label ?? "")]
    .slice(0, AGENT_SESSION_LABEL_MAX_CHARS)
    .join("");
  if (label.length === 0) return `${AGENT_SESSION_LABEL_PREFIX}${threadId}`;
  return `${AGENT_SESSION_LABEL_PREFIX}${label}·${threadId}`;
}

const CUA_CURSOR_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function normalizeCuaCursorColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return CUA_CURSOR_COLOR_PATTERN.test(candidate) ? candidate : undefined;
}

/** Drop unusable channels so a half-typed color never reaches the driver. */
function normalizeCuaCursorStyle(
  style: CuaCursorStyle | null | undefined,
): CuaCursorStyle | undefined {
  if (!style || typeof style !== "object") return undefined;
  const fill = normalizeCuaCursorColor(style.fill);
  const rim = normalizeCuaCursorColor(style.rim);
  const shadow = normalizeCuaCursorColor(style.shadow);
  if (!fill && !rim && !shadow) return undefined;
  return {
    ...(fill ? { fill } : {}),
    ...(rim ? { rim } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

function permissionsChanged(a: CuaHostPermissions, b: CuaHostPermissions): boolean {
  return a.accessibility !== b.accessibility || a.screenRecording !== b.screenRecording;
}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);
const RequestJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRequest = Schema.decodeUnknownOption(RequestJson);
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const log = (message: string) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs("component", "desktop-cua"));

const safeNativeId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
    ? value
    : undefined;
const LOGGABLE_CUA_CODES = new Set([
  "computer_input_paused",
  "desktop_input_paused",
  "same_pid_keyboard_ambiguity",
  "cua_action_failed",
  "cua_refusal",
  "invalid_arguments",
  "input_admission_closed",
  "target_not_on_active_space",
  "target_unavailable",
  "auth_sheet_focused",
  "input_monitor_unavailable",
  "gui_host_required",
  "background_pixel_focus_unavailable",
]);

/**
 * How long a physical Escape keeps new mutating dispatch refused while the
 * interrupted input settles. A deadline, never a latch: it lapses on its
 * own and a repeated press only re-arms it. Reads are never gated by it.
 */
export const ESCAPE_INPUT_COOLDOWN_MS = 1_500;

/**
 * Match names for a launch_app prime: the agent names an app or a bundle id
 * while the daemon reports process names. Compare lowercased, with the
 * bundle tail as a second candidate.
 */
function launchAppMatchNames(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const args = input as Record<string, unknown>;
  const names: string[] = [];
  if (typeof args.name === "string" && args.name.length > 0) names.push(args.name.toLowerCase());
  if (typeof args.bundle_id === "string" && args.bundle_id.length > 0) {
    names.push(args.bundle_id.toLowerCase());
    const tail = args.bundle_id.split(".").pop();
    if (tail) names.push(tail.toLowerCase());
  }
  return names;
}

/**
 * A daemon whose host died by SIGKILL never sees retirement and can stay
 * wedged with its overlay window and socket dir. Kill any embedded daemon
 * whose recorded host pid is gone. A recycled pid reads as alive and is left
 * alone, the safe direction.
 */
export const sweepOrphanedCuaDrivers = Effect.fn("sweepOrphanedCuaDrivers")(function* () {
  // ps/env scanning exists on every unix the standalone host can run on;
  // Windows orphan reaping is a different mechanism entirely.
  if ((yield* HostProcessPlatform) === "win32") return;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const listing = yield* spawner
    .string(ChildProcess.make("ps", ["-axo", "pid,args"]))
    .pipe(Effect.option);
  if (Option.isNone(listing)) return;
  const liveSocketDirs = new Set<string>();
  for (const line of listing.value.split("\n")) {
    if (!/cua-driver\s+serve\s+--embedded/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;
    const socketDir = line.match(/--socket\s+(\S+)\//)?.[1];
    // A running daemon's dir is protected whether or not its env can be
    // read: reaping it would sever every new connection to that daemon.
    if (socketDir) liveSocketDirs.add(socketDir);
    const env = yield* spawner
      .string(ChildProcess.make("ps", ["eww", "-p", String(pid), "-o", "command"]))
      .pipe(Effect.option);
    if (Option.isNone(env)) continue;
    const hostPid = Number(env.value.match(/CUA_DRIVER_EMBEDDED_HOST_PID=(\d+)/)?.[1]);
    if (!hostPid) continue;
    if (cuaHostProcessIsAlive(hostPid)) continue;
    const killed = yield* Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.option);
    if (Option.isSome(killed))
      yield* log(`killed orphaned cua-driver pid=${pid} (host pid ${hostPid} gone)`);
  }
  const removed = yield* sweepOwnedCuaRuntimeDirectories({
    directory: NodeOS.tmpdir(),
    liveSocketDirs,
  });
  for (const entry of removed) yield* log(`removed stale owned driver directory ${entry}`);
});

const DRIVER_SESSION_DEATH_CODES = new Set([
  "session_ended",
  "session-expired",
  "session_expired",
  "unknown_session",
  "session_not_found",
]);

/**
 * The native driver ended this session while the host still held it. Every
 * later call with the same id fails the same way; the driver confirms
 * nothing was dispatched, so starting fresh once is replay-safe.
 */
function isDriverSessionDeath(reply: CuaReply): boolean {
  if (!reply.ok) {
    // A transport rejection carries the same verdict in `error`, retired only
    // when dispatch is ruled out.
    return (
      reply.effect !== "dispatched-unknown" &&
      typeof reply.error === "string" &&
      reply.error.includes("has ended") &&
      reply.error.includes("start_session")
    );
  }
  const result = reply.result;
  if (!result?.isError) return false;
  const code = result.structuredContent?.code;
  if (typeof code === "string" && DRIVER_SESSION_DEATH_CODES.has(code)) return true;
  const texts: string[] = [];
  for (const part of result.content ?? []) {
    if (part && typeof part.text === "string") texts.push(part.text);
  }
  const message = result.structuredContent?.message;
  if (typeof message === "string") texts.push(message);
  const joined = texts.join("\n");
  return joined.includes("has ended") && joined.includes("start_session");
}

const cancelledReply = (error: string): CuaReply => ({
  ok: false,
  error,
  effect: "not-dispatched",
});

/**
 * Makes the Computer host. On macOS only Electron's main process spawns the
 * native daemon: a bundle id sent by a standalone server cannot confer TCC.
 * The standalone entry runs the same host where no such grant model exists.
 * Closing the scope disposes the host.
 */
export const makeCuaDriverHost = Effect.fn("makeCuaDriverHost")(function* (
  options: CuaDriverHostOptions,
) {
  const platform = yield* HostProcessPlatform;
  const clock = yield* Clock.Clock;
  const runFork = yield* FiberSet.makeRuntime<ChildProcessSpawner.ChildProcessSpawner>();
  // Forked before the dispose finalizer is added, so closing the host scope
  // disposes the host (cancel_input, held-input release) before it kills the
  // driver processes spawned here.
  const processScope = yield* Scope.fork(yield* Effect.scope);
  const linux = platform === "linux" ? options.linuxAdmission : undefined;
  const now = () => clock.currentTimeMillisUnsafe();
  const isoNow = () => DateTime.formatIso(DateTime.makeUnsafe(now()));

  /** Starts `effect` detached in the host; the returned task memoizes its exit. */
  const start = <A>(
    effect: Effect.Effect<A, CuaHostError, ChildProcessSpawner.ChildProcessSpawner>,
  ): Task<A> => {
    const deferred = Deferred.makeUnsafe<A, CuaHostError>();
    runFork(Effect.exit(effect).pipe(Effect.flatMap((exit) => Deferred.done(deferred, exit))));
    return { await: Deferred.await(deferred) };
  };
  /** Starts `effect` and logs its failure; nobody awaits it. */
  const detach = (effect: Effect.Effect<unknown, SurfaceError>, failure: string) => {
    runFork(
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : log(`${failure}: ${String(toHostError(Cause.squash(cause)).message)}`),
        ),
      ),
    );
  };
  const ignored = (task: Task<unknown>): Effect.Effect<void> => Effect.ignore(task.await);

  const driverRequest = <T = CuaReply>(
    socket: string,
    body: unknown,
    requestOptions: { timeoutMs?: number; mutation?: boolean; signal?: AbortSignal } = {},
  ): Effect.Effect<T, CuaHostError> =>
    Effect.tryPromise({
      try: (interrupted) =>
        cuaRequest<T>(socket, body, {
          ...requestOptions,
          signal: requestOptions.signal
            ? AbortSignal.any([requestOptions.signal, interrupted])
            : interrupted,
        }),
      catch: toHostError,
    });

  let directory = "";
  let server: NodeNet.Server | undefined;
  let generation: Generation | undefined;
  let starting: Task<Generation> | undefined;
  let retiring: Effect.Effect<void> = Effect.void;
  let closed = false;
  let suspended = false;
  let inputMonitorArmed = false;
  let inputMonitorRequested = false;
  let nativeInputCleanupPending: Generation | undefined;
  let activeForegroundInput = false;
  const controlledTargets = new Map<string, ControlledTarget>();
  const takeoverTargets = new Map<string, ControlledTarget>();
  const browserTargets = new Map<string, ControlledTarget>();
  const repliedConnections = new WeakSet<NodeNet.Socket>();
  let activeInputTaskKey: string | undefined;
  const monitoredTasks = new Map<string, string>();
  /** Deadline until which mutating dispatch is refused after physical input. */
  let inputInterruptCooldownUntil = 0;
  /** Abort handles for mutating calls whose driver request is live right now. */
  const inFlightInputInterrupts = new Set<AbortController>();
  const activeTaskCalls = new Map<AbortController, string>();
  const desktopPauses = new Set<string>();
  let desktopObservationRequired = false;
  let browserObservationRequired = false;
  const browserRecoveryObservations = new Map<string, number>();
  let desktopEpoch = 0;
  /**
   * Monotonic count of OS desktop interruptions, one per `pauseDesktop`,
   * never reset. It lets the backend invalidate pre-interruption consent
   * when a lock/resume cycle netted back to "not paused" between replies.
   */
  let desktopInterruptionCount = 0;
  /** The native revision the live driver reported at handshake; `0` for upstream. */
  let observedNativeRevision: number | undefined;
  let operations: Effect.Effect<void> = Effect.void;
  let stopping: Effect.Effect<void> = Effect.void;
  /** Serializes live cursor-style pushes so two rapid changes cannot race. */
  let cursorStyleUpdates: Effect.Effect<void> = Effect.void;
  let epoch = 0;
  /** Separates listener failures from real cancellation during activation. */
  let inputMonitorEpochChanges = 0;
  const connections = new Set<NodeNet.Socket>();
  let permissions: CuaHostPermissions | undefined;
  const pendingPermissionChecks = new Map<() => void, string | undefined>();
  const userStoppedTasks = new Set<string>();
  const admittedTaskRequests = new Set<TaskRequest>();
  const knownTasks = new Map<string, CuaComputerTask>();
  const endedFrameTasks = new Set<string>();
  let frameTapTask: CuaComputerTask | undefined;
  let warmAttempted = false;
  const defaultOwnPids: ReadonlySet<number> = new Set([process.pid]);

  /** Runs `effect` after every queued native operation, as the new queue tail. */
  const enqueue = <A>(
    effect: (previous: Effect.Effect<void>) => Effect.Effect<A, CuaHostError, never>,
  ): Task<A> => {
    const task = start(effect(operations));
    operations = ignored(task);
    return task;
  };

  const rememberTask = (set: Set<string>, task: CuaComputerTask) => {
    set.add(cuaComputerTaskKey(task));
    while (set.size > 256) set.delete(set.values().next().value!);
  };

  const ownPids = () => options.ownPids?.() ?? defaultOwnPids;

  /** The helper only reports Escape while a live generation could dispatch input. */
  const updateInputMonitorArmed = () => {
    const armed =
      !closed &&
      generation !== undefined &&
      !generation.retired &&
      (!options.activateInputMonitor || inputMonitorRequested);
    if (armed === inputMonitorArmed) return;
    inputMonitorArmed = armed;
    try {
      options.onInputMonitorArmedChange?.(armed);
    } catch {
      // Monitor plumbing must never take input admission down with it.
    }
  };

  const monitorState = Effect.suspend(() => options.inputMonitorState ?? Effect.undefined);

  const desktopState = (): Pick<
    CuaReply,
    | "desktopEpoch"
    | "desktopPauses"
    | "desktopInterruptions"
    | "driverNativeRevision"
    | "driverBrowserInputControl"
    | "hostPlatform"
  > => ({
    desktopEpoch,
    desktopPauses: [...desktopPauses].toSorted(),
    desktopInterruptions: desktopInterruptionCount,
    hostPlatform: platform,
    ...(observedNativeRevision !== undefined
      ? { driverNativeRevision: observedNativeRevision }
      : {}),
    ...(platform === "linux"
      ? {
          driverBrowserInputControl:
            generation?.browserInputControl === true && !generation.retired && !generation.didExit,
        }
      : {}),
  });

  const desktopPauseReply = (): CuaReply => {
    const message =
      desktopPauses.size > 0
        ? "Computer input is paused because the desktop is locked, asleep or inactive. Return to the desktop, then read fresh state before continuing."
        : "Computer input was interrupted or the user changed the controlled window. Read fresh computer state and inspect it before continuing; do not replay an uncertain action.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "computer_input_paused",
          layer: "driver-host",
          message,
          requery_hint:
            "After physical input stops, observe a usable window of the affected app with computer_get_state and its exact window_id. Do not replay an uncertain action.",
        },
      },
    };
  };

  const inputMonitorUnavailableReply = (monitor: CuaInputMonitorState | undefined): CuaReply => {
    const message =
      platform === "linux"
        ? "A working global Escape stop is unavailable in this Linux desktop session. Computer browser actions remain paused; browser observation is still available."
        : monitor?.error === "input-monitoring-required"
          ? "Allow Input Monitoring in System Settings, then wait for the computer input listener to reconnect before continuing."
          : "The computer input listener is unavailable. Input remains paused until the listener reconnects.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "input_monitor_unavailable",
          message,
          ...(monitor?.error ? { input_monitor_error: monitor.error } : {}),
        },
      },
    };
  };

  /**
   * The cooldown refusal a mutating call gets inside the physical-input
   * window. The deadline bounds the quiet period; a separate
   * fresh-observation gate prevents blind continuation.
   */
  const inputInterruptedReply = (): CuaReply => {
    const message =
      "Computer input was interrupted by physical input. Wait for the user to finish, then read fresh computer state before continuing. Do not replay an uncertain action.";
    return {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
          effect: "refused",
          code: "computer_input_paused",
          layer: "driver-host",
          message,
          wait_seconds: Math.max(0, (inputInterruptCooldownUntil - now()) / 1000),
          requery_hint:
            "Wait, then observe the affected target before deciding the next action. Waiting alone does not resume input.",
        },
      },
    };
  };

  const taskStoppedReply = (): CuaReply =>
    cancelledReply("The user stopped computer use for this turn. Do not retry actions.");

  const inputMonitorAvailable = (name: string, input: unknown) =>
    Effect.gen(function* () {
      const linuxBrowserMutation =
        linux !== undefined &&
        CUA_BROWSER_MUTATION_TOOLS.has(name) &&
        !linux.browserCallIsReadOnly(name, input);
      const required =
        CUA_ACTION_TOOLS.has(name) ||
        linuxBrowserMutation ||
        (platform === "darwin" &&
          options.nativeRevision !== null &&
          CUA_BROWSER_MUTATION_TOOLS.has(name));
      if (!required) return true;
      const monitor = yield* monitorState;
      // Portable native paths have no listener contract. The verified Linux
      // browser port does: missing integration is not readiness.
      return monitor?.ready ?? !linuxBrowserMutation;
    });

  /** A separate owned browser can be set up while old targets remain paused. */
  const isIsolatedBrowserSetup = (name: string, input: unknown): boolean => {
    if (name !== "browser_prepare" || !input || typeof input !== "object" || Array.isArray(input))
      return false;
    const args = input as Record<string, unknown>;
    const profile = args.profile;
    return (
      args.allow_launch === true &&
      args.pid === undefined &&
      args.window_id === undefined &&
      args.target_id === undefined &&
      args.strategy === undefined &&
      profile !== null &&
      typeof profile === "object" &&
      !Array.isArray(profile) &&
      ((profile as Record<string, unknown>).mode === "isolated_new" ||
        (profile as Record<string, unknown>).mode === "isolated_named")
    );
  };

  const browserRecoveryKey = (
    input: unknown,
    task: CuaComputerTask | undefined,
  ): string | undefined => {
    if (!task || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const args = input as Record<string, unknown>;
    if (
      typeof args.target_id !== "string" ||
      args.target_id.length === 0 ||
      typeof args.tab_id !== "string" ||
      args.tab_id.length === 0
    )
      return undefined;
    return encodeJson([cuaComputerTaskKey(task), args.target_id, args.tab_id]);
  };

  const hasBrowserRecoveryObservation = (input: unknown, task: CuaComputerTask | undefined) => {
    const key = browserRecoveryKey(input, task);
    return key !== undefined && browserRecoveryObservations.get(key) === desktopEpoch;
  };

  const controlledTarget = (
    input: unknown,
    task: CuaComputerTask | undefined,
    browser: boolean,
  ): ControlledTarget | undefined => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const args = input as Record<string, unknown>;
    if (browser && task && typeof args.target_id === "string") {
      const bound = browserTargets.get(encodeJson([task.threadId, args.target_id]));
      if (bound)
        return {
          ...bound,
          ...(typeof args.tab_id === "string" ? { browserTabId: args.tab_id } : {}),
        };
    }
    if (
      typeof args.pid !== "number" ||
      !Number.isSafeInteger(args.pid) ||
      args.pid <= 0 ||
      args.pid > 0x7fffffff
    )
      return undefined;
    return {
      pid: args.pid,
      ...(task ? { threadId: task.threadId } : {}),
      ...(typeof args.window_id === "number" &&
      Number.isSafeInteger(args.window_id) &&
      args.window_id > 0 &&
      args.window_id <= 0xffffffff
        ? { windowId: args.window_id }
        : {}),
    };
  };

  const rememberBrowserTarget = (
    input: unknown,
    result: CuaToolResult | undefined,
    task: CuaComputerTask,
  ) => {
    const data = result?.structuredContent;
    if (data?.status !== "ok" || data.mode !== "bind" || typeof data.target_id !== "string") return;
    const target = controlledTarget(input, task, false);
    if (!target) return;
    const bound = { ...target, browserTargetId: data.target_id };
    browserTargets.set(encodeJson([task.threadId, data.target_id]), bound);
    while (browserTargets.size > 256) browserTargets.delete(browserTargets.keys().next().value!);
    controlledTargets.set(cuaComputerTaskKey(task), bound);
  };

  const isBrowserSnapshot = (input: unknown, result: CuaToolResult): boolean => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const args = input as Record<string, unknown>;
    const data = result.structuredContent;
    const snapshot = data?.snapshot;
    const snapshotId =
      data?.snapshot_id ??
      (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? (snapshot as Record<string, unknown>).id
        : undefined);
    return (
      data?.status === "ok" &&
      data.mode === "snapshot" &&
      typeof args.target_id === "string" &&
      args.target_id.length > 0 &&
      typeof args.tab_id === "string" &&
      args.tab_id.length > 0 &&
      data.target_id === args.target_id &&
      data.tab_id === args.tab_id &&
      typeof snapshotId === "string" &&
      /^p[0-9]+$/.test(snapshotId) &&
      Array.isArray(data.refs)
    );
  };

  const observationMatchesTarget = (
    name: string,
    input: unknown,
    target: ControlledTarget,
    result: CuaToolResult,
  ): boolean => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const args = input as Record<string, unknown>;
    if (target.browserTargetId !== undefined) {
      if (name !== "get_browser_state") return false;
      return (
        args.target_id === target.browserTargetId &&
        (target.browserTabId === undefined || args.tab_id === target.browserTabId)
      );
    }
    // A model may re-aim at a usable sibling after the old window closes or
    // moves off-Space. An overview, another app, a degraded capture or an
    // empty sibling tree never clears the task's takeover gate.
    const state = result.structuredContent;
    const exactWindow = args.window_id === target.windowId;
    return (
      name === "get_window_state" &&
      args.pid === target.pid &&
      state?.pid === target.pid &&
      safeNativeId(args.window_id) !== undefined &&
      state.window_id === args.window_id &&
      !state.degraded &&
      state.screenshot_frame_valid !== false &&
      (target.windowId === undefined ||
        exactWindow ||
        (state.window_is_on_screen === true &&
          state.window_on_current_space === true &&
          Array.isArray(state.elements) &&
          state.elements.length > 0))
    );
  };

  /** The call args carry the agent's window target; attribution alone does not. */
  const frameTapTarget = (task: CuaComputerTask, input: unknown): CuaPreviewTarget | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const args = input as Record<string, unknown>;
    if (
      typeof args.pid !== "number" ||
      !Number.isSafeInteger(args.pid) ||
      args.pid <= 0 ||
      args.pid > 0x7fffffff ||
      typeof args.window_id !== "number" ||
      !Number.isSafeInteger(args.window_id) ||
      args.window_id <= 0 ||
      args.window_id > 0xffffffff
    )
      return undefined;
    return { task, pid: args.pid, windowId: args.window_id };
  };

  const removeSocket = (path: string) =>
    Effect.promise(() => NodeFSP.rm(path, { force: true }).catch(() => undefined));

  const terminate = (target: Generation) =>
    Effect.gen(function* () {
      if (target.didExit) return;
      // End the lifetime pipe too: Tokio's blocking stdin reader otherwise
      // keeps the native runtime alive during graceful shutdown.
      yield* target.child.endInput;
      const escalation = yield* Effect.sleep(500).pipe(
        Effect.andThen(target.child.signal("SIGTERM")),
        Effect.andThen(Effect.sleep(1_000)),
        Effect.andThen(target.child.signal("SIGKILL")),
        Effect.forkChild,
      );
      // Every branch that reaches here already proved the generation cannot
      // hold OS input, so a kernel-wedged process must not hang retirement.
      yield* Effect.timeoutOption(target.child.exited, 4_000);
      yield* Fiber.interrupt(escalation);
      if (!target.didExit)
        yield* log(
          `driver pid=${target.child.pid} did not exit after SIGKILL; releasing the generation anyway`,
        );
    });

  const forget = (target: Generation) =>
    Effect.suspend(() => {
      if (generation === target) generation = undefined;
      return removeSocket(target.socket);
    });

  const retire = (target: Generation): Task<void> => {
    if (target.retirement) return target.retirement;
    target.retired = true;
    browserTargets.clear();
    browserRecoveryObservations.clear();
    if (nativeInputCleanupPending === target) nativeInputCleanupPending = undefined;
    updateInputMonitorArmed();
    // Browser teardown rides the control connection's lifetime: closing it
    // now lets the driver reap every owned session while it is still alive.
    target.controlSocket?.destroy();
    target.controlSocket = undefined;
    const previous = retiring;
    const retirement = start(
      Effect.gen(function* () {
        yield* previous;
        // Captured up front: the flag clears on confirmed cleanup, and an
        // exit can land after the dead socket already broke the request.
        const inputUncertain = target.inputInFlight;
        const releaseHeldInput = Effect.gen(function* () {
          if (!inputUncertain || target.browserInputInFlight || !options.releaseHeldInput)
            return false;
          return yield* options.releaseHeldInput.pipe(
            Effect.andThen(log("released held input left by the dead driver generation")),
            Effect.as(true),
            Effect.catch((error) =>
              log(`held-input release failed: ${toHostError(error).message}`).pipe(
                Effect.as(false),
              ),
            ),
          );
        });
        if (target.didExit && target.inputInFlight) {
          // A confirmed release makes the desktop provably clean again.
          // Without it the dead generation stays referenced so every later
          // request fails closed instead of compounding the uncertainty.
          if (yield* releaseHeldInput) return yield* forget(target);
          return yield* hostError(
            "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
          );
        }
        if (!target.didExit && target.cancellationReady) {
          const reply = yield* driverRequest<CuaReply>(
            target.socket,
            { method: "cancel_input", args: { expected_pid: target.child.pid } },
            { timeoutMs: 5_000 },
          ).pipe(Effect.option);
          const cleanupConfirmed =
            Option.isSome(reply) &&
            reply.value.ok === true &&
            cuaCleanupAcknowledged(reply.value.result, target.child.pid);
          if (!cleanupConfirmed) {
            // A dead socket can outrun the exit event: give the exit a short grace.
            if (!target.didExit) yield* Effect.timeoutOption(target.child.exited, 500);
            if (target.didExit) {
              const cleared = !target.inputInFlight || (yield* releaseHeldInput);
              if (cleared) return yield* forget(target);
              return yield* hostError(
                "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
              );
            }
            if (!target.inputEverDispatched) {
              // No action ever reached this generation, so it cannot hold
              // input: replace it instead of closing admission for good.
              yield* terminate(target);
              return yield* forget(target);
            }
            // The live driver's acknowledgement cannot be trusted. Post the
            // OS-level ups before admission closes; do not kill or replace it.
            yield* releaseHeldInput;
            return yield* hostError(
              "Cua Driver did not confirm native input cleanup. Computer admission is closed; the driver was not killed or replaced.",
            );
          }
          target.inputInFlight = false;
        }
        // Before the handshake nothing can have been dispatched; otherwise
        // the acknowledgement above covers every release before termination.
        yield* terminate(target);
        yield* forget(target);
      }),
    );
    target.retirement = retirement;
    // The failure belongs to whoever retired this generation, not to the
    // sequence: one admission-closed cleanup must not refuse every later spawn.
    retiring = ignored(retirement);
    return retirement;
  };

  const interruptNativeInput = (target: Generation) =>
    Effect.gen(function* () {
      if (target.retired || target.didExit) return;
      // The upstream driver has no native input gate; this makes no cleanup claim.
      if (options.nativeRevision === null && !target.browserInputControl) return;
      nativeInputCleanupPending = target;
      const reply = yield* driverRequest<CuaReply>(
        target.socket,
        { method: "interrupt_input", args: { expected_pid: target.child.pid } },
        { timeoutMs: 5_000 },
      ).pipe(Effect.option);
      const state = Option.isSome(reply) ? reply.value.result : undefined;
      const confirmed =
        Option.isSome(reply) &&
        reply.value.ok === true &&
        state !== undefined &&
        state.pid === target.child.pid &&
        state.input_interrupted === true &&
        state.input_admission_open === true &&
        state.cleanup_complete === true &&
        state.pending_input === 0 &&
        typeof state.input_epoch === "number" &&
        Number.isSafeInteger(state.input_epoch) &&
        state.input_epoch > target.nativeInputEpoch;
      if (confirmed) target.nativeInputEpoch = state.input_epoch as number;
      if (target.retired || target.didExit) return;
      if (!confirmed) {
        // The native barrier stays closed. OS releases are only a fallback,
        // never proof that the old input loop has stopped.
        if (!target.browserInputInFlight && options.releaseHeldInput)
          yield* options.releaseHeldInput.pipe(
            Effect.catch((error) =>
              log(`interrupted held-input release failed: ${toHostError(error).message}`),
            ),
          );
        return yield* hostError(
          "Cua Driver has not confirmed input interruption and cleanup. Input remains paused; a later attempt will recheck the native drain.",
        );
      }
      target.inputInFlight = false;
      target.browserInputInFlight = false;
      target.inputTask = undefined;
      if (nativeInputCleanupPending === target) nativeInputCleanupPending = undefined;
    });

  const stopSurfaces = () => {
    // Surface failures reach the caller through the returned task only.
    const frameTapStopped = options.frameTap
      ? start(options.frameTap.stop.pipe(Effect.mapError(toHostError)))
      : doneTask;
    // Any shield still up belongs to an excursion this stop interrupts.
    const shieldStopped = options.shield
      ? start(options.shield.stop.pipe(Effect.mapError(toHostError)))
      : doneTask;
    return Effect.andThen(frameTapStopped.await, shieldStopped.await);
  };

  const stopNow = (): Task<void> => {
    inputMonitorRequested = false;
    if (inputMonitorArmed) {
      inputMonitorArmed = false;
      options.onInputMonitorArmedChange?.(false);
    }
    controlledTargets.clear();
    takeoverTargets.clear();
    browserTargets.clear();
    browserRecoveryObservations.clear();
    monitoredTasks.clear();
    epoch += 1;
    // A read dispatched before a stop must not be admitted as a fresh
    // observation afterwards: the stale-read refusal keys off this epoch.
    desktopEpoch += 1;
    for (const cancel of pendingPermissionChecks.keys()) cancel();
    const admitted = operations;
    const surfaces = stopSurfaces();
    const previous = stopping;
    const task = start(
      Effect.gen(function* () {
        yield* previous;
        if (generation) yield* retire(generation).await;
        if (starting) yield* ignored(starting);
        if (generation) yield* retire(generation).await;
        yield* admitted;
        yield* retiring;
        yield* surfaces;
      }),
    );
    // The caller sees the failure; the chain must not.
    stopping = ignored(task);
    return task;
  };

  /** Interrupts native input without retiring browser or session identity. */
  const interruptInputNow = (): Task<void> => {
    epoch += 1;
    desktopEpoch += 1;
    for (const cancel of pendingPermissionChecks.keys()) cancel();
    const admitted = operations;
    const surfaces = stopSurfaces();
    for (const interrupt of inFlightInputInterrupts) interrupt.abort();
    const previous = stopping;
    const task = start(
      Effect.gen(function* () {
        yield* previous;
        if (starting) yield* ignored(starting);
        if (generation) yield* interruptNativeInput(generation);
        yield* admitted;
        yield* retiring;
        yield* surfaces;
      }),
    );
    stopping = ignored(task);
    return task;
  };

  /**
   * Opens this generation's persistent control connection: the socket that
   * sends `session_begin` and stays open. Its id is reused on reconnect;
   * the labels the old transport's EOF reaped wait in `endedBrowserSessions`.
   */
  const ensureControlSession = (target: Generation) =>
    Effect.gen(function* () {
      if (target.controlSocket && !target.controlSocket.destroyed) return;
      if (target.controlSocket) {
        for (const label of target.liveBrowserSessions) target.endedBrowserSessions.add(label);
        target.liveBrowserSessions.clear();
      }
      const socket = NodeNet.createConnection(target.socket);
      target.controlSocket = socket;
      socket.on("error", () => undefined);
      const begin = Effect.callback<CuaReply, CuaHostError>((resume) => {
        const chunks: Buffer[] = [];
        const fail = () => resume(Effect.fail(hostError("session_begin connection closed")));
        socket.once("close", fail);
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const end = Buffer.concat(chunks).indexOf(10);
          if (end < 0) return;
          socket.removeListener("close", fail);
          socket.removeAllListeners("data");
          const reply = decodeReply(Buffer.concat(chunks).subarray(0, end).toString("utf8"));
          resume(
            Option.isSome(reply)
              ? Effect.succeed(reply.value as CuaReply)
              : Effect.fail(hostError("Invalid session_begin reply.")),
          );
        });
        socket.write(
          `${encodeJson({ method: "session_begin", session_id: target.controlSession })}\n`,
        );
        return Effect.sync(() => {
          socket.removeListener("close", fail);
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: 10_000,
          orElse: () => Effect.fail(hostError("session_begin timed out")),
        }),
        Effect.flatMap((reply) =>
          reply.ok ? Effect.void : Effect.fail(hostError(reply.error ?? "session_begin refused.")),
        ),
      );
      yield* begin.pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            socket.destroy();
            if (target.controlSocket === socket) target.controlSocket = undefined;
          }),
        ),
      );
      // A late EOF after a successful begin still means the sessions are
      // gone; the next check notices the destroyed socket.
    });

  const stopped = (target: Generation) => target.retired || target.didExit;

  /** Spawn plus the validated handshake: the warmable half of startup. */
  const ensureSpawned = (): Task<Generation> => {
    if (starting) return starting;
    let settled = false;
    const task = start(
      Effect.gen(function* () {
        yield* retiring;
        if (closed) return yield* hostError("Computer host is closed.");
        if (generation && !generation.retired && !generation.didExit) return generation;
        if (generation) yield* retire(generation).await;
        const present = yield* Effect.promise(() =>
          NodeFSP.access(options.binaryPath).then(
            () => true,
            () => false,
          ),
        );
        if (!present) return yield* hostError(CUA_DRIVER_MISSING_MESSAGE);
        const endpoint =
          platform === "win32"
            ? `\\\\.\\pipe\\pathway-cua-driver-${NodeCrypto.randomUUID().slice(0, 8)}`
            : NodePath.join(directory, `driver-${NodeCrypto.randomUUID().slice(0, 8)}.sock`);
        // Park the compact cursor between actions until end_task removes it,
        // with a one-minute native expiry. Upstream cannot parse these flags.
        const expectsPatched = options.nativeRevision !== null;
        // Keep a short stderr tail so a wedged daemon is diagnosable after the
        // fact; payloads may be private, so only lines are kept, on exit.
        const stderrTail: string[] = [];
        let spawned: Generation | undefined;
        const child = yield* spawnHelper(processScope, {
          command: options.binaryPath,
          args: [
            "serve",
            "--embedded",
            "--socket",
            endpoint,
            ...(expectsPatched
              ? ["--compact-cursor", "--idle-hide-ms", String(CUA_CURSOR_IDLE_HIDE_MS)]
              : []),
          ],
          stdin: true,
          env: {
            CUA_DRIVER_EMBEDDED: "1",
            CUA_DRIVER_HOST_BUNDLE_ID: options.bundleId,
            CUA_DRIVER_PERMISSION_MODE: "standard",
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
            // Upgrade lifecycle belongs to the app, not the managed driver.
            CUA_DRIVER_RS_UPDATE_CHECK: "0",
            // Owned by the GUI host, never by public tool arguments.
            PATHWAY_CUA_FOREGROUND_OBSERVATION_MS: "100",
            // Long enough to catch the windows an action spawns, short
            // enough to save ~650ms per background action.
            PATHWAY_CUA_BACKGROUND_OBSERVATION_MS: "350",
            CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
            CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
            CUA_DRIVER_RS_HOME: NodePath.join(directory, "state"),
          },
          onStderrLine: (line) =>
            Effect.gen(function* () {
              if (!line.trim()) return;
              // These native literals carry no app content; other stderr stays
              // private to the bounded shutdown tail.
              const overlay = line.match(
                /^pathway_cua_overlay_init code=(overlay_display_unavailable|overlay_window_unavailable)$/,
              );
              const restore = line.match(
                /^pathway_cua_focus_restore status=(not-needed|restored|failed|unobservable|user-changed)$/,
              );
              if (overlay || restore)
                yield* log(
                  encodeJson({
                    event: overlay ? "computer_cursor_init" : "computer_focus_restore",
                    ts: isoNow(),
                    ...(overlay ? { code: overlay[1] } : { status: restore![1] }),
                  }),
                );
              stderrTail.push(line.slice(0, 200));
              if (stderrTail.length > 20) stderrTail.shift();
            }),
          onExit: () =>
            Effect.suspend(() => {
              if (spawned) spawned.didExit = true;
              return stderrTail.length
                ? log(`driver stderr tail: ${stderrTail.join(" | ")}`)
                : Effect.void;
            }),
        }).pipe(Effect.mapError(toHostError));
        const next: Generation = {
          nativeInputEpoch: 0,
          browserInputControl: false,
          child,
          socket: endpoint,
          session: `pathway-${NodeCrypto.randomUUID()}`,
          didExit: false,
          retired: false,
          cancellationReady: false,
          inputInFlight: false,
          inputTask: undefined,
          browserInputInFlight: false,
          inputEverDispatched: false,
          controlSession: `pathway-transport-${NodeCrypto.randomUUID()}`,
          controlSocket: undefined,
          endedBrowserSessions: new Set<string>(),
          liveBrowserSessions: new Set<string>(),
          endedTaskSessions: new Set<string>(),
          appliedCursorStyle: "",
          appliedSessionCursorStyles: new Map<string, string>(),
          taskCursors: new Map<string, TaskCursor>(),
        };
        spawned = next;
        if (yield* child.hasExited) next.didExit = true;
        generation = next;
        updateInputMonitorArmed();
        const handshake = Effect.gen(function* () {
          let metadata: CuaReply | undefined;
          for (let attempt = 0; attempt < 80; attempt++) {
            if (stopped(next)) return yield* hostError("Cua Driver stopped during startup.");
            const reply = yield* driverRequest<CuaReply>(
              endpoint,
              { method: "metadata" },
              { timeoutMs: 200 },
            ).pipe(Effect.option);
            if (Option.isSome(reply)) {
              metadata = reply.value;
              break;
            }
            yield* Effect.sleep(50);
          }
          // `nativeRevision: null` expects an upstream driver whose metadata
          // carries no Pathway revision. A patched build is still accepted
          // there: a superset of the expected identity is never a downgrade.
          const expectedNativeRevision =
            options.nativeRevision === undefined ? CUA_NATIVE_REVISION : options.nativeRevision;
          const reportedRevision = metadata?.result?.pathway_native_revision;
          if (
            !metadata?.ok ||
            metadata.result?.driver_version !== CUA_DRIVER_VERSION ||
            (expectedNativeRevision !== null && reportedRevision !== expectedNativeRevision) ||
            metadata.result?.embedded !== true ||
            metadata.result?.pid !== child.pid
          )
            return yield* hostError(
              "Cua Driver identity/version/native revision handshake failed.",
            );
          observedNativeRevision =
            typeof reportedRevision === "number" && Number.isSafeInteger(reportedRevision)
              ? reportedRevision
              : 0;
          next.browserInputControl =
            platform === "linux" &&
            reportedRevision === CUA_NATIVE_REVISION &&
            metadata.result?.pathway_browser_input_control === 1;
          if (stopped(next)) return yield* hostError("Cua Driver stopped during startup.");
          next.cancellationReady = expectedNativeRevision !== null || next.browserInputControl;
          if (platform !== "win32")
            yield* Effect.promise(() => NodeFSP.chmod(endpoint, 0o600).catch(() => undefined));
          if (stopped(next)) return yield* hostError("Cua Driver stopped during startup.");
          return next;
        });
        return yield* handshake.pipe(Effect.tapError(() => Effect.ignore(retire(next).await)));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true;
            starting = undefined;
          }),
        ),
      ),
    );
    // A live generation settles synchronously; caching that finished task
    // would hand the retired generation to every later call.
    if (!settled) starting = task;
    return task;
  };

  /**
   * The session half of startup: `start_session` plus once-per-generation
   * cursor setup, opened on the first call that needs it. A failure retires
   * the generation so the next call starts clean.
   */
  const openSession = (target: Generation) =>
    Effect.gen(function* () {
      target.sessionOpening ??= start(
        Effect.gen(function* () {
          const startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
          if (stopped(target)) return yield* hostError("Cua Driver stopped during startup.");
          const session = yield* driverRequest<CuaReply>(
            target.socket,
            { method: "call", name: "start_session", args: { session: target.session } },
            { timeoutMs: startupTimeoutMs },
          );
          if (!session.ok || session.result?.isError)
            return yield* hostError("Cua session initialization failed.");
          if (stopped(target)) return yield* hostError("Cua Driver stopped during startup.");
          // Configure once per generation, not before each input.
          const motion = yield* driverRequest<CuaReply>(
            target.socket,
            {
              method: "call",
              name: "set_agent_cursor_motion",
              args: { session: target.session, glide_duration_ms: 100, dwell_after_click_ms: 0 },
            },
            { timeoutMs: startupTimeoutMs },
          );
          if (!motion.ok || motion.result?.isError)
            return yield* hostError("Cua cursor initialization failed.");
          // The shared session rarely paints an action, so its style is best
          // effort: a cosmetic color must never retire a driver.
          const style = normalizeCuaCursorStyle(options.cursorStyle?.());
          if (style && observedNativeRevision !== 0) {
            const styled = yield* driverRequest<CuaReply>(
              target.socket,
              {
                method: "call",
                name: "set_agent_cursor_style",
                args: { session: target.session, ...style },
              },
              { timeoutMs: startupTimeoutMs },
            ).pipe(Effect.result);
            if (styled._tag === "Failure")
              yield* log(`shared cursor session style failed: ${styled.failure.message}`);
            else if (!styled.success.ok || styled.success.result?.isError)
              yield* log("shared cursor session style was refused; keeping the stock cursor");
            else target.appliedCursorStyle = encodeJson(style);
          }
        }),
      );
      yield* target.sessionOpening.await.pipe(
        Effect.tapError(() => Effect.ignore(retire(target).await)),
      );
    });

  const ensureStarted = Effect.gen(function* () {
    const target = yield* Effect.suspend(() => ensureSpawned().await);
    yield* openSession(target);
    return target;
  });

  const setTaskCursorEnabled = (target: Generation, label: string, enabled: boolean) =>
    driverRequest<CuaReply>(
      target.socket,
      { method: "call", name: "set_agent_cursor_enabled", args: { session: label, enabled } },
      { timeoutMs: 500 },
    ).pipe(
      Effect.map((reply) => reply.ok && !reply.result?.isError),
      Effect.orElseSucceed(() => false),
    );

  /** A single bounded read after mint or first action, never periodic polling. */
  const logCursorState = (
    target: Generation,
    label: string,
    task: CuaComputerTask,
    stage: "session-created" | "first-action",
  ) =>
    Effect.gen(function* () {
      if (observedNativeRevision === 0) return;
      const fields: Record<string, unknown> = {
        event: "computer_cursor",
        ts: isoNow(),
        thread: task.threadId,
        turn: task.turnId,
        stage,
      };
      const reply = yield* driverRequest<CuaReply>(
        target.socket,
        { method: "call", name: "get_agent_cursor_state", args: { session: label } },
        { timeoutMs: 250 },
      ).pipe(Effect.option);
      if (Option.isNone(reply)) fields.status = "query-failed";
      else {
        const state = reply.value.result?.structuredContent;
        const motion = state?.motion as Record<string, unknown> | undefined;
        fields.status = reply.value.ok && !reply.value.result?.isError ? "reported" : "unavailable";
        if (typeof state?.enabled === "boolean") fields.enabled = state.enabled;
        if (state && "position" in state) fields.has_position = state.position != null;
        if (typeof motion?.idle_hide_ms === "number" && Number.isFinite(motion.idle_hide_ms))
          fields.idle_hide_ms = motion.idle_hide_ms;
        if (typeof state?.overlay_ready === "boolean") fields.overlay_ready = state.overlay_ready;
        if (typeof state?.render_visible === "boolean")
          fields.render_visible = state.render_visible;
        if (state?.overlay_scope === "main_display") fields.overlay_scope = state.overlay_scope;
      }
      yield* log(encodeJson(fields));
    });

  const endCursorSession = (target: Generation, label: string) =>
    Effect.gen(function* () {
      const cursor = target.taskCursors.get(label);
      const hidden = yield* setTaskCursorEnabled(target, label, false);
      // A lost reply can mean either state. Keep the cleanup handle until
      // acknowledged, and re-enable explicitly if a later action reuses it.
      if (hidden) target.taskCursors.delete(label);
      else if (cursor) cursor.enabled = false;
      yield* log(
        encodeJson({
          event: "computer_cursor",
          ts: isoNow(),
          thread: cursor?.task.threadId,
          turn: cursor?.task.turnId,
          stage: "task-end",
          status: hidden ? "hidden" : "hide-failed",
        }),
      );
      return hidden;
    });

  /**
   * Applies the cursor preference to one task cursor session before its
   * first dispatch. Task sessions never inherit the shared session's style.
   * Failures cost the action nothing.
   */
  const applyCursorStyleForSession = (target: Generation, session: string) =>
    Effect.gen(function* () {
      const style = normalizeCuaCursorStyle(options.cursorStyle?.());
      const previous = target.appliedSessionCursorStyles.get(session);
      // Stock with no prior override: the template default is already right.
      if (!style && previous === undefined) return;
      const styleJson = style ? encodeJson(style) : "";
      if (previous === styleJson) return;
      if (observedNativeRevision === 0) return;
      const reply = yield* driverRequest<CuaReply>(
        target.socket,
        {
          method: "call",
          name: "set_agent_cursor_style",
          args: style ? { session, ...style } : { session },
        },
        { timeoutMs: 5_000 },
      ).pipe(Effect.result);
      if (reply._tag === "Failure")
        return yield* log(`task cursor style setup failed: ${reply.failure.message}`);
      if (!reply.success.ok || reply.success.result?.isError)
        return yield* log("task cursor style was refused; keeping the previous cursor");
      if (style) target.appliedSessionCursorStyles.set(session, styleJson);
      else target.appliedSessionCursorStyles.delete(session);
      while (target.appliedSessionCursorStyles.size > 256)
        target.appliedSessionCursorStyles.delete(
          target.appliedSessionCursorStyles.keys().next().value!,
        );
    });

  /** End only the latest matching turn, in the same queue as native dispatch. */
  const endTaskCursors = (task: CuaComputerTask, allTurns: boolean): Task<void> =>
    enqueue((previous) =>
      Effect.gen(function* () {
        yield* previous;
        const target = generation;
        if (!target || stopped(target)) return;
        for (const [label, cursor] of target.taskCursors) {
          if (
            cursor.task.threadId === task.threadId &&
            (allTurns || cursor.task.turnId === task.turnId)
          )
            yield* endCursorSession(target, label);
        }
      }),
    );

  const endTask = (task: CuaComputerTask, allTurns: boolean, waitForCursor = true) =>
    Effect.gen(function* () {
      const taskKey = cuaComputerTaskKey(task);
      controlledTargets.delete(taskKey);
      takeoverTargets.delete(taskKey);
      monitoredTasks.delete(taskKey);
      if (allTurns) {
        for (const [key, target] of controlledTargets)
          if (target.threadId === task.threadId) controlledTargets.delete(key);
        for (const [key, target] of takeoverTargets)
          if (target.threadId === task.threadId) takeoverTargets.delete(key);
        for (const [key, threadId] of monitoredTasks)
          if (threadId === task.threadId) monitoredTasks.delete(key);
      }
      if (monitoredTasks.size === 0) {
        inputMonitorRequested = false;
        inputMonitorArmed = false;
        options.onInputMonitorArmedChange?.(false);
      }
      rememberTask(endedFrameTasks, task);
      if (
        frameTapTask?.threadId === task.threadId &&
        (allTurns || task.turnId === frameTapTask.turnId)
      ) {
        rememberTask(endedFrameTasks, frameTapTask);
        frameTapTask = undefined;
      }
      // Preview and shield authority end now. Cosmetic cursor cleanup stays
      // on the native queue, but task Stop must not wait on another task's
      // long native action merely to hide this task's cursor.
      const cursorEnded = endTaskCursors(task, allTurns);
      if (!waitForCursor) detach(cursorEnded.await, "stopped task cursor cleanup failed");
      yield* Effect.all(
        [
          options.frameTap?.endTask(task) ?? Effect.void,
          options.shield?.endTask(task) ?? Effect.void,
          waitForCursor ? cursorEnded.await : Effect.void,
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.mapError(toHostError));
    });

  const stopTaskInput = (task: CuaComputerTask) =>
    Effect.gen(function* () {
      const key = cuaComputerTaskKey(task);
      const matches = (candidate: CuaComputerTask) =>
        candidate.threadId === task.threadId &&
        (task.turnId === undefined || candidate.turnId === task.turnId);
      const stoppedKeys = new Set([key]);
      rememberTask(userStoppedTasks, task);
      for (const known of knownTasks.values()) {
        if (!matches(known)) continue;
        stoppedKeys.add(cuaComputerTaskKey(known));
        rememberTask(userStoppedTasks, known);
      }
      for (const admitted of admittedTaskRequests) {
        if (!matches(admitted.task)) continue;
        admitted.stopped = true;
        stoppedKeys.add(cuaComputerTaskKey(admitted.task));
        rememberTask(userStoppedTasks, admitted.task);
      }
      for (const [cancel, owner] of pendingPermissionChecks)
        if (owner !== undefined && stoppedKeys.has(owner)) cancel();
      for (const [cancel, owner] of activeTaskCalls) if (stoppedKeys.has(owner)) cancel.abort();
      // Once this task dispatched input, stopping it drains that generation
      // and fences queued siblings too. Idle and queued tasks need only their
      // own revocation; a thread-wide Stop never interrupts another thread.
      const scope: "task" | "generation" =
        generation?.inputInFlight &&
        generation.inputTask !== undefined &&
        matches(generation.inputTask)
          ? "generation"
          : "task";
      const interrupted = scope === "generation" ? interruptInputNow() : doneTask;
      yield* Effect.all([interrupted.await, endTask(task, task.turnId === undefined, false)], {
        concurrency: "unbounded",
        discard: true,
      });
      yield* log(
        encodeJson({
          event: "computer_task_stop",
          thread: task.threadId,
          turn: task.turnId,
          scope,
        }),
      );
      return scope;
    });

  /**
   * Hosts warm on first touch only when asked. The initial check answers
   * without the driver, so its cold start overlaps later work without caching
   * pre-grant TCC. Warming opens no session and fires once per host lifetime.
   */
  const warm = () => {
    if (warmAttempted || closed || suspended || !options.warmOnFirstTouch) return;
    warmAttempted = true;
    detach(ensureSpawned().await, "driver warm-up failed");
  };

  /**
   * Waits for one permission check. Stop and disconnected readers abandon
   * only this wait: the check itself keeps its shared helper queue slot.
   */
  const checkPermissionsFor = (
    connection: NodeNet.Socket,
    check: NonNullable<CuaDriverHostOptions["checkPermissions"]>,
    force: boolean,
    task: CuaComputerTask | undefined,
  ): Effect.Effect<CuaHostPermissions | undefined, CuaHostError> =>
    Effect.suspend(() => {
      const cancelled = Deferred.makeUnsafe<undefined>();
      const cleanup = () => {
        pendingPermissionChecks.delete(cancel);
        connection.removeListener("close", cancel);
      };
      const cancel = () => {
        cleanup();
        Deferred.doneUnsafe(cancelled, Exit.void as Exit.Exit<undefined>);
      };
      pendingPermissionChecks.set(cancel, task ? cuaComputerTaskKey(task) : undefined);
      connection.once("close", cancel);
      const checking = start(check({ force }).pipe(Effect.mapError(toHostError)));
      return Effect.raceFirst(Deferred.await(cancelled), checking.await).pipe(
        Effect.ensuring(Effect.sync(cleanup)),
      );
    });

  /** Best-effort frame-tap prime after launch_app: stream the launched app's main window. */
  const primeTapAfterLaunch = (
    task: CuaComputerTask,
    input: unknown,
    connection: NodeNet.Socket,
    admittedEpoch: number,
  ) =>
    Effect.gen(function* () {
      const candidates = launchAppMatchNames(input);
      const frameTap = options.frameTap;
      if (candidates.length === 0 || !frameTap) return;
      const reply = yield* call("list_windows", {}, connection, false);
      if (
        admittedEpoch !== epoch ||
        endedFrameTasks.has(cuaComputerTaskKey(task)) ||
        userStoppedTasks.has(cuaComputerTaskKey(task)) ||
        !reply.ok ||
        reply.result?.isError
      )
        return;
      const windows = (reply.result?.structuredContent as { windows?: unknown } | undefined)
        ?.windows;
      if (!Array.isArray(windows)) return;
      let best: { pid: number; windowId: number; area: number } | undefined;
      for (const row of windows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const pid = record.pid;
        const windowId = record.window_id;
        const bounds = record.bounds as { width?: unknown; height?: unknown } | undefined;
        const width = typeof bounds?.width === "number" ? bounds.width : 0;
        const height = typeof bounds?.height === "number" ? bounds.height : 0;
        if (
          typeof pid !== "number" ||
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          typeof windowId !== "number" ||
          !Number.isSafeInteger(windowId) ||
          windowId <= 0 ||
          record.is_on_screen !== true ||
          width <= 0 ||
          height <= 0
        )
          continue;
        const appName = typeof record.app_name === "string" ? record.app_name.toLowerCase() : "";
        if (!candidates.some((candidate) => appName === candidate || appName.includes(candidate)))
          continue;
        const area = width * height;
        if (!best || area > best.area) best = { pid, windowId, area };
      }
      if (!best)
        return yield* log(
          "computer frame tap launch prime: no on-screen window matched the launched app",
        );
      if (
        admittedEpoch !== epoch ||
        endedFrameTasks.has(cuaComputerTaskKey(task)) ||
        userStoppedTasks.has(cuaComputerTaskKey(task))
      )
        return;
      yield* log(
        `computer frame tap launch prime: streaming pid ${best.pid} window ${best.windowId}`,
      );
      yield* frameTap.update({ task, pid: best.pid, windowId: best.windowId });
    });

  const call = (
    name: string,
    input: unknown,
    connection: NodeNet.Socket,
    modelObservation: boolean,
    task?: CuaComputerTask,
    foregroundDelivery = false,
  ): Effect.Effect<CuaReply> =>
    Effect.suspend(() => {
      let target: Generation | undefined;
      let dispatched = false;
      let cursorEnabled: boolean | undefined;
      const admittedEpoch = epoch;
      const admittedDesktopEpoch = desktopEpoch;
      const isBrowser = CUA_BROWSER_TOOLS.has(name);
      const mutation = isBrowser
        ? CUA_BROWSER_MUTATION_TOOLS.has(name)
        : CUA_ACTION_TOOLS.has(name);
      // One browser capability namespace per thread, surviving turns.
      const label = isBrowser && task ? browserSessionLabel(task.threadId) : undefined;
      // Desktop calls get a per-task cursor session, minted lazily on dispatch.
      const agentLabel = !isBrowser && task ? agentSessionLabel(task) : undefined;
      // Per-call cancellation: the input interrupt aborts mutating calls, and a
      // caller's connection closing aborts too. Neither indicts the driver,
      // so an aborted call never retires the generation.
      const callCancel = new AbortController();
      if (mutation) inFlightInputInterrupts.add(callCancel);
      if (task) activeTaskCalls.set(callCancel, cuaComputerTaskKey(task));
      const abort = () => {
        if (repliedConnections.has(connection)) return;
        const alreadyInterrupted = callCancel.signal.aborted;
        callCancel.abort();
        // Closing a socket does not stop a native input loop. Fence queued
        // work behind the real native drain, just as an explicit Stop does.
        if (mutation && dispatched && !alreadyInterrupted)
          detach(interruptInputNow().await, "disconnected input cleanup failed");
      };
      connection.once("close", abort);
      // Set only by the pre-dispatch guards: nothing reached the driver.
      let cancelledBeforeDispatch = false;
      const cancelBeforeDispatch = () => {
        cancelledBeforeDispatch = !dispatched;
        return hostError("Cancelled before dispatch.");
      };

      const attempt = Effect.gen(function* () {
        let reply: CuaReply | undefined;
        for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
          target = yield* ensureStarted;
          const current = target;
          if (
            connection.destroyed ||
            current.retired ||
            admittedEpoch !== epoch ||
            desktopPauses.size > 0 ||
            callCancel.signal.aborted
          )
            return yield* cancelBeforeDispatch();
          const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
          let browserSessionId: string | undefined;
          if (isBrowser && label) {
            // The transport owner must be a live proxy session for download
            // approval; re-begin if the control connection died.
            yield* ensureControlSession(current);
            if (current.endedBrowserSessions.has(label)) {
              // Revival is attempted once; a session still dead after it
              // returns the death reply verbatim.
              const revived = yield* driverRequest<CuaReply>(
                current.socket,
                {
                  method: "call",
                  name: "start_session",
                  args: { session: label },
                  session_id: current.controlSession,
                },
                { timeoutMs: 10_000 },
              );
              if (revived.ok && !revived.result?.isError)
                current.endedBrowserSessions.delete(label);
            }
            browserSessionId = current.controlSession;
          } else if (agentLabel && current.endedTaskSessions.has(agentLabel)) {
            // A desktop task session owns itself, so the plain call form of
            // start_session revives it.
            const revived = yield* driverRequest<CuaReply>(
              current.socket,
              { method: "call", name: "start_session", args: { session: agentLabel } },
              { timeoutMs: 10_000 },
            );
            if (revived.ok && !revived.result?.isError) {
              current.endedTaskSessions.delete(agentLabel);
              // A revived cursor comes from the launch template: re-apply its style.
              current.appliedSessionCursorStyles.delete(agentLabel);
            }
          }
          // The action paints under its own task session, so the user's
          // colors are applied to that session, once per task.
          if (agentLabel) yield* applyCursorStyleForSession(current, agentLabel);
          if (agentLabel && !current.taskCursors.get(agentLabel)?.enabled) {
            // Showing a cursor must not end its session: it can still own
            // retained accessibility refs across turns.
            cursorEnabled = yield* setTaskCursorEnabled(current, agentLabel, true);
          }
          // Session setup can await I/O. Stop wins even if it arrived after
          // the first guard and before the native request is sent.
          if (admittedEpoch !== epoch || connection.destroyed || callCancel.signal.aborted)
            return yield* cancelBeforeDispatch();
          if (linux && isBrowser) {
            const refusal = linux.refusal(
              name,
              input,
              foregroundDelivery ? "foreground" : undefined,
              current.browserInputControl,
            );
            if (refusal) return refusal;
          }
          if (!(yield* inputMonitorAvailable(name, input)))
            return inputMonitorUnavailableReply(yield* monitorState);
          if (mutation || modelObservation) {
            const controlled = controlledTarget(input, task, isBrowser);
            if (controlled) {
              controlledTargets.set(task ? cuaComputerTaskKey(task) : "anonymous", controlled);
              while (controlledTargets.size > 256)
                controlledTargets.delete(controlledTargets.keys().next().value!);
            }
          }
          if (mutation) {
            activeInputTaskKey = task ? cuaComputerTaskKey(task) : "anonymous";
            activeForegroundInput =
              foregroundDelivery ||
              (args as Record<string, unknown>).delivery_mode === "foreground" ||
              name === "bring_to_front";
          }
          dispatched = true;
          if (label) current.liveBrowserSessions.add(label);
          if (mutation) {
            current.inputInFlight = true;
            current.browserInputInFlight = isBrowser;
            current.inputTask = task;
          }
          current.inputEverDispatched ||= current.inputInFlight;
          const attemptReply = yield* driverRequest<CuaReply>(
            current.socket,
            {
              method: "call",
              name,
              ...(mutation && (options.nativeRevision !== null || current.browserInputControl)
                ? { expected_input_epoch: current.nativeInputEpoch }
                : {}),
              // The spread order is the real guard: the label overwrites any
              // caller `session`, and the daemon injects its own session ids.
              args: { ...args, session: label ?? agentLabel ?? current.session },
              ...(browserSessionId ? { session_id: browserSessionId } : {}),
            },
            { timeoutMs: 30_000, mutation, signal: callCancel.signal },
          );
          if (attemptReply.result?.structuredContent?.input_cleanup_unconfirmed === true) {
            // A tool reply is not a release acknowledgement. Keep CDP input
            // uncertainty across later reads and process exits.
            current.inputInFlight = true;
            current.browserInputInFlight ||= isBrowser;
            nativeInputCleanupPending = current;
          } else if (mutation && nativeInputCleanupPending !== current) {
            current.inputInFlight = false;
            current.browserInputInFlight = false;
            current.inputTask = undefined;
          }
          if (isDriverSessionDeath(attemptReply)) {
            if (isBrowser && label) {
              // A browser session can die without the generation dying: mark
              // it ended so the next attempt revives before dispatching.
              current.liveBrowserSessions.delete(label);
              current.endedBrowserSessions.add(label);
              if (attemptIndex === 0) continue;
            } else if (agentLabel) {
              // A task cursor session expires on its own too; reviving it in
              // place keeps every other thread's cursor and the driver alive.
              current.endedTaskSessions.add(agentLabel);
              while (current.endedTaskSessions.size > 256)
                current.endedTaskSessions.delete(current.endedTaskSessions.values().next().value!);
              if (attemptIndex === 0) continue;
            } else if (attemptIndex === 0) {
              yield* Effect.ignore(retire(current).await);
              continue;
            }
          }
          reply = attemptReply;
          break;
        }
        const current = target;
        if (!reply || !current) return yield* hostError("Cancelled before dispatch.");
        if (
          mutation &&
          (reply.result?.structuredContent?.code === "focus_restore_failed" ||
            parseCuaActionDiagnostics(reply.result?.structuredContent)?.error_code ===
              "focus_restore_failed")
        ) {
          // Input may already have landed. Keep that uncertain result, but
          // fence queued work after losing user focus; never replay.
          desktopObservationRequired = true;
          epoch += 1;
          desktopEpoch += 1;
          const key = task ? cuaComputerTaskKey(task) : "anonymous";
          const controlled = controlledTargets.get(key);
          if (controlled) takeoverTargets.set(key, { ...controlled });
        }
        if (
          admittedDesktopEpoch !== desktopEpoch &&
          (CUA_READ_TOOLS.has(name) || name === "get_browser_state")
        ) {
          yield* log(
            `refused stale ${name} read (desktop epoch ${admittedDesktopEpoch} -> ${desktopEpoch})`,
          );
          return desktopPauseReply();
        }
        if (isBrowser && task && reply.ok && !reply.result?.isError)
          rememberBrowserTarget(input, reply.result, task);
        // Reads may finish during the cooldown, but must not release recovery
        // tracking while continued physical input can still make them stale.
        if (
          modelObservation &&
          inputInterruptCooldownUntil <= now() &&
          !connection.destroyed &&
          !stopped(current) &&
          admittedEpoch === epoch &&
          desktopPauses.size === 0 &&
          reply.ok &&
          !reply.result?.isError &&
          reply.result !== undefined
        ) {
          const nativeObservation =
            (name === "get_window_state" || name === "get_desktop_state") &&
            reply.result.structuredContent?.screenshot_frame_valid !== false &&
            (reply.result.content?.some((part) => part.type === "image" && !!part.data) ||
              Array.isArray(reply.result.structuredContent?.elements));
          const browserObservation =
            name === "get_browser_state" && isBrowserSnapshot(input, reply.result);
          if (nativeObservation || browserObservation) {
            if (nativeObservation) desktopObservationRequired = false;
            if (browserObservation) {
              const key = browserRecoveryKey(input, task);
              if (key) browserRecoveryObservations.set(key, desktopEpoch);
              while (browserRecoveryObservations.size > 256)
                browserRecoveryObservations.delete(
                  browserRecoveryObservations.keys().next().value!,
                );
            }
            const key = task ? cuaComputerTaskKey(task) : "anonymous";
            const interrupted = takeoverTargets.get(key);
            if (interrupted && observationMatchesTarget(name, input, interrupted, reply.result))
              takeoverTargets.delete(key);
            yield* log(`fresh model observation via ${name}; matching input gate cleared`);
          }
        }
        if (name === "get_desktop_state" && reply.result && options.normalizeOverview)
          reply.result = { ...reply.result, ...options.normalizeOverview(reply.result) };
        if (agentLabel && task && !isDriverSessionDeath(reply)) {
          const cursor = current.taskCursors.get(agentLabel);
          const sameTurn =
            cursor !== undefined && cuaComputerTaskKey(cursor.task) === cuaComputerTaskKey(task);
          const firstAction = mutation && (!sameTurn || !cursor.firstActionObserved);
          current.taskCursors.delete(agentLabel);
          current.taskCursors.set(agentLabel, {
            task,
            firstActionObserved: mutation || (sameTurn && cursor.firstActionObserved) || false,
            enabled: cursorEnabled ?? cursor?.enabled ?? false,
          });
          if (!cursor || firstAction)
            yield* logCursorState(
              current,
              agentLabel,
              task,
              firstAction ? "first-action" : "session-created",
            );
          while (current.taskCursors.size > 256) {
            const oldest = current.taskCursors.keys().next().value!;
            // Native idle expiry bounds a failed cosmetic cleanup.
            if (!(yield* endCursorSession(current, oldest))) current.taskCursors.delete(oldest);
          }
        }
        return reply;
      });

      return attempt.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            let detail = error.message;
            // A cancelled call proves nothing about the generation's health;
            // every real dispatch failure still retires it.
            if (target && !cancelledBeforeDispatch && !callCancel.signal.aborted) {
              const retired = yield* Effect.result(retire(target).await);
              if (retired._tag === "Failure") detail += `; ${retired.failure.message}`;
            }
            return {
              ok: false,
              error: detail,
              effect: dispatched && mutation ? "dispatched-unknown" : "not-dispatched",
            } satisfies CuaReply;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (mutation) {
              activeForegroundInput = false;
              activeInputTaskKey = undefined;
            }
            connection.removeListener("close", abort);
            inFlightInputInterrupts.delete(callCancel);
            activeTaskCalls.delete(callCancel);
          }),
        ),
      );
    });

  /**
   * The `shield` host method. Engage is admission-gated; release and
   * release_all are teardown, accepted in every state. Shield commands never
   * reach the driver or the operation queue: the helper owns the panels.
   */
  const handleShield = (request: Record<string, unknown>, task: CuaComputerTask | undefined) =>
    Effect.gen(function* () {
      const args = parseCuaShieldArgs(request.args);
      if (!args) return yield* hostError("Invalid computer shield request.");
      const shield = options.shield;
      if (args.action === "engage") {
        if (closed || suspended)
          return cancelledReply(
            "The activation shield is unavailable while the computer host is stopped.",
          );
        if (desktopPauses.size > 0)
          return cancelledReply(
            "The activation shield is unavailable while the desktop is paused. " +
              "Observe the desktop again before activating windows.",
          );
        if (!shield) return cancelledReply("The activation shield is not available in this build.");
        const engaged = yield* shield
          .engage(
            {
              shieldId: args.shieldId,
              frame: args.frame,
              windowId: args.windowId,
              pid: args.pid,
              ...(args.label !== undefined ? { label: args.label } : {}),
            },
            task,
          )
          .pipe(Effect.result);
        if (engaged._tag === "Failure")
          return cancelledReply(
            `The activation shield could not be shown: ${toHostError(engaged.failure).message}`,
          );
        return { ok: true, result: { engaged: true, shield_id: args.shieldId } } satisfies CuaReply;
      }
      if (args.action === "release") {
        if (shield) yield* shield.release(args.shieldId).pipe(Effect.mapError(toHostError));
        return { ok: true } satisfies CuaReply;
      }
      const released = shield ? yield* shield.releaseAll.pipe(Effect.mapError(toHostError)) : 0;
      return { ok: true, result: { released } } satisfies CuaReply;
    });

  const handleAuthenticatedRequest = (
    request: Record<string, unknown>,
    connection: NodeNet.Socket,
    task: CuaComputerTask | undefined,
    admitted: TaskRequest | undefined,
  ): Effect.Effect<CuaReply, CuaHostError> =>
    Effect.gen(function* () {
      const taskStopped = () =>
        admitted?.stopped === true ||
        (task !== undefined && userStoppedTasks.has(cuaComputerTaskKey(task)));
      if (request.method === "stop") {
        if (task) {
          const scope = yield* stopTaskInput(task);
          return { ok: true, result: { stop_scope: scope } } satisfies CuaReply;
        }
        // The backend's generic input-stop verb: while serving it means
        // interrupt input, not retire the driver. Full retirement belongs to
        // suspend, dispose, setup and a stop after serving ended.
        if (closed || suspended) yield* stopNow().await;
        else yield* interruptInputNow().await;
        return { ok: true } satisfies CuaReply;
      }
      if (request.method === "end_task") {
        if (!task) return yield* hostError("Computer task attribution is required.");
        yield* endTask(task, task.turnId === undefined);
        return { ok: true } satisfies CuaReply;
      }
      // Answered before the closed/suspended gate: a shield left up because
      // teardown was gated is exactly the failure this surface prevents.
      if (request.method === "shield") return yield* handleShield(request, task);
      if (request.method === "end_browser_thread") {
        // Explicit browser teardown for a removed thread, queued like a call
        // so it cannot end a session under an in-flight call on that label.
        if (!task) return yield* hostError("Computer task attribution is required.");
        for (const [key, target] of browserTargets)
          if (target.threadId === task.threadId) browserTargets.delete(key);
        const label = browserSessionLabel(task.threadId);
        yield* enqueue((previous) =>
          Effect.gen(function* () {
            yield* previous;
            yield* stopping;
            const target = generation;
            if (
              closed ||
              !target ||
              stopped(target) ||
              !target.controlSocket ||
              target.controlSocket.destroyed ||
              // Nothing was dispatched under this label: no session to end.
              (!target.liveBrowserSessions.has(label) && !target.endedBrowserSessions.has(label))
            )
              return;
            yield* driverRequest<CuaReply>(
              target.socket,
              {
                method: "call",
                name: "end_session",
                args: { session: label },
                session_id: target.controlSession,
              },
              { timeoutMs: 5_000 },
            ).pipe(Effect.ignore);
            // Even a failed end marks the label ended: transport EOF finishes
            // the rest, and reviving a gone session is a no-op.
            target.liveBrowserSessions.delete(label);
            target.endedBrowserSessions.add(label);
          }),
        ).await;
        return { ok: true } satisfies CuaReply;
      }
      if (closed) return yield* hostError("Computer host is closed.");
      if (suspended)
        return yield* hostError("Computer host is suspended while the backend is stopping.");
      if (taskStopped()) return taskStoppedReply();
      const requestName = typeof request.name === "string" ? request.name : undefined;
      const activeComputerWork =
        request.method === "call" &&
        requestName !== undefined &&
        requestName !== "check_permissions" &&
        (platform !== "linux" || task !== undefined) &&
        (CUA_ACTION_TOOLS.has(requestName) ||
          (CUA_BROWSER_MUTATION_TOOLS.has(requestName) &&
            (linux === undefined || !linux.browserCallIsReadOnly(requestName, request.args))) ||
          (task !== undefined &&
            request.modelObservation === true &&
            (CUA_READ_TOOLS.has(requestName) || CUA_BROWSER_TOOLS.has(requestName))));
      if (activeComputerWork) {
        inputMonitorRequested = true;
        const activationEpoch = epoch;
        const activationMonitorEpochChanges = inputMonitorEpochChanges;
        if (options.activateInputMonitor) yield* options.activateInputMonitor;
        if (
          activationEpoch !== epoch ||
          connection.destroyed ||
          closed ||
          suspended ||
          taskStopped()
        ) {
          const monitor = yield* monitorState;
          // Listener failure fences input like Stop. Keep its diagnosis only
          // when no other cancellation occurred while activating.
          if (
            !connection.destroyed &&
            !closed &&
            !suspended &&
            monitor?.ready === false &&
            epoch - activationEpoch === inputMonitorEpochChanges - activationMonitorEpochChanges
          )
            return inputMonitorUnavailableReply(monitor);
          return cancelledReply("Cancelled before listener activation completed.");
        }
        if (options.activateInputMonitor) inputMonitorArmed = true;
        if (task) {
          monitoredTasks.set(cuaComputerTaskKey(task), task.threadId);
          while (monitoredTasks.size > 256)
            monitoredTasks.delete(monitoredTasks.keys().next().value!);
        }
      }
      // Hosts without a permission bridge can warm on first touch. On macOS
      // the first granted snapshot warms instead, so the daemon cannot cache
      // a denied TCC result before setup completes.
      if (
        !options.checkPermissions &&
        (request.method === "probe" ||
          (request.method === "call" && request.name === "check_permissions"))
      )
        warm();
      if (request.method === "probe") {
        const present = yield* Effect.promise(() =>
          NodeFSP.access(options.binaryPath).then(
            () => true,
            () => false,
          ),
        );
        if (!present) return { ok: false, error: CUA_DRIVER_MISSING_MESSAGE } satisfies CuaReply;
        return {
          ok: true,
          result: { version: CUA_DRIVER_VERSION, running: !!generation },
        } satisfies CuaReply;
      }
      if (request.method === "setup") {
        connection.setTimeout(CUA_SETUP_TIMEOUT_MS);
        yield* stopNow().await;
        if (connection.destroyed || closed || suspended)
          return cancelledReply("Cancelled before permission setup.");
        yield* options.setup.pipe(Effect.mapError(toHostError));
        return { ok: true } satisfies CuaReply;
      }
      const name = requestName;
      if (
        request.method !== "call" ||
        name === undefined ||
        (!CUA_READ_TOOLS.has(name) && !CUA_ACTION_TOOLS.has(name) && !CUA_BROWSER_TOOLS.has(name))
      )
        return yield* hostError("Unsupported computer host request.");
      if (linux && !CUA_BROWSER_TOOLS.has(name)) {
        const refusal = linux.refusal(name, request.args, request.deliveryMode);
        if (refusal) return refusal;
      }
      // Browser calls mint session-scoped capabilities; without attribution
      // there is no label to scope them under.
      if (CUA_BROWSER_TOOLS.has(name) && !task)
        return yield* hostError("Computer browser calls require task attribution.");
      if (CUA_BROWSER_TOOLS.has(name)) {
        const args =
          request.args && typeof request.args === "object" && !Array.isArray(request.args)
            ? (request.args as Record<string, unknown>)
            : {};
        const pid = args.pid;
        if (typeof pid === "number" && Number.isSafeInteger(pid) && ownPids().has(pid)) {
          const message =
            "Computer browser calls may never target this application's own processes; the integrated browser is a separate surface.";
          return {
            ok: true,
            result: {
              isError: true,
              content: [{ type: "text", text: message }],
              structuredContent: { effect: "refused", code: "browser_self_target", message },
            },
          } satisfies CuaReply;
        }
      }
      if (desktopPauses.size > 0) return desktopPauseReply();
      // Observations and input share one native session: a capture must not
      // race input or turn a concurrent read into a driver restart.
      const stoppingAtAdmission = stopping;
      const admittedEpoch = epoch;
      return yield* enqueue((previous) =>
        Effect.gen(function* () {
          yield* previous;
          yield* stoppingAtAdmission;
          if (closed || suspended || connection.destroyed || admittedEpoch !== epoch)
            return cancelledReply("Cancelled before dispatch.");
          if (desktopPauses.size > 0) return desktopPauseReply();
          if (linux && CUA_BROWSER_TOOLS.has(name)) {
            // Capability comes only from the embedded child's handshake.
            const current = yield* ensureSpawned().await;
            if (
              closed ||
              suspended ||
              connection.destroyed ||
              admittedEpoch !== epoch ||
              stopped(current)
            )
              return cancelledReply("Cancelled before dispatch.");
            const refusal = linux.refusal(
              name,
              request.args,
              request.deliveryMode,
              current.browserInputControl,
            );
            if (refusal) return refusal;
          }
          if (!(yield* inputMonitorAvailable(name, request.args)))
            return inputMonitorUnavailableReply(yield* monitorState);
          if (
            (CUA_ACTION_TOOLS.has(name) || CUA_BROWSER_MUTATION_TOOLS.has(name)) &&
            nativeInputCleanupPending
          ) {
            yield* interruptNativeInput(nativeInputCleanupPending);
            if (admittedEpoch !== epoch || connection.destroyed)
              return cancelledReply("Cancelled while waiting for native input cleanup.");
          }
          // Physical input's cooldown, checked at dispatch time: a call queued
          // past the window runs, one admitted inside it is refused. Reads
          // are never gated.
          if (
            inputInterruptCooldownUntil > now() &&
            (CUA_ACTION_TOOLS.has(name) || CUA_BROWSER_MUTATION_TOOLS.has(name))
          )
            return inputInterruptedReply();
          if (taskStopped()) return taskStoppedReply();
          const check = options.checkPermissions;
          if (name === "check_permissions" && check) {
            // The short-lived helper avoids the daemon's TCC cache. Prompt
            // args from tools never reach the permission request path.
            const cancelled = () =>
              closed ||
              suspended ||
              connection.destroyed ||
              admittedEpoch !== epoch ||
              taskStopped();
            let latest = yield* checkPermissionsFor(connection, check, false, task);
            if (!latest || cancelled())
              return cancelledReply("Cancelled before permission check completed.");
            if (permissions && permissionsChanged(permissions, latest)) {
              // One probe can read TCC mid-transition and report a phantom
              // change the next reverts. Only a confirmed second read counts.
              const confirmed = yield* checkPermissionsFor(connection, check, true, task);
              if (!confirmed || cancelled())
                return cancelledReply("Cancelled before permission check completed.");
              latest = confirmed;
            }
            if (permissions && permissionsChanged(permissions, latest)) {
              epoch += 1;
              desktopEpoch += 1;
              desktopObservationRequired = true;
              browserObservationRequired = true;
              yield* log(
                `permission state changed accessibility ${permissions.accessibility} -> ${latest.accessibility}, ` +
                  `screen_recording ${permissions.screenRecording} -> ${latest.screenRecording}; requiring fresh desktop observation`,
              );
              // Already inside the operation queue: stop would wait for itself.
              if (generation) yield* retire(generation).await;
            }
            permissions = latest;
            if (latest.accessibility && latest.screenRecording && latest.inputMonitoring !== false)
              warm();
            const monitor = inputMonitorRequested ? yield* monitorState : undefined;
            return {
              ok: true,
              result: {
                structuredContent: {
                  accessibility: latest.accessibility,
                  screen_recording: latest.screenRecording,
                  ...(latest.inputMonitoring !== undefined
                    ? { input_monitoring: latest.inputMonitoring }
                    : {}),
                  ...(monitor
                    ? {
                        input_monitor_ready: monitor.ready,
                        ...(monitor.error ? { input_monitor_error: monitor.error } : {}),
                      }
                    : {}),
                  source: {
                    attribution: "host",
                    host_bundle_id: options.bundleId,
                    probe: "pathway-helper-permissions",
                  },
                },
              },
            } satisfies CuaReply;
          }
          const browserRecoverySetup = isIsolatedBrowserSetup(name, request.args);
          const browserRecoveryObserved = hasBrowserRecoveryObservation(request.args, task);
          // Launching names an app, not anything on screen, so a stale view
          // cannot misdirect it; gating it stranded tasks after every lock.
          if (
            (desktopObservationRequired &&
              ((CUA_ACTION_TOOLS.has(name) && name !== "launch_app") ||
                name === "check_input_ready")) ||
            (browserObservationRequired &&
              CUA_BROWSER_MUTATION_TOOLS.has(name) &&
              !browserRecoverySetup &&
              !browserRecoveryObserved) ||
            ((takeoverTargets.has(task ? cuaComputerTaskKey(task) : "anonymous") ||
              (!task && takeoverTargets.size > 0)) &&
              (CUA_ACTION_TOOLS.has(name) ||
                (CUA_BROWSER_MUTATION_TOOLS.has(name) &&
                  !browserRecoverySetup &&
                  !browserRecoveryObserved) ||
                name === "check_input_ready"))
          ) {
            yield* log(`refused ${name}: fresh desktop observation still required`);
            return desktopPauseReply();
          }
          if (
            task &&
            (request.modelObservation === true ||
              CUA_ACTION_TOOLS.has(name) ||
              CUA_BROWSER_TOOLS.has(name))
          )
            frameTapTask = task;
          const reply = yield* call(
            name,
            request.args,
            connection,
            request.modelObservation === true,
            task,
            request.deliveryMode === "foreground",
          );
          // Frame tap updates carry no frames through this queue: they only
          // point the helper channel at the task's window target.
          if (
            task &&
            !endedFrameTasks.has(cuaComputerTaskKey(task)) &&
            !taskStopped() &&
            admittedEpoch === epoch &&
            !connection.destroyed &&
            reply.ok &&
            !reply.result?.isError &&
            reply.result?.structuredContent?.effect !== "refused" &&
            reply.result?.structuredContent?.status !== "refused" &&
            (request.modelObservation === true ||
              CUA_ACTION_TOOLS.has(name) ||
              CUA_BROWSER_TOOLS.has(name))
          ) {
            const target = frameTapTarget(task, request.args);
            if (target && options.frameTap) {
              yield* options.frameTap
                .update(target)
                .pipe(
                  Effect.catch((error) =>
                    log(`computer frame tap update failed: ${toHostError(error).message}`),
                  ),
                );
            } else if (!target && name === "launch_app") {
              // launch_app carries no window. Resolve the launched app's main
              // window off the reply path: the agent's launch already returned.
              detach(
                primeTapAfterLaunch(task, request.args, connection, admittedEpoch),
                "computer frame tap launch prime failed",
              );
            }
          }
          return reply;
        }),
      ).await;
    });

  const handleRequest = (request: Record<string, unknown>, connection: NodeNet.Socket) =>
    Effect.gen(function* () {
      const supplied =
        typeof request.capability === "string" ? Buffer.from(request.capability) : Buffer.alloc(0);
      const expected = Buffer.from(options.capability);
      if (
        expected.length < 32 ||
        supplied.length !== expected.length ||
        !NodeCrypto.timingSafeEqual(supplied, expected)
      )
        return yield* hostError("Computer host authority is required.");
      const task = parseCuaComputerTask(request.task);
      if (request.task !== undefined && !task)
        return yield* hostError("Invalid computer task attribution.");
      const admitted = request.method === "call" && task ? { task, stopped: false } : undefined;
      if (admitted) {
        admittedTaskRequests.add(admitted);
        const key = cuaComputerTaskKey(admitted.task);
        knownTasks.delete(key);
        knownTasks.set(key, admitted.task);
        while (knownTasks.size > 256) knownTasks.delete(knownTasks.keys().next().value!);
      }
      return yield* handleAuthenticatedRequest(request, connection, task, admitted).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (admitted) admittedTaskRequests.delete(admitted);
          }),
        ),
      );
    });

  const handle = (request: Record<string, unknown>, connection: NodeNet.Socket) => {
    const name = typeof request.name === "string" ? request.name : "";
    if (request.method !== "call" || !CUA_ACTION_TOOLS.has(name))
      return handleRequest(request, connection);
    const started = now();
    return handleRequest(request, connection).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.suspend(() => {
          const reply = Exit.isSuccess(exit) ? exit.value : undefined;
          const task = reply ? parseCuaComputerTask(request.task) : undefined;
          const args =
            request.args && typeof request.args === "object"
              ? (request.args as Record<string, unknown>)
              : {};
          const structured = reply?.result?.structuredContent;
          const diagnostics = parseCuaActionDiagnostics(structured);
          const effect = structured?.effect ?? reply?.effect;
          const refusal = structured?.refusal as Record<string, unknown> | undefined;
          const code = structured?.code ?? refusal?.code;
          return log(
            encodeJson({
              event: "computer_action",
              ts: isoNow(),
              thread: task?.threadId,
              turn: task?.turnId,
              tool: name,
              layer: "driver-host",
              code: typeof code === "string" && LOGGABLE_CUA_CODES.has(code) ? code : undefined,
              pid: safeNativeId(args.pid),
              windowId: safeNativeId(args.window_id),
              effect:
                typeof effect === "string" &&
                ["refused", "not-dispatched", "dispatched-unknown", "verified"].includes(effect)
                  ? effect
                  : "unknown",
              failed: !reply?.ok || reply.result?.isError === true,
              ...(diagnostics
                ? { diagnostics, reason: cuaActionDiagnosticMessage(diagnostics) }
                : {}),
              ms: now() - started,
            }),
          );
        }),
      ),
      Effect.flatten,
    );
  };

  const respond = (socket: NodeNet.Socket, request: Record<string, unknown>) =>
    handle(request, socket).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
          const reply: CuaReply = Exit.isSuccess(exit)
            ? exit.value
            : cancelledReply(toHostError(Cause.squash(exit.cause)).message);
          repliedConnections.add(socket);
          socket.end(`${encodeJson({ ...reply, ...desktopState() })}\n`);
        }),
      ),
    );

  const accept = (socket: NodeNet.Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      socket.removeAllListeners("data");
      const request = decodeRequest(Buffer.concat(chunks).toString("utf8"));
      if (Option.isNone(request)) {
        socket.destroy();
        return;
      }
      runFork(respond(socket, request.value));
    });
    socket.setTimeout(60_000, () => socket.destroy());
  };

  const listen = Effect.gen(function* () {
    directory = yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-cua-")),
      catch: toHostError,
    });
    yield* Effect.tryPromise({ try: () => NodeFSP.chmod(directory, 0o700), catch: toHostError });
    yield* markCuaRuntimeDirectory(directory).pipe(Effect.mapError(toHostError));
    // Named pipes are already private to the creating user on Windows; the
    // 0600 owner check is a unix-socket protection, applied where it exists.
    const endpoint =
      options.hostEndpoint ??
      (platform === "win32"
        ? `\\\\.\\pipe\\pathway-cua-host-${NodeCrypto.randomUUID().slice(0, 8)}`
        : NodePath.join(directory, "host.sock"));
    const listening = NodeNet.createServer(accept);
    server = listening;
    yield* Effect.callback<void, CuaHostError>((resume) => {
      listening.once("error", (error) => resume(Effect.fail(toHostError(error))));
      listening.listen(endpoint, () => resume(Effect.void));
    });
    if (platform !== "win32")
      yield* Effect.tryPromise({ try: () => NodeFSP.chmod(endpoint, 0o600), catch: toHostError });
    return endpoint;
  });

  const dispose = Effect.gen(function* () {
    closed = true;
    updateInputMonitorArmed();
    const stopExit = yield* Effect.exit(stopNow().await);
    if (options.frameTap) yield* Effect.ignore(options.frameTap.dispose);
    if (options.shield) yield* Effect.ignore(options.shield.dispose);
    for (const socket of connections) socket.destroy();
    const listening = server;
    if (listening)
      yield* Effect.callback<void>((resume) => {
        listening.close(() => resume(Effect.void));
      });
    if (directory && !generation)
      yield* Effect.promise(() =>
        NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined),
      );
    return yield* stopExit;
  });

  yield* Effect.addFinalizer(() => Effect.ignore(dispose));

  const host: CuaDriverHost = {
    listen,
    isInputMonitorRequested: Effect.sync(() => inputMonitorRequested),
    stop: Effect.suspend(() => stopNow().await),
    suspend: Effect.suspend(() => {
      suspended = true;
      return stopNow().await;
    }),
    resume: Effect.sync(() => {
      if (!closed) suspended = false;
    }),
    pauseDesktop: (reason) =>
      Effect.gen(function* () {
        desktopPauses.add(reason);
        desktopInterruptionCount += 1;
        desktopObservationRequired = true;
        browserObservationRequired = true;
        const task = stopNow();
        yield* log(`desktop input paused (${reason}); requiring fresh desktop observation`);
        yield* task.await;
      }),
    resumeDesktop: (reason) =>
      Effect.suspend(() =>
        desktopPauses.delete(reason)
          ? log(`desktop pause "${reason}" lifted; ${desktopPauses.size} pause(s) remain`)
          : Effect.void,
      ),
    emergencyStopInput: Effect.suspend(() => {
      if (closed) return Effect.succeed(false);
      if (generation === undefined && starting === undefined) return Effect.succeed(false);
      desktopObservationRequired = true;
      browserObservationRequired = true;
      inputInterruptCooldownUntil = now() + ESCAPE_INPUT_COOLDOWN_MS;
      detach(interruptInputNow().await, "emergency input interrupt failed");
      return log("physical Escape: interrupting computer input").pipe(Effect.as(true));
    }),
    physicalInput: (event) =>
      Effect.suspend(() => {
        // Background control shares the Mac with the human. Only a foreground
        // action in flight collides with physical input, so only that action
        // is interrupted; recovery keeps observing until quiet and fresh.
        if (closed || !generation || generation.retired) return Effect.succeed(false);
        if (!activeForegroundInput && !desktopObservationRequired && takeoverTargets.size === 0)
          return Effect.succeed(false);
        const affected = [...controlledTargets].filter(
          ([key]) => activeForegroundInput && key === activeInputTaskKey,
        );
        const alreadyPaused =
          desktopObservationRequired || browserObservationRequired || takeoverTargets.size > 0;
        const logged = alreadyPaused
          ? Effect.void
          : log(
              encodeJson({
                event: "computer_physical_input",
                ts: isoNow(),
                pid: safeNativeId(event.pid),
                windowId: safeNativeId(event.windowId),
                targets: affected.map(([, target]) => ({
                  thread: target.threadId,
                  pid: target.pid,
                  windowId: target.windowId,
                })),
                foreground: true,
              }),
            );
        for (const [key, target] of affected) takeoverTargets.set(key, { ...target });
        if (activeForegroundInput && affected.length === 0) {
          desktopObservationRequired = true;
          browserObservationRequired = true;
        }
        const affectedInputInFlight =
          activeForegroundInput &&
          [...inFlightInputInterrupts].some((input) => !input.signal.aborted);
        inputInterruptCooldownUntil = now() + ESCAPE_INPUT_COOLDOWN_MS;
        if (alreadyPaused && !affectedInputInFlight) {
          // Repeated typing keeps observations stale without one native
          // cancellation RPC per key. No new mutation can enter this gate.
          epoch += 1;
          desktopEpoch += 1;
          return logged.pipe(Effect.as(true));
        }
        detach(interruptInputNow().await, "human takeover interrupt failed");
        return logged.pipe(Effect.as(true));
      }),
    inputMonitorStateChanged: (state) =>
      Effect.sync(() => {
        if (
          state.ready ||
          state.error === "input_monitor_idle" ||
          state.error === "input_monitor_starting" ||
          closed ||
          !generation ||
          generation.retired
        )
          return;
        desktopObservationRequired = true;
        browserObservationRequired = true;
        inputMonitorEpochChanges += 1;
        detach(interruptInputNow().await, "input listener interruption failed");
      }),
    stopTaskByUser: (task) => Effect.asVoid(stopTaskInput(task)),
    setCursorStyle: (style) =>
      Effect.suspend(() => {
        const next = normalizeCuaCursorStyle(style);
        const nextJson = next ? encodeJson(next) : "";
        // Pushes only to a generation whose session is already open: a
        // settings change never spawns a driver, and a failure is logged.
        const apply = Effect.gen(function* () {
          const target = generation;
          if (!target || stopped(target) || !target.sessionOpening) return;
          yield* ignored(target.sessionOpening);
          if (
            closed ||
            stopped(target) ||
            target.appliedCursorStyle === nextJson ||
            observedNativeRevision === 0
          )
            return;
          const reply = yield* driverRequest<CuaReply>(
            target.socket,
            {
              method: "call",
              name: "set_agent_cursor_style",
              args: next ? { session: target.session, ...next } : { session: target.session },
            },
            { timeoutMs: 5_000 },
          ).pipe(Effect.result);
          if (reply._tag === "Failure")
            return yield* log(`live cursor style push failed: ${reply.failure.message}`);
          if (!reply.success.ok || reply.success.result?.isError)
            return yield* log("live cursor style push was refused; keeping the previous style");
          target.appliedCursorStyle = nextJson;
        });
        const previous = cursorStyleUpdates;
        const task = start(Effect.andThen(previous, apply));
        cursorStyleUpdates = ignored(task);
        return cursorStyleUpdates;
      }),
    dispose,
  };
  return host;
});
