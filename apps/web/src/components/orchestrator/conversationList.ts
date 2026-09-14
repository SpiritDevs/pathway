import type { OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";

export function unreadMessageTotal(
  chats: readonly Pick<OrchestratorChat, "archived" | "unreadCount">[],
) {
  return chats.reduce(
    (count, chat) => count + (chat.archived ? 0 : Math.max(0, chat.unreadCount ?? 0)),
    0,
  );
}

export function unreadLabel(count: number) {
  return count > 99 ? "99+" : String(count);
}

export function conversationTime(timestamp: number, now = Date.now()) {
  const sent = new Date(timestamp);
  const today = new Date(now);
  return sent.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(sent)
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        ...(sent.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
      }).format(sent);
}
