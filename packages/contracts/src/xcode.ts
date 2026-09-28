/** Environment-owned Xcode jobs. All paths refer to the host, never the watching client. */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { AppleEnvironmentAccountInput, AppleError } from "./apple.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const XcodePlatform = Schema.Literals(["iOS", "watchOS", "tvOS"]);
export type XcodePlatform = typeof XcodePlatform.Type;
export const XcodeFailure = Schema.Struct({
  code: Schema.Literals([
    "needs-mac",
    "busy",
    "not-found",
    "disk-space",
    "reauth-required",
    "admin-required",
    "cancelled",
    "interrupted",
    "process-failed",
    "download-failed",
    "invalid-response",
    "storage-failed",
  ]),
  message: Schema.String,
});
export type XcodeFailure = typeof XcodeFailure.Type;
export class XcodeError extends Schema.TaggedErrorClass<XcodeError>()(
  "XcodeError",
  XcodeFailure.fields,
) {}
export const InstalledXcode = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
  build: Schema.String,
  beta: Schema.Boolean,
  selected: Schema.Boolean,
});
export type InstalledXcode = typeof InstalledXcode.Type;
export const AvailableXcode = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  build: Schema.String,
  beta: Schema.Boolean,
  downloadBytes: Schema.NullOr(Schema.Number),
  requiredBytes: Schema.Number,
});
export type AvailableXcode = typeof AvailableXcode.Type;
export const XcodeRuntime = Schema.Struct({
  id: Schema.String,
  platform: XcodePlatform,
  version: Schema.String,
  build: Schema.NullOr(Schema.String),
  installed: Schema.Boolean,
  available: Schema.Boolean,
  downloadBytes: Schema.NullOr(Schema.Number),
});
export type XcodeRuntime = typeof XcodeRuntime.Type;
export const XcodeStepId = Schema.Literals([
  "check",
  "download",
  "expand",
  "move",
  "license",
  "select",
  "first-launch",
  "runtimes",
  "helpers",
]);
export type XcodeStepId = typeof XcodeStepId.Type;
export const XcodeStep = Schema.Struct({
  id: XcodeStepId,
  state: Schema.Literals([
    "pending",
    "running",
    "needs-admin",
    "completed",
    "skipped",
    "failed",
    "cancelled",
  ]),
  error: Schema.NullOr(XcodeFailure),
  progress: Schema.NullOr(
    Schema.Struct({
      bytes: Schema.Number,
      total: Schema.NullOr(Schema.Number),
      bytesPerSecond: Schema.Number,
    }),
  ),
});
export type XcodeStep = typeof XcodeStep.Type;
export const XcodeJob = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["install", "select", "runtimes"]),
  account: AppleEnvironmentAccountInput,
  versionId: Schema.NullOr(Schema.String),
  path: Schema.String,
  platforms: Schema.Array(XcodePlatform),
  state: Schema.Literals([
    "running",
    "needs-admin",
    "needs-reauth",
    "interrupted",
    "failed",
    "cancelling",
    "cancelled",
    "completed",
  ]),
  steps: Schema.Array(XcodeStep),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type XcodeJob = typeof XcodeJob.Type;
export const XcodeStatus = Schema.Struct({
  host: Schema.Literals(["mac", "needs-mac"]),
  installed: Schema.Array(InstalledXcode),
  available: Schema.Array(AvailableXcode),
  runtimes: Schema.Array(XcodeRuntime),
  disk: Schema.Struct({ freeBytes: Schema.NullOr(Schema.Number), requiredBytes: Schema.Number }),
  job: Schema.NullOr(XcodeJob),
  error: Schema.NullOr(XcodeFailure),
});
export type XcodeStatus = typeof XcodeStatus.Type;
/** Inventory is sent initially and after completion, not alongside each download tick. */
export const XcodeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status"), status: XcodeStatus }),
  Schema.Struct({ kind: Schema.Literal("job"), job: Schema.NullOr(XcodeJob) }),
]);
export type XcodeUpdate = typeof XcodeUpdate.Type;
export const XcodeInstallInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  versionId: TrimmedNonEmptyString,
  platforms: Schema.Array(XcodePlatform),
});
export const XcodeJobInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  jobId: Schema.String,
});
export const XcodeSelectInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  path: TrimmedNonEmptyString,
});
export const XcodeRuntimesInput = Schema.Struct({
  ...XcodeSelectInput.fields,
  platforms: Schema.Array(XcodePlatform),
});
export const XCODE_WS_METHODS = {
  status: "xcode.status",
  subscribe: "xcode.subscribe",
  install: "xcode.install",
  cancel: "xcode.cancel",
  retry: "xcode.retry",
  select: "xcode.select",
  installRuntimes: "xcode.installRuntimes",
  approve: "xcode.approve",
} as const;
const error = Schema.Union([XcodeError, AppleError, EnvironmentAuthorizationError]);
export const XcodeRpcs = RpcGroup.make(
  Rpc.make(XCODE_WS_METHODS.status, {
    payload: AppleEnvironmentAccountInput,
    success: XcodeStatus,
    error,
  }),
  Rpc.make(XCODE_WS_METHODS.subscribe, {
    payload: AppleEnvironmentAccountInput,
    success: XcodeUpdate,
    error,
    stream: true,
  }),
  Rpc.make(XCODE_WS_METHODS.install, { payload: XcodeInstallInput, success: XcodeJob, error }),
  Rpc.make(XCODE_WS_METHODS.cancel, { payload: XcodeJobInput, success: XcodeJob, error }),
  Rpc.make(XCODE_WS_METHODS.retry, { payload: XcodeJobInput, success: XcodeJob, error }),
  Rpc.make(XCODE_WS_METHODS.approve, { payload: XcodeJobInput, success: XcodeJob, error }),
  Rpc.make(XCODE_WS_METHODS.select, { payload: XcodeSelectInput, success: XcodeJob, error }),
  Rpc.make(XCODE_WS_METHODS.installRuntimes, {
    payload: XcodeRuntimesInput,
    success: XcodeJob,
    error,
  }),
);
