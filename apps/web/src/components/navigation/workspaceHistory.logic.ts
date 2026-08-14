import type { RouterHistory } from "@tanstack/react-router";

type HistoryAction = "PUSH" | "REPLACE" | "FORWARD" | "BACK" | "GO";

export type ForwardHistoryTracker = {
  furthestIndex: number;
  index: number;
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

const trackerListeners = new WeakMap<ForwardHistoryTracker, Set<() => void>>();

export function createForwardHistoryTracker(index: number): ForwardHistoryTracker {
  const listeners = new Set<() => void>();
  const tracker: ForwardHistoryTracker = {
    furthestIndex: index,
    index,
    getSnapshot: () => tracker.index < tracker.furthestIndex,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  trackerListeners.set(tracker, listeners);
  return tracker;
}

export function recordForwardHistoryNavigation(
  tracker: ForwardHistoryTracker,
  index: number,
  action?: HistoryAction,
): boolean {
  const wasAvailable = tracker.getSnapshot();
  // A new entry discards the browser's forward stack. When observing an
  // existing entry (including after a component remount), retain the furthest
  // index already reached by this history instance.
  tracker.furthestIndex = action === "PUSH" ? index : Math.max(tracker.furthestIndex, index);
  tracker.index = index;
  const isAvailable = tracker.getSnapshot();
  if (isAvailable !== wasAvailable) {
    for (const listener of trackerListeners.get(tracker) ?? []) listener();
  }
  return isAvailable;
}

const forwardHistoryTrackers = new WeakMap<RouterHistory, ForwardHistoryTracker>();

export function forwardHistoryTracker(history: RouterHistory): ForwardHistoryTracker {
  const existing = forwardHistoryTrackers.get(history);
  if (existing) return existing;

  const tracker = createForwardHistoryTracker(history.location.state.__TSR_index);
  forwardHistoryTrackers.set(history, tracker);
  // This subscription intentionally shares the history instance's lifetime so
  // pushes on routes without workspace controls still discard the forward range.
  history.subscribe(({ location, action }) => {
    recordForwardHistoryNavigation(tracker, location.state.__TSR_index, action.type);
  });
  return tracker;
}
