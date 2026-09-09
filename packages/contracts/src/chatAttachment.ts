import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

import { SnapShotSource } from "./snapShot.ts";

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_ATTACHMENT_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  source: Schema.optional(SnapShotSource),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[^\s/]+\/[^\s/]+$/i),
  ),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

/**
 * Forward-compatible attachment metadata. A newer environment may introduce
 * another attachment kind before every client has updated; preserving the
 * common fields lets older clients render an inert row instead of rejecting
 * the entire thread projection.
 */
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENT_DATA_URL_CHARS),
  ),
  source: Schema.optional(SnapShotSource),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[^\s/]+\/[^\s/]+$/i),
  ),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENT_DATA_URL_CHARS),
  ),
});
export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;

/** Saved answer attachments are grouped by the question that owns them. */
export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])),
).check(
  Schema.makeFilter(
    (value) =>
      Object.values(value).reduce((count, attachments) => count + attachments.length, 0) <=
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

const PendingChatAttachmentId = ChatAttachmentId.check(
  Schema.isPattern(
    /^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9]{1,10}$/i,
  ),
);

export const PendingChatAttachment = Schema.Union([
  Schema.Struct({ ...ChatImageAttachment.fields, id: PendingChatAttachmentId }),
  Schema.Struct({ ...ChatFileAttachment.fields, id: PendingChatAttachmentId }),
]);
export type PendingChatAttachment = typeof PendingChatAttachment.Type;

export const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatFileAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const PersistChatAttachmentsInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachments: Schema.Array(Schema.Union([UploadChatAttachment, PendingChatAttachment])),
});
export type PersistChatAttachmentsInput = typeof PersistChatAttachmentsInput.Type;

export const PersistChatAttachmentsResult = Schema.Struct({
  attachments: Schema.Array(ChatAttachment),
});
export type PersistChatAttachmentsResult = typeof PersistChatAttachmentsResult.Type;

export class PersistChatAttachmentsError extends Schema.TaggedErrorClass<PersistChatAttachmentsError>()(
  "PersistChatAttachmentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
