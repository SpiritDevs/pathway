import * as Schema from "effect/Schema";

import { EnvironmentId, PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  pathwayHome: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  /** Stable identity owned by the packaged desktop host, independent of backend userdata. */
  desktopEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** Electron parent PID. The backend exits if force-quit leaves it orphaned. */
  desktopParentPid: Schema.optionalKey(PositiveInt),
  /** The native desktop has already hydrated the environment inherited by this child. */
  shellEnvironmentHydrated: Schema.optionalKey(Schema.Boolean),
  /** Receives one refreshed, allow-listed shell environment from the desktop host. */
  shellEnvironmentFd: Schema.optionalKey(PositiveInt),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * Authenticates the backend to the desktop Computer host listening at
   * `PATHWAY_CUA_HOST_SOCKET`. It travels in the bootstrap envelope, never argv or env.
   */
  cuaHostCapability: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Only shell-discovered values may cross the environment handoff pipe. */
export const DesktopShellEnvironmentPatch = Schema.Struct({
  PATH: Schema.optionalKey(Schema.String),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.String),
  DISPLAY: Schema.optionalKey(Schema.String),
  LANG: Schema.optionalKey(Schema.String),
  LC_ALL: Schema.optionalKey(Schema.String),
  LC_CTYPE: Schema.optionalKey(Schema.String),
  SSH_AUTH_SOCK: Schema.optionalKey(Schema.String),
  HOMEBREW_PREFIX: Schema.optionalKey(Schema.String),
  HOMEBREW_CELLAR: Schema.optionalKey(Schema.String),
  HOMEBREW_REPOSITORY: Schema.optionalKey(Schema.String),
  XDG_CONFIG_HOME: Schema.optionalKey(Schema.String),
  XDG_CURRENT_DESKTOP: Schema.optionalKey(Schema.String),
  XDG_DATA_HOME: Schema.optionalKey(Schema.String),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.String),
  XDG_SESSION_DESKTOP: Schema.optionalKey(Schema.String),
  XDG_SESSION_TYPE: Schema.optionalKey(Schema.String),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.String),
  FNM_DIR: Schema.optionalKey(Schema.String),
  FNM_MULTISHELL_PATH: Schema.optionalKey(Schema.String),
});
export type DesktopShellEnvironmentPatch = typeof DesktopShellEnvironmentPatch.Type;
