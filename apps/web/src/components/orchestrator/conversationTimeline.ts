import type {
  OrchestratorMessage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";

type TimelineEntry =
  | { kind: "message"; message: OrchestratorMessage; index: number }
  | { kind: "work"; id: string; items: OrchestratorWorkItem[] };

// Keep message sequence authoritative and insert work by its immutable creation time.
export function buildConversationTimeline(
  messages: readonly OrchestratorMessage[],
  work: readonly OrchestratorWorkItem[],
) {
  const pending = [...work].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
  const entries: TimelineEntry[] = [];
  let cursor = 0;
  const appendWorkBefore = (time: number) => {
    const items: OrchestratorWorkItem[] = [];
    while (cursor < pending.length && (pending[cursor]!.createdAt ?? 0) < time) {
      items.push(pending[cursor++]!);
    }
    if (items.length) entries.push({ kind: "work", id: `work:${items[0]!.id}`, items });
  };
  messages.forEach((message, index) => {
    appendWorkBefore(message.createdAt);
    entries.push({ kind: "message", message, index });
  });
  appendWorkBefore(Infinity);
  return entries.map((entry, index) => {
    if (entry.kind === "work") return entry;
    const previous = messages[entry.index - 1];
    return {
      ...entry,
      startsGroup: !canGroup(entries[index - 1], entry),
      endsGroup: !canGroup(entry, entries[index + 1]),
      timeMarker:
        !previous ||
        new Date(previous.createdAt).toDateString() !==
          new Date(entry.message.createdAt).toDateString() ||
        entry.message.createdAt - previous.createdAt > 2 * 60 * 60 * 1000,
    };
  });
}

function canGroup(previous: TimelineEntry | undefined, next: TimelineEntry | undefined) {
  if (previous?.kind !== "message" || next?.kind !== "message") return false;
  const a = previous.message;
  const b = next.message;
  const gap = b.createdAt - a.createdAt;
  return (
    a.senderKind !== "system" &&
    a.senderKind === b.senderKind &&
    a.senderId === b.senderId &&
    b.sequence === a.sequence + 1 &&
    gap >= 0 &&
    gap <= 5 * 60 * 1000 &&
    new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString()
  );
}

export const conversationMessageTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function conversationTimeMarker(timestamp: number, now = Date.now()) {
  const date = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day =
    date.toDateString() === today.toDateString()
      ? "Today"
      : date.toDateString() === yesterday.toDateString()
        ? "Yesterday"
        : new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
          }).format(date);
  return `${day} ${conversationMessageTime.format(date)}`;
}
