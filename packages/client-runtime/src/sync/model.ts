/**
 * Engine-internal vocabulary of the cloud sync engine — see `docs/internals/cloud-sync.md`.
 *
 * Every shape that crosses the wire lives in `@spiritdevs/contracts/cloudSync` and is imported from
 * there: the change envelope, the operation envelope, the receipts, and the branded identifiers are
 * the same values Convex validates, so web, mobile, and the Pathway server cannot drift apart. What
 * stays here is only what never leaves the client — the composite replica key, the decoded view of
 * an outbox row, and the pending/rejected bookkeeping the UI renders.
 *
 * The engine is framework-neutral: it never imports React, DOM, or a Convex client. Everything that
 * touches the network arrives through {@link module:sync/transport}, and everything that survives a
 * restart arrives through {@link module:sync/persistence}.
 *
 * @module sync/model
 */
import {
  AuthorizationEpoch,
  CompanyVersion,
  SYNC_INITIAL_VERSION as SYNC_INITIAL_VERSION_NUMBER,
  SyncEntityId,
  SyncEntityKind,
  type LocalSequence,
  type SyncClientId,
  type SyncOperationId,
  type SyncOperationKind,
  type SyncRejectionCode,
} from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";

/** Branded forms of the protocol's origin values, so a fresh replica needs no casts. */
export const SYNC_INITIAL_VERSION = CompanyVersion.make(SYNC_INITIAL_VERSION_NUMBER);
export const SYNC_INITIAL_EPOCH = AuthorizationEpoch.make(0);

/**
 * Where an entity lives in the local replica. The protocol never sends this pair together — a
 * change envelope carries both fields inline and an operation envelope infers the kind from its
 * operation kind — so it is a client-side composite, not a wire shape.
 */
export const SyncEntityKey = Schema.Struct({
  entityKind: SyncEntityKind,
  entityId: SyncEntityId,
});
export type SyncEntityKey = typeof SyncEntityKey.Type;

/**
 * Map key for one entity. The separator is a control character so a domain identifier can never
 * forge a collision with another entity kind.
 */
export function syncEntityKey(key: SyncEntityKey): string {
  return `${key.entityKind}\u0000${key.entityId}`;
}

export function sameSyncEntityKey(left: SyncEntityKey, right: SyncEntityKey): boolean {
  return left.entityKind === right.entityKind && left.entityId === right.entityId;
}

/**
 * One outbox row with its arguments decoded into the domain's operation type. A projection of
 * `SyncOperationEnvelope`: transport attribution and the authoring environment stay on the
 * envelope, which the outbox keeps alongside this.
 */
export interface SyncOperation<Operation> {
  readonly protocolVersion: number;
  readonly operationId: SyncOperationId;
  readonly companyId: CompanyId;
  readonly clientId: SyncClientId;
  readonly localSequence: LocalSequence;
  readonly baseVersion: CompanyVersion;
  readonly kind: SyncOperationKind;
  readonly entityId: SyncEntityId;
  readonly dependsOn: ReadonlyArray<SyncOperationId>;
  readonly operation: Operation;
}

/**
 * Outbox entry state. `Blocked` is derived at overlay time rather than persisted: a dependency
 * that gets rejected while the app is closed must still show its reason on the next start.
 */
export type PendingSyncStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Acknowledged"; readonly version: CompanyVersion }
  | { readonly _tag: "Blocked"; readonly reason: string };

export interface PendingSyncOperation<Operation> {
  readonly operation: SyncOperation<Operation>;
  readonly status: PendingSyncStatus;
}

export interface RejectedSyncOperation<Operation> {
  readonly operation: SyncOperation<Operation>;
  readonly code: SyncRejectionCode;
  readonly message: string;
}
