import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { AppleAppInput, AppleBuild, AppleBetaGroup, AppleError } from "./apple.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ReleaseTarget = AppleAppInput;
export type ReleaseTarget = typeof ReleaseTarget.Type;
export const ReleasePlatform = Schema.Literals(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
export const ReleaseFailure = Schema.Struct({
  code: Schema.Literals([
    "needs-mac",
    "busy",
    "invalid-input",
    "archive-failed",
    "signing-configuration",
    "artifact-changed",
    "not-found",
    "publishing-disabled",
    "confirmation-required",
    "stale-lease",
    "cancelled",
    "interrupted",
    "storage-failed",
    "operation-failed",
  ]),
  message: Schema.String,
});
export class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()(
  "ReleaseError",
  ReleaseFailure.fields,
) {}
export const ReleaseArchiveInput = Schema.Struct({
  ...ReleaseTarget.fields,
  projectPath: TrimmedNonEmptyString,
  scheme: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  platform: ReleasePlatform,
});
export type ReleaseArchiveInput = typeof ReleaseArchiveInput.Type;
export const LocalReleaseArchive = Schema.Struct({
  id: Schema.String,
  target: ReleaseTarget,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  projectPath: Schema.String,
  scheme: Schema.String,
  bundleId: Schema.String,
  version: Schema.String,
  buildNumber: Schema.String,
  platform: ReleasePlatform,
  archivePath: Schema.String,
  artifactPath: Schema.String,
  artifactSha256: Schema.String,
  artifactBytes: Schema.Number,
  createdAt: Schema.Number,
});
export type LocalReleaseArchive = typeof LocalReleaseArchive.Type;
/** Immutable payload shown by the client before Cloud confirmation. No arbitrary HTTP or paths. */
export const ReleaseAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upload"),
    archiveId: Schema.String,
    artifactSha256: Schema.String,
    version: Schema.String,
    buildNumber: Schema.String,
    platform: ReleasePlatform,
  }),
  Schema.Struct({
    kind: Schema.Literal("testflight"),
    buildId: Schema.String,
    groupIds: Schema.Array(Schema.String),
    locale: Schema.String,
    whatsNew: Schema.String,
    submitForReview: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("app-store"),
    buildId: Schema.String,
    versionId: Schema.String,
  }),
]);
export type ReleaseAction = typeof ReleaseAction.Type;
export const ReleaseIntent = Schema.Struct({
  id: Schema.String,
  target: ReleaseTarget,
  environmentId: Schema.String,
  action: ReleaseAction,
  state: Schema.Literals(["pending", "approved", "consumed", "cancelled"]),
  expiresAt: Schema.Number,
});
export type ReleaseIntent = typeof ReleaseIntent.Type;
export const ReleaseJob = Schema.Struct({
  id: Schema.String,
  target: ReleaseTarget,
  kind: Schema.Literals(["archive", "upload", "testflight", "app-store"]),
  state: Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"]),
  phase: Schema.String,
  progress: Schema.NullOr(Schema.Struct({ bytes: Schema.Number, total: Schema.Number })),
  archiveId: Schema.NullOr(Schema.String),
  intentId: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(ReleaseFailure),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ReleaseJob = typeof ReleaseJob.Type;
export const ReleaseBetaTester = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});
export const ReleaseBuild = Schema.Struct({
  ...AppleBuild.fields,
  betaReviewState: Schema.NullOr(Schema.String),
  internalBuildState: Schema.NullOr(Schema.String),
  externalBuildState: Schema.NullOr(Schema.String),
});
export const ReleaseStoreVersion = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  platform: Schema.String,
  state: Schema.String,
  buildId: Schema.NullOr(Schema.String),
});
export const ReleaseReviewSubmission = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  submittedDate: Schema.NullOr(Schema.String),
});
export const ReleaseOrganizer = Schema.Struct({
  builds: Schema.Array(ReleaseBuild),
  groups: Schema.Array(AppleBetaGroup),
  testers: Schema.Array(ReleaseBetaTester),
  versions: Schema.Array(ReleaseStoreVersion),
  reviews: Schema.Array(ReleaseReviewSubmission),
  fetchedAt: Schema.Number,
});
export type ReleaseOrganizer = typeof ReleaseOrganizer.Type;
export const ReleaseLocalStatus = Schema.Struct({
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  archives: Schema.Array(LocalReleaseArchive),
  jobs: Schema.Array(ReleaseJob),
});
export const ReleaseUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("organizer"), organizer: ReleaseOrganizer }),
  Schema.Struct({ kind: Schema.Literal("local"), local: ReleaseLocalStatus }),
]);
export type ReleaseUpdate = typeof ReleaseUpdate.Type;
export const ReleasePrepareInput = Schema.Struct({
  ...ReleaseTarget.fields,
  action: ReleaseAction,
});
export const ReleaseIntentInput = Schema.Struct({
  ...ReleaseTarget.fields,
  intentId: Schema.String,
});
export const ReleaseJobInput = Schema.Struct({ ...ReleaseTarget.fields, jobId: Schema.String });
export const RELEASE_WS_METHODS = {
  archive: "releases.archive",
  prepare: "releases.prepare",
  execute: "releases.execute",
  cancel: "releases.cancel",
  localStatus: "releases.localStatus",
  subscribe: "releases.subscribe",
  refresh: "releases.refresh",
} as const;
const error = Schema.Union([ReleaseError, AppleError, EnvironmentAuthorizationError]);
export const ReleaseRpcs = RpcGroup.make(
  Rpc.make(RELEASE_WS_METHODS.archive, {
    payload: ReleaseArchiveInput,
    success: ReleaseJob,
    error,
  }),
  Rpc.make(RELEASE_WS_METHODS.prepare, {
    payload: ReleasePrepareInput,
    success: ReleaseIntent,
    error,
  }),
  Rpc.make(RELEASE_WS_METHODS.execute, { payload: ReleaseIntentInput, success: ReleaseJob, error }),
  Rpc.make(RELEASE_WS_METHODS.cancel, { payload: ReleaseJobInput, success: ReleaseJob, error }),
  Rpc.make(RELEASE_WS_METHODS.localStatus, {
    payload: ReleaseTarget,
    success: ReleaseLocalStatus,
    error,
  }),
  Rpc.make(RELEASE_WS_METHODS.subscribe, {
    payload: ReleaseTarget,
    success: ReleaseUpdate,
    error,
    stream: true,
  }),
  Rpc.make(RELEASE_WS_METHODS.refresh, { payload: ReleaseTarget, success: Schema.Void, error }),
);
