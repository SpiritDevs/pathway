import type { EnvironmentThreadHistory } from "@spiritdevs/client-runtime/state/threads";
import type { MessageId } from "@spiritdevs/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly messageId: MessageId;
  readonly rowIndex: number | null;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.slice(0, 500).replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

/** Keep every prompt navigable while only the current history window has rows. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
  index: EnvironmentThreadHistory["index"] = [],
): TimelineMinimapItem[] {
  const loadedItems: TimelineMinimapItem[] = [];
  let finalAssistantText: string | null = null;
  let hasFinalAssistantMessage = false;
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    if (row?.kind !== "message") continue;
    if (row.message.role === "assistant") {
      if (!hasFinalAssistantMessage) {
        finalAssistantText = row.message.text ?? null;
        hasFinalAssistantMessage = true;
      }
      continue;
    }
    if (row.message.role !== "user") continue;
    loadedItems.push({
      id: row.message.id,
      messageId: row.message.id,
      rowIndex,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(finalAssistantText),
    });
    finalAssistantText = null;
    hasFinalAssistantMessage = false;
  }
  loadedItems.reverse();
  if (index.length === 0) return loadedItems;

  const loadedById = new Map(loadedItems.map((item) => [item.messageId, item]));
  const items = index.map((entry): TimelineMinimapItem => {
    const loaded = loadedById.get(entry.messageId);
    loadedById.delete(entry.messageId);
    return {
      id: entry.messageId,
      messageId: entry.messageId,
      rowIndex: loaded?.rowIndex ?? null,
      userText: loaded?.userText ?? compactMinimapPreview(entry.preview),
      assistantText: loaded?.assistantText ?? compactMinimapPreview(entry.assistantPreview),
    };
  });
  // New live prompts can arrive before the next index snapshot.
  items.push(...loadedById.values());
  return items;
}

/** Adjacent pages start loading this many viewports before their edge scrolls into view. */
export const TIMELINE_HISTORY_PREFETCH_VIEWPORTS = 2.5;
const TIMELINE_HISTORY_MIN_PREFETCH_PX = 120;

/** Prefetch only on user movement toward an edge, never from initial layout or a prepend. */
export function resolveTimelineHistoryPrefetch(input: {
  readonly previousScroll: number | null;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly distanceToEnd: number;
  readonly liveFollowEnabled: boolean;
  readonly userScrollDirection: "older" | "newer" | "either" | null;
  readonly history: Pick<
    EnvironmentThreadHistory,
    "hasOlder" | "hasNewer" | "isLoading" | "isPrefetching" | "error"
  > | null;
}): "older" | "newer" | null {
  const { history, previousScroll, scroll } = input;
  if (
    !history ||
    history.isLoading ||
    history.isPrefetching ||
    history.error ||
    previousScroll === null ||
    input.liveFollowEnabled ||
    input.userScrollDirection === null
  ) {
    return null;
  }
  const runway = Math.max(
    TIMELINE_HISTORY_MIN_PREFETCH_PX,
    input.scrollLength * TIMELINE_HISTORY_PREFETCH_VIEWPORTS,
  );
  if (
    history.hasOlder &&
    input.userScrollDirection !== "newer" &&
    scroll < previousScroll &&
    scroll <= runway
  )
    return "older";
  if (
    history.hasNewer &&
    input.userScrollDirection !== "older" &&
    scroll > previousScroll &&
    input.distanceToEnd <= runway
  )
    return "newer";
  return null;
}

/** Returning to live content cancels a pending remote marker, even if its row arrives late. */
export function resolveTimelineHistoryNavigation(input: {
  readonly messageId: MessageId | null;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly liveFollowEnabled: boolean;
  readonly isLoading: boolean;
}): { readonly kind: "cancel" | "wait" } | { readonly kind: "scroll"; readonly rowIndex: number } {
  if (input.liveFollowEnabled) return { kind: "cancel" };
  if (input.messageId === null || input.isLoading) return { kind: "wait" };
  const rowIndex = input.rows.findIndex(
    (row) => row.kind === "message" && row.message.id === input.messageId,
  );
  return rowIndex < 0 ? { kind: "wait" } : { kind: "scroll", rowIndex };
}
