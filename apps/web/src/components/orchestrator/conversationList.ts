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

/** Both presentations share the companion's exact top and height. */
export function conversationPanelLayout(bounds: {
  left: number;
  top: number;
  height: number;
  width: number;
}) {
  const docked = bounds.left >= 336;
  return {
    docked,
    left: docked ? bounds.left - 320 : bounds.left,
    top: bounds.top,
    width: docked ? 320 : bounds.width,
    height: bounds.height,
    panelWidth: docked ? 320 : Math.min(320, Math.max(0, bounds.width - 40)),
  };
}
