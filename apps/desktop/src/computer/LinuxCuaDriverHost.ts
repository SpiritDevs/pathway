import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";

import { type CuaCursorStyle, makeCuaDriverHost } from "./CuaDriverHost.ts";
import { linuxCuaAdmission } from "./LinuxCuaAdmission.ts";
import type { LinuxEscapeKillSwitchMonitor } from "./LinuxEscapeKillSwitchMonitor.ts";

export const LINUX_SESSION_GUIDANCE =
  "Start Pathway inside your Linux desktop session with its display and accessibility " +
  "bus available. Screen capture and input depend on the X11 or Wayland compositor; " +
  "the macOS permission guide does not apply. If the driver is missing, reinstall " +
  "the Linux package or run `node scripts/provision-cua-driver.ts --platform linux`.";

export interface LinuxCuaDriverHostOptions {
  readonly binaryPath: string;
  readonly bundleId: string;
  readonly capability: string;
  readonly ownPids: () => ReadonlySet<number>;
  readonly hostEndpoint?: string;
  readonly cursorStyle?: () => CuaCursorStyle | null | undefined;
  /** The task-scoped Escape shortcut; without it browser mutations stay closed. */
  readonly inputMonitor?: Pick<LinuxEscapeKillSwitchMonitor, "state" | "activate" | "setArmed">;
}

/**
 * The Cua host on Linux. There is no pathway-helper: browser safety
 * capabilities come from the live driver handshake, the Linux admission rules
 * close unproven native routes, and permission setup is session guidance.
 */
export const makeLinuxCuaDriverHost = Effect.fn("desktop.computer.makeLinuxCuaDriverHost")(
  function* (options: LinuxCuaDriverHostOptions) {
    const monitor = options.inputMonitor;
    // The host reports arming synchronously; the shortcut registration is sync too.
    const runFork = yield* FiberSet.makeRuntime();
    return yield* makeCuaDriverHost({
      binaryPath: options.binaryPath,
      bundleId: options.bundleId,
      capability: options.capability,
      ownPids: options.ownPids,
      nativeRevision: null,
      linuxAdmission: linuxCuaAdmission,
      inputMonitorState:
        monitor?.state ??
        Effect.succeed({ ready: false, error: "linux_global_escape_unavailable" }),
      ...(monitor ? { activateInputMonitor: monitor.activate } : {}),
      ...(monitor
        ? {
            onInputMonitorArmedChange: (armed: boolean) => {
              runFork(monitor.setArmed(armed));
            },
          }
        : {}),
      ...(options.hostEndpoint ? { hostEndpoint: options.hostEndpoint } : {}),
      ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
      setup: Effect.fail({ message: LINUX_SESSION_GUIDANCE }),
    });
  },
);
