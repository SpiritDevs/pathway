import type { GlobalShortcut } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";

import type { ComputerInputMonitorState, LinuxEscapeError } from "./EscapeKillSwitchMonitor.ts";

export type LinuxEscapeSession = "x11" | "wayland" | "unknown";
/** Electron's global shortcuts. `isSuspended` arrives in Electron 43; older builds cannot suspend. */
export type LinuxShortcutRegistry = Pick<
  GlobalShortcut,
  "register" | "unregister" | "isRegistered"
> & {
  readonly isSuspended?: () => boolean;
};

/** Inspects the existing desktop configuration without changing its display backend. */
export function linuxEscapeSession(
  ozonePlatform: string,
  environment: Readonly<Record<string, string | undefined>>,
): LinuxEscapeSession {
  const platform = ozonePlatform.trim().toLowerCase();
  const session = environment.XDG_SESSION_TYPE?.trim().toLowerCase();
  // An XWayland key grab cannot cover applications outside that X server.
  if (platform === "wayland" || session === "wayland" || environment.WAYLAND_DISPLAY?.trim())
    return "wayland";
  if (!environment.DISPLAY?.trim()) return "unknown";
  if (platform && platform !== "x11" && platform !== "auto") return "unknown";
  if (session && session !== "x11") return "unknown";
  return platform === "x11" || session === "x11" ? "x11" : "unknown";
}

export interface LinuxEscapeKillSwitchMonitorOptions {
  readonly shortcutRegistry: LinuxShortcutRegistry;
  readonly sessionType: LinuxEscapeSession;
  /** Runs for every Escape the armed, verified registration delivers. */
  readonly onEscape: () => Effect.Effect<void>;
  readonly onStateChange?: (state: ComputerInputMonitorState) => Effect.Effect<void>;
  readonly onError?: (message: string) => Effect.Effect<void>;
}

export interface LinuxEscapeKillSwitchMonitor {
  /** Re-checks a ready registration, so a suspended or lost key closes admission. */
  readonly state: Effect.Effect<ComputerInputMonitorState>;
  readonly activate: Effect.Effect<void>;
  readonly setArmed: (armed: boolean) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

/**
 * A task-scoped X11 Escape shortcut for the packaged Linux app. Unlike the
 * macOS event tap, this consumes Escape and does not observe physical input or
 * human takeover. The host owns task attribution, arming and the native stop.
 *
 * Electron's portal registration reports a local callback, not a successful
 * compositor binding, and single-shortcut unregister does not clear that map.
 * Do not claim a working kill switch or reserve a persistent key on Wayland.
 * Closing the caller's scope disposes the monitor.
 */
export const make = Effect.fn("desktop.computer.LinuxEscapeKillSwitchMonitor.make")(function* (
  options: LinuxEscapeKillSwitchMonitorOptions,
) {
  // Shortcut callbacks arrive from Electron; sync handlers run inline.
  const runFork = yield* FiberSet.makeRuntime();
  const registry = options.shortcutRegistry;
  let armed = false;
  let registered = false;
  let disposed = false;
  let registration = 0;
  let current: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };

  const setState = (next: ComputerInputMonitorState) =>
    Effect.suspend(() => {
      if (current.ready === next.ready && current.error === next.error) return Effect.void;
      current = next;
      return options.onStateChange?.(next) ?? Effect.void;
    });

  const unavailable = (error: LinuxEscapeError, message: string) =>
    Effect.suspend(() => {
      if (current.error === error) return Effect.void;
      return setState({ ready: false, error }).pipe(
        // Diagnostics must never take the monitor down.
        Effect.andThen(options.onError ? Effect.ignore(options.onError(message)) : Effect.void),
      );
    });

  /** Runs one registry call; Electron throws before the app is ready. */
  const attempt = <A>(call: () => A) => Effect.option(Effect.try(call));

  const state = Effect.gen(function* () {
    if (!current.ready) return current;
    const check = yield* attempt(() =>
      registry.isSuspended?.() === true
        ? "suspended"
        : registry.isRegistered("Escape")
          ? "held"
          : "lost",
    );
    if (check._tag === "None")
      yield* unavailable("linux_escape_registration_failed", "Cannot check the Escape shortcut.");
    else if (check.value === "suspended")
      yield* unavailable("linux_escape_shortcut_suspended", "The Escape shortcut is suspended.");
    else if (check.value === "lost") {
      registered = false;
      yield* unavailable("linux_escape_shortcut_lost", "The Escape shortcut was unregistered.");
    }
    return current;
  });

  /** Releases only the key this monitor owns; false keeps ownership for a retry. */
  const release = Effect.gen(function* () {
    if (!registered) return true;
    const released = yield* attempt(() => {
      registry.unregister("Escape");
      return !registry.isRegistered("Escape");
    });
    if (released._tag === "Some" && released.value) {
      registered = false;
      return true;
    }
    yield* unavailable("linux_escape_release_failed", "The Escape shortcut could not be released.");
    return false;
  });

  const onShortcut = (owner: number) =>
    Effect.gen(function* () {
      if (disposed || !armed || !registered || owner !== registration) return;
      if ((yield* state).ready) yield* options.onEscape();
    });

  const setArmed = (next: boolean) =>
    Effect.gen(function* () {
      if (disposed) return;
      armed = next;
      if (!next) {
        registration += 1;
        if (yield* release) yield* setState({ ready: false, error: "input_monitor_idle" });
        return;
      }
      if (options.sessionType !== "x11") {
        yield* unavailable(
          options.sessionType === "wayland"
            ? "linux_escape_portal_unverified"
            : "linux_escape_session_unavailable",
          "A global Escape stop cannot be confirmed for this Linux desktop session. " +
            "Computer browser actions remain unavailable; observation is still allowed.",
        );
        return;
      }
      if (registered && (yield* state).ready) return;
      // After suspension or loss, obtain a fresh OS registration. Electron's
      // local registration map alone cannot prove it resumed the key grab.
      if (!(yield* release)) return;
      const blocker = yield* attempt(() =>
        registry.isSuspended?.() === true
          ? "suspended"
          : registry.isRegistered("Escape")
            ? "conflict"
            : null,
      );
      if (blocker._tag === "Some" && blocker.value === "suspended")
        return yield* unavailable(
          "linux_escape_shortcut_suspended",
          "The Escape shortcut is suspended.",
        );
      if (blocker._tag === "Some" && blocker.value === "conflict")
        return yield* unavailable(
          "linux_escape_shortcut_conflict",
          "Escape is already reserved by another feature. Computer browser actions remain unavailable.",
        );
      const owner = ++registration;
      const granted =
        blocker._tag === "None"
          ? blocker
          : yield* attempt(() =>
              registry.register("Escape", () => {
                runFork(onShortcut(owner));
              }),
            );
      if (granted._tag === "None")
        return yield* unavailable(
          "linux_escape_registration_failed",
          "The desktop could not register the Escape shortcut.",
        );
      registered = granted.value;
      if (!registered)
        return yield* unavailable(
          "linux_escape_registration_failed",
          "The desktop could not reserve Escape. Computer browser actions remain unavailable.",
        );
      yield* setState({ ready: true });
    });

  const dispose = Effect.gen(function* () {
    disposed = true;
    armed = false;
    registration += 1;
    if (yield* release) yield* setState({ ready: false, error: "input_monitor_stopped" });
  });
  yield* Effect.addFinalizer(() => dispose);

  return {
    state,
    activate: setArmed(true),
    setArmed,
    dispose,
  } satisfies LinuxEscapeKillSwitchMonitor;
});
