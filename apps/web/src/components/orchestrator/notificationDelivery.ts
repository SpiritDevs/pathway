import type { OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";

/** Old, read, muted, and visible updates advance the watermark without interrupting the user. */
export function shouldNotifyOrchestrator(input: {
  chat: OrchestratorChat;
  seenSequence: number;
  startedAt: number;
  focusedChatId: string | null;
  quiet: boolean;
}) {
  const { chat, seenSequence, startedAt, focusedChatId, quiet } = input;
  const update = chat.notification;
  return (
    !!update &&
    update.enabled &&
    !chat.archived &&
    !quiet &&
    focusedChatId !== chat.id &&
    update.createdAt >= startedAt &&
    update.sequence > Math.max(seenSequence, chat.readSequence)
  );
}

/** A storage failure cannot create duplicate deliveries in every open tab. */
export async function claimOrchestratorNotification(
  userId: string,
  chat: OrchestratorChat,
  eligible: (seen: number) => boolean | null,
) {
  if (!chat.notification || !navigator.locks) return false;
  const key = `pathway:orchestrator-alerts:${userId}`;
  return navigator.locks
    .request(key, () => {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      const rows: Record<string, number> = {};
      if (typeof raw === "object" && raw !== null)
        for (const [id, value] of Object.entries(raw))
          if (typeof value === "number" && Number.isFinite(value)) rows[id] = value;
      const seen = rows[chat.id] ?? 0;
      if (chat.notification!.sequence <= seen) return false;
      const delivery = eligible(seen);
      if (delivery === null) return false;
      delete rows[chat.id];
      rows[chat.id] = chat.notification!.sequence;
      localStorage.setItem(
        key,
        JSON.stringify(Object.fromEntries(Object.entries(rows).slice(-200))),
      );
      return delivery;
    })
    .catch(() => false);
}
