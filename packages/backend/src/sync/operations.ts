/**
 * Envelope handling for `sync.applyOperations`: bounds checking, dedupe by operation id, and
 * contiguous version assignment.
 *
 * All of it is pure so the mutation stays a thin shell around a database transaction, and so the
 * exactly-once and contiguity guarantees can be tested without a deployment.
 *
 * @module sync/operations
 */
import {
  isSyncRejectionCode,
  SYNC_MAX_OPERATION_ARGS_BYTES,
  SYNC_MAX_OPERATIONS_PER_BATCH,
  SYNC_PROTOCOL_MIN_SUPPORTED_VERSION,
  SYNC_PROTOCOL_VERSION,
  type SyncActor,
  type SyncRejectionCode,
} from "./protocol.ts";

/**
 * Mirrors `SyncOperationEnvelope` in `contracts/cloudSync`, field for field. `kind` stays `string`
 * rather than `SyncOperationKind` because an unknown kind has to reach the handler and come back as
 * an `unknown-operation` receipt for that one operation, not fail the batch.
 */
export interface SyncOperationEnvelope {
  readonly protocolVersion: number;
  readonly operationId: string;
  readonly companyId: string;
  /** The client or environment that authored the operation; scopes the local sequence. */
  readonly clientId: string;
  readonly environmentId: string | null;
  /** Asserted by the caller for attribution only; Convex re-derives it from the token. */
  readonly actor: SyncActor;
  readonly localSequence: number;
  /** Company version the client had confirmed when it authored this. Never a clock reading. */
  readonly baseVersion: number;
  readonly kind: string;
  readonly entityId: string;
  readonly args: unknown;
  /** Operations that must already be accepted; an unmet dependency blocks rather than drops. */
  readonly dependsOn: readonly string[];
}

const encoder = new TextEncoder();

/** Byte cost of one operation's arguments, measured the way the batch ceiling counts it. */
export function measureOperationArgsBytes(operation: SyncOperationEnvelope): number {
  return encoder.encode(JSON.stringify(operation.args ?? null)).length;
}

export function measureBatchArgsBytes(operations: readonly SyncOperationEnvelope[]): number {
  let total = 0;
  for (const operation of operations) total += measureOperationArgsBytes(operation);
  return total;
}

/**
 * Character ceiling for the envelope's identifiers, mirroring the `domainId` bound every argument
 * parser applies. The contract brands `SyncOperationId` and `SyncEntityId` as trimmed non-empty
 * strings, which Convex's `v.string()` cannot express, so the envelope layer holds them to it here.
 */
export const SYNC_MAX_ID_CHARS = 128;

/**
 * An entity id has to survive a round trip through the bootstrap walk, which pages ascending by
 * domain id from an exclusive `""` — a row keyed by the empty string sits below every page forever,
 * so it would reach connected replicas through the feed and never appear in a fresh device's seed.
 */
function isSyncId(value: string): boolean {
  return value.length > 0 && value.length <= SYNC_MAX_ID_CHARS && value.trim() === value;
}

export type BatchValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SyncRejectionCode; readonly message: string };

/**
 * Whole-batch preconditions. These reject the request rather than individual operations: a client
 * that oversends has a bug, and partially applying its batch would scramble its local sequence.
 */
export function validateOperationBatch(
  operations: readonly SyncOperationEnvelope[],
  companyId: string,
): BatchValidation {
  if (operations.length === 0) {
    return { ok: false, code: "batch-empty", message: "An operation batch must not be empty." };
  }
  if (operations.length > SYNC_MAX_OPERATIONS_PER_BATCH) {
    return {
      ok: false,
      code: "batch-too-large",
      message: `At most ${SYNC_MAX_OPERATIONS_PER_BATCH} operations may be sent at once.`,
    };
  }

  const seen = new Set<string>();
  for (const operation of operations) {
    if (
      operation.protocolVersion < SYNC_PROTOCOL_MIN_SUPPORTED_VERSION ||
      operation.protocolVersion > SYNC_PROTOCOL_VERSION
    ) {
      return {
        ok: false,
        code: "upgrade-required",
        message: `Unsupported sync protocol version ${operation.protocolVersion}.`,
      };
    }
    if (operation.companyId !== companyId) {
      return {
        ok: false,
        code: "company-mismatch",
        message: "Every operation in a batch must target the requested company.",
      };
    }
    if (!isSyncId(operation.operationId)) {
      return {
        ok: false,
        code: "invalid-arguments",
        message: `An operation id must be a trimmed, non-empty string of at most ${SYNC_MAX_ID_CHARS} characters.`,
      };
    }
    if (!isSyncId(operation.entityId)) {
      return {
        ok: false,
        code: "invalid-arguments",
        message: `An entity id must be a trimmed, non-empty string of at most ${SYNC_MAX_ID_CHARS} characters.`,
      };
    }
    if (seen.has(operation.operationId)) {
      return {
        ok: false,
        code: "batch-duplicate-operation-id",
        message: `Operation ${operation.operationId} appears twice in one batch.`,
      };
    }
    seen.add(operation.operationId);
  }

  if (measureBatchArgsBytes(operations) > SYNC_MAX_OPERATION_ARGS_BYTES) {
    return {
      ok: false,
      code: "batch-args-too-large",
      message: `Operation arguments exceed ${SYNC_MAX_OPERATION_ARGS_BYTES} bytes.`,
    };
  }

  return { ok: true };
}

export interface OperationPartition {
  /** Operations already applied by a previous attempt; replayed from their stored receipts. */
  readonly duplicates: readonly SyncOperationEnvelope[];
  readonly fresh: readonly SyncOperationEnvelope[];
}

/**
 * Splits a validated batch against the receipts already on file. This is what makes a retried
 * submission apply exactly once: the retry sees its earlier receipts and applies nothing.
 */
export function partitionByExistingReceipts(
  operations: readonly SyncOperationEnvelope[],
  appliedOperationIds: ReadonlySet<string>,
): OperationPartition {
  const duplicates: SyncOperationEnvelope[] = [];
  const fresh: SyncOperationEnvelope[] = [];
  for (const operation of operations) {
    if (appliedOperationIds.has(operation.operationId)) duplicates.push(operation);
    else fresh.push(operation);
  }
  return { duplicates, fresh };
}

export interface VersionAssignment {
  /** First version written by this batch; equals `head` when the batch produced no changes. */
  readonly firstVersion: number;
  readonly lastVersion: number;
  readonly versions: readonly number[];
  /** Company sync head to persist once the batch commits. */
  readonly nextHead: number;
}

/**
 * Contiguous versions starting one past the current head. Convex serializes the mutation and
 * retries it under OCC, so a losing attempt re-reads the head and re-derives its range — versions
 * never interleave and never skip.
 */
export function assignVersions(headVersion: number, changeCount: number): VersionAssignment {
  const count = Math.max(0, Math.trunc(changeCount));
  const versions: number[] = [];
  for (let index = 1; index <= count; index += 1) versions.push(headVersion + index);
  return {
    firstVersion: count === 0 ? headVersion : headVersion + 1,
    lastVersion: headVersion + count,
    versions,
    nextHead: headVersion + count,
  };
}

export interface AcceptedOperationReceipt {
  readonly operationId: string;
  readonly status: "accepted";
  /** True when this receipt replays a stored outcome rather than a fresh apply. */
  readonly duplicate: boolean;
  readonly firstVersion: number;
  readonly lastVersion: number;
}

export interface RejectedOperationReceipt {
  readonly operationId: string;
  readonly status: "rejected";
  readonly duplicate: boolean;
  readonly code: SyncRejectionCode;
  readonly message: string;
}

/**
 * Mirrors `SyncOperationReceipt` in the contracts: the status is the operation's real outcome and
 * `duplicate` is orthogonal to it, so replaying the receipt of a rejected operation still refuses
 * it.
 */
export type OperationReceipt = AcceptedOperationReceipt | RejectedOperationReceipt;

/** One `syncOperationReceipts` row, as the dedupe ledger stores it. */
export interface StoredOperationReceipt {
  readonly status: "accepted" | "rejected";
  readonly firstVersion: number | null;
  readonly lastVersion: number | null;
  /** Open string on the wire and in storage; narrowed back to a known code on replay. */
  readonly rejectionCode: string | null;
  readonly rejectionMessage: string | null;
}

/**
 * The answer a resent operation gets. The stored outcome is what comes back — a resend of a
 * rejected operation is still a rejection, carrying the original code and message, because a
 * client that lost the first response has to see the same verdict rather than a success it would
 * quietly drop from its outbox.
 */
export function replayStoredReceipt(input: {
  readonly operationId: string;
  readonly stored: StoredOperationReceipt;
  /** Fallback for a stored receipt that recorded no versions, e.g. an operation that changed nothing. */
  readonly headVersion: number;
}): OperationReceipt {
  if (input.stored.status === "rejected") {
    const code = input.stored.rejectionCode ?? "";
    return {
      operationId: input.operationId,
      status: "rejected",
      duplicate: true,
      // A code this build cannot name came from a newer deployment; the stored message still
      // carries the reason, so the operation stays refused rather than becoming a success.
      code: isSyncRejectionCode(code) ? code : "invalid-arguments",
      message: input.stored.rejectionMessage ?? "This operation was refused by an earlier attempt.",
    };
  }
  return {
    operationId: input.operationId,
    status: "accepted",
    duplicate: true,
    firstVersion: input.stored.firstVersion ?? input.headVersion,
    lastVersion: input.stored.lastVersion ?? input.headVersion,
  };
}

/**
 * The version range a client may treat as covered by this response. Rejected operations contribute
 * nothing, so a batch that produced no changes reports the unchanged head.
 */
export function acceptedVersionRange(
  headBefore: number,
  receipts: readonly OperationReceipt[],
): { readonly from: number; readonly to: number } {
  let to = headBefore;
  for (const receipt of receipts) {
    if (receipt.status === "rejected") continue;
    if (receipt.lastVersion > to) to = receipt.lastVersion;
  }
  return { from: headBefore, to };
}
