/**
 * Persisted shape of one company replica, and the pure semantics every storage adapter must
 * reproduce.
 *
 * Rows stay encoded here: the store writes payloads the local build could not decode (a newer
 * client wrote them, or the domain adapter changed) and the engine quarantines them on read
 * rather than failing startup. Quarantine is a move, not a delete — an unreadable operation is
 * never replayed, but its bytes are kept so a later build (or the user) can still recover the
 * work. `applySyncStoreBatch` is the reference implementation of a commit; the IndexedDB and
 * SQLite adapters run the same batch inside one transaction.
 *
 * @module sync/document
 */
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SyncEntityId,
  SyncEntityKind,
  SyncOperationEnvelope,
  SyncRejectionCode,
  type SyncOperationId,
} from "@t3tools/contracts/cloudSync";
import { CompanyId } from "@t3tools/contracts/company";
import * as Schema from "effect/Schema";

import { syncEntityKey, type SyncEntityKey } from "./model.ts";

/** Bumped when the persisted shape changes; a mismatch drops the replica and re-bootstraps. */
export const SYNC_DOCUMENT_SCHEMA_VERSION = 1 as const;

export const StoredSyncCheckpoint = Schema.Struct({
  schemaVersion: Schema.Literal(SYNC_DOCUMENT_SCHEMA_VERSION),
  companyId: CompanyId,
  cursor: CompanyVersion,
  authorizationEpoch: AuthorizationEpoch,
  /** False until the first bootstrap completed, so a half-drained first page never looks live. */
  bootstrapped: Schema.Boolean,
});
export type StoredSyncCheckpoint = typeof StoredSyncCheckpoint.Type;

export const StoredSyncEntity = Schema.Struct({
  entityKind: SyncEntityKind,
  entityId: SyncEntityId,
  version: CompanyVersion,
  payload: Schema.Unknown,
});
export type StoredSyncEntity = typeof StoredSyncEntity.Type;

/**
 * Outbox row. Only `Pending` and `Acknowledged` are durable — `Acknowledged` records the version
 * Convex assigned so a restart knows the operation is already applied and must be held (not
 * resent) until the cursor reaches it. Blocked-ness is recomputed from the rejected list.
 */
export const StoredOutboxStatus = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Acknowledged", { version: CompanyVersion }),
]);
export type StoredOutboxStatus = typeof StoredOutboxStatus.Type;

export const StoredOutboxEntry = Schema.Struct({
  envelope: SyncOperationEnvelope,
  status: StoredOutboxStatus,
});
export type StoredOutboxEntry = typeof StoredOutboxEntry.Type;

export const StoredSyncRejection = Schema.Struct({
  envelope: SyncOperationEnvelope,
  code: SyncRejectionCode,
  message: Schema.String,
});
export type StoredSyncRejection = typeof StoredSyncRejection.Type;

/**
 * An outbox row this build could not read, moved out of the send path but kept whole.
 *
 * Replaying it is not an option — arguments this build cannot decode would be shipped unchanged
 * and applied against state they may no longer match — but deleting it silently loses a user's
 * work. So it lands here with its envelope (arguments included, still encoded) and the reason,
 * and only an explicit discard removes it.
 */
export const StoredSyncQuarantine = Schema.Struct({
  envelope: SyncOperationEnvelope,
  status: StoredOutboxStatus,
  reason: Schema.String,
});
export type StoredSyncQuarantine = typeof StoredSyncQuarantine.Type;

export interface StoredSyncState {
  readonly checkpoint: StoredSyncCheckpoint | null;
  readonly entities: ReadonlyArray<StoredSyncEntity>;
  readonly outbox: ReadonlyArray<StoredOutboxEntry>;
  readonly rejected: ReadonlyArray<StoredSyncRejection>;
  /** Unreadable outbox rows, kept verbatim until something explicitly discards them. */
  readonly quarantined: ReadonlyArray<StoredSyncQuarantine>;
  /**
   * Highest local sequence this client has ever issued, whatever became of the row that carried
   * it. Sequences are never reused, so the next one cannot be derived from the rows still present:
   * pruning an acknowledged operation would otherwise hand its number to a different operation.
   */
  readonly localSequenceHighWater: LocalSequence;
}

export const EMPTY_STORED_SYNC_STATE: StoredSyncState = Object.freeze({
  checkpoint: null,
  entities: [],
  outbox: [],
  rejected: [],
  quarantined: [],
  localSequenceHighWater: LocalSequence.make(0),
});

/**
 * One atomic write. Confirmed changes, cursor advance, and outbox pruning land together or not at
 * all — a crash between them would either resend an applied operation or lose an unsent one.
 */
export interface SyncStoreBatch {
  readonly checkpoint?: StoredSyncCheckpoint;
  /** Bootstrap and authorization-epoch reseeds drop every confirmed row first. */
  readonly resetEntities?: boolean;
  readonly upsertEntities?: ReadonlyArray<StoredSyncEntity>;
  readonly deleteEntities?: ReadonlyArray<SyncEntityKey>;
  readonly upsertOutbox?: ReadonlyArray<StoredOutboxEntry>;
  readonly removeOutbox?: ReadonlyArray<SyncOperationId>;
  readonly appendRejected?: ReadonlyArray<StoredSyncRejection>;
  readonly removeRejected?: ReadonlyArray<SyncOperationId>;
  /**
   * Moves unreadable rows into quarantine. Paired with `removeOutbox` in the same batch, so the
   * row is never both sendable and quarantined, and never neither.
   */
  readonly quarantineOutbox?: ReadonlyArray<StoredSyncQuarantine>;
  /** The only way a quarantined row leaves the document. */
  readonly removeQuarantined?: ReadonlyArray<SyncOperationId>;
  /** Raises the high-water mark; it never moves down, even if a stale batch asks it to. */
  readonly localSequenceHighWater?: LocalSequence;
}

export function applySyncStoreBatch(
  state: StoredSyncState,
  batch: SyncStoreBatch,
): StoredSyncState {
  const deleted = new Set((batch.deleteEntities ?? []).map(syncEntityKey));
  const upserted = new Map(
    (batch.upsertEntities ?? []).map((entity) => [syncEntityKey(entity), entity]),
  );
  const retained = (batch.resetEntities === true ? [] : state.entities).filter((entity) => {
    const key = syncEntityKey(entity);
    return !deleted.has(key) && !upserted.has(key);
  });

  const removedOutbox = new Set(batch.removeOutbox ?? []);
  const replacedOutbox = new Map(
    (batch.upsertOutbox ?? []).map((entry) => [entry.envelope.operationId, entry]),
  );
  const outbox = [
    ...state.outbox.filter(
      (entry) =>
        !removedOutbox.has(entry.envelope.operationId) &&
        !replacedOutbox.has(entry.envelope.operationId),
    ),
    ...(batch.upsertOutbox ?? []).filter((entry) => !removedOutbox.has(entry.envelope.operationId)),
  ].sort((left, right) => left.envelope.localSequence - right.envelope.localSequence);

  const removedRejected = new Set(batch.removeRejected ?? []);
  const appendedRejected = new Set(
    (batch.appendRejected ?? []).map((rejection) => rejection.envelope.operationId),
  );

  const removedQuarantined = new Set(batch.removeQuarantined ?? []);
  const addedQuarantined = new Set(
    (batch.quarantineOutbox ?? []).map((row) => row.envelope.operationId),
  );
  const quarantined = [
    ...state.quarantined.filter(
      (row) =>
        !removedQuarantined.has(row.envelope.operationId) &&
        !addedQuarantined.has(row.envelope.operationId),
    ),
    ...(batch.quarantineOutbox ?? []).filter(
      (row) => !removedQuarantined.has(row.envelope.operationId),
    ),
  ];

  return {
    checkpoint: batch.checkpoint ?? state.checkpoint,
    entities: [...retained, ...upserted.values()],
    outbox,
    quarantined,
    localSequenceHighWater: LocalSequence.make(
      Math.max(state.localSequenceHighWater, batch.localSequenceHighWater ?? 0),
    ),
    rejected: [
      ...state.rejected.filter(
        (rejection) =>
          !removedRejected.has(rejection.envelope.operationId) &&
          !appendedRejected.has(rejection.envelope.operationId),
      ),
      ...(batch.appendRejected ?? []).filter(
        (rejection) => !removedRejected.has(rejection.envelope.operationId),
      ),
    ],
  };
}
