/**
 * IndexedDB {@link SyncStore} for web and Electron renderers.
 *
 * One database per (scope, company) — `pathway:cloud-sync/<scope>/<companyId>` — where the scope
 * names the signed-in user (and, when one origin serves several environments, the environment), so
 * two accounts on one origin can never read each other's replica. Five object stores:
 *
 * - `entities`   confirmed replica rows, keyed `[entityKind, entityId]`;
 * - `outbox`     pending and acknowledged operations, keyed by operation id;
 * - `rejected`   refusals kept for the recovery panel, insertion-ordered;
 * - `quarantine` outbox rows some build could not read, kept verbatim, insertion-ordered;
 * - `meta`       the checkpoint, the local-sequence high-water mark, and the insertion counter
 *                that preserves rejected/quarantine ordering across restarts.
 *
 * Every commit replays {@link applySyncStoreBatch}'s semantics — including "the high-water mark
 * never moves down" and "a quarantine move removes the outbox row in the same stroke" — inside a
 * single readwrite transaction across all five stores. A commit that fails mid-way aborts the
 * transaction explicitly, so a cursor advance can never land without the rows it covers, and an
 * outbox append can never land without its high-water mark.
 *
 * Migration story: {@link SYNC_INDEXED_DB_VERSION} equals the length of
 * {@link syncDatabaseMigrations}; opening a database runs, inside the browser's upgrade
 * transaction, exactly the migrations between the stored version and the current one. A shape
 * change appends one migration that transforms rows in place. A change that cannot transform rows
 * may clear `entities` and the checkpoint — the engine then re-bootstraps — but must carry
 * `outbox` and `quarantine` forward in some readable form, because those rows are a user's unsent
 * work. Payload-level shape changes that need no new object store go through
 * {@link SYNC_DOCUMENT_SCHEMA_VERSION} instead: the engine drops a checkpoint written by another
 * document schema version and re-bootstraps without an IndexedDB version bump. A checkpoint this
 * build cannot decode reads as `null` for the same reason.
 *
 * An outbox, rejected, or quarantine row this build cannot decode is not corruption either — some
 * build wrote it, and what it holds is a user's work — so it reads back as a quarantined row,
 * verbatim, exactly as an operation whose arguments the domain adapter cannot decode does. The
 * stored row itself is left where it is, so the build that understands it again still finds it in
 * the outbox and sends it. Only a row too damaged to name its operation, and any undecodable
 * replica row, fail the read loudly.
 *
 * @module sync/indexedDbStore
 */
import {
  LocalSequence,
  SyncOperationId,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  StoredOutboxEntry,
  StoredOutboxStatus,
  StoredSyncCheckpoint,
  StoredSyncEntity,
  StoredSyncQuarantine,
  StoredSyncRejection,
  type StoredSyncState,
  type SyncStoreBatch,
} from "./document.ts";
import { SyncStore, SyncStoreError } from "./persistence.ts";
import { SYNC_INDEXED_DB_PREFIX } from "./webNamespace.ts";

export { SYNC_INDEXED_DB_PREFIX } from "./webNamespace.ts";

const ENTITIES_STORE = "entities";
const OUTBOX_STORE = "outbox";
const REJECTED_STORE = "rejected";
const QUARANTINE_STORE = "quarantine";
const META_STORE = "meta";
const ALL_STORES = [ENTITIES_STORE, OUTBOX_STORE, REJECTED_STORE, QUARANTINE_STORE, META_STORE];

const META_CHECKPOINT_KEY = "checkpoint";
const META_HIGH_WATER_KEY = "localSequenceHighWater";
const META_INSERTION_ORDER_KEY = "insertionOrder";

/** One step of the IndexedDB schema history, run inside the upgrade transaction. */
export type SyncDatabaseMigration = (database: IDBDatabase, transaction: IDBTransaction) => void;

/**
 * Complete schema history. `syncDatabaseMigrations[n]` migrates version `n` to `n + 1`; a fresh
 * database starts at 0 and runs them all. Append — never edit — entries.
 */
export const syncDatabaseMigrations: ReadonlyArray<SyncDatabaseMigration> = [
  (database) => {
    database.createObjectStore(ENTITIES_STORE, { keyPath: ["entityKind", "entityId"] });
    database.createObjectStore(OUTBOX_STORE, { keyPath: "envelope.operationId" });
    database.createObjectStore(REJECTED_STORE, { keyPath: "rejection.envelope.operationId" });
    database.createObjectStore(QUARANTINE_STORE, { keyPath: "row.envelope.operationId" });
    database.createObjectStore(META_STORE);
  },
];

export const SYNC_INDEXED_DB_VERSION = syncDatabaseMigrations.length;

export function syncDatabaseName(scope: string, companyId: CompanyId): string {
  return `${SYNC_INDEXED_DB_PREFIX}/${scope}/${companyId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves with the request's result, rejecting with the request's error. */
function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The IndexedDB request failed."));
  });
}

/** Resolves when the transaction commits; rejects when it aborts or errors. */
function awaitTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The IndexedDB transaction was aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("The IndexedDB transaction failed."));
  });
}

export interface OpenSyncDatabaseOptions {
  readonly factory: IDBFactory;
  readonly name: string;
  /** Defaults to {@link SYNC_INDEXED_DB_VERSION}; tests override to exercise the upgrade path. */
  readonly version?: number;
  /** Defaults to {@link syncDatabaseMigrations}; tests override to simulate future versions. */
  readonly migrations?: ReadonlyArray<SyncDatabaseMigration>;
}

/**
 * Opens (creating or upgrading as needed) one sync database, running only the migrations between
 * the stored version and the requested one. Exported for the upgrade-path tests and for platform
 * wiring that needs the raw handle; the store service below is the normal entry point.
 */
export function openSyncDatabase(options: OpenSyncDatabaseOptions): Promise<IDBDatabase> {
  const version = options.version ?? SYNC_INDEXED_DB_VERSION;
  const migrations = options.migrations ?? syncDatabaseMigrations;
  return new Promise((resolve, reject) => {
    const request = options.factory.open(options.name, version);
    request.onupgradeneeded = (event) => {
      runMigrations({ request, from: event.oldVersion, to: version, migrations });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error;
      // A newer build — another tab, or this origin before a rollback — already upgraded this
      // database, and IndexedDB refuses to open one at a lower version than it is at. Take it at
      // the version that build left behind instead: migrations only ever add, so every store this
      // build reads is still there, and rows it cannot decode quarantine rather than fail. An
      // explicit version is a caller saying which version it means, so it is left to fail.
      if (options.version === undefined && error?.name === "VersionError") {
        openAtStoredVersion(options.factory, options.name, migrations).then(resolve, reject);
        return;
      }
      reject(error ?? new Error(`Opening the "${options.name}" database failed.`));
    };
  });
}

/** Runs `migrations[from] … migrations[to - 1]` inside the open request's upgrade transaction. */
function runMigrations(input: {
  readonly request: IDBOpenDBRequest;
  readonly from: number;
  readonly to: number;
  readonly migrations: ReadonlyArray<SyncDatabaseMigration>;
}): void {
  const transaction = input.request.transaction;
  if (transaction === null) return;
  for (let from = input.from; from < input.to; from += 1) {
    const migrate = input.migrations[from];
    if (migrate === undefined) {
      throw new Error(`No migration is registered from sync database version ${from}.`);
    }
    migrate(input.request.result, transaction);
  }
}

/** Opens whatever version is on disk; only reached once a newer build has moved it past ours. */
function openAtStoredVersion(
  factory: IDBFactory,
  name: string,
  migrations: ReadonlyArray<SyncDatabaseMigration>,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    // Only fires if the database was deleted between the two opens; a versionless open then
    // creates version 1, so the history runs from the start.
    request.onupgradeneeded = (event) => {
      runMigrations({ request, from: event.oldVersion, to: request.result.version, migrations });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Opening the "${name}" database failed.`));
  });
}

function deleteSyncDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`Deleting the "${name}" database failed.`));
  });
}

/** Rejected rows wrapped with a monotonic stamp so read order equals append order. */
const StoredRejectionRow = Schema.Struct({
  order: Schema.Number,
  rejection: StoredSyncRejection,
});

/** Quarantined rows wrapped the same way; the stamp counter is shared with `rejected`. */
const StoredQuarantineRow = Schema.Struct({
  order: Schema.Number,
  row: StoredSyncQuarantine,
});

/**
 * The least a row this build cannot read must still carry for quarantine to hold it: the
 * operation id the quarantine store is keyed by, and the local sequence the high-water mark is
 * derived from. Anything less is not a row a later build could recover — it is a corrupt one.
 */
const SalvageableRow = Schema.Struct({
  envelope: Schema.Struct({ operationId: SyncOperationId, localSequence: LocalSequence }),
});

const decodeEntity = Schema.decodeUnknownOption(StoredSyncEntity);
const decodeOutboxRow = Schema.decodeUnknownOption(StoredOutboxEntry);
const decodeRejectionRow = Schema.decodeUnknownOption(StoredRejectionRow);
const decodeQuarantineRow = Schema.decodeUnknownOption(StoredQuarantineRow);
const decodeCheckpoint = Schema.decodeUnknownOption(StoredSyncCheckpoint);
const decodeHighWater = Schema.decodeUnknownOption(LocalSequence);
const decodeSalvageableRow = Schema.decodeUnknownOption(SalvageableRow);
const decodeOutboxStatus = Schema.decodeUnknownOption(StoredOutboxStatus);

/**
 * Wraps a row this build cannot read as a quarantine row, or answers `null` when even the
 * operation it belongs to is unreadable. The stored value is carried over as it is: the parts
 * this build cannot decode are exactly the parts a build that can needs back.
 */
function salvageRow(stored: unknown, fallbackReason: string): StoredSyncQuarantine | null {
  if (Option.isNone(decodeSalvageableRow(stored))) return null;
  const row = stored as {
    readonly envelope: unknown;
    readonly status?: unknown;
    readonly reason?: unknown;
  };
  return {
    envelope: row.envelope as SyncOperationEnvelope,
    status: Option.getOrElse(
      decodeOutboxStatus(row.status),
      (): StoredOutboxStatus => ({ _tag: "Pending" }),
    ),
    // A quarantine row that was already unreadable once keeps the reason it was quarantined for.
    reason: typeof row.reason === "string" ? row.reason : fallbackReason,
  };
}

/** The insertion stamp of a wrapper row; unstamped rows sort after every stamped one. */
function stampOf(stored: unknown): number {
  const order = (stored as { readonly order?: unknown }).order;
  return typeof order === "number" ? order : Number.MAX_SAFE_INTEGER;
}

interface RawSnapshot {
  readonly entities: ReadonlyArray<unknown>;
  readonly outbox: ReadonlyArray<unknown>;
  readonly rejected: ReadonlyArray<unknown>;
  readonly quarantined: ReadonlyArray<unknown>;
  readonly checkpoint: unknown;
  readonly localSequenceHighWater: unknown;
}

type DecodedSnapshot =
  | { readonly ok: true; readonly state: StoredSyncState }
  | { readonly ok: false; readonly error: SyncStoreError };

function decodeSnapshot(databaseName: string, raw: RawSnapshot): DecodedSnapshot {
  const bad = (what: string): DecodedSnapshot => ({
    ok: false,
    error: new SyncStoreError({
      operation: "read",
      message: `The "${databaseName}" database holds ${what} this build cannot read.`,
    }),
  });

  const entities: Array<StoredSyncEntity> = [];
  for (const row of raw.entities) {
    const decoded = decodeEntity(row);
    if (Option.isNone(decoded)) return bad("a replica row");
    entities.push(decoded.value);
  }

  // Rows this build cannot read do not fail the read: they leave the send path and land in
  // quarantine, whole, so a stale tab (or a rolled-back build) sharing this database still starts
  // and the work in them survives until a build that understands them reads them back.
  const quarantinedRows: Array<typeof StoredQuarantineRow.Type> = [];

  const outbox: Array<StoredOutboxEntry> = [];
  for (const row of raw.outbox) {
    const decoded = decodeOutboxRow(row);
    if (Option.isNone(decoded)) {
      const salvaged = salvageRow(
        row,
        "This build cannot read the stored shape of this outbox row.",
      );
      if (salvaged === null) return bad("an outbox row");
      quarantinedRows.push({ order: stampOf(row), row: salvaged });
      continue;
    }
    outbox.push(decoded.value);
  }
  outbox.sort((left, right) => left.envelope.localSequence - right.envelope.localSequence);

  const rejectedRows: Array<typeof StoredRejectionRow.Type> = [];
  for (const row of raw.rejected) {
    const decoded = decodeRejectionRow(row);
    if (Option.isNone(decoded)) {
      const salvaged = salvageRow(
        (row as { readonly rejection?: unknown }).rejection,
        "This build cannot read the stored shape of this rejected row.",
      );
      if (salvaged === null) return bad("a rejected row");
      quarantinedRows.push({ order: stampOf(row), row: salvaged });
      continue;
    }
    rejectedRows.push(decoded.value);
  }
  rejectedRows.sort((left, right) => left.order - right.order);

  for (const row of raw.quarantined) {
    const decoded = decodeQuarantineRow(row);
    if (Option.isNone(decoded)) {
      const salvaged = salvageRow(
        (row as { readonly row?: unknown }).row,
        "This build cannot read the stored shape of this quarantined row.",
      );
      if (salvaged === null) return bad("a quarantined row");
      quarantinedRows.push({ order: stampOf(row), row: salvaged });
      continue;
    }
    quarantinedRows.push(decoded.value);
  }
  quarantinedRows.sort((left, right) => left.order - right.order);

  // A checkpoint written by a document schema this build does not know reads as "no checkpoint":
  // the engine re-bootstraps, exactly as it does for an explicit schema-version mismatch. The
  // other stores never take that shortcut — their rows carry user work.
  const checkpoint =
    raw.checkpoint === undefined ? null : Option.getOrNull(decodeCheckpoint(raw.checkpoint));

  let localSequenceHighWater = LocalSequence.make(0);
  if (raw.localSequenceHighWater !== undefined) {
    const decoded = decodeHighWater(raw.localSequenceHighWater);
    if (Option.isNone(decoded)) return bad("a local-sequence high-water mark");
    localSequenceHighWater = decoded.value;
  }

  return {
    ok: true,
    state: {
      checkpoint,
      entities,
      outbox,
      rejected: rejectedRows.map((row) => row.rejection),
      quarantined: quarantinedRows.map((row) => row.row),
      localSequenceHighWater,
    },
  };
}

export interface IndexedDbSyncStoreOptions {
  /**
   * Names the user (and environment, when one origin serves several) this replica belongs to.
   * Part of every database name, so switching accounts switches databases instead of leaking rows.
   */
  readonly scope: string;
  /** Injectable for tests (fake-indexeddb); defaults to the ambient `indexedDB`. */
  readonly factory?: IDBFactory;
}

export interface IndexedDbSyncStore {
  readonly service: SyncStore["Service"];
  readonly databaseName: (companyId: CompanyId) => string;
  /** Closes every open connection; a reopened store instance sees the same rows. */
  readonly close: Effect.Effect<void>;
}

export const makeIndexedDbSyncStore = Effect.fn("makeIndexedDbSyncStore")(function* (
  options: IndexedDbSyncStoreOptions,
) {
  const ambient = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const factory = options.factory ?? ambient;
  if (factory === undefined) {
    return yield* Effect.die(
      new Error(
        "IndexedDB is not available in this context. Pass an explicit factory, or use the in-memory sync store.",
      ),
    );
  }

  const databaseName = (companyId: CompanyId) => syncDatabaseName(options.scope, companyId);
  const connections = new Map<string, Promise<IDBDatabase>>();

  const connect = (companyId: CompanyId): Promise<IDBDatabase> => {
    const name = databaseName(companyId);
    const existing = connections.get(name);
    if (existing !== undefined) return existing;
    const opened = openSyncDatabase({ factory, name }).then((database) => {
      // Another context is upgrading (a newer build in another tab): yield the connection. The
      // next operation reopens at whatever version that build left behind.
      database.onversionchange = () => {
        database.close();
        connections.delete(name);
      };
      return database;
    });
    opened.catch(() => connections.delete(name));
    connections.set(name, opened);
    return opened;
  };

  const readRaw = async (companyId: CompanyId): Promise<RawSnapshot> => {
    const database = await connect(companyId);
    const transaction = database.transaction(ALL_STORES, "readonly");
    const meta = transaction.objectStore(META_STORE);
    const [entities, outbox, rejected, quarantined, checkpoint, localSequenceHighWater] =
      await Promise.all([
        awaitRequest<Array<unknown>>(transaction.objectStore(ENTITIES_STORE).getAll()),
        awaitRequest<Array<unknown>>(transaction.objectStore(OUTBOX_STORE).getAll()),
        awaitRequest<Array<unknown>>(transaction.objectStore(REJECTED_STORE).getAll()),
        awaitRequest<Array<unknown>>(transaction.objectStore(QUARANTINE_STORE).getAll()),
        awaitRequest<unknown>(meta.get(META_CHECKPOINT_KEY)),
        awaitRequest<unknown>(meta.get(META_HIGH_WATER_KEY)),
      ]);
    await awaitTransaction(transaction);
    return { entities, outbox, rejected, quarantined, checkpoint, localSequenceHighWater };
  };

  const commitRaw = async (companyId: CompanyId, batch: SyncStoreBatch): Promise<void> => {
    const database = await connect(companyId);
    const transaction = database.transaction(ALL_STORES, "readwrite");
    try {
      const meta = transaction.objectStore(META_STORE);
      const [rawHighWater, rawOrder] = await Promise.all([
        awaitRequest<unknown>(meta.get(META_HIGH_WATER_KEY)),
        awaitRequest<unknown>(meta.get(META_INSERTION_ORDER_KEY)),
      ]);
      const storedOrder = typeof rawOrder === "number" ? rawOrder : 0;
      let order = storedOrder;

      // Deletes first, puts second: an entity named in both lands upserted, as in the reference.
      const entities = transaction.objectStore(ENTITIES_STORE);
      if (batch.resetEntities === true) entities.clear();
      for (const key of batch.deleteEntities ?? []) entities.delete([key.entityKind, key.entityId]);
      for (const entity of batch.upsertEntities ?? []) entities.put(entity);

      // Puts first, deletes second: for the outbox and both panels, a removal beats an upsert
      // named in the same batch, again as in the reference.
      const outbox = transaction.objectStore(OUTBOX_STORE);
      for (const entry of batch.upsertOutbox ?? []) outbox.put(entry);
      for (const operationId of batch.removeOutbox ?? []) outbox.delete(operationId);

      const rejected = transaction.objectStore(REJECTED_STORE);
      for (const rejection of batch.appendRejected ?? []) {
        order += 1;
        rejected.put({ order, rejection } satisfies typeof StoredRejectionRow.Type);
      }
      for (const operationId of batch.removeRejected ?? []) rejected.delete(operationId);

      const quarantine = transaction.objectStore(QUARANTINE_STORE);
      for (const row of batch.quarantineOutbox ?? []) {
        order += 1;
        quarantine.put({ order, row } satisfies typeof StoredQuarantineRow.Type);
      }
      for (const operationId of batch.removeQuarantined ?? []) {
        quarantine.delete(operationId);
        // A quarantined operation is neither sendable nor rejected, so these are no-ops for a row
        // this build moved itself — but a row it only *read* as quarantined, because it could not
        // decode it, is still sitting in the store it came from, and a discard has to reach it.
        outbox.delete(operationId);
        rejected.delete(operationId);
      }

      if (batch.checkpoint !== undefined) meta.put(batch.checkpoint, META_CHECKPOINT_KEY);

      const currentHighWater = typeof rawHighWater === "number" ? rawHighWater : 0;
      const nextHighWater = Math.max(currentHighWater, batch.localSequenceHighWater ?? 0);
      if (nextHighWater !== currentHighWater) meta.put(nextHighWater, META_HIGH_WATER_KEY);
      if (order !== storedOrder) meta.put(order, META_INSERTION_ORDER_KEY);

      await awaitTransaction(transaction);
    } catch (error) {
      // Without this, requests issued before the failure would auto-commit on their own — exactly
      // the half-applied batch the port forbids.
      try {
        transaction.abort();
      } catch {
        // Already aborted or committed; the original error is the one that matters.
      }
      throw error;
    }
  };

  const clearRaw = async (companyId: CompanyId): Promise<void> => {
    const name = databaseName(companyId);
    const open = connections.get(name);
    if (open !== undefined) {
      connections.delete(name);
      (await open).close();
    }
    await deleteSyncDatabase(factory, name);
  };

  const service = SyncStore.of({
    read: (companyId) =>
      Effect.tryPromise({
        try: () => readRaw(companyId),
        catch: (error: unknown) =>
          new SyncStoreError({
            operation: "read",
            message: `Reading the "${databaseName(companyId)}" database failed: ${describeError(error)}`,
          }),
      }).pipe(
        Effect.flatMap((raw) => {
          const decoded = decodeSnapshot(databaseName(companyId), raw);
          return decoded.ok ? Effect.succeed(decoded.state) : Effect.fail(decoded.error);
        }),
      ),
    commit: (companyId, batch) =>
      Effect.tryPromise({
        try: () => commitRaw(companyId, batch),
        catch: (error: unknown) =>
          new SyncStoreError({
            operation: "commit",
            message: `Writing to the "${databaseName(companyId)}" database failed: ${describeError(error)}`,
          }),
      }),
    clear: (companyId) =>
      Effect.tryPromise({
        try: () => clearRaw(companyId),
        catch: (error: unknown) =>
          new SyncStoreError({
            operation: "clear",
            message: `Deleting the "${databaseName(companyId)}" database failed: ${describeError(error)}`,
          }),
      }),
  });

  const close = Effect.promise(async () => {
    const open = [...connections.values()];
    connections.clear();
    for (const pending of open) {
      try {
        (await pending).close();
      } catch {
        // The connection never opened; there is nothing to close.
      }
    }
  });

  return { service, databaseName, close } satisfies IndexedDbSyncStore;
});

export const indexedDbSyncStoreLayer = (options: IndexedDbSyncStoreOptions) =>
  Layer.effect(
    SyncStore,
    makeIndexedDbSyncStore(options).pipe(Effect.map((store) => store.service)),
  );
