type HistoryAction = "PUSH" | "REPLACE" | "FORWARD" | "BACK" | "GO";

export type ForwardHistoryTracker = {
  furthestIndex: number;
};

export function createForwardHistoryTracker(index: number): ForwardHistoryTracker {
  return { furthestIndex: index };
}

export function recordForwardHistoryNavigation(
  tracker: ForwardHistoryTracker,
  index: number,
  action?: HistoryAction,
): boolean {
  // A new entry discards the browser's forward stack. When observing an
  // existing entry (including after a component remount), retain the furthest
  // index already reached by this history instance.
  tracker.furthestIndex = action === "PUSH" ? index : Math.max(tracker.furthestIndex, index);
  return index < tracker.furthestIndex;
}
