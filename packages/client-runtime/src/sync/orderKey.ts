/**
 * Fractional order keys for offline-reorderable collections.
 *
 * A move writes one key to one row, so two clients that drop a row in the same place converge
 * without rewriting neighbours. The base-26 midpoint scheme is the one the sidebar already uses
 * (`state/threadSort.ts`) and is reused here rather than copied — the server keeps its own copy in
 * `apps/server/src/issues/sortOrder.ts` only because it cannot depend on the client runtime.
 *
 * Equal keys are still possible when two offline clients insert into the same gap, so ordering is
 * never key-only: {@link compareSyncOrder} breaks ties by entity id, which every client resolves
 * identically.
 *
 * @module sync/orderKey
 */
import { pinOrderKeyBetween } from "../state/threadSort.ts";

/** Middle of the alphabet — the key `pinOrderKeyBetween(null, null)` produces. */
const ORDER_KEY_MIDDLE_DIGIT = "n";

export interface SyncOrdered {
  readonly id: string;
  readonly orderKey: string;
}

/**
 * Key that sorts strictly between two neighbours; `null` bounds mean "before everything" and
 * "after everything". Returns `null` when a neighbour key is corrupt or the pair is out of order,
 * so callers fall back rather than writing a key that breaks the total order.
 */
export function syncOrderKeyBetween(before: string | null, after: string | null): string | null {
  return pinOrderKeyBetween(before, after);
}

/**
 * Key for a row appended after `last`. Appending a digit to a corrupt key still sorts after it,
 * so an imported or hand-edited key never blocks a create.
 */
export function syncOrderKeyAfter(last: string | null): string {
  return syncOrderKeyBetween(last, null) ?? `${last ?? ""}${ORDER_KEY_MIDDLE_DIGIT}`;
}

/** Total order over a reorderable collection: key first, entity id as the tie-break. */
export function compareSyncOrder(left: SyncOrdered, right: SyncOrdered): number {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function sortBySyncOrder<T extends SyncOrdered>(values: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...values].sort(compareSyncOrder);
}
