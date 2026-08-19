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

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CloudProjectId } from "./cloudProject.ts";
import { CloudTimestamp, CompanyId, TeamId } from "./company.ts";
import {
  IssueCycleId,
  IssueId,
  IssueStatusId,
  SlackChannelId,
  SlackEmojiName,
  SlackMessageTs,
} from "./issues.ts";
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

export const SLACK_ROUTING_MAX_RULES_PER_CHANNEL = 25;
export const SLACK_ROUTING_MAX_NODES_PER_RULE = 50;
export const SLACK_ROUTING_MAX_NODES_PER_WATCH = 250;
export const SLACK_ROUTING_MAX_PREFIXES_PER_LEAF = 10;
export const SLACK_ROUTING_MAX_PREFIX_CHARS = 80;
export const SLACK_ROUTING_MAX_SERIALIZED_BYTES = 32 * 1_024;

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

export const CompanySlackRoutingRuleId = makeIntegrationEntityId("CompanySlackRoutingRuleId");
export type CompanySlackRoutingRuleId = typeof CompanySlackRoutingRuleId.Type;

export type CompanySlackRoutingCondition =
  | {
      readonly kind: "all";
      readonly conditions: ReadonlyArray<CompanySlackRoutingCondition>;
    }
  | {
      readonly kind: "any";
      readonly conditions: ReadonlyArray<CompanySlackRoutingCondition>;
    }
  | {
      readonly kind: "text-prefix";
      readonly prefixes: ReadonlyArray<string>;
    }
  | { readonly kind: "reaction"; readonly emoji: SlackEmojiName }
  | { readonly kind: "bot-mention" }
  | { readonly kind: "every-message" };

const CompanySlackRoutingConditionRef = Schema.suspend(
  (): Schema.Codec<CompanySlackRoutingCondition> => CompanySlackRoutingCondition,
);

const CompanySlackRoutingConditionGroup = (kind: "all" | "any") =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    conditions: Schema.Array(CompanySlackRoutingConditionRef).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SLACK_ROUTING_MAX_NODES_PER_RULE),
    ),
  });

export const CompanySlackRoutingCondition: Schema.Codec<CompanySlackRoutingCondition> =
  Schema.Union([
    CompanySlackRoutingConditionGroup("all"),
    CompanySlackRoutingConditionGroup("any"),
    Schema.Struct({
      kind: Schema.Literal("text-prefix"),
      prefixes: Schema.Array(
        TrimmedNonEmptyString.check(Schema.isMaxLength(SLACK_ROUTING_MAX_PREFIX_CHARS)),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(SLACK_ROUTING_MAX_PREFIXES_PER_LEAF)),
    }),
    Schema.Struct({ kind: Schema.Literal("reaction"), emoji: SlackEmojiName }),
    Schema.Struct({ kind: Schema.Literal("bot-mention") }),
    Schema.Struct({ kind: Schema.Literal("every-message") }),
  ]);

export const CompanySlackInvestigationTiming = Schema.Literals(["off", "immediate", "on-status"]);
export type CompanySlackInvestigationTiming = typeof CompanySlackInvestigationTiming.Type;

export const CompanySlackInvestigationPolicy = Schema.Struct({
  timing: CompanySlackInvestigationTiming,
  triggerStatusId: Schema.NullOr(IssueStatusId),
  successStatusId: Schema.NullOr(IssueStatusId),
});
export type CompanySlackInvestigationPolicy = typeof CompanySlackInvestigationPolicy.Type;

export const CompanySlackAssignmentTiming = Schema.Literals([
  "off",
  "immediate",
  "after-investigation",
]);
export type CompanySlackAssignmentTiming = typeof CompanySlackAssignmentTiming.Type;

const slackRoutingConditionNodeCount = (condition: CompanySlackRoutingCondition): number =>
  condition.kind === "all" || condition.kind === "any"
    ? 1 +
      condition.conditions.reduce(
        (count, child) => count + slackRoutingConditionNodeCount(child),
        0,
      )
    : 1;

const slackRoutingRuleNodeLimit = Schema.makeFilter(
  (rule: { readonly condition: CompanySlackRoutingCondition }) =>
    slackRoutingConditionNodeCount(rule.condition) <= SLACK_ROUTING_MAX_NODES_PER_RULE ||
    `Slack routing rules cannot contain more than ${SLACK_ROUTING_MAX_NODES_PER_RULE} condition nodes.`,
);

export const CompanySlackRoutingRule = Schema.Struct({
  id: CompanySlackRoutingRuleId,
  name: TrimmedNonEmptyString,
  condition: CompanySlackRoutingCondition,
  teamId: Schema.NullOr(TeamId),
  cloudProjectId: Schema.NullOr(CloudProjectId),
  cycleId: Schema.NullOr(IssueCycleId),
  initialStatusId: Schema.NullOr(IssueStatusId),
  investigation: CompanySlackInvestigationPolicy,
  assignmentTiming: CompanySlackAssignmentTiming,
}).check(slackRoutingRuleNodeLimit);
export type CompanySlackRoutingRule = typeof CompanySlackRoutingRule.Type;

const slackRoutingWatchLimits = Schema.makeFilter(
  (configuration: {
    readonly configurationVersion: 2;
    readonly rules: ReadonlyArray<CompanySlackRoutingRule>;
  }) => {
    const totalNodes = configuration.rules.reduce(
      (count, rule) => count + slackRoutingConditionNodeCount(rule.condition),
      0,
    );
    if (totalNodes > SLACK_ROUTING_MAX_NODES_PER_WATCH) {
      return `Slack channel watches cannot contain more than ${SLACK_ROUTING_MAX_NODES_PER_WATCH} condition nodes.`;
    }

    const serializedBytes = new TextEncoder().encode(JSON.stringify(configuration)).byteLength;
    return (
      serializedBytes <= SLACK_ROUTING_MAX_SERIALIZED_BYTES ||
      `Slack channel watch configuration cannot exceed ${SLACK_ROUTING_MAX_SERIALIZED_BYTES} serialized bytes.`
    );
  },
);

export const CompanySlackRoutingConfigurationV2 = Schema.Struct({
  configurationVersion: Schema.Literal(2),
  rules: Schema.Array(CompanySlackRoutingRule).check(
    Schema.isMaxLength(SLACK_ROUTING_MAX_RULES_PER_CHANNEL),
  ),
}).check(slackRoutingWatchLimits);
export type CompanySlackRoutingConfigurationV2 = typeof CompanySlackRoutingConfigurationV2.Type;

export const CompanySlackChannelWatchV2 = Schema.Struct({
  id: makeIntegrationEntityId("CompanySlackChannelWatchId"),
  companyId: CompanyId,
  integrationId: SlackIntegrationId,
  channelId: SlackChannelId,
  channelName: TrimmedNonEmptyString,
  configurationVersion: Schema.Literal(2),
  rules: Schema.Array(CompanySlackRoutingRule).check(
    Schema.isMaxLength(SLACK_ROUTING_MAX_RULES_PER_CHANNEL),
  ),
  revision: NonNegativeInt,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
}).check(slackRoutingWatchLimits);
export type CompanySlackChannelWatchV2 = typeof CompanySlackChannelWatchV2.Type;

/** V1 remains decodable while V2 controllers roll out across environments. */
export const CompanySlackChannelWatchDefinition = Schema.Union([
  CompanySlackChannelWatch,
  CompanySlackChannelWatchV2,
]);
export type CompanySlackChannelWatchDefinition = typeof CompanySlackChannelWatchDefinition.Type;

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
  /** Missing snapshots predate the versioned Slack protocol and therefore mean V1. */
  slackProtocolVersion: Schema.optional(PositiveInt),
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
