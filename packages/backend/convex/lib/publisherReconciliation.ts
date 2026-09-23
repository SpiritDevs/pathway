/**
 * Full scans repair missed events periodically; unchanged 15-second publisher ticks are cheap.
 * Updated servers only call when an id left their inventory or this interval passed.
 */
export const PUBLISHER_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1_000;

export async function publisherInventoryFingerprint(ids: ReadonlySet<string>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([...ids].sort())),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function publisherReconciliationDue(
  previous: { fingerprint: string; completedAt: number } | undefined,
  fingerprint: string,
  now: number,
): boolean {
  return (
    previous === undefined ||
    previous.fingerprint !== fingerprint ||
    now - previous.completedAt >= PUBLISHER_RECONCILIATION_INTERVAL_MS
  );
}
