/** Owner-private connected mailbox wire records. Relay credentials never cross into clients. */
import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";

export const MailBucket = Schema.Literals(["priority", "noise"]);
export type MailBucket = typeof MailBucket.Type;
export const MailBrain = Schema.Struct({
  primaryEnvironmentId: Schema.String,
  backupEnvironmentId: Schema.optionalKey(Schema.String),
  selection: ModelSelection,
  backupSelection: Schema.optionalKey(ModelSelection),
});
export type MailBrain = typeof MailBrain.Type;
export const MailAccount = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  credentialSource: Schema.Literals(["byo", "hosted"]),
  status: Schema.Literals(["active", "reauth_required", "disconnected"]),
  brain: Schema.optionalKey(MailBrain),
  lastSyncAt: Schema.optionalKey(Schema.Number),
  lastError: Schema.optionalKey(Schema.String),
});
export type MailAccount = typeof MailAccount.Type;
export const MailAttachment = Schema.Struct({
  partId: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  blobKey: Schema.optionalKey(Schema.String),
});
export type MailAttachment = typeof MailAttachment.Type;
export const MailMessage = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  providerMessageId: Schema.String,
  providerThreadId: Schema.String,
  historyId: Schema.optionalKey(Schema.String),
  from: Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  snippet: Schema.String,
  receivedAt: Schema.Number,
  labels: Schema.Array(Schema.String),
  attachments: Schema.Array(MailAttachment),
  read: Schema.Boolean,
  bucket: MailBucket,
  reason: Schema.String,
  analysisStatus: Schema.Literals(["pending", "ready", "failed"]),
  briefing: Schema.optionalKey(Schema.String),
  classificationRevision: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type MailMessage = typeof MailMessage.Type;
export const MailMessageDetail = Schema.Struct({
  ...MailMessage.fields,
  textBody: Schema.optionalKey(Schema.String),
  htmlBody: Schema.optionalKey(Schema.String),
  bodyBlobKey: Schema.optionalKey(Schema.String),
  bodyTruncated: Schema.optionalKey(Schema.Boolean),
});
export type MailMessageDetail = typeof MailMessageDetail.Type;
export const MailDraft = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  replyToMessageId: Schema.optionalKey(Schema.String),
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["draft", "queued", "sending", "sent", "failed", "unknown"]),
  generation: Schema.Number,
  providerMessageId: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type MailDraft = typeof MailDraft.Type;
export const MailSenderKnowledge = Schema.Struct({
  accountId: Schema.String,
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
  summary: Schema.String,
  messageCount: Schema.Number,
  lastMessageAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type MailSenderKnowledge = typeof MailSenderKnowledge.Type;

/** Minimal, bounded work payload available only to the selected environment. */
export const MailAnalysisJob = Schema.Struct({
  id: Schema.String,
  generation: Schema.Number,
  kind: Schema.Literals(["analyze", "brief", "draft"]),
  forcedBucket: Schema.optionalKey(MailBucket),
  selection: ModelSelection,
  message: Schema.Struct({
    from: Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
    to: Schema.Array(Schema.String),
    subject: Schema.String,
    snippet: Schema.optionalKey(Schema.String),
    textBody: Schema.optionalKey(Schema.String),
    htmlBody: Schema.optionalKey(Schema.String),
    bodyTruncated: Schema.optionalKey(Schema.Boolean),
    bucket: MailBucket,
    reason: Schema.String,
  }),
  senderKnowledge: Schema.NullOr(Schema.Struct({ summary: Schema.String })),
  instructions: Schema.optionalKey(Schema.String),
});
export type MailAnalysisJob = typeof MailAnalysisJob.Type;
export const MailAnalysisResult = Schema.Struct({
  bucket: MailBucket,
  reason: Schema.String,
  briefing: Schema.optionalKey(Schema.String),
  senderSummary: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(
    Schema.Struct({
      to: Schema.Array(Schema.String),
      subject: Schema.String,
      text: Schema.String,
    }),
  ),
});
export type MailAnalysisResult = typeof MailAnalysisResult.Type;
