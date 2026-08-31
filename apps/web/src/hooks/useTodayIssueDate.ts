/**
 * Today, kept true for as long as a surface stays open.
 *
 * A calendar left open past local midnight otherwise calls yesterday today: the Today button lands
 * on the wrong day, the grid highlights the wrong column, and a cycle that started this morning
 * still reads as upcoming — the stale label AGENTS.md says our users notice. One shared timeout
 * fires on the next local midnight rather than a tick a minute, so between two midnights nothing
 * here repaints at all. The `useSyncExternalStore` shape is `useNowMinute`'s, at the cadence a
 * calendar day actually changes at.
 */
import type { IssueDate } from "@spiritdevs/contracts";
import { useSyncExternalStore } from "react";

import { todayIssueDate } from "~/state/issues";

/**
 * How long until the local day rolls over. Never zero, so a timeout that fires a moment early
 * re-arms rather than spinning on the same boundary.
 */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

let today = todayIssueDate();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  timerId = null;
  const next = todayIssueDate();
  if (next !== today) {
    today = next;
    for (const listener of listeners) listener();
  }
  // Re-armed off the clock rather than by a fixed period, so a timeout that fires late — a laptop
  // asleep through midnight — lands on the next boundary instead of drifting past it.
  if (listeners.size > 0) arm();
}

function arm(): void {
  timerId = window.setTimeout(tick, msUntilNextLocalMidnight());
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) arm();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): IssueDate {
  // With no timer running the stored day may be stale — the first render after a full unmount, or
  // one before any subscriber — so re-read it. While the timer runs the cached value is returned
  // untouched, as useSyncExternalStore requires between notifications.
  if (timerId === null) today = todayIssueDate();
  return today;
}

export function useTodayIssueDate(): IssueDate {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
