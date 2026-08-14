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
  /** Company head captured on the first page; the version the finished seed is consistent at. */
  readonly snapshotVersion: number;
  readonly entityKind: BootstrapEntityKind;
  /** Last domain id consumed in `entityKind`'s table; `""` starts the table from the top. */
  readonly afterId: string;
}

export function initialBootstrapState(snapshotVersion: number): BootstrapCursorState {
  return { snapshotVersion, entityKind: BOOTSTRAP_ENTITY_ORDER[0], afterId: "" };
}

/** The table after `kind` in walk order, or `null` when `kind` is the last. */
export function bootstrapKindAfter(kind: BootstrapEntityKind): BootstrapEntityKind | null {
  const index = BOOTSTRAP_ENTITY_ORDER.indexOf(kind);
  return BOOTSTRAP_ENTITY_ORDER[index + 1] ?? null;
}

/**
 * Serialized as compact JSON rather than anything fancier: the contract only requires a trimmed
 * non-empty string, and a token a developer can read in a network tab is worth more than one that
 * pretends to be tamper-proof. Nothing in the token grants anything — the walk re-authorizes every
 * row against the caller — but its snapshot version *is* load-bearing, since the client persists it
 * as its feed cursor, so the caller must hold it to the company head as well as decoding it.
 */
export function encodeBootstrapCursor(state: BootstrapCursorState): string {
  return JSON.stringify({ v: state.snapshotVersion, k: state.entityKind, a: state.afterId });
}

/**
 * `null` for anything that did not come out of {@link encodeBootstrapCursor} — including a token
 * naming an entity kind this build does not walk, which a newer deployment could have minted. The
 * caller turns `null` into an `invalid-arguments` refusal so the client restarts its seed cleanly
 * instead of resuming from a position that means something else now.
 *
 * The snapshot version must be a non-negative integer, because it comes back as the seed's resume
 * `version` and the client decodes that as a `CompanyVersion`. Whether it is a version this company
 * ever reached is the caller's check — this module cannot see the head.
 */
export function decodeBootstrapCursor(token: string): BootstrapCursorState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const version = source["v"];
  const kind = source["k"];
  const afterId = source["a"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  if (typeof kind !== "string" || !BOOTSTRAP_ENTITY_SET.has(kind)) return null;
  if (typeof afterId !== "string") return null;
  return { snapshotVersion: version, entityKind: kind as BootstrapEntityKind, afterId };
}
