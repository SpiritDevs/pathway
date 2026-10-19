import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  conversationShareSubject,
  type ConversationShareSession,
} from "@spiritdevs/contracts";
import { canAccessConversation, sharedConversationHttpRequestAllowed } from "./ThreadAccess.ts";

const share: ConversationShareSession = {
  shareId: "share-a",
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread-a"),
  ownerUserId: "owner",
  userId: "recipient",
  membershipId: "member-recipient",
  access: "view",
  conversations: [
    { threadId: ThreadId.make("thread-a"), ownerUserId: "owner", access: "view" },
    { threadId: ThreadId.make("thread-b"), ownerUserId: "owner", access: "collaborate" },
  ],
};
const principal = {
  subject: conversationShareSubject(share.shareId),
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
describe("conversation access", () => {
  it("limits shared connections to each thread's current grant", () => {
    const allows = (
      id: string,
      action: "read" | "collaborate" | "manage",
      current = share as ConversationShareSession | null,
    ) =>
      canAccessConversation({
        principal,
        linkedOwnerUserId: "owner",
        thread: { id: ThreadId.make(id), projectId: null, ownerUserId: "owner" },
        share: current,
        action,
      });
    expect(allows("thread-a", "read")).toBe(true);
    expect(allows("thread-a", "collaborate")).toBe(false);
    expect(allows("thread-b", "collaborate")).toBe(true);
    expect(allows("thread-b", "manage")).toBe(false);
    expect(allows("thread-private", "read")).toBe(false);
    expect(allows("thread-a", "read", null)).toBe(false);
    expect(
      allows("thread-b", "collaborate", {
        ...share,
        conversations: share.conversations.map((row) => ({ ...row, access: "view" })),
      }),
    ).toBe(false);
  });
  it("does not grant personal conversations to a company peer", () => {
    const thread = { id: ThreadId.make("private"), projectId: null, ownerUserId: "owner" };
    expect(
      canAccessConversation({
        principal: {
          subject: "another-cloud-user",
          initiatingEnvironmentId: EnvironmentId.make("peer"),
          scopes: principal.scopes,
        },
        linkedOwnerUserId: "owner",
        thread,
        share: null,
        action: "read",
      }),
    ).toBe(false);
    expect(
      canAccessConversation({
        principal: { subject: "desktop-bootstrap", scopes: principal.scopes },
        linkedOwnerUserId: "owner",
        thread,
        share: null,
        action: "manage",
      }),
    ).toBe(true);
    expect(
      canAccessConversation({
        principal: { subject: "another-cloud-user", scopes: principal.scopes },
        linkedOwnerUserId: "owner",
        thread,
        share: null,
        action: "read",
      }),
    ).toBe(false);
  });
  it("restricts shared HTTP sessions to authenticated conversation reads and socket tickets", () => {
    expect(sharedConversationHttpRequestAllowed("GET", "/api/orchestration/shell")).toBe(true);
    expect(sharedConversationHttpRequestAllowed("GET", "/api/orchestration/threads/thread-a")).toBe(
      true,
    );
    expect(sharedConversationHttpRequestAllowed("POST", "/api/auth/websocket-ticket")).toBe(true);
    for (const path of [
      "/api/files/read",
      "/api/terminal",
      "/api/auth/pairing-links",
      "/api/config",
      "/api/orchestration/threads/thread-a/other",
    ])
      expect(sharedConversationHttpRequestAllowed("GET", path)).toBe(false);
  });
});
