/**
 * Durable outbox and the optimistic overlay it produces.
 *
 * The outbox is ordered by local sequence and replayed, never rewritten: the overlay is recomputed
 * by folding pending operations over the confirmed replica, so every confirmed change rebases the
 * remaining operations for free. An accepted operation is kept — not dropped — until the confirmed
 * cursor reaches the version Convex gave it, which is what stops a row from flickering back to its
 * old value between acknowledgement and delivery.
 *
 * @module sync/outbox
 */
import {
  LocalSequence,
  type CompanyVersion,
  type SyncOperationEnvelope,
  type SyncOperationId,
  type SyncOperationReceipt,
} from "@t3tools/contracts/cloudSync";
import * as Option from "effect/Option";

import type { SyncDomainAdapter } from "./adapter.ts";
import type {
  StoredOutboxEntry,
  StoredOutboxStatus,
  StoredSyncQuarantine,
  StoredSyncRejection,
} from "./document.ts";
import {
  syncEntityKey,
  type PendingSyncOperation,
  type PendingSyncStatus,
  type SyncOperation,
} from "./model.ts";
import type { ConfirmedReplica } from "./replica.ts";

export interface OutboxEntry<Operation> {
  /** Encoded form, ready to ship or persist without re-encoding. */
  readonly envelope: SyncOperationEnvelope;
  readonly operation: SyncOperation<Operation>;
  readonly status: StoredOutboxStatus;
}

export function decodeOutbox<Entity, Operation>(input: {
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  readonly rows: ReadonlyArray<StoredOutboxEntry>;
}): {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  /**
   * Rows this build cannot decode. The caller moves them out of the send path — replaying
   * arguments it cannot read would apply them against state they may no longer match — but keeps
   * them whole, so a build that understands them again can still recover the work.
   */
  readonly quarantined: ReadonlyArray<StoredSyncQuarantine>;
} {
  const entries: Array<OutboxEntry<Operation>> = [];
  const quarantined: Array<StoredSyncQuarantine> = [];
  for (const row of input.rows) {
    const decoded = input.adapter.operationCodec.decode(row.envelope.args);
    if (Option.isNone(decoded)) {
      quarantined.push({
        envelope: row.envelope,
        status: row.status,
        reason: `The "${input.adapter.domain}" adapter in this build cannot read this operation's arguments.`,
      });
      continue;
    }
    entries.push({
      envelope: row.envelope,
      operation: toSyncOperation(row.envelope, decoded.value),
      status: row.status,
    });
  }
  return { entries: sortOutbox(entries), quarantined };
}

export function toSyncOperation<Operation>(
  envelope: SyncOperationEnvelope,
  operation: Operation,
): SyncOperation<Operation> {
  return {
    protocolVersion: envelope.protocolVersion,
    operationId: envelope.operationId,
    companyId: envelope.companyId,
    clientId: envelope.clientId,
    localSequence: envelope.localSequence,
    baseVersion: envelope.baseVersion,
    kind: envelope.kind,
    entityId: envelope.entityId,
    dependsOn: envelope.dependsOn,
    operation,
  };
}

export function sortOutbox<Operation>(
  entries: ReadonlyArray<OutboxEntry<Operation>>,
): ReadonlyArray<OutboxEntry<Operation>> {
  return [...entries].sort(
    (left, right) => left.envelope.localSequence - right.envelope.localSequence,
  );
}

/**
 * Next local sequence.
 *
 * Sequences are never reused, so the rows still present are not enough to derive one: an
 * acknowledged operation is pruned once the cursor covers it, and reading only the survivors would
 * hand its number to a different operation. `highWater` is the highest sequence this client ever
 * issued, persisted with the document, and it is what makes the counter monotonic across pruning
 * and restarts.
 */
export function nextLocalSequence<Operation>(
  entries: ReadonlyArray<OutboxEntry<Operation>>,
  highWater: LocalSequence = LocalSequence.make(0),
): LocalSequence {
  const highest = entries.reduce(
    (max, entry) => Math.max(max, entry.envelope.localSequence),
    highWater as number,
  );
  return LocalSequence.make(highest + 1);
}

export interface OverlayResult<Entity, Operation> {
  /** Confirmed state with the pending operations replayed over it — what the UI renders. */
  readonly view: ReadonlyMap<string, Entity>;
  /** Pending operations with their derived status, including blocked reasons. */
  readonly pending: ReadonlyArray<PendingSyncOperation<Operation>>;
}

/**
 * Replays the outbox over the confirmed replica.
 *
 * An operation blocks when the domain says it cannot apply (an update against a deleted entity)
 * or when a dependency was rejected or is itself blocked. Blocked operations keep their overlay
 * off — they never half-apply — and carry a reason to the rejected-changes panel; independent
 * operations behind them still apply.
 */
export function overlay<Entity, Operation>(input: {
  readonly replica: ConfirmedReplica<Entity>;
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  readonly rejected: ReadonlyArray<StoredSyncRejection>;
}): OverlayResult<Entity, Operation> {
  const view = new Map<string, Entity>();
  for (const [key, confirmed] of input.replica.entities) view.set(key, confirmed.entity);

  const rejectedIds = new Set(input.rejected.map((rejection) => rejection.envelope.operationId));
  const blockedIds = new Set<SyncOperationId>();
  const pending: Array<PendingSyncOperation<Operation>> = [];

  for (const entry of sortOutbox(input.entries)) {
    const dependencies = input.adapter.operationDependencies?.(entry.operation.operation) ?? [];
    const blockedDependency = [...entry.envelope.dependsOn, ...dependencies].find(
      (dependency) => rejectedIds.has(dependency) || blockedIds.has(dependency),
    );
    if (blockedDependency !== undefined) {
      blockedIds.add(entry.envelope.operationId);
      pending.push({
        operation: entry.operation,
        status: blockedReason(`Waiting on a change that was not accepted (${blockedDependency}).`),
      });
      continue;
    }

    const key = syncEntityKey(input.adapter.operationTarget(entry.operation.operation));
    const outcome = input.adapter.apply({
      current: view.get(key) ?? null,
      operation: entry.operation.operation,
    });
    switch (outcome._tag) {
      case "Applied":
        view.set(key, outcome.entity);
        pending.push({ operation: entry.operation, status: toPendingStatus(entry.status) });
        break;
      case "Deleted":
        view.delete(key);
        pending.push({ operation: entry.operation, status: toPendingStatus(entry.status) });
        break;
      case "Blocked":
        blockedIds.add(entry.envelope.operationId);
        pending.push({ operation: entry.operation, status: blockedReason(outcome.reason) });
        break;
    }
  }

  return { view, pending };
}

function blockedReason(reason: string): PendingSyncStatus {
  return { _tag: "Blocked", reason };
}

function toPendingStatus(status: StoredOutboxStatus): PendingSyncStatus {
  return status._tag === "Pending"
    ? { _tag: "Pending" }
    : { _tag: "Acknowledged", version: status.version };
}

/**
 * Operations to send: still pending (an acknowledged one is applied server-side already) and not
 * blocked. Bounded by the batch limit Convex accepts.
 */
export function sendableOperations<Operation>(input: {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  readonly pending: ReadonlyArray<PendingSyncOperation<Operation>>;
  readonly limit: number;
}): ReadonlyArray<SyncOperationEnvelope> {
  const blocked = new Set(
    input.pending
      .filter((entry) => entry.status._tag === "Blocked")
      .map((entry) => entry.operation.operationId),
  );
  return sortOutbox(input.entries)
    .filter((entry) => entry.status._tag === "Pending" && !blocked.has(entry.envelope.operationId))
    .slice(0, input.limit)
    .map((entry) => entry.envelope);
}

export interface ReceiptResult<Operation> {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  /** Entries whose status changed and must be rewritten. */
  readonly updated: ReadonlyArray<StoredOutboxEntry>;
  /** Rejected operations: removed from the outbox, their overlay gone, kept for the user. */
  readonly rejections: ReadonlyArray<StoredSyncRejection>;
  readonly removed: ReadonlyArray<SyncOperationId>;
  readonly accepted: number;
}

/** Folds one `applyOperations` answer into the outbox. */
export function applyReceipts<Operation>(input: {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  readonly receipts: ReadonlyArray<SyncOperationReceipt>;
}): ReceiptResult<Operation> {
  const byId = new Map(input.receipts.map((receipt) => [receipt.operationId, receipt]));
  const entries: Array<OutboxEntry<Operation>> = [];
  const updated: Array<StoredOutboxEntry> = [];
  const rejections: Array<StoredSyncRejection> = [];
  const removed: Array<SyncOperationId> = [];
  let accepted = 0;

  for (const entry of input.entries) {
    const receipt = byId.get(entry.envelope.operationId);
    if (receipt === undefined) {
      entries.push(entry);
      continue;
    }
    // `status` is the operation's real outcome and `duplicate` only says the answer was replayed,
    // so a resend after a dropped response rolls back exactly like the first refusal did. Reading
    // "this one I have seen before" as a success is how a rejected operation would be kept.
    if (receipt.status === "rejected") {
      rejections.push({
        envelope: entry.envelope,
        code: receipt.code,
        message: receipt.message,
      });
      removed.push(entry.envelope.operationId);
      continue;
    }
    accepted += 1;
    // Held until the cursor covers the *last* version the operation produced, so an operation that
    // wrote several entities never unblocks while part of its result is still in flight.
    const status: StoredOutboxStatus = { _tag: "Acknowledged", version: receipt.lastVersion };
    entries.push({ ...entry, status });
    updated.push({ envelope: entry.envelope, status });
  }

  return { entries: sortOutbox(entries), updated, rejections, removed, accepted };
}

/**
 * Drops acknowledged operations the confirmed cursor now covers. Until then the overlay keeps
 * showing them, so an accepted edit never disappears while its change is still in flight.
 */
export function pruneAcknowledged<Operation>(input: {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  readonly cursor: CompanyVersion;
}): {
  readonly entries: ReadonlyArray<OutboxEntry<Operation>>;
  readonly removed: ReadonlyArray<SyncOperationId>;
} {
  const removed: Array<SyncOperationId> = [];
  const entries = input.entries.filter((entry) => {
    if (entry.status._tag !== "Acknowledged" || entry.status.version > input.cursor) return true;
    removed.push(entry.envelope.operationId);
    return false;
  });
  return { entries, removed };
}
