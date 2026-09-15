import type { OrchestratorMessage } from "@spiritdevs/contracts/aiOrchestrator";

/** Composer context survives switching between the floating and full conversation. */
export type ConversationReply = {
  kind: "reply" | "worker" | "edit";
  name: string;
  text: string;
  messageId?: string;
  workId?: string;
  orchestratorId?: string;
  deliveryId?: string;
  revision?: number;
  previousDraft?: string;
};

export function replyToMessage(message: OrchestratorMessage): ConversationReply {
  return {
    kind: "reply",
    name: message.senderName,
    text: message.text || message.attachments?.[0]?.name || "Attachment",
    messageId: message.id,
    ...(message.worker ? { workId: message.worker.workId } : {}),
    ...(message.senderKind === "orchestrator" ? { orchestratorId: message.senderId } : {}),
  };
}
