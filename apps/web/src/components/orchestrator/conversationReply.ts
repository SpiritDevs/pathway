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
    ...(message.worker?.orchestratorId
      ? { orchestratorId: message.worker.orchestratorId }
      : message.senderKind === "orchestrator"
        ? { orchestratorId: message.senderId }
        : {}),
  };
}

/** Leaving or replacing an edit restores the draft that preceded it. */
export function transitionConversationReply(
  draft: string,
  current: ConversationReply | undefined,
  next: ConversationReply | undefined,
) {
  const restoredDraft = current?.kind === "edit" ? (current.previousDraft ?? "") : draft;
  return {
    reply: next?.kind === "edit" ? { ...next, previousDraft: restoredDraft } : next,
    draft: next?.kind === "edit" ? next.text : current?.kind === "edit" ? restoredDraft : undefined,
  };
}

export function canDirectMessageWorker(
  message: OrchestratorMessage,
  contacts: readonly { id: string; canDirect: boolean }[],
) {
  return (
    !!message.worker?.orchestratorId &&
    contacts.some((contact) => contact.id === message.worker?.orchestratorId && contact.canDirect)
  );
}
