/**
 * The one seam a domain implements to ride the sync engine.
 *
 * The engine owns cursors, the outbox, and conflict mechanics; it knows nothing about issues.
 * A domain supplies typed per-entity codecs plus one pure `apply` reducer. That reducer is the
 * same function Convex runs server-side, which is what makes the local optimistic overlay and the
 * authoritative result agree: two operations touching different fields merge, two touching the
 * same field resolve to whichever Convex accepted last.
 *
 * @module sync/adapter
 */
import type {
  SyncEntityKind,
  SyncOperationEnvelope,
  SyncOperationId,
  SyncOperationKind,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";

import type { SyncCodec } from "./codec.ts";
import type { SyncEntityKey } from "./model.ts";

/**
 * Result of applying one operation to one entity.
 *
 * `Blocked` is not a failure: the operation stays in the outbox, keeps its place in local
 * sequence, and surfaces `reason` to the user rather than being silently discarded.
 */
export type SyncApplyOutcome<Entity> =
  | { readonly _tag: "Applied"; readonly entity: Entity }
  | { readonly _tag: "Deleted" }
  | { readonly _tag: "Blocked"; readonly reason: string };

export const applied = <Entity>(entity: Entity): SyncApplyOutcome<Entity> => ({
  _tag: "Applied",
  entity,
});
export const deleted = <Entity>(): SyncApplyOutcome<Entity> => ({ _tag: "Deleted" });
export const blocked = <Entity>(reason: string): SyncApplyOutcome<Entity> => ({
  _tag: "Blocked",
  reason,
});

export interface SyncDomainAdapter<Entity, Operation> {
  /** Diagnostic name, e.g. `issues`. */
  readonly domain: string;
  /**
   * Codec for one entity kind, or `null` when this build does not know the kind. Returning `null`
   * is how a client tolerates a company that already syncs tables it cannot render yet.
   */
  readonly entityCodec: (entityKind: SyncEntityKind) => SyncCodec<Entity> | null;
  readonly operationCodec: SyncCodec<Operation>;
  /**
   * Recovers a whole operation from a stored or returned envelope.
   *
   * `operationCodec.decode` only ever sees `envelope.args`, and a domain whose operation identity
   * lives in `envelope.kind` cannot recover it from arguments alone — the issue domain's ten
   * entity-only verbs all encode to `{}`, as does every patch that happens to touch no field.
   * Supplying this is how such a domain keeps a pending delete readable across a restart instead
   * of quarantining it. Absent, the engine falls back to the arguments codec.
   */
  readonly decodeOperation?: (envelope: SyncOperationEnvelope) => Option.Option<Operation>;
  /**
   * Protocol kind stamped on the envelope. Convex dispatches on it, so the domain — not the engine
   * — decides which of the contract's operation kinds an operation is.
   */
  readonly operationKind: (operation: Operation) => SyncOperationKind;
  /** Where the operation writes. The engine routes the overlay and the outbox by this key. */
  readonly operationTarget: (operation: Operation) => SyncEntityKey;
  /**
   * Operations that must be accepted before this one can be. A rejected dependency blocks its
   * dependents with a visible reason instead of letting them apply against missing state.
   */
  readonly operationDependencies?: (operation: Operation) => ReadonlyArray<SyncOperationId>;
  /** Pure reducer shared with the server. `current` is `null` for a missing or deleted entity. */
  readonly apply: (input: {
    readonly current: Entity | null;
    readonly operation: Operation;
  }) => SyncApplyOutcome<Entity>;
  /**
   * Optional hook for folding a confirmed change into the confirmed replica. The default is
   * replacement, which is correct because the feed carries whole entities in server order; a
   * domain only needs this to keep locally derived, non-synced fields alive across a change.
   * Tombstones bypass it — a delete always removes the entity.
   */
  readonly mergeConfirmed?: (input: {
    readonly current: Entity | null;
    readonly incoming: Entity;
  }) => Entity;
}

/**
 * The one way the engine turns a stored envelope back into an operation: the domain's own
 * {@link SyncDomainAdapter.decodeOperation} when it has one, its arguments codec otherwise.
 */
export function decodeSyncOperation<Entity, Operation>(
  adapter: SyncDomainAdapter<Entity, Operation>,
  envelope: SyncOperationEnvelope,
): Option.Option<Operation> {
  return adapter.decodeOperation === undefined
    ? adapter.operationCodec.decode(envelope.args)
    : adapter.decodeOperation(envelope);
}
