/**
 * Local SMTP capture contracts.
 *
 * Capture is scoped to one source environment. Messages retain their SMTP and MIME provenance so
 * the Email view can explain routing and parsing without reaching back into the capture service;
 * the cloud-sync wrapper adds source-environment and logical-project identity when they replicate.
 *
 * @module email
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const EMAIL_WS_METHODS = {
  list: "email.list",
  get: "email.get",
  analytics: "email.analytics",
  triggerRulesList: "email.triggerRules.list",
  triggerRulesUpsert: "email.triggerRules.upsert",
  triggerRulesDelete: "email.triggerRules.delete",
  triggerFiringsList: "email.triggerFirings.list",
  markRead: "email.markRead",
  markUnread: "email.markUnread",
  deleteMessages: "email.deleteMessages",
  clearInbox: "email.clearInbox",
  getSettings: "email.getSettings",
  updateSettings: "email.updateSettings",
  stream: "email.stream",
} as const;

const makeEmailEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const EmailMessageId = makeEmailEntityId("EmailMessageId");
export type EmailMessageId = typeof EmailMessageId.Type;
export const EmailTagId = makeEmailEntityId("EmailTagId");
export type EmailTagId = typeof EmailTagId.Type;
export const TrustedEmailSenderId = makeEmailEntityId("TrustedEmailSenderId");
export type TrustedEmailSenderId = typeof TrustedEmailSenderId.Type;
export const EmailAttachmentId = makeEmailEntityId("EmailAttachmentId");
export type EmailAttachmentId = typeof EmailAttachmentId.Type;
export const EmailTriggerRuleId = makeEmailEntityId("EmailTriggerRuleId");
export type EmailTriggerRuleId = typeof EmailTriggerRuleId.Type;
export const EmailTriggerFiringId = makeEmailEntityId("EmailTriggerFiringId");
export type EmailTriggerFiringId = typeof EmailTriggerFiringId.Type;
export const EmailWaitRegistrationId = makeEmailEntityId("EmailWaitRegistrationId");
export type EmailWaitRegistrationId = typeof EmailWaitRegistrationId.Type;

export const EMAIL_MAIL_SLUG_MAX_LENGTH = 63;
export const EmailMailSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(EMAIL_MAIL_SLUG_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
).pipe(Schema.brand("EmailMailSlug"));
export type EmailMailSlug = typeof EmailMailSlug.Type;

export const EmailRoutingRule = Schema.Literals([
  "auth-username",
  "auth-password",
  "recipient-domain",
  "recipient-plus-tag",
  "unassigned",
]);
export type EmailRoutingRule = typeof EmailRoutingRule.Type;

/** The attribution decision persisted beside a message so a wrong inbox explains itself. */
export const EmailProjectAttribution = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  mailSlug: Schema.NullOr(EmailMailSlug),
  matchedBy: EmailRoutingRule,
  /** The AUTH routing label or recipient address that won. Null only for Unassigned. */
  matchedValue: Schema.NullOr(TrimmedNonEmptyString),
});
export type EmailProjectAttribution = typeof EmailProjectAttribution.Type;

export const EmailEnvelope = Schema.Struct({
  /** Null represents SMTP's empty reverse-path (`MAIL FROM:<>`). */
  mailFrom: Schema.NullOr(TrimmedNonEmptyString),
  rcptTo: Schema.Array(TrimmedNonEmptyString),
  /** A routing label, never a credential or authenticated identity. */
  authUsername: Schema.NullOr(TrimmedNonEmptyString),
  helo: Schema.NullOr(TrimmedNonEmptyString),
  remoteAddress: Schema.NullOr(TrimmedNonEmptyString),
});
export type EmailEnvelope = typeof EmailEnvelope.Type;

export const EmailAddress = Schema.Struct({
  address: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
});
export type EmailAddress = typeof EmailAddress.Type;

/** One exact From address whose remote images and styles may load automatically. */
export const TrustedEmailSender = Schema.Struct({
  id: TrustedEmailSenderId,
  address: TrimmedNonEmptyString,
});
export type TrustedEmailSender = typeof TrustedEmailSender.Type;

export const EmailHeader = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Decoded display value. Repeated headers remain repeated array entries. */
  value: Schema.String,
});
export type EmailHeader = typeof EmailHeader.Type;

/** Common address fields plus the complete ordered decoded header list. */
export const EmailParsedHeaders = Schema.Struct({
  subject: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(TrimmedNonEmptyString),
  date: Schema.NullOr(IsoDateTime),
  from: Schema.Array(EmailAddress),
  to: Schema.Array(EmailAddress),
  cc: Schema.Array(EmailAddress),
  bcc: Schema.Array(EmailAddress),
  replyTo: Schema.Array(EmailAddress),
  headers: Schema.Array(EmailHeader),
});
export type EmailParsedHeaders = typeof EmailParsedHeaders.Type;

export const EmailAttachment = Schema.Struct({
  id: EmailAttachmentId,
  filename: Schema.NullOr(Schema.String),
  contentType: TrimmedNonEmptyString,
  contentDisposition: Schema.NullOr(TrimmedNonEmptyString),
  contentId: Schema.NullOr(TrimmedNonEmptyString),
  sizeBytes: NonNegativeInt,
});
export type EmailAttachment = typeof EmailAttachment.Type;

export const EmailSmtpTransactionDirection = Schema.Literals(["client", "server"]);
export type EmailSmtpTransactionDirection = typeof EmailSmtpTransactionDirection.Type;

export const EmailSmtpTransactionEntry = Schema.Struct({
  at: IsoDateTime,
  direction: EmailSmtpTransactionDirection,
  /** Preserves whitespace because the Raw tab presents the SMTP exchange verbatim. */
  line: Schema.String,
});
export type EmailSmtpTransactionEntry = typeof EmailSmtpTransactionEntry.Type;

export const EmailCaptureTimings = Schema.Struct({
  connectedAt: IsoDateTime,
  messageReceivedAt: IsoDateTime,
  parsedAt: IsoDateTime,
  storedAt: IsoDateTime,
  parseDurationMs: NonNegativeInt,
  totalDurationMs: NonNegativeInt,
});
export type EmailCaptureTimings = typeof EmailCaptureTimings.Type;

export const DetectedEmailCode = Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32));
export type DetectedEmailCode = typeof DetectedEmailCode.Type;

export const EmailDeliverabilityCheckId = Schema.Literals([
  "spf",
  "dkim",
  "dmarc",
  "list-unsubscribe",
  "text-plain-alternative",
  "subject-length",
  "image-to-text-ratio",
  "tracking-pixels",
  "html-compatibility",
]);
export type EmailDeliverabilityCheckId = typeof EmailDeliverabilityCheckId.Type;

export const EmailDeliverabilityCheckStatus = Schema.Literals(["pass", "warning", "fail"]);
export type EmailDeliverabilityCheckStatus = typeof EmailDeliverabilityCheckStatus.Type;

export const EmailDeliverabilityCheck = Schema.Struct({
  id: EmailDeliverabilityCheckId,
  status: EmailDeliverabilityCheckStatus,
  summary: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
});
export type EmailDeliverabilityCheck = typeof EmailDeliverabilityCheck.Type;

export const EmailHtmlCompatibilityWarning = Schema.Struct({
  ruleId: TrimmedNonEmptyString,
  feature: TrimmedNonEmptyString,
  clients: Schema.Array(TrimmedNonEmptyString),
  detail: TrimmedNonEmptyString,
});
export type EmailHtmlCompatibilityWarning = typeof EmailHtmlCompatibilityWarning.Type;

export const EmailDeliverabilityMetrics = Schema.Struct({
  subjectLength: NonNegativeInt,
  imageCount: NonNegativeInt,
  visibleTextCharacters: NonNegativeInt,
  imageToTextRatio: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  trackingPixelCount: NonNegativeInt,
});
export type EmailDeliverabilityMetrics = typeof EmailDeliverabilityMetrics.Type;

/** Capture-time, offline analysis. Versioned so old messages retain the result they were sent with. */
export const EmailDeliverabilityResult = Schema.Struct({
  version: PositiveInt,
  checks: Schema.Array(EmailDeliverabilityCheck),
  metrics: EmailDeliverabilityMetrics,
  htmlCompatibilityWarnings: Schema.Array(EmailHtmlCompatibilityWarning),
});
export type EmailDeliverabilityResult = typeof EmailDeliverabilityResult.Type;

export const CapturedEmailMessage = Schema.Struct({
  id: EmailMessageId,
  attribution: EmailProjectAttribution,
  envelope: EmailEnvelope,
  parsedHeaders: EmailParsedHeaders,
  textBody: Schema.NullOr(Schema.String),
  htmlBody: Schema.NullOr(Schema.String),
  attachments: Schema.Array(EmailAttachment),
  smtpTransactionLog: Schema.Array(EmailSmtpTransactionEntry),
  timings: EmailCaptureTimings,
  sizeBytes: NonNegativeInt,
  isRead: Schema.Boolean,
  detectedCode: Schema.NullOr(DetectedEmailCode),
  deliverability: EmailDeliverabilityResult,
});
export type CapturedEmailMessage = typeof CapturedEmailMessage.Type;

/** The list row and live-event payload; bodies and transcripts stay in `email.get`. */
export const CapturedEmailSummary = Schema.Struct({
  id: EmailMessageId,
  attribution: EmailProjectAttribution,
  from: Schema.Array(EmailAddress),
  to: Schema.Array(EmailAddress),
  subject: Schema.NullOr(Schema.String),
  textPreview: Schema.String,
  receivedAt: IsoDateTime,
  sizeBytes: NonNegativeInt,
  attachmentCount: NonNegativeInt,
  isRead: Schema.Boolean,
  detectedCode: Schema.NullOr(DetectedEmailCode),
});
export type CapturedEmailSummary = typeof CapturedEmailSummary.Type;

/** Company-wide, colour-coded vocabulary assigned to replicated captured mail. */
export const EmailTag = Schema.Struct({
  id: EmailTagId,
  name: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
});
export type EmailTag = typeof EmailTag.Type;

export const EmailInboxScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("unassigned") }),
]);
export type EmailInboxScope = typeof EmailInboxScope.Type;

export const EmailInboxSummary = Schema.Struct({
  scope: EmailInboxScope,
  name: TrimmedNonEmptyString,
  mailSlug: Schema.NullOr(EmailMailSlug),
  messageCount: NonNegativeInt,
  unreadCount: NonNegativeInt,
  toastMuted: Schema.Boolean,
});
export type EmailInboxSummary = typeof EmailInboxSummary.Type;

export const DEFAULT_EMAIL_LISTENER_BIND_ADDRESS = "0.0.0.0";
export const DEFAULT_EMAIL_LISTENER_PORT = 1025;
export const DEFAULT_EMAIL_RETENTION_MAX_MESSAGES = 500;
export const DEFAULT_EMAIL_RETENTION_MAX_AGE_DAYS = 7;

export const EmailListenerSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  bindAddress: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EMAIL_LISTENER_BIND_ADDRESS)),
  ),
  port: PortSchema.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_EMAIL_LISTENER_PORT))),
});
export type EmailListenerSettings = typeof EmailListenerSettings.Type;

export const EmailRetentionPolicy = Schema.Struct({
  maxMessages: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EMAIL_RETENTION_MAX_MESSAGES)),
  ),
  maxAgeDays: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EMAIL_RETENTION_MAX_AGE_DAYS)),
  ),
});
export type EmailRetentionPolicy = typeof EmailRetentionPolicy.Type;

/** Null inherits the corresponding central cap. */
export const EmailRetentionOverrides = Schema.Struct({
  maxMessages: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  maxAgeDays: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type EmailRetentionOverrides = typeof EmailRetentionOverrides.Type;

export const EmailTriggerMatcher = Schema.Struct({
  sender: Schema.NullOr(TrimmedNonEmptyString),
  subject: Schema.NullOr(TrimmedNonEmptyString),
  recipient: Schema.NullOr(TrimmedNonEmptyString),
});
export type EmailTriggerMatcher = typeof EmailTriggerMatcher.Type;

/**
 * One project-owned automation rule. Window fields are persisted with the rule so an hourly cap
 * survives restart; loop detection records its auto-disable alongside ordinary user disables.
 */
export const EmailTriggerRule = Schema.Struct({
  id: EmailTriggerRuleId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  matcher: EmailTriggerMatcher,
  promptTemplate: Schema.String.check(Schema.isNonEmpty()),
  maxTriggersPerHour: PositiveInt,
  rateLimitWindowStartedAt: Schema.NullOr(IsoDateTime),
  triggersInCurrentWindow: NonNegativeInt,
  autoDisabledAt: Schema.NullOr(IsoDateTime),
  autoDisabledReason: Schema.NullOr(Schema.String),
});
export type EmailTriggerRule = typeof EmailTriggerRule.Type;

export const EmailTriggerFiringStatus = Schema.Literals(["launched", "failed", "loop-detected"]);
export type EmailTriggerFiringStatus = typeof EmailTriggerFiringStatus.Type;

/** Durable audit record tying an agent run to the captured message that caused it. */
export const EmailTriggerFiring = Schema.Struct({
  id: EmailTriggerFiringId,
  ruleId: EmailTriggerRuleId,
  projectId: ProjectId,
  messageId: EmailMessageId,
  threadId: ThreadId,
  firedAt: IsoDateTime,
  status: EmailTriggerFiringStatus,
  error: Schema.NullOr(Schema.String),
  /** The later message proven to have originated from this firing's thread. */
  loopMessageId: Schema.NullOr(EmailMessageId),
});
export type EmailTriggerFiring = typeof EmailTriggerFiring.Type;

export const EmailTriggerRulesListInput = Schema.Struct({ projectId: ProjectId });
export type EmailTriggerRulesListInput = typeof EmailTriggerRulesListInput.Type;
export const EmailTriggerRulesListResult = Schema.Struct({
  rules: Schema.Array(EmailTriggerRule),
});
export type EmailTriggerRulesListResult = typeof EmailTriggerRulesListResult.Type;

export const EmailTriggerRuleUpsertInput = Schema.Struct({
  id: Schema.optional(EmailTriggerRuleId),
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  matcher: EmailTriggerMatcher,
  promptTemplate: Schema.String.check(Schema.isNonEmpty()),
  maxTriggersPerHour: PositiveInt,
});
export type EmailTriggerRuleUpsertInput = typeof EmailTriggerRuleUpsertInput.Type;
export const EmailTriggerRuleMutationResult = Schema.Struct({ rule: EmailTriggerRule });
export type EmailTriggerRuleMutationResult = typeof EmailTriggerRuleMutationResult.Type;

export const EmailTriggerRuleDeleteInput = Schema.Struct({
  projectId: ProjectId,
  ruleId: EmailTriggerRuleId,
});
export type EmailTriggerRuleDeleteInput = typeof EmailTriggerRuleDeleteInput.Type;
export const EmailTriggerRuleDeleteResult = Schema.Struct({ ruleId: EmailTriggerRuleId });
export type EmailTriggerRuleDeleteResult = typeof EmailTriggerRuleDeleteResult.Type;

export const EmailTriggerFiringsListInput = Schema.Struct({
  projectId: ProjectId,
  ruleId: Schema.optional(EmailTriggerRuleId),
  cursor: Schema.optional(EmailTriggerFiringId),
  limit: Schema.optional(PositiveInt),
});
export type EmailTriggerFiringsListInput = typeof EmailTriggerFiringsListInput.Type;
export const EmailTriggerFiringsListResult = Schema.Struct({
  firings: Schema.Array(EmailTriggerFiring),
  nextCursor: Schema.NullOr(EmailTriggerFiringId),
});
export type EmailTriggerFiringsListResult = typeof EmailTriggerFiringsListResult.Type;

export const EmailProjectSettings = Schema.Struct({
  projectId: ProjectId,
  mailSlug: EmailMailSlug,
  capturePassword: Schema.NullOr(TrimmedNonEmptyString)
    .pipe(Schema.withDecodingDefault(Effect.succeed(null)))
    .annotate({
      description:
        "Optional SMTP AUTH password routing label. Like the mail slug, this is not a secret or security boundary.",
    }),
  retention: EmailRetentionOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  toastMuted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  twoFactorCodeRegex: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type EmailProjectSettings = typeof EmailProjectSettings.Type;

export const EmailCaptureSettings = Schema.Struct({
  listener: EmailListenerSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  retention: EmailRetentionPolicy.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  toastsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  projects: Schema.Array(EmailProjectSettings).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type EmailCaptureSettings = typeof EmailCaptureSettings.Type;

export const DEFAULT_EMAIL_CAPTURE_SETTINGS: EmailCaptureSettings = Schema.decodeSync(
  EmailCaptureSettings,
)({});

export const EmailListenerState = Schema.Literals(["disabled", "listening", "error"]);
export type EmailListenerState = typeof EmailListenerState.Type;

export const EmailListenerStatus = Schema.Struct({
  state: EmailListenerState,
  bindAddress: TrimmedNonEmptyString,
  port: PortSchema,
  error: Schema.NullOr(Schema.String),
});
export type EmailListenerStatus = typeof EmailListenerStatus.Type;

export const EmailWaitCriteria = Schema.Struct({
  scope: EmailInboxScope,
  sender: Schema.NullOr(TrimmedNonEmptyString),
  subject: Schema.NullOr(TrimmedNonEmptyString),
  recipient: Schema.NullOr(TrimmedNonEmptyString),
});
export type EmailWaitCriteria = typeof EmailWaitCriteria.Type;

export const EmailWaitDelivery = Schema.Literals(["task", "long-poll"]);
export type EmailWaitDelivery = typeof EmailWaitDelivery.Type;
export const EmailWaitStatus = Schema.Literals(["pending", "completed", "expired", "cancelled"]);
export type EmailWaitStatus = typeof EmailWaitStatus.Type;

export const EmailWaitRegistration = Schema.Struct({
  id: EmailWaitRegistrationId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  criteria: EmailWaitCriteria,
  delivery: EmailWaitDelivery,
  /** Present for tasks-capable clients; null for a held long-poll. */
  taskId: Schema.NullOr(TrimmedNonEmptyString),
  status: EmailWaitStatus,
  registeredAt: IsoDateTime,
  expiresAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  matchedMessageId: Schema.NullOr(EmailMessageId),
});
export type EmailWaitRegistration = typeof EmailWaitRegistration.Type;

export const EmailListFilters = Schema.Struct({
  sender: Schema.optional(TrimmedNonEmptyString),
  subject: Schema.optional(TrimmedNonEmptyString),
  recipient: Schema.optional(TrimmedNonEmptyString),
  isRead: Schema.optional(Schema.Boolean),
});
export type EmailListFilters = typeof EmailListFilters.Type;

export const EmailListInput = Schema.Struct({
  scope: EmailInboxScope,
  /** Physical connection ids to combine when `scope` identifies one logical project. */
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
  filters: Schema.optional(EmailListFilters),
});
export type EmailListInput = typeof EmailListInput.Type;

export const EmailListResult = Schema.Struct({
  messages: Schema.Array(CapturedEmailSummary),
  inboxes: Schema.Array(EmailInboxSummary),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type EmailListResult = typeof EmailListResult.Type;

export const EmailGetInput = Schema.Struct({ messageId: EmailMessageId });
export type EmailGetInput = typeof EmailGetInput.Type;
export const EmailGetResult = Schema.Struct({ message: CapturedEmailMessage });
export type EmailGetResult = typeof EmailGetResult.Type;

export const EmailAnalyticsInterval = Schema.Literals(["hour", "day"]);
export type EmailAnalyticsInterval = typeof EmailAnalyticsInterval.Type;

export const EmailAnalyticsInput = Schema.Struct({
  scope: EmailInboxScope,
  from: Schema.optional(IsoDateTime),
  to: Schema.optional(IsoDateTime),
  interval: EmailAnalyticsInterval,
  topAddressLimit: Schema.optional(PositiveInt),
});
export type EmailAnalyticsInput = typeof EmailAnalyticsInput.Type;

export const EmailVolumePoint = Schema.Struct({
  bucketStart: IsoDateTime,
  messageCount: NonNegativeInt,
});
export type EmailVolumePoint = typeof EmailVolumePoint.Type;

export const EmailProjectMessageCount = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  mailSlug: Schema.NullOr(EmailMailSlug),
  messageCount: NonNegativeInt,
});
export type EmailProjectMessageCount = typeof EmailProjectMessageCount.Type;

export const EmailAddressMessageCount = Schema.Struct({
  address: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
});
export type EmailAddressMessageCount = typeof EmailAddressMessageCount.Type;

export const EmailCaptureLatencyAnalytics = Schema.Struct({
  messageCount: NonNegativeInt,
  averageMs: NonNegativeInt,
  p50Ms: NonNegativeInt,
  p95Ms: NonNegativeInt,
  maxMs: NonNegativeInt,
});
export type EmailCaptureLatencyAnalytics = typeof EmailCaptureLatencyAnalytics.Type;

export const EmailAnalyticsResult = Schema.Struct({
  volumeOverTime: Schema.Array(EmailVolumePoint),
  perProjectCounts: Schema.Array(EmailProjectMessageCount),
  topSenders: Schema.Array(EmailAddressMessageCount),
  topRecipients: Schema.Array(EmailAddressMessageCount),
  captureLatency: EmailCaptureLatencyAnalytics,
});
export type EmailAnalyticsResult = typeof EmailAnalyticsResult.Type;

/** Project selector used by agent-facing email tools. Omitted means the calling thread's project. */
export const EmailMcpProject = Schema.Union([Schema.Literal("all"), EmailMailSlug]);
export type EmailMcpProject = typeof EmailMcpProject.Type;

export const EmailMcpWaitForInput = Schema.Struct({
  project: Schema.optional(EmailMcpProject),
  sender: Schema.optional(TrimmedNonEmptyString),
  subject: Schema.optional(TrimmedNonEmptyString),
  recipient: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(PositiveInt),
});
export type EmailMcpWaitForInput = typeof EmailMcpWaitForInput.Type;

export const EmailMcpLatestCodeInput = Schema.Struct({
  project: Schema.optional(EmailMcpProject),
});
export type EmailMcpLatestCodeInput = typeof EmailMcpLatestCodeInput.Type;

export const EmailMcpLatestCodeResult = Schema.Struct({
  messageId: EmailMessageId,
  code: DetectedEmailCode,
  sender: Schema.NullOr(TrimmedNonEmptyString),
  receivedAt: IsoDateTime,
  ageMs: NonNegativeInt,
});
export type EmailMcpLatestCodeResult = typeof EmailMcpLatestCodeResult.Type;

export const EmailMcpListInput = Schema.Struct({
  project: Schema.optional(EmailMcpProject),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
  sender: Schema.optional(TrimmedNonEmptyString),
  subject: Schema.optional(TrimmedNonEmptyString),
  recipient: Schema.optional(TrimmedNonEmptyString),
  isRead: Schema.optional(Schema.Boolean),
});
export type EmailMcpListInput = typeof EmailMcpListInput.Type;

export const EmailMcpGetInput = Schema.Struct({
  project: Schema.optional(EmailMcpProject),
  messageId: EmailMessageId,
});
export type EmailMcpGetInput = typeof EmailMcpGetInput.Type;

export const EmailMcpTaskStatus = Schema.Literals(["working", "completed", "failed", "cancelled"]);
export type EmailMcpTaskStatus = typeof EmailMcpTaskStatus.Type;

/** Full task state, used by both `tasks/get` and the arrival notification. */
export const EmailMcpTaskState = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  status: EmailMcpTaskStatus,
  createdAt: IsoDateTime,
  lastUpdatedAt: IsoDateTime,
  ttlMs: PositiveInt,
  pollIntervalMs: PositiveInt,
  result: Schema.NullOr(CapturedEmailMessage),
  error: Schema.NullOr(Schema.String),
});
export type EmailMcpTaskState = typeof EmailMcpTaskState.Type;

export const EmailMcpCreateTaskResult = Schema.Struct({
  task: EmailMcpTaskState,
});
export type EmailMcpCreateTaskResult = typeof EmailMcpCreateTaskResult.Type;

export const EmailMcpLongPollResult = Schema.Struct({
  message: Schema.NullOr(CapturedEmailMessage),
  timedOut: Schema.Boolean,
});
export type EmailMcpLongPollResult = typeof EmailMcpLongPollResult.Type;

export const EmailReadTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), messageId: EmailMessageId }),
  Schema.Struct({ type: Schema.Literal("inbox"), scope: EmailInboxScope }),
]);
export type EmailReadTarget = typeof EmailReadTarget.Type;
export const EmailMarkReadInput = Schema.Struct({ target: EmailReadTarget });
export type EmailMarkReadInput = typeof EmailMarkReadInput.Type;
export const EmailMarkUnreadInput = Schema.Struct({ target: EmailReadTarget });
export type EmailMarkUnreadInput = typeof EmailMarkUnreadInput.Type;

export const EmailReadStateResult = Schema.Struct({
  updatedMessageIds: Schema.Array(EmailMessageId),
  inboxes: Schema.Array(EmailInboxSummary),
});
export type EmailReadStateResult = typeof EmailReadStateResult.Type;

export const EmailClearInboxInput = Schema.Struct({ scope: EmailInboxScope });
export type EmailClearInboxInput = typeof EmailClearInboxInput.Type;
export const EmailClearInboxResult = Schema.Struct({
  clearedCount: NonNegativeInt,
  inboxes: Schema.Array(EmailInboxSummary),
});
export type EmailClearInboxResult = typeof EmailClearInboxResult.Type;

export const EmailDeleteMessagesInput = Schema.Struct({
  messageIds: Schema.Array(EmailMessageId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type EmailDeleteMessagesInput = typeof EmailDeleteMessagesInput.Type;
export const EmailDeleteMessagesResult = Schema.Struct({
  deletedMessageIds: Schema.Array(EmailMessageId),
  inboxes: Schema.Array(EmailInboxSummary),
});
export type EmailDeleteMessagesResult = typeof EmailDeleteMessagesResult.Type;

export const EmailSettingsSnapshot = Schema.Struct({
  settings: EmailCaptureSettings,
  listenerStatus: EmailListenerStatus,
});
export type EmailSettingsSnapshot = typeof EmailSettingsSnapshot.Type;
export const EmailGetSettingsInput = Schema.Struct({});
export type EmailGetSettingsInput = typeof EmailGetSettingsInput.Type;
export const EmailGetSettingsResult = EmailSettingsSnapshot;
export type EmailGetSettingsResult = typeof EmailGetSettingsResult.Type;
export const EmailUpdateSettingsInput = Schema.Struct({ settings: EmailCaptureSettings });
export type EmailUpdateSettingsInput = typeof EmailUpdateSettingsInput.Type;
export const EmailUpdateSettingsResult = EmailSettingsSnapshot;
export type EmailUpdateSettingsResult = typeof EmailUpdateSettingsResult.Type;

/** Diffs after the initial list/settings reads; the captured event deliberately repeats the code. */
export const EmailStreamEvent = Schema.Union([
  Schema.TaggedStruct("EmailCaptured", {
    message: CapturedEmailSummary,
    detectedCode: Schema.NullOr(DetectedEmailCode),
    inboxes: Schema.Array(EmailInboxSummary),
  }),
  Schema.TaggedStruct("EmailReadStateChanged", {
    messageIds: Schema.Array(EmailMessageId),
    isRead: Schema.Boolean,
    inboxes: Schema.Array(EmailInboxSummary),
  }),
  Schema.TaggedStruct("EmailInboxCleared", {
    scope: EmailInboxScope,
    clearedCount: NonNegativeInt,
    inboxes: Schema.Array(EmailInboxSummary),
  }),
  Schema.TaggedStruct("EmailMessagesDeleted", {
    messageIds: Schema.Array(EmailMessageId),
    inboxes: Schema.Array(EmailInboxSummary),
  }),
  Schema.TaggedStruct("EmailSettingsChanged", { snapshot: EmailSettingsSnapshot }),
  Schema.TaggedStruct("EmailTriggerRuleAutoDisabled", {
    rule: EmailTriggerRule,
    firing: EmailTriggerFiring,
    loopMessageId: EmailMessageId,
    notice: TrimmedNonEmptyString,
  }),
]);
export type EmailStreamEvent = typeof EmailStreamEvent.Type;

/** Completion signals for listener-owned asynchronous work. Tests and internal reactors subscribe
 * before initiating work, so completion is observed without sleeps or polling. */
export const EmailCaptureReceipt = Schema.Union([
  Schema.TaggedStruct("EmailMessageStored", {
    messageId: EmailMessageId,
    attribution: EmailProjectAttribution,
    storedAt: IsoDateTime,
    evictedMessageIds: Schema.Array(EmailMessageId),
  }),
  Schema.TaggedStruct("EmailCaptureFailed", {
    failedAt: IsoDateTime,
    message: Schema.String,
  }),
  Schema.TaggedStruct("EmailListenerChanged", {
    changedAt: IsoDateTime,
    status: EmailListenerStatus,
  }),
  Schema.TaggedStruct("EmailInboxClearCompleted", {
    completedAt: IsoDateTime,
    scope: EmailInboxScope,
    clearedMessageIds: Schema.Array(EmailMessageId),
  }),
]);
export type EmailCaptureReceipt = typeof EmailCaptureReceipt.Type;

export const EmailCaptureErrorReason = Schema.Literals([
  "not-found",
  "invalid",
  "conflict",
  "listener",
  "storage",
]);
export type EmailCaptureErrorReason = typeof EmailCaptureErrorReason.Type;

export class EmailCaptureError extends Schema.TaggedErrorClass<EmailCaptureError>()(
  "EmailCaptureError",
  {
    reason: EmailCaptureErrorReason,
    message: Schema.String,
    messageId: Schema.optional(EmailMessageId),
  },
) {}
