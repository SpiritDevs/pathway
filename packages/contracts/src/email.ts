/**
 * Local SMTP capture contracts.
 *
 * Capture is scoped to the primary environment. Messages retain their SMTP and MIME provenance so
 * the Email view can explain routing and parsing without reaching back into the capture service.
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
  markRead: "email.markRead",
  markUnread: "email.markUnread",
  clearInbox: "email.clearInbox",
  getSettings: "email.getSettings",
  updateSettings: "email.updateSettings",
  stream: "email.stream",
} as const;

const makeEmailEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const EmailMessageId = makeEmailEntityId("EmailMessageId");
export type EmailMessageId = typeof EmailMessageId.Type;
export const EmailAttachmentId = makeEmailEntityId("EmailAttachmentId");
export type EmailAttachmentId = typeof EmailAttachmentId.Type;
export const EmailTriggerRuleId = makeEmailEntityId("EmailTriggerRuleId");
export type EmailTriggerRuleId = typeof EmailTriggerRuleId.Type;
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
  /** The AUTH username or recipient address that won. Null only for Unassigned. */
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

export const DetectedEmailCode = Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(8));
export type DetectedEmailCode = typeof DetectedEmailCode.Type;

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

export const EmailProjectSettings = Schema.Struct({
  projectId: ProjectId,
  mailSlug: EmailMailSlug,
  retention: EmailRetentionOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  toastMuted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  twoFactorCodeRegex: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  triggerRules: Schema.Array(EmailTriggerRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
  Schema.TaggedStruct("EmailSettingsChanged", { snapshot: EmailSettingsSnapshot }),
]);
export type EmailStreamEvent = typeof EmailStreamEvent.Type;

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
