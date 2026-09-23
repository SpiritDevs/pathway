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
