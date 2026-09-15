import type { OrchestratorMessage, OrchestratorReader } from "@spiritdevs/contracts/aiOrchestrator";

export function hasReadMessage(reader: OrchestratorReader, message: OrchestratorMessage) {
  if (reader.id === message.senderId || message.sequence < reader.fromSequence) return false;
  return reader.kind === "user"
    ? (reader.readSequence ?? 0) >= message.sequence
    : (message.seenBy ?? []).includes(reader.id);
}

/** Each reader appears once, beneath their latest read outgoing message. */
export function placeConversationReaders(
  messages: readonly OrchestratorMessage[],
  readers: readonly OrchestratorReader[],
  accountID: string,
) {
  const placements = new Map<string, OrchestratorReader[]>();
  const outgoing = messages.filter(
    (message) => message.senderKind === "user" && message.senderId === accountID,
  );
  for (const reader of readers) {
    const message = outgoing.findLast((candidate) => hasReadMessage(reader, candidate));
    if (!message) continue;
    placements.set(message.id, [...(placements.get(message.id) ?? []), reader]);
  }
  return placements;
}

export function conversationReceiptLabel(
  message: OrchestratorMessage,
  readers: readonly OrchestratorReader[],
  sending = false,
) {
  if (sending) return "Sending…";
  if (message.delivery?.state === "removed" || message.status === "cancelled") return "Cancelled";
  if (message.delivery?.state === "failed") return "Could not deliver";
  if (message.status === "failed") return "Could not complete this request";
  if (readers.some((reader) => hasReadMessage(reader, message)) || message.seenAt !== undefined)
    return "Read";
  // A saved cloud message is delivered even while its work is waiting to run.
  return "Delivered";
}
