/**
 * Fractional ordering keys for the issue list.
 *
 * Same base-26 scheme `pin_order_key` uses (`packages/client-runtime/src/state/threadSort.ts`):
 * a move writes ONE key to ONE row, so reordering never rewrites the neighbours and two clients
 * that drop a row in the same place converge. The algorithm is duplicated rather than imported
 * because the server does not depend on the client runtime.
 *
 * @module issues/sortOrder
 */

const SORT_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

/**
 * A trailing minimum digit would leave no room to sort a key immediately before this one;
 * generators never produce it, so treat it as corrupt.
 */
export function isIssueSortOrder(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!SORT_ORDER_DIGITS.includes(char)) return false;
  }
  return key.at(-1) !== SORT_ORDER_DIGITS[0];
}

/**
 * Midpoint of two digit strings read as fractions in (0, 1). `""` stands for the open bound on
 * either side. Requires `a < b`.
 */
function sortOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("sortOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || SORT_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + sortOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : SORT_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? SORT_ORDER_DIGITS.length : SORT_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return SORT_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into, or we extend a (never
  // producing a trailing minimum digit — the base case midpoint("", "") is the middle digit).
  if (b.length > 1) return b.charAt(0);
  return SORT_ORDER_DIGITS.charAt(digitA) + sortOrderMidpoint(a.slice(1), "");
}

/**
 * Key that sorts strictly between two neighbours; null bounds mean "before everything" and
 * "after everything". Returns null when a neighbour key is corrupt or the pair is out of order,
 * so callers can fall back rather than write a key that breaks the total order.
 */
export function issueSortOrderBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isIssueSortOrder(a)) return null;
  if (b !== "" && !isIssueSortOrder(b)) return null;
  if (b !== "" && a >= b) return null;
  return sortOrderMidpoint(a, b);
}

/**
 * Key for a row appended after `last`, which is the only insertion the server itself performs —
 * a create lands at the bottom of its status and a drag arrives with its key already computed.
 *
 * Appending a digit to a corrupt key still sorts after it, so an imported or hand-edited key
 * never blocks a create.
 */
export function issueSortOrderAfter(last: string | null): string {
  return (
    issueSortOrderBetween(last, null) ??
    `${last ?? ""}${SORT_ORDER_DIGITS.charAt(SORT_ORDER_DIGITS.length >> 1)}`
  );
}
