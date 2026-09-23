import type {
  DesktopAgentCursorStyle,
  DesktopComputerHelperState,
  DesktopComputerPermissionKind,
  DesktopComputerSettingsPane,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** What the primary backend needs to reach the desktop Computer host. */
export interface DesktopComputerHandoff {
  readonly endpoint: string;
  readonly capability: string;
}

export interface DesktopComputerService {
  /** Present only while a host is listening. */
  readonly handoff: Option.Option<DesktopComputerHandoff>;
  /** The backend is stopping: reject new work and retire the driver. */
  readonly suspend: Effect.Effect<void>;
  /** A backend is starting against this host again. */
  readonly resume: Effect.Effect<void>;
  /**
   * Sets the backend notice forked after each physical Escape that stopped
   * local input. Set late: the notice needs the backend pool, which is built
   * on top of this service.
   */
  readonly setEmergencyStopNotice: (notice: Effect.Effect<void>) => Effect.Effect<void>;
  // The renderer's `DesktopBridge.computer`, served over IPC.
  /** Reads grants without prompting; `permissions` also asks about Accessibility. */
  readonly getState: (
    permissions?: ReadonlyArray<DesktopComputerPermissionKind>,
  ) => Effect.Effect<DesktopComputerHelperState>;
  /** Raises the macOS prompts for these grants. */
  readonly requestPermissions: (
    permissions?: ReadonlyArray<DesktopComputerPermissionKind>,
  ) => Effect.Effect<DesktopComputerHelperState>;
  /** Walks the floating guide through each pane still missing a grant. */
  readonly startPermissionSetup: (
    permissions: ReadonlyArray<DesktopComputerPermissionKind>,
  ) => Effect.Effect<DesktopComputerHelperState>;
  /** Opens System Settings at a privacy pane; false when it could not. */
  readonly openPermissionSettings: (pane: DesktopComputerSettingsPane) => Effect.Effect<boolean>;
  readonly showPermissionGuide: (pane: DesktopComputerSettingsPane) => Effect.Effect<void>;
  readonly hidePermissionGuide: Effect.Effect<void>;
  /**
   * Makes a normalized agent cursor style current for later driver sessions
   * and live-pushes it to an open one. Persisting it is the caller's job.
   */
  readonly setCursorStyle: (style: DesktopAgentCursorStyle | null) => Effect.Effect<void>;
}

/** The helper state every inert host reports: no grants to check or set up. */
export const unsupportedComputerHelperState = (
  message: string,
  appDisplayName: string,
): DesktopComputerHelperState => ({
  supported: false,
  status: "unsupported",
  message,
  appDisplayName,
  screenRecordingPermission: "unknown",
  inputMonitoringPermission: "unknown",
});

/** No host: backends start exactly as they would without Computer, and the bridge reports `state`. */
export const makeInertDesktopComputer = (
  state: DesktopComputerHelperState,
): DesktopComputerService => ({
  handoff: Option.none(),
  suspend: Effect.void,
  resume: Effect.void,
  setEmergencyStopNotice: () => Effect.void,
  getState: () => Effect.succeed(state),
  requestPermissions: () => Effect.succeed(state),
  startPermissionSetup: () => Effect.succeed(state),
  openPermissionSettings: () => Effect.succeed(false),
  showPermissionGuide: () => Effect.void,
  hidePermissionGuide: Effect.void,
  setCursorStyle: () => Effect.void,
});

export const inertDesktopComputer: DesktopComputerService = makeInertDesktopComputer(
  unsupportedComputerHelperState("Computer use is not available in this desktop app.", "Pathway"),
);

/**
 * The desktop Computer host as the backend lifecycle and the renderer bridge
 * see it. Inert unless `DesktopComputerHost.layer` provides a live host.
 */
export const DesktopComputer = Context.Reference<DesktopComputerService>(
  "@spiritdevs/desktop/computer/DesktopComputer",
  { defaultValue: () => inertDesktopComputer },
);
