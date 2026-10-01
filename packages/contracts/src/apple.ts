/** Company-owned ASC configuration and environment-local Apple operations. */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { CompanyId, CloudTimestamp } from "./company.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AppleScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("company"), companyId: CompanyId }),
]);
export const AppleAccount = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  displayName: Schema.String,
  scope: AppleScope,
  revision: Schema.Int,
  createdAt: CloudTimestamp,
  verifiedAt: Schema.NullOr(CloudTimestamp),
});
export const AppleListAccountsInput = Schema.Struct({ companyId: Schema.optional(CompanyId) });
export const AppleAccountLookupInput = Schema.Struct({
  accountId: Schema.String,
  companyId: Schema.optional(CompanyId),
});
export const AppleAccountInput = Schema.Struct({ accountId: Schema.String });
/** Company is the environment authorization context, also when the Apple account is personal. */
export const AppleEnvironmentAccountInput = Schema.Struct({
  companyId: CompanyId,
  accountId: Schema.String,
});
export const AppleTarget = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  teamId: Schema.String,
});
export type AppleTarget = typeof AppleTarget.Type;
export const AppleTeamInput = Schema.Struct({ accountId: Schema.String, teamId: Schema.String });
export const AppleAppInput = Schema.Struct({ ...AppleTarget.fields, appId: TrimmedNonEmptyString });
export const AppleAccountCreateInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  scope: Schema.optional(AppleScope),
});
export const AppleAccountUpdateInput = Schema.Struct({
  accountId: Schema.String,
  displayName: TrimmedNonEmptyString,
  scope: AppleScope,
  expectedRevision: Schema.Int,
});
export const AppleAccountRemoveInput = Schema.Struct({
  accountId: Schema.String,
  expectedRevision: Schema.Int,
});
export const AppleTeam = Schema.Struct({
  accountId: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["individual", "organization", "enterprise", "unknown"]),
});
export const AppleTeamUpsertInput = AppleTeam;
/** Sent only to the authenticated Cloud action. Never returned or persisted locally. */
export const AppleConnectInput = Schema.Struct({
  ...AppleTeamInput.fields,
  issuerId: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  privateKey: Schema.String,
  expectedRevision: Schema.Int,
});
export const AppleRevokeInput = Schema.Struct({
  ...AppleTeamInput.fields,
  expectedRevision: Schema.Int,
});
export const AppleApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  bundleId: Schema.String,
});
export type AppleApp = typeof AppleApp.Type;
export const AppleIntegration = Schema.Struct({
  accountId: Schema.String,
  teamId: Schema.String,
  accountRevision: Schema.Int,
  connected: Schema.Boolean,
  revision: Schema.Int,
  issuerId: Schema.NullOr(Schema.String),
  keyIdSuffix: Schema.NullOr(Schema.String),
  lastVerifiedAt: Schema.NullOr(CloudTimestamp),
});
export type AppleIntegration = typeof AppleIntegration.Type;
export const AppleErrorCode = Schema.Literals([
  "not-connected",
  "cloud-unavailable",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "invalid-key",
  "invalid-response",
  "request-failed",
  "credential-changed",
  "not-implemented",
]);
export const AppleFailure = Schema.Struct({
  code: AppleErrorCode,
  message: Schema.String,
  retryAfterSeconds: Schema.NullOr(Schema.Number),
});
export type AppleFailure = typeof AppleFailure.Type;
export class AppleError extends Schema.TaggedErrorClass<AppleError>()(
  "AppleError",
  AppleFailure.fields,
) {}
export const AppleEnvironmentHealth = Schema.Struct({
  environmentId: Schema.String,
  leaseExpiresAt: Schema.NullOr(CloudTimestamp),
  connected: Schema.Boolean,
  revision: Schema.Int,
  lastVerifiedAt: Schema.NullOr(CloudTimestamp),
  error: Schema.NullOr(AppleFailure),
});
export type AppleEnvironmentHealth = typeof AppleEnvironmentHealth.Type;
export const AppleStatus = Schema.Struct({
  integration: AppleIntegration,
  health: AppleEnvironmentHealth,
});
export type AppleStatus = typeof AppleStatus.Type;
export const AppleCloudStatus = Schema.Struct({
  integration: AppleIntegration,
  environments: Schema.Array(AppleEnvironmentHealth),
});
export const AppleBuild = Schema.Struct({
  id: Schema.String,
  version: Schema.NullOr(Schema.String),
  buildNumber: Schema.String,
  processingState: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  uploadedDate: Schema.NullOr(Schema.String),
});
export type AppleBuild = typeof AppleBuild.Type;
export const AppleBetaGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isInternalGroup: Schema.Boolean,
});
export type AppleBetaGroup = typeof AppleBetaGroup.Type;

export const AppleBundlePlatform = Schema.Literals(["IOS", "MAC_OS", "UNIVERSAL"]);
export const AppleRegisterBundleIdInput = Schema.Struct({
  ...AppleTarget.fields,
  name: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  platform: AppleBundlePlatform,
});
export const AppleBundleId = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  identifier: Schema.String,
  platform: AppleBundlePlatform,
});
export const AppleCreateAppInput = Schema.Struct({
  ...AppleTarget.fields,
  name: TrimmedNonEmptyString,
  bundleId: TrimmedNonEmptyString,
  sku: TrimmedNonEmptyString,
  primaryLocale: TrimmedNonEmptyString,
  platforms: Schema.Array(Schema.Literals(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])),
});
export const AppleProjectInput = Schema.Struct({ companyId: CompanyId, projectId: Schema.String });
export const AppleLinkProjectInput = Schema.Struct({
  ...AppleProjectInput.fields,
  ...AppleTeamInput.fields,
  appId: Schema.String,
});
export const AppleProjectLink = Schema.Struct({
  ...AppleProjectInput.fields,
  ...AppleTeamInput.fields,
  app: AppleApp,
  linkedAt: CloudTimestamp,
});
/** COR-101: a sealed, expiring account session can be leased by authorized environments.
 * Passwords/codes are invocation inputs; cookies never cross a client-facing contract.
 */
export const AppleIdStartInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  password: Schema.String,
});
export const AppleIdChallengeInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  flowId: Schema.String,
  code: Schema.String,
});
export const AppleIdFlowInput = Schema.Struct({
  ...AppleEnvironmentAccountInput.fields,
  flowId: Schema.String,
});
export const AppleIdRequestCodeInput = Schema.Struct({
  ...AppleIdFlowInput.fields,
  phoneNumberId: Schema.Int,
});
export const AppleIdSessionState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signed-out") }),
  Schema.Struct({
    state: Schema.Literal("authenticating"),
    flowId: Schema.String,
    expiresAt: CloudTimestamp,
  }),
  Schema.Struct({ state: Schema.Literal("failed"), error: AppleFailure }),
  Schema.Struct({
    state: Schema.Literal("challenge"),
    flowId: Schema.String,
    expiresAt: CloudTimestamp,
    destination: Schema.NullOr(Schema.String),
    kind: Schema.Literals(["trusted-device", "sms", "sms-choice"]),
    phoneNumbers: Schema.Array(Schema.Struct({ id: Schema.Int, destination: Schema.String })),
  }),
  Schema.Struct({ state: Schema.Literal("authenticated"), expiresAt: CloudTimestamp }),
  Schema.Struct({ state: Schema.Literal("expired") }),
]);

export const APPLE_WS_METHODS = {
  registerBundleId: "apple.registerBundleId",
  createApp: "apple.createApp",
  status: "apple.status",
  testConnection: "apple.testConnection",
  listApps: "apple.listApps",
  listBuilds: "apple.listBuilds",
  listBetaGroups: "apple.listBetaGroups",
  appleIdRequestCode: "apple.id.requestCode",
  appleIdStart: "apple.id.start",
  appleIdComplete: "apple.id.complete",
  appleIdCancel: "apple.id.cancel",
  appleIdStatus: "apple.id.status",
  appleIdSubscribe: "apple.id.subscribe",
  appleIdSignOut: "apple.id.signOut",
} as const;
const error = Schema.Union([AppleError, EnvironmentAuthorizationError]);
export const AppleRpcs = RpcGroup.make(
  Rpc.make(APPLE_WS_METHODS.appleIdRequestCode, {
    payload: AppleIdRequestCodeInput,
    success: AppleIdSessionState,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.registerBundleId, {
    payload: AppleRegisterBundleIdInput,
    success: AppleBundleId,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.createApp, { payload: AppleCreateAppInput, success: AppleApp, error }),
  Rpc.make(APPLE_WS_METHODS.status, { payload: AppleTarget, success: AppleStatus, error }),
  Rpc.make(APPLE_WS_METHODS.testConnection, { payload: AppleTarget, success: AppleStatus, error }),
  Rpc.make(APPLE_WS_METHODS.listApps, {
    payload: AppleTarget,
    success: Schema.Array(AppleApp),
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.listBuilds, {
    payload: AppleAppInput,
    success: Schema.Array(AppleBuild),
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.listBetaGroups, {
    payload: AppleAppInput,
    success: Schema.Array(AppleBetaGroup),
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdStart, {
    payload: AppleIdStartInput,
    success: AppleIdSessionState,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdComplete, {
    payload: AppleIdChallengeInput,
    success: AppleIdSessionState,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdCancel, {
    payload: AppleIdFlowInput,
    success: AppleIdSessionState,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdStatus, {
    payload: AppleEnvironmentAccountInput,
    success: AppleIdSessionState,
    error,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdSubscribe, {
    payload: AppleEnvironmentAccountInput,
    success: AppleIdSessionState,
    error,
    stream: true,
  }),
  Rpc.make(APPLE_WS_METHODS.appleIdSignOut, {
    payload: AppleEnvironmentAccountInput,
    success: AppleIdSessionState,
    error,
  }),
);
