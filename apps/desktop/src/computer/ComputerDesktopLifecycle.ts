import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";

/** Why the desktop is unavailable. Each reason is an independent gate. */
export type ComputerDesktopPauseReason = "screen-lock" | "system-sleep" | "user-session";

export type ComputerDesktopLifecycleEvent =
  | "lock-screen"
  | "unlock-screen"
  | "suspend"
  | "resume"
  | "user-did-resign-active"
  | "user-did-become-active";

/**
 * The slice of Electron's power monitor this module reads, shaped like
 * `ElectronPowerMonitor` so that service can back it directly.
 */
export interface ComputerDesktopPowerMonitor {
  readonly getSystemIdleState: (idleThresholdSeconds: number) => Effect.Effect<string>;
  readonly onSimpleEvent: (
    eventName: ComputerDesktopLifecycleEvent,
    listener: () => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export interface ComputerDesktopLifecycleHost<E> {
  /** Fails when native cleanup was not acknowledged; the failure goes to `onError`. */
  readonly pauseDesktop: (reason: ComputerDesktopPauseReason) => Effect.Effect<void, E>;
  readonly resumeDesktop: (reason: ComputerDesktopPauseReason) => Effect.Effect<void>;
}

export interface ComputerDesktopLifecycleOptions<E> {
  readonly monitor: ComputerDesktopPowerMonitor;
  readonly host: ComputerDesktopLifecycleHost<E>;
  readonly onError: (error: E) => Effect.Effect<void>;
}

const GATES = [
  ["lock-screen", "unlock-screen", "screen-lock"],
  ["suspend", "resume", "system-sleep"],
  ["user-did-resign-active", "user-did-become-active", "user-session"],
] as const;

/**
 * Translates OS desktop availability into independent, composable input
 * gates: each pause reason is lifted only by its own resume event. The
 * listeners stay registered until the caller's scope closes.
 */
export const make = Effect.fn("desktop.computer.ComputerDesktopLifecycle.make")(function* <E>(
  options: ComputerDesktopLifecycleOptions<E>,
) {
  const { monitor, host, onError } = options;
  // Power events arrive on Electron callbacks; their work runs on fibers
  // owned by the caller's scope.
  const runFork = yield* FiberSet.makeRuntime<never>();
  const pause = (reason: ComputerDesktopPauseReason) =>
    host.pauseDesktop(reason).pipe(Effect.catch(onError));

  for (const [pauseEvent, resumeEvent, reason] of GATES) {
    yield* monitor.onSimpleEvent(pauseEvent, () => {
      runFork(pause(reason));
    });
    yield* monitor.onSimpleEvent(resumeEvent, () => {
      runFork(host.resumeDesktop(reason));
    });
  }
  // Events alone miss an app launched while the screen is already locked.
  if ((yield* monitor.getSystemIdleState(1)) === "locked") runFork(pause("screen-lock"));
});
