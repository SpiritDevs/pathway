/**
 * Company-owned integrations and durable issue-automation contracts.
 *
 * These records are configured online and deliberately stay out of the company issue replica
 * feed. Environments execute work, but Convex remains the authority for configuration, leases,
 * Slack message identity, and automation intent.
 *
 * @module integrations
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudProjectId } from "./cloudProject.ts";
import { CloudTimestamp, CompanyId } from "./company.ts";
import { IssueCycleId, IssueId, SlackChannelId, SlackEmojiName, SlackMessageTs } from "./issues.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { IssueAutomationSettings } from "./settings.ts";

const makeIntegrationEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const SlackIntegrationId = makeIntegrationEntityId("SlackIntegrationId");
export type SlackIntegrationId = typeof SlackIntegrationId.Type;
export const SlackWorkspaceId = makeIntegrationEntityId("SlackWorkspaceId");
export type SlackWorkspaceId = typeof SlackWorkspaceId.Type;
export const SlackDeliveryId = makeIntegrationEntityId("SlackDeliveryId");
export type SlackDeliveryId = typeof SlackDeliveryId.Type;
export const IssueAutomationJobId = makeIntegrationEntityId("IssueAutomationJobId");
export type IssueAutomationJobId = typeof IssueAutomationJobId.Type;

export const SLACK_CONTROLLER_MAX_BACKUPS = 10;
export const SLACK_CONTROLLER_HEARTBEAT_INTERVAL_MS = 30_000;
export const SLACK_CONTROLLER_LEASE_TTL_MS = 90_000;
export const SLACK_CONTROLLER_FAILBACK_HEARTBEATS = 2;

export const SlackIntegrationState = Schema.Literals(["draft", "active", "disconnected"]);
export type SlackIntegrationState = typeof SlackIntegrationState.Type;

const uniqueControllerBackups = Schema.makeFilter(
  (environmentIds: ReadonlyArray<EnvironmentId>) =>
    new Set(environmentIds).size === environmentIds.length ||
    "Slack controller backups must not contain duplicates.",
);

export const SlackControllerPool = Schema.Struct({
  preferredEnvironmentId: Schema.NullOr(EnvironmentId),
  backupEnvironmentIds: Schema.Array(EnvironmentId)
    .check(Schema.isMaxLength(SLACK_CONTROLLER_MAX_BACKUPS))
    .check(uniqueControllerBackups),
}).check(
  Schema.makeFilter(
    (pool) =>
      pool.preferredEnvironmentId === null ||
      !pool.backupEnvironmentIds.includes(pool.preferredEnvironmentId) ||
      "The preferred Slack controller cannot also be a backup.",
  ),
);
export type SlackControllerPool = typeof SlackControllerPool.Type;

export const SlackIntegrationHealth = Schema.Struct({
  controllerEnvironmentId: Schema.NullOr(EnvironmentId),
  lastPollAt: Schema.NullOr(CloudTimestamp),
  currentError: Schema.NullOr(Schema.String),
  blockedReason: Schema.NullOr(Schema.String),
  watchCount: NonNegativeInt,
});
export type SlackIntegrationHealth = typeof SlackIntegrationHealth.Type;

/** Metadata only. The credential is never part of a public contract. */
export const SlackIntegration = Schema.Struct({
  id: SlackIntegrationId,
  companyId: CompanyId,
  workspaceId: SlackWorkspaceId,
  workspaceName: TrimmedNonEmptyString,
  workspaceDomain: Schema.NullOr(TrimmedNonEmptyString),
  botUserId: Schema.NullOr(TrimmedNonEmptyString),
  botId: Schema.NullOr(TrimmedNonEmptyString),
  state: SlackIntegrationState,
  activatedAt: Schema.NullOr(CloudTimestamp),
  credentialPresent: Schema.Boolean,
  controllerPool: SlackControllerPool,
  configurationRevision: NonNegativeInt,
  health: SlackIntegrationHealth,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SlackIntegration = typeof SlackIntegration.Type;

export const CompanySlackReactionRoute = Schema.Struct({
  emoji: SlackEmojiName,
  cloudProjectId: Schema.NullOr(CloudProjectId),
  autoInvestigate: Schema.NullOr(Schema.Boolean),
});
export type CompanySlackReactionRoute = typeof CompanySlackReactionRoute.Type;

const uniqueCompanySlackReactionRoutes = Schema.makeFilter(
  (routes: ReadonlyArray<CompanySlackReactionRoute>) =>
    new Set(routes.map((route) => route.emoji)).size === routes.length ||
    "Slack reaction routes must use different reactions.",
);

export const CompanySlackIntakeTrigger = Schema.Struct({
  reactionRoutes: Schema.Array(CompanySlackReactionRoute).check(uniqueCompanySlackReactionRoutes),
  everyMessage: Schema.Boolean,
  botMention: Schema.Boolean,
});
export type CompanySlackIntakeTrigger = typeof CompanySlackIntakeTrigger.Type;

export const CompanySlackChannelWatch = Schema.Struct({
  id: makeIntegrationEntityId("CompanySlackChannelWatchId"),
  companyId: CompanyId,
  integrationId: SlackIntegrationId,
  channelId: SlackChannelId,
  channelName: TrimmedNonEmptyString,
  cloudProjectId: Schema.NullOr(CloudProjectId),
  cycleId: Schema.NullOr(IssueCycleId),
  autoInvestigate: Schema.Boolean,
  autoAssign: Schema.Boolean,
  trigger: CompanySlackIntakeTrigger,
  revision: NonNegativeInt,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanySlackChannelWatch = typeof CompanySlackChannelWatch.Type;

export const SlackControllerLease = Schema.Struct({
  integrationId: SlackIntegrationId,
  holderEnvironmentId: Schema.NullOr(EnvironmentId),
  generation: NonNegativeInt,
  expiresAt: Schema.NullOr(CloudTimestamp),
});
export type SlackControllerLease = typeof SlackControllerLease.Type;

export const ProviderCapability = Schema.Struct({
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  modelIds: Schema.Array(TrimmedNonEmptyString),
});
export type ProviderCapability = typeof ProviderCapability.Type;

export const EnvironmentProviderCapabilitySnapshot = Schema.Struct({
  companyId: CompanyId,
  environmentId: EnvironmentId,
  revision: NonNegativeInt,
  supportsSlackCoordination: Schema.Boolean,
  supportsAutomationJobs: Schema.Boolean,
  providers: Schema.Array(ProviderCapability),
  publishedAt: CloudTimestamp,
});
export type EnvironmentProviderCapabilitySnapshot =
  typeof EnvironmentProviderCapabilitySnapshot.Type;

export const IssueAutomationJobKind = Schema.Literals([
  "slack-investigation",
  "automatic-assignment",
  "audit-execution",
  "audit-outcome-reduction",
  "remediation-dispatch",
]);
export type IssueAutomationJobKind = typeof IssueAutomationJobKind.Type;

export const IssueAutomationJobState = Schema.Literals([
  "pending",
  "blocked",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type IssueAutomationJobState = typeof IssueAutomationJobState.Type;

export const IssueAutomationBlockCode = Schema.Literals([
  "environment-offline",
  "project-binding-missing",
  "thread-environment-offline",
  "provider-instance-missing",
  "provider-disabled",
  "model-unavailable",
  "configuration-changed",
  "authorization-revoked",
]);
export type IssueAutomationBlockCode = typeof IssueAutomationBlockCode.Type;

export const IssueAutomationJobTarget = Schema.Union([
  Schema.TaggedStruct("project", {
    cloudProjectId: Schema.NullOr(CloudProjectId),
    environmentId: Schema.NullOr(EnvironmentId),
  }),
  Schema.TaggedStruct("thread", {
    threadId: Schema.NullOr(ThreadId),
    environmentId: Schema.NullOr(EnvironmentId),
  }),
]);
export type IssueAutomationJobTarget = typeof IssueAutomationJobTarget.Type;

export const IssueAutomationJobResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("investigation"), summary: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("assignment"),
    routingRuleId: Schema.NullOr(TrimmedNonEmptyString),
    auditRuleIds: Schema.Array(TrimmedNonEmptyString),
    rationale: Schema.String,
    modelSelection: ModelSelection,
    driverKind: ProviderDriverKind,
  }),
  Schema.Struct({
    kind: Schema.Literal("audit"),
    outcome: Schema.Literals(["passed", "changes-requested"]),
    summary: Schema.String,
    findings: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("reduction"),
    outcome: Schema.Literals(["passed", "changes-requested"]),
  }),
  Schema.Struct({ kind: Schema.Literal("remediation"), dispatched: Schema.Boolean }),
]);
export type IssueAutomationJobResult = typeof IssueAutomationJobResult.Type;

export const IssueAutomationJob = Schema.Struct({
  id: IssueAutomationJobId,
  companyId: CompanyId,
  issueId: IssueId,
  kind: IssueAutomationJobKind,
  triggerKey: TrimmedNonEmptyString,
  settingsRevision: NonNegativeInt,
  /** Immutable copy of the exact selection/rule used by this job. */
  modelSelection: Schema.NullOr(ModelSelection),
  ruleId: Schema.NullOr(TrimmedNonEmptyString),
  ruleSnapshot: Schema.NullOr(Schema.String),
  target: IssueAutomationJobTarget,
  requiredProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  requiredModel: Schema.NullOr(TrimmedNonEmptyString),
  state: IssueAutomationJobState,
  blockCode: Schema.NullOr(IssueAutomationBlockCode),
  diagnostic: Schema.NullOr(Schema.String),
  claimHolderEnvironmentId: Schema.NullOr(EnvironmentId),
  claimGeneration: NonNegativeInt,
  claimExpiresAt: Schema.NullOr(CloudTimestamp),
  attempts: NonNegativeInt,
  nextRetryAt: Schema.NullOr(CloudTimestamp),
  result: Schema.NullOr(IssueAutomationJobResult),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
  completedAt: Schema.NullOr(CloudTimestamp),
});
export type IssueAutomationJob = typeof IssueAutomationJob.Type;

export const CompanyIssueAutomationSettings = Schema.Struct({
  companyId: CompanyId,
  enabled: Schema.Boolean,
  activatedAt: Schema.NullOr(CloudTimestamp),
  revision: NonNegativeInt,
  settings: IssueAutomationSettings,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanyIssueAutomationSettings = typeof CompanyIssueAutomationSettings.Type;

export const SlackProcessedOrigin = Schema.Struct({
  integrationId: SlackIntegrationId,
  workspaceId: SlackWorkspaceId,
  channelId: SlackChannelId,
  messageTs: SlackMessageTs,
});
export type SlackProcessedOrigin = typeof SlackProcessedOrigin.Type;
