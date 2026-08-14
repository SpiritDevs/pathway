/**
 * Cursor protocol for `sync.bootstrap`, the paginated full seed.
 *
 * A bootstrap walks the issue-domain tables in a fixed order, within each table ascending by
 * domain id — the one ordering every table can serve from its `by_company_and_domain_id` index
 * without ever revisiting or skipping a row as writes land mid-seed. The cursor token encodes the
 * walk position plus the company head captured on the first page; that head is the version the
 * finished seed is *consistent at*, because any row written after it carries a higher version and
 * will be re-delivered by the incremental drain that starts there. Re-applying such a row is an
 * idempotent upsert (or a tombstone for an entity the seed still included), so the handoff has no
 * gap and no double-apply hazard.
 *
 * The token is opaque to clients by contract; this module is the only place that knows its shape.
 *
 * @module sync/bootstrap
 */
import { SYNC_MAX_ID_CHARS } from "./operations.ts";
import type { SyncEntityKind } from "./protocol.ts";

/**
 * The tables a bootstrap seeds, in walk order. Only issue-domain kinds appear: the company-domain
 * mutations do not emit change-feed rows yet, so seeding those kinds here would hand clients rows
 * the incremental feed could never update — worse than not seeding them. The two lists must grow
 * together (see `docs/internals/cloud-sync.md`).
 *
 * References come before referents where cheap (statuses before issues, issues before their
 * sub-entities), but the client folds envelopes idempotently so the order is a nicety, not a
 * protocol guarantee.
 */
export const BOOTSTRAP_ENTITY_ORDER = [
  "issueStatus",
  "issueLabel",
  "issueMilestone",
  "issueCycle",
  "issue",
  "issueTodo",
  "issueRelation",
  "issueComment",
  "issueAttachment",
  "issueView",
  "issueThreadLink",
  "issueAuditEvent",
] as const satisfies readonly SyncEntityKind[];

export type BootstrapEntityKind = (typeof BOOTSTRAP_ENTITY_ORDER)[number];

const BOOTSTRAP_ENTITY_SET: ReadonlySet<string> = new Set(BOOTSTRAP_ENTITY_ORDER);

/** Where a bootstrap walk stands: everything at or before (`entityKind`, `afterId`) is delivered. */
export interface BootstrapCursorState {
  /** The company the walk belongs to; a token is refused against any other. */
  readonly companyId: string;
  /** Company head captured on the first page; the version the finished seed is consistent at. */
  readonly snapshotVersion: number;
  readonly entityKind: BootstrapEntityKind;
  /** Last domain id consumed in `entityKind`'s table; `""` starts the table from the top. */
  readonly afterId: string;
}

export function initialBootstrapState(
  companyId: string,
  snapshotVersion: number,
): BootstrapCursorState {
  return { companyId, snapshotVersion, entityKind: BOOTSTRAP_ENTITY_ORDER[0], afterId: "" };
}

/** The table after `kind` in walk order, or `null` when `kind` is the last. */
export function bootstrapKindAfter(kind: BootstrapEntityKind): BootstrapEntityKind | null {
  const index = BOOTSTRAP_ENTITY_ORDER.indexOf(kind);
  return BOOTSTRAP_ENTITY_ORDER[index + 1] ?? null;
}

/**
 * Integrity tag over the token's fields, so a persisted cursor that has been truncated, hand-edited,
 * or half-overwritten by a crashed client fails to decode instead of silently naming a different
 * walk position.
 *
 * It is a checksum, not a signature. The backend deployment holds no shared secret to key an HMAC
 * with — its whole environment is the relay issuer, the relay JWKS URL, the Clerk issuer domain, and
 * the cloud-sync capability flag — and inventing one to defend this token would be defending the
 * wrong thing: nothing in the cursor grants anything (the walk re-authorizes every row against the
 * caller, the company binding is checked against the caller's own company, and the snapshot version
 * is held to that company's head), so the only party a forged cursor can hurt is the forger, whose
 * own seed it truncates. What is worth defending against is *corruption*, which is silent, and this
 * catches it. If a server secret is ever added to the deployment, key this with it.
 *
 * FNV-1a over the canonical field string: short, dependency-free, and deterministic, which a Convex
 * query requires.
 */
function cursorChecksum(state: BootstrapCursorState): string {
  const canonical = `${state.companyId}\u0000${state.snapshotVersion}\u0000${state.entityKind}\u0000${state.afterId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Serialized as compact JSON rather than anything fancier: the contract only requires a trimmed
 * non-empty string, and a token a developer can read in a network tab is worth more than an opaque
 * blob. The fields are all load-bearing and all checked on the way back in — the company binding
 * because a cursor replayed against another company would resume a walk position that means nothing
 * there, and the snapshot version because the client persists it as its feed cursor.
 */
export function encodeBootstrapCursor(state: BootstrapCursorState): string {
  return JSON.stringify({
    c: state.companyId,
    v: state.snapshotVersion,
    k: state.entityKind,
    a: state.afterId,
    x: cursorChecksum(state),
  });
}

/**
 * A walk position is coherent when its `afterId` is something the walk could actually have stopped
 * on: `""` for the top of a table, or an id inside the same bounds `validateOperationBatch` holds
 * every entity id to. A cursor naming a padded or oversized id was never minted here, and resuming
 * from it would skip an arbitrary stretch of the table.
 */
function isCoherentAfterId(afterId: string): boolean {
  if (afterId === "") return true;
  return afterId.length <= SYNC_MAX_ID_CHARS && afterId.trim() === afterId;
}

/**
 * `null` for anything that did not come out of {@link encodeBootstrapCursor} for this company —
 * a failed checksum, an incoherent walk position, a token naming an entity kind this build does not
 * walk (which a newer deployment could have minted), or one bound to another company. The caller
 * turns `null` into an `invalid-arguments` refusal so the client restarts its seed cleanly instead
 * of resuming from a position that means something else now, or silently seeding nothing.
 *
 * The snapshot version must be a non-negative integer, because it comes back as the seed's resume
 * `version` and the client decodes that as a `CompanyVersion`. Whether it is a version this company
 * ever reached is the caller's check — this module cannot see the head.
 */
export function decodeBootstrapCursor(
  token: string,
  companyId: string,
): BootstrapCursorState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const company = source["c"];
  const version = source["v"];
  const kind = source["k"];
  const afterId = source["a"];
  const checksum = source["x"];
  if (typeof company !== "string" || company !== companyId) return null;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  if (typeof kind !== "string" || !BOOTSTRAP_ENTITY_SET.has(kind)) return null;
  if (typeof afterId !== "string" || !isCoherentAfterId(afterId)) return null;
  const state: BootstrapCursorState = {
    companyId: company,
    snapshotVersion: version,
    entityKind: kind as BootstrapEntityKind,
    afterId,
  };
  if (typeof checksum !== "string" || checksum !== cursorChecksum(state)) return null;
  return state;
}
