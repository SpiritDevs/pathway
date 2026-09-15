import { describe, expect, it } from "vite-plus/test";
import type { OrchestratorMessage } from "@spiritdevs/contracts/aiOrchestrator";
import {
  canDirectMessageWorker,
  replyToMessage,
  transitionConversationReply,
  type ConversationReply,
} from "./conversationReply";

const message: OrchestratorMessage = {
  id: "message",
  chatId: "chat",
  sequence: 1,
  createdAt: 1,
  senderKind: "user",
  senderId: "me",
  senderName: "Me",
  text: "Check this",
  status: "queued",
  replyToId: null,
  worker: { workId: "work", orchestratorId: "worker-owner" },
};

describe("conversation reply transitions", () => {
  it("retains a worker's orchestrator when replying to another user's message", () => {
    expect(replyToMessage(message)).toMatchObject({
      workId: "work",
      orchestratorId: "worker-owner",
      messageId: "message",
    });
  });
  it("requires direction permission for the message's worker", () => {
    expect(
      canDirectMessageWorker(message, [
        { id: "other", canDirect: true },
        { id: "worker-owner", canDirect: false },
      ]),
    ).toBe(false);
    expect(canDirectMessageWorker(message, [{ id: "worker-owner", canDirect: true }])).toBe(true);
    expect(
      canDirectMessageWorker({ ...message, worker: { workId: "work" } }, [
        { id: "other", canDirect: true },
      ]),
    ).toBe(false);
  });
  it("restores the original draft before switching from edit to reply or another edit", () => {
    const edit: ConversationReply = { kind: "edit", name: "Me", text: "Queued message" };
    const first = transitionConversationReply("My unsent draft", undefined, edit);
    expect(first.draft).toBe("Queued message");
    const reply = transitionConversationReply("Editing text", first.reply, replyToMessage(message));
    expect(reply.draft).toBe("My unsent draft");
    expect(reply.reply?.previousDraft).toBeUndefined();
    const nextEdit = transitionConversationReply("Editing text", first.reply, {
      ...edit,
      text: "Another queued message",
    });
    expect(nextEdit.draft).toBe("Another queued message");
    expect(transitionConversationReply("More edits", nextEdit.reply, undefined).draft).toBe(
      "My unsent draft",
    );
  });
});
