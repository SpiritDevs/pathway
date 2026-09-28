import type {
  OrchestrationV2ThreadItemsPage,
  OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";

/**
 * Trims a snapshot to its latest visible items for clients that page history in
 * on scroll. The raw `turnItems` and `nodes` collections are dropped because the
 * window already carries the visible items and they dominate long threads.
 */
export function windowThreadProjection(
  projection: OrchestrationV2ThreadProjection,
  limit: number,
): { readonly projection: OrchestrationV2ThreadProjection; readonly olderItemsBefore?: number } {
  const visibleTurnItems = projection.visibleTurnItems.slice(-limit);
  const first = visibleTurnItems[0];
  return {
    projection: { ...projection, turnItems: [], nodes: [], visibleTurnItems },
    ...(first !== undefined && visibleTurnItems.length < projection.visibleTurnItems.length
      ? { olderItemsBefore: first.position }
      : {}),
  };
}

/** Returns the page of visible items that precedes `beforePosition`. */
export function threadItemsBefore(
  projection: OrchestrationV2ThreadProjection,
  beforePosition: number,
  limit: number,
): OrchestrationV2ThreadItemsPage {
  const older = projection.visibleTurnItems.filter((row) => row.position < beforePosition);
  const items = older.slice(-limit);
  const first = items[0];
  return {
    items,
    ...(first !== undefined && items.length < older.length
      ? { olderItemsBefore: first.position }
      : {}),
  };
}
