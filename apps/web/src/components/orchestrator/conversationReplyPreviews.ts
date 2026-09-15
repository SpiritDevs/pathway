import type { OrchestratorMessage } from "@spiritdevs/contracts/aiOrchestrator";

/** Suppress only an uninterrupted coordinator response to a visible user request. */
export function redundantReplyPreviews(messages: readonly OrchestratorMessage[]) {
  const hidden = new Set<string>();
  let request: OrchestratorMessage | undefined;
  let coordinator: string | undefined;
  let previous: OrchestratorMessage | undefined;
  for (const message of messages) {
    if (
      previous &&
      (message.chatId !== previous.chatId ||
        message.sequence !== previous.sequence + 1 ||
        message.createdAt < previous.createdAt ||
        message.createdAt - previous.createdAt > 2 * 60 * 60 * 1000)
    ) {
      request = undefined;
      coordinator = undefined;
    }
    if (message.senderKind === "user") {
      request = message;
      coordinator = undefined;
    } else if (
      request &&
      message.senderKind === "orchestrator" &&
      !message.worker &&
      message.replyToId === request.id &&
      (coordinator === undefined || coordinator === message.senderId)
    ) {
      hidden.add(message.id);
      coordinator = message.senderId;
    } else {
      request = undefined;
      coordinator = undefined;
    }
    previous = message;
  }
  return hidden;
}
