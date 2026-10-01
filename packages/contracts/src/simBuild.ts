/** Simulator builds belong to an environment and a thread's current project checkout. */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DeviceHostId, DeviceId } from "./device.ts";

export const SimBuildFailure = Schema.Struct({
  code: Schema.Literals([
    "needs-mac",
    "not-found",
    "invalid-project",
    "invalid-destination",
    "busy",
    "process-failed",
    "cancelled",
    "interrupted",
    "storage-failed",
    "unavailable",
  ]),
  message: Schema.String,
});
export type SimBuildFailure = typeof SimBuildFailure.Type;
export class SimBuildError extends Schema.TaggedErrorClass<SimBuildError>()(
  "SimBuildError",
  SimBuildFailure.fields,
) {}

export const SimBuildContext = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type SimBuildContext = typeof SimBuildContext.Type;
const Name = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  // eslint-disable-next-line no-control-regex -- Reject NUL and newlines in Xcode arguments.
  Schema.isPattern(/^[^-\r\n\0][^\r\n\0]*$/),
);
export const SimBuildContainer = Schema.Struct({
  /** Relative to workspaceRoot, including ios/ for Expo and React Native. */
  path: Schema.String,
  kind: Schema.Literals(["project", "workspace"]),
  schemes: Schema.Array(Schema.String),
  targets: Schema.Array(Schema.String),
  configurations: Schema.Array(Schema.String),
});
export type SimBuildContainer = typeof SimBuildContainer.Type;
export const SimBuildDiscovery = Schema.Struct({
  ...SimBuildContext.fields,
  workspaceRoot: Schema.String,
  framework: Schema.Literals(["xcode", "react-native", "expo"]),
  developerDir: Schema.String,
  containers: Schema.Array(SimBuildContainer),
  /** For example, Expo prebuild or CocoaPods preparation required before building. */
  notices: Schema.Array(Schema.String),
});
export type SimBuildDiscovery = typeof SimBuildDiscovery.Type;
export const SimBuildAction = Schema.Literals(["build", "run", "test"]);
export type SimBuildAction = typeof SimBuildAction.Type;
export const SimBuildOptions = Schema.Struct({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  containerPath: Name,
  scheme: Name,
  /** Optional application target when a scheme produces multiple .app bundles. */
  target: Schema.optional(Name),
  /** Defaults to Debug for Xcode, Release for RN/Expo so JavaScript is bundled. */
  configuration: Schema.optional(Name),
});
export type SimBuildOptions = typeof SimBuildOptions.Type;
export const SimBuildStartInput = Schema.Struct({
  ...SimBuildContext.fields,
  ...SimBuildOptions.fields,
  action: SimBuildAction,
  /** Reuse on transport retries; reusing it with different options is rejected. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type SimBuildStartInput = typeof SimBuildStartInput.Type;
export const SimBuildJobInput = Schema.Struct({ ...SimBuildContext.fields, jobId: Schema.String });
export type SimBuildJobInput = typeof SimBuildJobInput.Type;
export const SimBuildPhase = Schema.Literals([
  "resolving",
  "building",
  "installing",
  "launching",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SimBuildPhase = typeof SimBuildPhase.Type;
export const SimBuildArtifact = Schema.Struct({
  appPath: Schema.String,
  bundleId: Schema.String,
  target: Schema.String,
});
export const SimBuildJob = Schema.Struct({
  ...SimBuildStartInput.fields,
  id: Schema.String,
  workspaceRoot: Schema.String,
  developerDir: Schema.NullOr(Schema.String),
  phase: SimBuildPhase,
  /** running means launch succeeded, not continuous app-liveness monitoring. */
  terminal: Schema.Boolean,
  artifact: Schema.NullOr(SimBuildArtifact),
  failure: Schema.NullOr(SimBuildFailure),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type SimBuildJob = typeof SimBuildJob.Type;
/** Durable phase event, published only after persistence. Sequence is per job, starting at 1. */
export const SimBuildReceipt = Schema.Struct({
  sequence: NonNegativeInt,
  kind: Schema.Literal("phase"),
  job: SimBuildJob,
});
export type SimBuildReceipt = typeof SimBuildReceipt.Type;
export const SimBuildDiagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  /** Absolute environment path, never a client-local path. Null for non-file diagnostics. */
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(NonNegativeInt),
  column: Schema.NullOr(NonNegativeInt),
});
export type SimBuildDiagnostic = typeof SimBuildDiagnostic.Type;
export const SIM_BUILD_LOG_CHUNK_CHARS = 16_384;
export const SIM_BUILD_LOG_WINDOW_CHARS = 65_536;
export const SimBuildLogChunk = Schema.Struct({
  sequence: NonNegativeInt,
  text: Schema.String.check(Schema.isMaxLength(SIM_BUILD_LOG_CHUNK_CHARS)),
  diagnostics: Schema.Array(SimBuildDiagnostic),
});
export type SimBuildLogChunk = typeof SimBuildLogChunk.Type;
/** Initial/reconnect snapshot, then cursor deltas. A slow client skips old logs, never phase receipts. */
export const SimBuildUpdate = Schema.Struct({
  kind: Schema.Literals(["snapshot", "update"]),
  job: SimBuildJob,
  receipts: Schema.Array(SimBuildReceipt),
  logs: Schema.Array(SimBuildLogChunk),
  /** Oldest retained log sequence. A gap against the client's cursor means truncation. */
  firstLogSequence: NonNegativeInt,
  nextLogSequence: NonNegativeInt,
});
export type SimBuildUpdate = typeof SimBuildUpdate.Type;
export const SIM_BUILD_WS_METHODS = {
  discover: "simBuild.discover",
  start: "simBuild.start",
  list: "simBuild.list",
  get: "simBuild.get",
  cancel: "simBuild.cancel",
  subscribe: "simBuild.subscribe",
} as const;
const error = Schema.Union([SimBuildError, EnvironmentAuthorizationError]);
export const SimBuildRpcs = RpcGroup.make(
  Rpc.make(SIM_BUILD_WS_METHODS.discover, {
    payload: SimBuildContext,
    success: SimBuildDiscovery,
    error,
  }),
  Rpc.make(SIM_BUILD_WS_METHODS.start, {
    payload: SimBuildStartInput,
    success: SimBuildJob,
    error,
  }),
  Rpc.make(SIM_BUILD_WS_METHODS.list, {
    payload: SimBuildContext,
    success: Schema.Array(SimBuildJob),
    error,
  }),
  Rpc.make(SIM_BUILD_WS_METHODS.get, { payload: SimBuildJobInput, success: SimBuildUpdate, error }),
  Rpc.make(SIM_BUILD_WS_METHODS.cancel, { payload: SimBuildJobInput, success: SimBuildJob, error }),
  Rpc.make(SIM_BUILD_WS_METHODS.subscribe, {
    payload: SimBuildJobInput,
    success: SimBuildUpdate,
    error,
    stream: true,
  }),
);
