/**
 * The sync engine: local replica, durable outbox, and the bootstrap/change-feed driver that keeps
 * them honest.
 *
 * One instance covers one company. It reads its whole replica once, renders confirmed state plus
 * the optimistic overlay immediately, and from then on does exactly two things when asked to
 * sync: drain bounded change pages from the persisted cursor, then send the outbox in local
 * sequence. Both are idempotent, so a dropped connection costs a retry and nothing else.
 *
 * `sync` never fails on a transport error — it records the error in the state and answers with a
 * receipt. Callers (and tests) wait on that receipt instead of on a timer, and `run` reads the same
 * receipt to decide whether the cycle has to be re-armed on a backoff.
 *
 * @module sync/engine
 */
import {
  LocalSequence,
  SYNC_MAX_CHANGES_PER_PAGE,
  SYNC_MAX_OPERATIONS_PER_BATCH,
  SYNC_PROTOCOL_VERSION,
  type AuthorizationEpoch,
  type CompanyVersion,
  type SyncActor,
  type SyncBootstrapResponse,
  type SyncClientId,
  type SyncOperationEnvelope,
  type SyncOperationId,
  type SyncPresentation,
} from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { decodeSyncOperation, type SyncDomainAdapter } from "./adapter.ts";
import { whenCloudSyncEnabled } from "./capability.ts";
import {
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type StoredOutboxEntry,
  type StoredSyncCheckpoint,
  type StoredSyncQuarantine,
  type StoredSyncRejection,
} from "./document.ts";
import {
  SYNC_INITIAL_EPOCH,
  SYNC_INITIAL_VERSION,
  type PendingSyncOperation,
  type PendingSyncStatus,
  type RejectedSyncOperation,
} from "./model.ts";
import {
  applyReceipts,
  decodeOutbox,
  nextLocalSequence,
  overlay,
  pruneAcknowledged,
  sendableOperations,
  toSyncOperation,
  type OutboxEntry,
} from "./outbox.ts";
import { SyncStore, type SyncStoreError } from "./persistence.ts";
import { presentSyncState, type SyncPhase } from "./presentation.ts";
import {
  applyConfirmedChanges,
  decodeConfirmedEntities,
  emptyConfirmedReplica,
} from "./replica.ts";
import { SyncTransport, type SyncTransportError } from "./transport.ts";

export interface SyncEngineState<Entity, Operation> {
  readonly phase: SyncPhase;
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
  readonly bootstrapped: boolean;
  /** Confirmed layer only — what Convex has accepted up to `cursor`. */
  readonly confirmed: ReadonlyMap<string, Entity>;
  /** Confirmed state with the outbox replayed over it. This is what the UI renders. */
  readonly view: ReadonlyMap<string, Entity>;
  readonly pending: ReadonlyArray<PendingSyncOperation<Operation>>;
  readonly rejected: ReadonlyArray<RejectedSyncOperation<Operation>>;
  /**
   * Outbox rows this build could not read, kept verbatim instead of deleted. They are out of the
   * send path and out of the overlay, so they are inert — but they are a user's unsent work, and a
   * surface that wants to offer "export" or "discard" reads them from here.
   */
  readonly quarantined: ReadonlyArray<StoredSyncQuarantine>;
  readonly lastError: SyncTransportError | null;
  readonly presentation: SyncPresentation;
}

export type SyncCycleOutcome =
  | "disabled"
  | "synced"
  | "bootstrapped"
  /** Authorization epoch moved, so the replica was discarded and reseeded. */
  | "reseeded"
  | "offline"
  | "failed";

/**
 * How one pass over the change feed ended. `CursorExpired` and `EpochChanged` both mean the
 * replica cannot be carried forward and has to be reseeded.
 */
interface DrainOutcome {
  readonly _tag: "Drained" | "CursorExpired" | "EpochChanged";
  readonly applied: number;
}

export interface SyncCycleReceipt {
  readonly outcome: SyncCycleOutcome;
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
  readonly appliedChanges: number;
  readonly acceptedOperations: number;
  readonly rejectedOperations: number;
  readonly error: SyncTransportError | null;
}

export interface SyncEnqueueReceipt {
  /** False when the operation id is already known — an enqueue applies exactly once. */
  readonly accepted: boolean;
  readonly operationId: SyncOperationId;
  readonly localSequence: LocalSequence;
  readonly status: PendingSyncStatus;
}

export interface SyncEngine<Entity, Operation> {
  readonly companyId: CompanyId;
  readonly state: SubscriptionRef.SubscriptionRef<SyncEngineState<Entity, Operation>>;
  /** Durably records one optimistic operation and republishes the overlay. */
  readonly enqueue: (input: {
    readonly operationId: SyncOperationId;
    readonly operation: Operation;
    readonly dependsOn?: ReadonlyArray<SyncOperationId>;
  }) => Effect.Effect<SyncEnqueueReceipt, SyncStoreError>;
  /** One full cycle: drain the feed, flush the outbox, drain again to confirm. */
  readonly sync: Effect.Effect<SyncCycleReceipt, SyncStoreError>;
  /**
   * Subscribes to `sync.latestVersion` and syncs whenever the company head moves, re-arming a
   * cycle that ended in retryable trouble on a backoff rather than waiting for the next move.
   */
  readonly run: Effect.Effect<void, SyncStoreError>;
  /** Dismisses rejected operations from the recovery panel. */
  readonly discardRejected: (
    operationIds: ReadonlyArray<SyncOperationId>,
  ) => Effect.Effect<void, SyncStoreError>;
  /**
   * The only way a quarantined row is deleted. Nothing in the engine calls it: an unreadable
   * operation stays until a person (or a migration that understood it) says otherwise.
   */
  readonly discardQuarantined: (
    operationIds: ReadonlyArray<SyncOperationId>,
  ) => Effect.Effect<void, SyncStoreError>;
}

export interface SyncEngineOptions<Entity, Operation> {
  readonly companyId: CompanyId;
  readonly clientId: SyncClientId;
  /**
   * Attribution stamped on every operation. Convex re-derives the authoritative actor from the
   * token, so this is what the audit trail shows, never what authorization trusts.
   */
  readonly actor: SyncActor;
  /** Set when a Pathway server authors the writes; `null` for a browser or mobile client. */
  readonly environmentId?: EnvironmentId | null;
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  /** Clamped to 1..{@link SYNC_MAX_CHANGES_PER_PAGE}; see {@link clampSyncBound}. */
  readonly pageSize?: number;
  /** Clamped to 1..{@link SYNC_MAX_OPERATIONS_PER_BATCH}; see {@link clampSyncBound}. */
  readonly batchSize?: number;
}

/**
 * Keeps a caller-supplied page or batch size inside the range the contract accepts.
 *
 * The protocol schemas already refuse anything below 1, but the engine's options are plain numbers
 * from application code, and a 0 that reaches the feed asks for empty pages forever: the cursor
 * cannot advance, `hasMore` stays true, and the drain loop never ends. An absent or non-finite
 * size means "no preference" and takes the maximum; anything else is truncated into 1..max. This
 * mirrors `clampPageLimit` on the Convex side, so neither end of the wire trusts the other.
 */
export function clampSyncBound(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return max;
  const whole = Math.trunc(requested);
  return whole < 1 ? 1 : Math.min(whole, max);
}

/** How long {@link SyncEngine.run} waits before re-arming the first time a cycle does not settle. */
export const SYNC_RETRY_MIN_DELAY = Duration.seconds(1);

/** The ceiling the backoff doubles up to: a long outage costs one cycle every half minute. */
export const SYNC_RETRY_MAX_DELAY = Duration.seconds(30);

const SYNC_RETRY_SCHEDULE = Schedule.exponential(SYNC_RETRY_MIN_DELAY).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, SYNC_RETRY_MAX_DELAY)),
  ),
);

export const makeSyncEngine = Effect.fn("makeSyncEngine")(function* <Entity, Operation>(
  options: SyncEngineOptions<Entity, Operation>,
) {
  const { actor, adapter, clientId, companyId } = options;
  const environmentId = options.environmentId ?? null;
  const pageSize = clampSyncBound(options.pageSize, SYNC_MAX_CHANGES_PER_PAGE);
  const batchSize = clampSyncBound(options.batchSize, SYNC_MAX_OPERATIONS_PER_BATCH);
  const store = yield* SyncStore;
  const transport = yield* SyncTransport;
  // One cycle at a time: draining and flushing both move the cursor and the outbox.
  const cycleLock = yield* Semaphore.make(1);

  const stored = yield* store.read(companyId);
  const checkpoint = stored.checkpoint;
  // A checkpoint written by another schema version is not readable; drop it and re-bootstrap
  // rather than guessing what its rows meant.
  const usableCheckpoint =
    checkpoint !== null && checkpoint.schemaVersion === SYNC_DOCUMENT_SCHEMA_VERSION
      ? checkpoint
      : null;
  const confirmed = decodeConfirmedEntities({
    adapter,
    rows: usableCheckpoint === null ? [] : stored.entities,
    cursor: usableCheckpoint?.cursor ?? SYNC_INITIAL_VERSION,
    authorizationEpoch: usableCheckpoint?.authorizationEpoch ?? SYNC_INITIAL_EPOCH,
  });
  const outbox = decodeOutbox({ adapter, rows: stored.outbox });

  const replicaRef = yield* Ref.make(confirmed.replica);
  const entriesRef = yield* Ref.make(outbox.entries);
  const rejectedRef = yield* Ref.make(stored.rejected);
  const quarantinedRef = yield* Ref.make<ReadonlyArray<StoredSyncQuarantine>>([
    ...stored.quarantined,
    ...outbox.quarantined,
  ]);
  const bootstrappedRef = yield* Ref.make(usableCheckpoint?.bootstrapped ?? false);
  const errorRef = yield* Ref.make<SyncTransportError | null>(null);
  const phaseRef = yield* Ref.make<SyncPhase>("initializing");

  // Sequences are never reused, so the mark covers every row ever written — including ones already
  // pruned, and the quarantined ones, which are gone from the send path but not from history.
  const highWater = highestLocalSequence(
    stored.localSequenceHighWater,
    stored.outbox,
    stored.quarantined,
  );
  const highWaterRef = yield* Ref.make(highWater);

  // Rows this build cannot read move out of the send path but are kept whole: shipping arguments
  // we cannot decode would apply them against state they no longer match, and deleting them would
  // lose a user's unsent work with no trace. Only `discardQuarantined` removes them.
  if (outbox.quarantined.length > 0 || highWater > stored.localSequenceHighWater) {
    yield* store.commit(companyId, {
      removeOutbox: outbox.quarantined.map((row) => row.envelope.operationId),
      quarantineOutbox: outbox.quarantined,
      localSequenceHighWater: highWater,
    });
  }

  const renderState = Effect.fn("SyncEngine.renderState")(function* () {
    const replica = yield* Ref.get(replicaRef);
    const entries = yield* Ref.get(entriesRef);
    const rejections = yield* Ref.get(rejectedRef);
    const quarantined = yield* Ref.get(quarantinedRef);
    const phase = yield* Ref.get(phaseRef);
    const lastError = yield* Ref.get(errorRef);
    const bootstrapped = yield* Ref.get(bootstrappedRef);
    const applied = overlay({ replica, entries, adapter, rejected: rejections });
    const confirmedView = new Map<string, Entity>();
    for (const [key, entity] of replica.entities) confirmedView.set(key, entity.entity);
    return {
      phase,
      cursor: replica.cursor,
      authorizationEpoch: replica.authorizationEpoch,
      bootstrapped,
      confirmed: confirmedView,
      view: applied.view,
      pending: applied.pending,
      rejected: decodeRejections({ adapter, rejections }),
      quarantined,
      lastError,
      presentation: presentSyncState({
        phase,
        pending: applied.pending,
        rejectedCount: rejections.length,
        error: lastError,
      }),
    } satisfies SyncEngineState<Entity, Operation>;
  });

  const state = yield* SubscriptionRef.make<SyncEngineState<Entity, Operation>>(
    yield* renderState(),
  );
  const publish = Effect.flatMap(Effect.suspend(renderState), (next) =>
    SubscriptionRef.set(state, next),
  );

  const setPhase = (phase: SyncPhase, error: SyncTransportError | null) =>
    Effect.flatMap(Ref.set(phaseRef, phase), () =>
      Effect.flatMap(Ref.set(errorRef, error), () => publish),
    );

  // A replica loaded from disk is usable immediately, but it is not live until a cycle runs.
  yield* setPhase(usableCheckpoint === null ? "initializing" : "disconnected", null);

  const checkpointFor = (input: {
    readonly cursor: CompanyVersion;
    readonly authorizationEpoch: AuthorizationEpoch;
    readonly bootstrapped: boolean;
  }): StoredSyncCheckpoint => ({
    schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
    companyId,
    cursor: input.cursor,
    authorizationEpoch: input.authorizationEpoch,
    bootstrapped: input.bootstrapped,
  });

  /** Drops acknowledged operations the confirmed cursor now covers. */
  const pruneCovered = Effect.fn("SyncEngine.pruneCovered")(function* (cursor: CompanyVersion) {
    const entries = yield* Ref.get(entriesRef);
    const pruned = pruneAcknowledged({ entries, cursor });
    if (pruned.removed.length === 0) return;
    yield* store.commit(companyId, { removeOutbox: pruned.removed });
    yield* Ref.set(entriesRef, pruned.entries);
  });

  /**
   * Full paginated reseed: the first sync, a cursor the feed no longer retains, or an
   * authorization-epoch change. The first page resets every confirmed row, which is what purges
   * records the actor may no longer see.
   */
  const bootstrap = Effect.fn("SyncEngine.bootstrap")(function* () {
    let replica = emptyConfirmedReplica<Entity>({
      cursor: SYNC_INITIAL_VERSION,
      authorizationEpoch: SYNC_INITIAL_EPOCH,
    });
    let cursor: string | null = null;
    let firstPage = true;
    let applied = 0;

    for (;;) {
      const page: SyncBootstrapResponse = yield* transport.bootstrap({
        companyId,
        cursor,
        pageSize,
      });
      const result = applyConfirmedChanges({
        replica,
        adapter,
        changes: page.entities,
        // Intermediate pages keep the zero cursor so later pages are not mistaken for redeliveries.
        cursor: page.isDone ? page.version : SYNC_INITIAL_VERSION,
        authorizationEpoch: page.authorizationEpoch,
      });
      replica = result.replica;
      applied += page.entities.length;
      yield* store.commit(companyId, {
        resetEntities: firstPage,
        upsertEntities: result.upserts,
        deleteEntities: result.deletes,
        checkpoint: checkpointFor({
          cursor: page.isDone ? page.version : SYNC_INITIAL_VERSION,
          authorizationEpoch: page.authorizationEpoch,
          bootstrapped: page.isDone,
        }),
      });
      firstPage = false;
      if (page.isDone) break;
      cursor = page.cursor;
    }

    yield* Ref.set(replicaRef, replica);
    yield* Ref.set(bootstrappedRef, true);
    yield* pruneCovered(replica.cursor);
    return applied;
  });

  /**
   * Drains bounded pages from the persisted cursor. The cursor advances even when authorization
   * filtering empties a page, so a client that cannot see a busy team still makes progress.
   */
  const drain = Effect.fn("SyncEngine.drain")(function* () {
    let applied = 0;
    for (;;) {
      const replica = yield* Ref.get(replicaRef);
      const page = yield* transport.listChanges({
        companyId,
        cursor: replica.cursor,
        limit: pageSize,
      });
      if (page._tag === "CursorExpired") return { _tag: "CursorExpired", applied } as const;
      if (page.authorizationEpoch !== replica.authorizationEpoch) {
        return { _tag: "EpochChanged", applied } as const;
      }
      const result = applyConfirmedChanges({
        replica,
        adapter,
        changes: page.changes,
        cursor: page.cursor,
        authorizationEpoch: page.authorizationEpoch,
      });
      yield* store.commit(companyId, {
        upsertEntities: result.upserts,
        deleteEntities: result.deletes,
        checkpoint: checkpointFor({
          cursor: page.cursor,
          authorizationEpoch: page.authorizationEpoch,
          bootstrapped: true,
        }),
      });
      yield* Ref.set(replicaRef, result.replica);
      yield* pruneCovered(page.cursor);
      applied += page.changes.length;
      if (!page.hasMore) return { _tag: "Drained", applied } as const;
    }
  });

  /** Sends the outbox in local sequence, in batches Convex accepts, until nothing is sendable. */
  const flush = Effect.fn("SyncEngine.flush")(function* () {
    let accepted = 0;
    let rejected = 0;
    for (;;) {
      const entries = yield* Ref.get(entriesRef);
      const rejections = yield* Ref.get(rejectedRef);
      const replica = yield* Ref.get(replicaRef);
      const applied = overlay({ replica, entries, adapter, rejected: rejections });
      const batch = sendableOperations({ entries, pending: applied.pending, limit: batchSize });
      if (batch.length === 0) return { accepted, rejected };

      const result = yield* transport.applyOperations({ companyId, operations: batch });
      const receipts = applyReceipts({ entries, receipts: result.receipts });
      yield* store.commit(companyId, {
        upsertOutbox: receipts.updated,
        removeOutbox: receipts.removed,
        appendRejected: receipts.rejections,
      });
      yield* Ref.set(entriesRef, receipts.entries);
      yield* Ref.update(rejectedRef, (current) => [...current, ...receipts.rejections]);
      accepted += receipts.accepted;
      rejected += receipts.rejections.length;
      // A server that answered nothing for the batch would otherwise be retried forever.
      if (receipts.accepted === 0 && receipts.rejections.length === 0) {
        return { accepted, rejected };
      }
    }
  });

  const receiptOf = Effect.fn("SyncEngine.receiptOf")(function* (input: {
    readonly outcome: SyncCycleOutcome;
    readonly appliedChanges: number;
    readonly acceptedOperations: number;
    readonly rejectedOperations: number;
    readonly error: SyncTransportError | null;
  }) {
    const replica = yield* Ref.get(replicaRef);
    return {
      outcome: input.outcome,
      cursor: replica.cursor,
      authorizationEpoch: replica.authorizationEpoch,
      appliedChanges: input.appliedChanges,
      acceptedOperations: input.acceptedOperations,
      rejectedOperations: input.rejectedOperations,
      error: input.error,
    } satisfies SyncCycleReceipt;
  });

  const cycle = Effect.fn("SyncEngine.cycle")(function* () {
    yield* setPhase("syncing", null);
    let applied = 0;
    let outcome: SyncCycleOutcome = "synced";

    /**
     * Settles one drain. Either the feed no longer retains our cursor or authorization changed
     * under us; both answers are the same reseed and only the reported outcome differs. Every
     * drain in the cycle goes through here — the post-flush one can be the first to see an epoch
     * change (a permission revoked while our own batch was in flight), and reporting that cycle as
     * live would leave the replica holding rows the actor may no longer read until something else
     * happens to move the company head.
     */
    const settle = Effect.fn("SyncEngine.settle")(function* (drained: DrainOutcome) {
      applied += drained.applied;
      if (drained._tag === "Drained") return;
      applied += yield* bootstrap();
      outcome = drained._tag === "CursorExpired" ? "bootstrapped" : "reseeded";
    });

    const bootstrapped = yield* Ref.get(bootstrappedRef);
    if (!bootstrapped) {
      applied += yield* bootstrap();
      outcome = "bootstrapped";
    } else {
      yield* settle(yield* drain());
    }

    const flushed = yield* flush();
    // Second drain confirms our own accepted operations and prunes them from the outbox.
    yield* settle(yield* drain());

    yield* setPhase("ready", null);
    return yield* receiptOf({
      outcome,
      appliedChanges: applied,
      acceptedOperations: flushed.accepted,
      rejectedOperations: flushed.rejected,
      error: null,
    });
  });

  const DISABLED_RECEIPT: SyncCycleReceipt = {
    outcome: "disabled",
    cursor: SYNC_INITIAL_VERSION,
    authorizationEpoch: SYNC_INITIAL_EPOCH,
    appliedChanges: 0,
    acceptedOperations: 0,
    rejectedOperations: 0,
    error: null,
  };

  const runCycle: Effect.Effect<SyncCycleReceipt, SyncStoreError> = cycle().pipe(
    Effect.catch((error: SyncTransportError | SyncStoreError) => {
      if (error._tag === "SyncStoreError") return Effect.fail(error);
      const phase = transportPhase(error);
      return setPhase(phase, error).pipe(
        Effect.flatMap(() =>
          receiptOf({
            outcome: phase === "failed" ? "failed" : "offline",
            appliedChanges: 0,
            acceptedOperations: 0,
            rejectedOperations: 0,
            error,
          }),
        ),
      );
    }),
  );

  const sync: Effect.Effect<SyncCycleReceipt, SyncStoreError> = cycleLock.withPermits(1)(
    Effect.suspend(() => whenCloudSyncEnabled(runCycle, DISABLED_RECEIPT)),
  );

  const enqueue = Effect.fn("SyncEngine.enqueue")(function* (input: {
    readonly operationId: SyncOperationId;
    readonly operation: Operation;
    readonly dependsOn?: ReadonlyArray<SyncOperationId>;
  }) {
    const entries = yield* Ref.get(entriesRef);
    const rejections = yield* Ref.get(rejectedRef);
    // Deduplicated locally as well as on the server: a retried command must not queue twice.
    const existing = entries.find((entry) => entry.envelope.operationId === input.operationId);
    const alreadyRejected = rejections.some(
      (rejection) => rejection.envelope.operationId === input.operationId,
    );
    if (existing !== undefined || alreadyRejected) {
      return {
        accepted: false,
        operationId: input.operationId,
        localSequence: existing?.envelope.localSequence ?? LocalSequence.make(0),
        status: { _tag: "Pending" },
      } satisfies SyncEnqueueReceipt;
    }

    const replica = yield* Ref.get(replicaRef);
    const target = adapter.operationTarget(input.operation);
    const localSequence = nextLocalSequence(entries, yield* Ref.get(highWaterRef));
    const envelope: SyncOperationEnvelope = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      operationId: input.operationId,
      companyId,
      clientId,
      environmentId,
      actor,
      localSequence,
      baseVersion: replica.cursor,
      entityId: target.entityId,
      dependsOn: input.dependsOn ?? adapter.operationDependencies?.(input.operation) ?? [],
      kind: adapter.operationKind(input.operation),
      args: adapter.operationCodec.encode(input.operation),
    };
    const entry: OutboxEntry<Operation> = {
      envelope,
      operation: toSyncOperation(envelope, input.operation),
      status: { _tag: "Pending" },
    };
    const row: StoredOutboxEntry = { envelope, status: entry.status };
    // The mark is raised in the same write that stores the row, so a crash between them cannot
    // leave a sequence issued but unrecorded.
    yield* store.commit(companyId, { upsertOutbox: [row], localSequenceHighWater: localSequence });
    yield* Ref.set(highWaterRef, localSequence);
    yield* Ref.set(entriesRef, [...entries, entry]);
    yield* publish;

    const published = yield* SubscriptionRef.get(state);
    const status: PendingSyncStatus = published.pending.find(
      (pending) => pending.operation.operationId === input.operationId,
    )?.status ?? { _tag: "Pending" };
    return {
      accepted: true,
      operationId: input.operationId,
      localSequence: envelope.localSequence,
      status,
    } satisfies SyncEnqueueReceipt;
  });

  const discardRejected = Effect.fn("SyncEngine.discardRejected")(function* (
    operationIds: ReadonlyArray<SyncOperationId>,
  ) {
    if (operationIds.length === 0) return;
    const removed = new Set(operationIds);
    yield* store.commit(companyId, { removeRejected: operationIds });
    yield* Ref.update(rejectedRef, (current) =>
      current.filter((rejection) => !removed.has(rejection.envelope.operationId)),
    );
    yield* publish;
  });

  const discardQuarantined = Effect.fn("SyncEngine.discardQuarantined")(function* (
    operationIds: ReadonlyArray<SyncOperationId>,
  ) {
    if (operationIds.length === 0) return;
    const removed = new Set(operationIds);
    yield* store.commit(companyId, { removeQuarantined: operationIds });
    yield* Ref.update(quarantinedRef, (current) =>
      current.filter((row) => !removed.has(row.envelope.operationId)),
    );
    yield* publish;
  });

  /**
   * One cycle, re-armed on a backoff for as long as it keeps ending in retryable trouble.
   *
   * The head stream says "the company moved"; it cannot say "your last cycle did not finish", and
   * no transport re-announces a version it has already emitted — they all deduplicate, because a
   * head that has not moved is not news. So a cycle killed by a blip mid-bootstrap or mid-flush
   * would otherwise leave the replica short and the outbox unsent until some *other* client wrote,
   * which on a quiet company is never. The engine owns this retry because the engine is the only
   * party that knows a cycle failed: `sync` answers with a receipt instead of failing, so the
   * stream sees nothing wrong.
   *
   * Only `offline` is re-armed — the outcome behind every retryable reason. `failed` is an
   * authorization or capability answer that the same call cannot talk its way out of, and looping
   * on it would spin against the deployment; it waits for a real head move like before.
   */
  const syncUntilSettled: Effect.Effect<SyncCycleReceipt, SyncStoreError> = Effect.repeat(sync, {
    schedule: SYNC_RETRY_SCHEDULE,
    while: (receipt) => receipt.outcome === "offline",
  });

  const run: Effect.Effect<void, SyncStoreError> = Effect.suspend(() =>
    whenCloudSyncEnabled(
      transport.latestVersion({ companyId }).pipe(
        Stream.runForEach(() => syncUntilSettled),
        Effect.catch((error: SyncTransportError | SyncStoreError) =>
          error._tag === "SyncStoreError"
            ? Effect.fail(error)
            : setPhase(transportPhase(error), error),
        ),
      ),
      undefined,
    ),
  );

  return {
    companyId,
    state,
    enqueue,
    sync,
    run,
    discardRejected,
    discardQuarantined,
  } satisfies SyncEngine<Entity, Operation>;
});

/**
 * The mark to start from. A document written before the mark existed reports 0, so the rows still
 * present carry the answer; from then on the stored mark is authoritative because it also covers
 * rows that were pruned.
 */
function highestLocalSequence(
  stored: LocalSequence,
  ...rows: ReadonlyArray<ReadonlyArray<{ readonly envelope: SyncOperationEnvelope }>>
): LocalSequence {
  let highest: number = stored;
  for (const group of rows) {
    for (const row of group) highest = Math.max(highest, row.envelope.localSequence);
  }
  return LocalSequence.make(highest);
}

/** Retryable transport trouble keeps the replica; an authorization answer stops the engine. */
function transportPhase(error: SyncTransportError): SyncPhase {
  return error.reason === "offline" || error.reason === "transport" ? "disconnected" : "failed";
}

function decodeRejections<Entity, Operation>(input: {
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  readonly rejections: ReadonlyArray<StoredSyncRejection>;
}): ReadonlyArray<RejectedSyncOperation<Operation>> {
  const decoded: Array<RejectedSyncOperation<Operation>> = [];
  for (const rejection of input.rejections) {
    const operation = decodeSyncOperation(input.adapter, rejection.envelope);
    if (Option.isNone(operation)) continue;
    decoded.push({
      operation: toSyncOperation(rejection.envelope, operation.value),
      code: rejection.code,
      message: rejection.message,
    });
  }
  return decoded;
}
