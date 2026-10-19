/** Business tools execute as the owner of an authorized PA assignment. */
import * as Schema from "effect/Schema";
import {
  MailAccount,
  MailBucket,
  MailDraft,
  MailMessage,
  MailMessageDetail,
  MailSenderKnowledge,
} from "./mail.ts";
import { TrackedSession, TrackedSessionPage, RecentTrackedTimeTotals } from "./businessTools.ts";

const mailPage = {
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
};
export const DelegatedMailRead = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("accounts") }),
  Schema.Struct({
    operation: Schema.Literal("messages"),
    accountId: Schema.optionalKey(Schema.String),
    bucket: Schema.optionalKey(MailBucket),
    ...mailPage,
  }),
  Schema.Struct({ operation: Schema.Literal("message"), messageId: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("thread"),
    accountId: Schema.String,
    providerThreadId: Schema.String,
    ...mailPage,
  }),
  Schema.Struct({ operation: Schema.Literal("drafts"), accountId: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("sender"),
    accountId: Schema.String,
    email: Schema.String,
  }),
]);
export type DelegatedMailRead = typeof DelegatedMailRead.Type;
export const DelegatedMailReadResult = Schema.Union([
  Schema.Array(MailAccount),
  Schema.Array(MailDraft),
  MailMessageDetail,
  Schema.NullOr(MailSenderKnowledge),
  Schema.Struct({ messages: Schema.Array(MailMessage), nextCursor: Schema.NullOr(Schema.String) }),
]);
export const DelegatedMailWrite = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("saveDraft"),
    accountId: Schema.String,
    draftId: Schema.optionalKey(Schema.String),
    replyToMessageId: Schema.optionalKey(Schema.String),
    to: Schema.Array(Schema.String),
    subject: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({ operation: Schema.Literal("discardDraft"), draftId: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("send"), draftId: Schema.String }),
]);
export type DelegatedMailWrite = typeof DelegatedMailWrite.Type;
export const DelegatedMailWriteResult = Schema.Struct({
  draftId: Schema.String,
  status: Schema.Literals(["draft", "discarded", "queued"]),
});
export const DelegatedTimeRead = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("list"),
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    since: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("totals"),
    todayStart: Schema.String,
    weekStart: Schema.String,
  }),
]);
export type DelegatedTimeRead = typeof DelegatedTimeRead.Type;
export const DelegatedTimeReadResult = Schema.Union([TrackedSessionPage, RecentTrackedTimeTotals]);
export const DelegatedTimeWrite = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("start"),
    id: Schema.String,
    description: Schema.String,
    projectKey: Schema.String,
    projectName: Schema.String,
    title: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ operation: Schema.Literal("stop"), id: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("remove"), id: Schema.String }),
]);
export type DelegatedTimeWrite = typeof DelegatedTimeWrite.Type;
export const DelegatedTimeWriteResult = Schema.NullOr(TrackedSession);
