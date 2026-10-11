import type { OrchestratorMessage } from "@spiritdevs/contracts/aiOrchestrator";

/**
 * Suppress only an uninterrupted coordinator response to a visible user request, or an answer
 * to a reaction on the message directly above. Messages one person sends back to back count
 * as a single request, whichever of them the reply targets.
 */
export function redundantReplyPreviews(messages: readonly OrchestratorMessage[]) {
  const hidden = new Set<string>();
  const request = new Set<string>();
  let requester: string | undefined;
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
      request.clear();
      coordinator = undefined;
    }
    // A reaction is answered through a hidden note, so the reply quotes the message that was
    // reacted to. Directly under that message, the quote only repeats it.
    if (
      previous &&
      message.reply &&
      message.reply.id !== message.replyToId &&
      message.reply.id === previous.id &&
      message.chatId === previous.chatId
    )
      hidden.add(message.id);
    if (message.senderKind === "user") {
      if (coordinator !== undefined || requester !== message.senderId) request.clear();
      request.add(message.id);
      requester = message.senderId;
      coordinator = undefined;
    } else if (
      message.senderKind === "orchestrator" &&
      !message.worker &&
      message.replyToId != null &&
      request.has(message.replyToId) &&
      (coordinator === undefined || coordinator === message.senderId)
    ) {
      hidden.add(message.id);
      coordinator = message.senderId;
    } else {
      request.clear();
      coordinator = undefined;
    }
    previous = message;
  }
  return hidden;
}
