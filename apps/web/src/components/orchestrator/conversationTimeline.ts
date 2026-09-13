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
): TimelineEntry[] {
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
  return entries;
}
