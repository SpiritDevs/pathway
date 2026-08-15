/**
 * Domain ids this deployment mints for itself.
 *
 * Most domain ids arrive from the client, which is what lets an offline write name its own entity
 * before it has ever reached the server. A few rows have no client to name them — the membership,
 * settings, and seed roles created *with* a company, and the rows an invitation acceptance writes
 * for someone holding a link rather than a sync engine — so they are minted here.
 *
 * @module lib/domainIds
 */

/**
 * A fresh UUIDv7 domain id, in the same layout client-authored ids use so that ordering by id keeps
 * meaning creation order across both sources.
 *
 * `crypto.randomUUID` is the entropy: the Convex runtime seeds it per function execution, so a
 * mutation Convex re-runs after an OCC conflict re-derives the same ids rather than leaving two
 * half-created companies behind.
 */
export function mintDomainId(now: number): string {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - Convex functions run in Convex's V8 runtime with no Effect runtime; `crypto` is the randomness it seeds per execution.
  const random = crypto.randomUUID();
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    // Version nibble 7, then the random group the v4 source used for its own version nibble.
    `7${random.slice(15, 18)}`,
    // Already carries the RFC 4122 variant bits, so it transplants unchanged.
    random.slice(19, 23),
    random.slice(24),
  ].join("-");
}
