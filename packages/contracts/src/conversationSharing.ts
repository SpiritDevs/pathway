import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudAgentThreadShell } from "./cloudProject.ts";

export const ConversationShareAccess = Schema.Literals(["view", "collaborate"]);
export type ConversationShareAccess = typeof ConversationShareAccess.Type;

export const ConversationShare = Schema.Struct({
  id: TrimmedNonEmptyString,
  companyId: TrimmedNonEmptyString,
  companyName: Schema.String,
  recipientUserId: TrimmedNonEmptyString,
  recipientName: Schema.String,
  access: ConversationShareAccess,
});
export type ConversationShare = typeof ConversationShare.Type;

export const PersonalConversation = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  ownerUserId: TrimmedNonEmptyString,
  access: Schema.Literals(["owner", "view", "collaborate"]),
  shareId: Schema.NullOr(TrimmedNonEmptyString),
  shell: CloudAgentThreadShell,
});
export type PersonalConversation = typeof PersonalConversation.Type;

export const ConversationShareSession = Schema.Struct({
  shareId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  ownerUserId: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
  membershipId: TrimmedNonEmptyString,
  access: ConversationShareAccess,
  conversations: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      ownerUserId: TrimmedNonEmptyString,
      access: ConversationShareAccess,
    }),
  ),
});
export type ConversationShareSession = typeof ConversationShareSession.Type;

export const CONVERSATION_SHARE_SUBJECT_PREFIX = "conversation-share:";

export function conversationShareSubject(shareId: string): string {
  return `${CONVERSATION_SHARE_SUBJECT_PREFIX}${shareId}`;
}

export function conversationShareIdFromSubject(subject: string): string | null {
  if (!subject.startsWith(CONVERSATION_SHARE_SUBJECT_PREFIX)) return null;
  return subject.slice(CONVERSATION_SHARE_SUBJECT_PREFIX.length);
}
