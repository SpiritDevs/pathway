import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { type HelperExit, type HelperProcess, spawnHelper } from "./HelperProcess.ts";
import {
  PathwayHelperMode,
  type PathwayHelperMessage,
  parsePathwayHelperMessage,
} from "./PathwayHelperProtocol.ts";

const RESPAWN_BASE_DELAY_MS = 1_000;
const RESPAWN_MAX_DELAY_MS = 30_000;
const READINESS_WAIT_MS = 1_000;

export type PhysicalComputerInput = Extract<PathwayHelperMessage, { type: "physical-input" }>;

/** Why native input admission is closed. The helper's own codes pass through. */
export type ComputerInputMonitorError =
  | "input_monitor_starting"
  | "input_monitor_idle"
  | "input_monitor_stopped"
  | "input_monitor_unavailable"
  | "input-monitoring-required"
  | "event_tap_disabled"
  | "event_tap_unavailable";

export interface ComputerInputMonitorState {
  readonly ready: boolean;
  readonly error?: ComputerInputMonitorError;
}

export interface EscapeKillSwitchMonitorOptions {
  readonly helperPath: string;
  /**
   * Runs for every physical, unmodified Escape the armed helper observed. The
   * callback owns all kill semantics; the monitor only transports the event.
   * Callbacks run on the helper's stdout reader, so keep them short.
   */
  readonly onEscape: () => Effect.Effect<void>;
  readonly onPhysicalInput?: (event: PhysicalComputerInput) => Effect.Effect<void>;
  readonly onStateChange?: (state: ComputerInputMonitorState) => Effect.Effect<void>;
  readonly onError?: (message: string) => Effect.Effect<void>;
}

export interface EscapeKillSwitchMonitor {
  readonly isRunning: Effect.Effect<boolean>;
  readonly state: Effect.Effect<ComputerInputMonitorState>;
  readonly start: Effect.Effect<void>;
  /**
   * Arms the monitor and waits up to 1s for the helper to report readiness or
   * a failure. `refreshGrantedAccess` replaces a listener that was denied
   * Input Monitoring, for use after a fresh permission probe saw the grant.
   */
  readonly activate: (refreshGrantedAccess?: boolean) => Effect.Effect<void>;
  readonly setArmed: (armed: boolean) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

const HELPER_ERROR_CODES: ReadonlySet<string> = new Set([
  "input-monitoring-required",
  "event_tap_disabled",
  "event_tap_unavailable",
]);

/** One spawned helper. `helper` is unset while the spawn is in flight. */
interface Generation {
  helper: HelperProcess | undefined;
}

/**
 * Owns the dedicated `--escape-monitor` helper. Its listen-only event tap
 * reports physical Escape presses without consuming them, and only while
 * armed, so `setArmed` is forwarded as `arm`/`disarm` stdin lines. An
 * unexpected exit is retried with exponential backoff while armed, and the
 * armed flag is replayed to every respawn. A missing grant, disabled tap or
 * dead helper closes readiness until the listener is healthy again.
 * Closing the caller's scope disposes the monitor.
 */
export const make = Effect.fn("desktop.computer.EscapeKillSwitchMonitor.make")(function* (
  options: EscapeKillSwitchMonitorOptions,
) {
  const scope = yield* Effect.scope;
  // Helpers and timers live in a child scope that closes after `dispose`, so
  // a helper killed during teardown never schedules a restart.
  const workScope = yield* Scope.fork(scope);
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

  let current: Generation | null = null;
  let disposed = false;
  let armed = false;
  let restartFiber: Fiber.Fiber<void> | null = null;
  let consecutiveFailures = 0;
  let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_starting" };
  const readinessWaiters = new Set<Deferred.Deferred<void>>();

  const reportError = (message: string) =>
    // Diagnostics must never take the monitor down.
    options.onError ? Effect.exit(options.onError(message)).pipe(Effect.asVoid) : Effect.void;

  const setState = (next: ComputerInputMonitorState) =>
    Effect.suspend(() => {
      if (state.ready === next.ready && state.error === next.error) return Effect.void;
      state = next;
      if (next.ready || next.error !== "input_monitor_starting") {
        for (const waiter of readinessWaiters) Deferred.doneUnsafe(waiter, Exit.void);
        readinessWaiters.clear();
      }
      return options.onStateChange?.(next) ?? Effect.void;
    });

  const writeCommand = (command: "arm" | "disarm") =>
    // A lost update is corrected on the next respawn, which replays `armed`.
    Effect.suspend(() => current?.helper?.writeLine(command) ?? Effect.void).pipe(Effect.asVoid);

  const clearRestart = Effect.suspend(() => {
    const fiber = restartFiber;
    restartFiber = null;
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });

  const scheduleRestart: Effect.Effect<void> = Effect.suspend(() => {
    if (disposed || !armed || restartFiber) return Effect.void;
    const delay = Math.min(RESPAWN_BASE_DELAY_MS * 2 ** consecutiveFailures, RESPAWN_MAX_DELAY_MS);
    consecutiveFailures += 1;
    return Effect.sleep(delay).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          restartFiber = null;
          if (disposed || !armed || current) return Effect.void;
          return spawnGeneration;
        }),
      ),
      Effect.forkIn(workScope),
      Effect.tap((fiber) =>
        Effect.sync(() => {
          restartFiber = fiber;
        }),
      ),
      Effect.asVoid,
    );
  });

  const handleMessage = (message: PathwayHelperMessage) =>
    Effect.suspend(() => {
      switch (message.type) {
        case "ready":
          if (!armed) return Effect.void;
          consecutiveFailures = 0;
          return setState({ ready: true });
        case "escape":
          return armed && state.ready ? options.onEscape() : Effect.void;
        case "physical-input":
          return armed && state.ready
            ? (options.onPhysicalInput?.(message) ?? Effect.void)
            : Effect.void;
        case "error":
          return setState({
            ready: false,
            error: HELPER_ERROR_CODES.has(message.code)
              ? (message.code as ComputerInputMonitorError)
              : "input_monitor_unavailable",
          }).pipe(Effect.andThen(reportError(message.message)));
        default:
          return Effect.void;
      }
    });

  const onExit = (generation: Generation, exit: HelperExit) =>
    Effect.gen(function* () {
      if (current !== generation) return;
      current = null;
      yield* setState({ ready: false, error: "input_monitor_unavailable" });
      const diagnostic = (yield* generation.helper?.stderr ?? Effect.succeed("")).trim();
      if (exit.code !== 0 && diagnostic.length > 0)
        yield* reportError(`Escape monitor helper: ${diagnostic}`);
      if (!disposed) yield* scheduleRestart;
    });

  const spawnGeneration: Effect.Effect<void> = Effect.gen(function* () {
    const generation: Generation = { helper: undefined };
    current = generation;
    yield* setState({ ready: false, error: "input_monitor_starting" });
    const spawned = yield* spawnHelper(workScope, {
      command: options.helperPath,
      args: [PathwayHelperMode.escapeMonitor],
      stdin: true,
      onStdoutLine: (line) =>
        Effect.suspend(() => {
          if (current !== generation || disposed) return Effect.void;
          const message = parsePathwayHelperMessage(line);
          return message ? handleMessage(message) : Effect.void;
        }),
      onExit: (exit) => onExit(generation, exit),
    }).pipe(Effect.provideContext(context), Effect.exit);
    if (Exit.isFailure(spawned)) {
      if (current !== generation) return;
      current = null;
      yield* setState({ ready: false, error: "input_monitor_unavailable" });
      yield* reportError("The Escape monitor helper could not start.");
      if (!disposed) yield* scheduleRestart;
      return;
    }
    generation.helper = spawned.value;
    // A dispose or replacement during the spawn leaves this helper orphaned.
    if (current !== generation) return yield* spawned.value.signal("SIGTERM");
    // A fresh helper starts disarmed; replay the armed side of the gate so a
    // respawn does not silently widen the window where Escape is inert.
    if (armed) yield* writeCommand("arm");
  });

  const start = Effect.suspend(() => {
    if (disposed || current) return Effect.void;
    return clearRestart.pipe(Effect.andThen(spawnGeneration));
  });

  const setArmed = (next: boolean) =>
    Effect.suspend(() => {
      const changed = armed !== next;
      armed = next;
      if (next && !current) return start;
      return Effect.gen(function* () {
        if (changed)
          yield* setState({
            ready: false,
            error: next ? "input_monitor_starting" : "input_monitor_idle",
          });
        if (next) return yield* writeCommand("arm");
        yield* writeCommand("disarm");
        yield* clearRestart;
      });
    });

  const activate = (refreshGrantedAccess = false) =>
    Effect.gen(function* () {
      // The short-lived permission helper may see a new TCC grant before this
      // listener's cached preflight does. Replace only that denied listener.
      if (refreshGrantedAccess && state.error === "input-monitoring-required") {
        const previous = current;
        current = null;
        yield* previous?.helper?.signal("SIGTERM") ?? Effect.void;
      }
      yield* setArmed(true);
      const waiter = yield* Effect.sync(() => {
        if (state.ready || state.error !== "input_monitor_starting") return undefined;
        const deferred = Deferred.makeUnsafe<void>();
        readinessWaiters.add(deferred);
        return deferred;
      });
      if (!waiter) return;
      yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(READINESS_WAIT_MS),
        Effect.ensuring(Effect.sync(() => readinessWaiters.delete(waiter))),
      );
    });

  const dispose = Effect.gen(function* () {
    disposed = true;
    yield* setState({ ready: false, error: "input_monitor_stopped" });
    yield* clearRestart;
    const previous = current;
    current = null;
    // Best effort; the helper also exits once its parent or stdin is gone.
    yield* previous?.helper?.signal("SIGTERM") ?? Effect.void;
  });

  yield* Scope.addFinalizer(scope, dispose);

  const monitor: EscapeKillSwitchMonitor = {
    isRunning: Effect.sync(() => current !== null),
    state: Effect.sync(() => state),
    start,
    activate,
    setArmed,
    dispose,
  };
  return monitor;
});
