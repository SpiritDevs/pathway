/**
 * SQLite {@link SyncStore} adapter over a minimal injected SQL executor.
 *
 * The adapter owns its schema outright: every table is prefixed `cloud_sync_` and versioned
 * through its own `cloud_sync_store_migrations` table, so a host application can point it at an
 * existing database without threading anything through the host's migration chain, and two opens
 * of the same file converge on the same schema. The executor seam keeps `@spiritdevs/client-runtime`
 * free of native dependencies — the Pathway server hands in its `node:sqlite`-backed SqlClient,
 * mobile its own driver, and tests whatever SQLite they have on hand.
 *
 * Rows are stored encoded (envelopes and payloads as JSON text), exactly as
 * {@link module:sync/document} requires: this store never decodes a domain payload, so a row
 * written by a newer build survives verbatim for the engine to quarantine or a later build to
 * read. `commit` reproduces `applySyncStoreBatch` inside one executor transaction, which is what
 * makes a crash mid-batch invisible.
 *
 * Reads decode every row on its own. An outbox, rejected, or quarantine row this build cannot read
 * — a blob some other build wrote, a status tag it has never heard of, a truncated write — is not
 * corruption but a user's unsent work, so it reads back as a quarantined row, out of the send path
 * and whole, while the stored row itself stays in the table it came from. Only a row too damaged
 * to name its operation, and any undecodable replica row, fail the read loudly; an undecodable
 * checkpoint reads as none at all and the engine re-bootstraps. This is the same contract
 * {@link module:sync/indexedDbStore} keeps, so the two adapters recover identically.
 *
 * @module sync/sqliteStore
 */
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  type SyncEntityId,
  type SyncEntityKind,
  type SyncOperationEnvelope,
  type SyncRejectionCode,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  StoredOutboxEntry,
  StoredOutboxStatus,
  StoredSyncCheckpoint,
  StoredSyncEntity,
  StoredSyncQuarantine,
  StoredSyncRejection,
  StoredSyncState,
  SyncStoreBatch,
} from "./document.ts";
import { SyncStore, SyncStoreError } from "./persistence.ts";

// ---------------------------------------------------------------------------
// Executor seam
// ---------------------------------------------------------------------------

export class SqliteSyncExecutorError extends Schema.TaggedErrorClass<SqliteSyncExecutorError>()(
  "SqliteSyncExecutorError",
  { message: Schema.String },
) {}

/** Values the adapter binds as positional `?` parameters. */
export type SqliteSyncValue = null | number | string;

/** Values a driver may hand back for a column (some drivers surface integers as bigint). */
export type SqliteSyncResultValue = null | number | string | bigint | Uint8Array;

export type SqliteSyncRow = { readonly [column: string]: SqliteSyncResultValue };

/**
 * The whole surface the adapter needs from a SQLite driver. Implementations exist where the
 * driver does — the server wraps its SqlClient, tests wrap `node:sqlite` — so this package never
 * links a native module.
 *
 * Contract: each call executes exactly one statement. `withTransaction` runs the effect between
 * BEGIN and COMMIT and rolls back when the effect fails or dies; the adapter never nests
 * transactions, so savepoint support is optional.
 */
export interface SqliteSyncExecutor {
  /** One parameterless statement; the adapter only uses it for DDL. */
  readonly exec: (statement: string) => Effect.Effect<void, SqliteSyncExecutorError>;
  /** One statement with positional parameters, rows discarded. */
  readonly run: (
    statement: string,
    params: ReadonlyArray<SqliteSyncValue>,
  ) => Effect.Effect<void, SqliteSyncExecutorError>;
  /** One statement with positional parameters, rows returned as column records. */
  readonly all: (
    statement: string,
    params: ReadonlyArray<SqliteSyncValue>,
  ) => Effect.Effect<ReadonlyArray<SqliteSyncRow>, SqliteSyncExecutorError>;
  readonly withTransaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SqliteSyncExecutorError>;
}

// ---------------------------------------------------------------------------
// Schema, owned and versioned by the adapter
// ---------------------------------------------------------------------------

/** Namespaced so it cannot collide with a host application's own migration bookkeeping. */
const MIGRATIONS_TABLE = "cloud_sync_store_migrations";

interface SqliteSyncStoreMigration {
  readonly version: number;
  readonly statements: ReadonlyArray<string>;
}

/**
 * Append-only. Insertion order doubles as persisted order: `cloud_sync_entities`,
 * `cloud_sync_rejected`, and `cloud_sync_quarantine` are read back `ORDER BY rowid`, which
 * together with delete-then-insert upserts reproduces the array semantics of
 * `applySyncStoreBatch` (retained rows first, new and re-written rows appended).
 */
const SQLITE_SYNC_STORE_MIGRATIONS: ReadonlyArray<SqliteSyncStoreMigration> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE cloud_sync_checkpoints (
        company_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        cursor INTEGER NOT NULL,
        authorization_epoch INTEGER NOT NULL,
        bootstrapped INTEGER NOT NULL
      )`,
      `CREATE TABLE cloud_sync_entities (
        company_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (company_id, entity_kind, entity_id)
      )`,
      `CREATE TABLE cloud_sync_outbox (
        company_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        local_sequence INTEGER NOT NULL,
        envelope TEXT NOT NULL,
        status_tag TEXT NOT NULL,
        acknowledged_version INTEGER,
        PRIMARY KEY (company_id, operation_id)
      )`,
      `CREATE INDEX cloud_sync_outbox_by_sequence
        ON cloud_sync_outbox (company_id, local_sequence)`,
      `CREATE TABLE cloud_sync_rejected (
        company_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (company_id, operation_id)
      )`,
      `CREATE TABLE cloud_sync_quarantine (
        company_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        status_tag TEXT NOT NULL,
        acknowledged_version INTEGER,
        reason TEXT NOT NULL,
        PRIMARY KEY (company_id, operation_id)
      )`,
      `CREATE TABLE cloud_sync_local_sequences (
        company_id TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL
      )`,
    ],
  },
];

const migrateSqliteSyncStore = Effect.fn("migrateSqliteSyncStore")(function* (
  executor: SqliteSyncExecutor,
) {
  yield* executor.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY)`,
  );
  const applyPending = Effect.gen(function* () {
    const rows = yield* executor.all(
      `SELECT COALESCE(MAX(version), 0) AS version FROM ${MIGRATIONS_TABLE}`,
      [],
    );
    const current = columnNumber(rows[0]?.["version"]);
    for (const migration of SQLITE_SYNC_STORE_MIGRATIONS) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) {
        yield* executor.exec(statement);
      }
      yield* executor.run(`INSERT INTO ${MIGRATIONS_TABLE} (version) VALUES (?)`, [
        migration.version,
      ]);
    }
  });
  // Sequentially, the version guard alone makes reopening a no-op. Concurrently — two processes
  // opening the same file for the first time — both can read version 0 inside their own deferred
  // transactions, and the loser's DDL then fails against the schema the winner just committed
  // (SQLITE_BUSY on the snapshot upgrade, or "table already exists"). One retry is all it takes to
  // converge: the second pass re-reads the version, finds the winner's row, and applies nothing.
  // Anything still failing after it is a genuine error and propagates.
  yield* Effect.retry(executor.withTransaction(applyPending), { times: 1 });
});

// ---------------------------------------------------------------------------
// Row codecs
// ---------------------------------------------------------------------------

function columnNumber(value: SqliteSyncResultValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`expected a numeric column, got ${typeof value}`);
}

function columnString(value: SqliteSyncResultValue | undefined): string {
  if (typeof value === "string") return value;
  throw new Error(`expected a text column, got ${typeof value}`);
}

function encodeJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("value is not JSON-serializable");
  }
  return text;
}

/** Runs one row codec, answering `null` when the row it was handed is not the shape it expects. */
function decoded<A>(decode: () => A): A | null {
  try {
    return decode();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEnvelope(value: SqliteSyncResultValue | undefined): SyncOperationEnvelope {
  const parsed: unknown = JSON.parse(columnString(value));
  if (!isRecord(parsed)) {
    throw new Error(`expected an envelope object, got ${typeof parsed}`);
  }
  return parsed as unknown as SyncOperationEnvelope;
}

function decodeStatus(row: SqliteSyncRow): StoredOutboxStatus {
  const tag = columnString(row["status_tag"]);
  if (tag === "Pending") return { _tag: "Pending" };
  if (tag === "Acknowledged") {
    return {
      _tag: "Acknowledged",
      version: CompanyVersion.make(columnNumber(row["acknowledged_version"])),
    };
  }
  // A tag some other build wrote is emphatically not "Pending": reading it as one would resend an
  // operation that build may already consider applied. The row leaves the send path instead.
  throw new Error(`expected a known outbox status, got ${JSON.stringify(tag)}`);
}

function statusColumns(status: StoredOutboxStatus): readonly [string, number | null] {
  return status._tag === "Acknowledged" ? ["Acknowledged", status.version] : ["Pending", null];
}

function decodeCheckpoint(row: SqliteSyncRow): StoredSyncCheckpoint | null {
  return decoded(() => ({
    // Preserved verbatim; the engine compares it against its own SYNC_DOCUMENT_SCHEMA_VERSION
    // and drops the checkpoint on mismatch, so the store must not judge it here.
    schemaVersion: columnNumber(row["schema_version"]) as StoredSyncCheckpoint["schemaVersion"],
    companyId: CompanyId.make(columnString(row["company_id"])),
    cursor: CompanyVersion.make(columnNumber(row["cursor"])),
    authorizationEpoch: AuthorizationEpoch.make(columnNumber(row["authorization_epoch"])),
    bootstrapped: columnNumber(row["bootstrapped"]) !== 0,
  }));
}

function decodeEntity(row: SqliteSyncRow): StoredSyncEntity | null {
  return decoded(() => ({
    entityKind: columnString(row["entity_kind"]) as SyncEntityKind,
    entityId: columnString(row["entity_id"]) as SyncEntityId,
    version: CompanyVersion.make(columnNumber(row["version"])),
    payload: JSON.parse(columnString(row["payload"])) as unknown,
  }));
}

function decodeOutboxRow(row: SqliteSyncRow): StoredOutboxEntry | null {
  return decoded(() => ({ envelope: decodeEnvelope(row["envelope"]), status: decodeStatus(row) }));
}

function decodeRejectedRow(row: SqliteSyncRow): StoredSyncRejection | null {
  return decoded(() => ({
    envelope: decodeEnvelope(row["envelope"]),
    code: columnString(row["code"]) as SyncRejectionCode,
    message: columnString(row["message"]),
  }));
}

function decodeQuarantineRow(row: SqliteSyncRow): StoredSyncQuarantine | null {
  return decoded(() => ({
    envelope: decodeEnvelope(row["envelope"]),
    status: decodeStatus(row),
    reason: columnString(row["reason"]),
  }));
}

/**
 * Wraps a row this build cannot read as a quarantine row, or answers `null` when not even the
 * operation it belongs to can be named.
 *
 * What the envelope blob does hold is carried over as it is — the parts this build cannot decode
 * are exactly the parts a build that can needs back — but the quarantine list is keyed by
 * operation id, and a blob too damaged to parse cannot supply one. The columns beside it can: no
 * amount of JSON damage reaches `operation_id`, `local_sequence`, or `reason`, so those are what a
 * salvaged row falls back to.
 */
function salvageRow(row: SqliteSyncRow, fallbackReason: string): StoredSyncQuarantine | null {
  const stored = decoded(() => JSON.parse(columnString(row["envelope"])) as unknown);
  const blob = isRecord(stored) ? stored : {};
  const operationId =
    typeof blob["operationId"] === "string"
      ? blob["operationId"]
      : decoded(() => columnString(row["operation_id"]));
  if (operationId === null) return null;
  const localSequence =
    typeof blob["localSequence"] === "number"
      ? blob["localSequence"]
      : // Only the outbox carries the column; a rejected or quarantined row whose blob lost its
        // sequence has nothing left to send, so an unknown sequence is recorded as zero.
        (decoded(() => columnNumber(row["local_sequence"])) ?? 0);
  return {
    envelope: { ...blob, operationId, localSequence } as unknown as SyncOperationEnvelope,
    // Unknown to this build is not "Pending": a salvaged row is out of the send path either way,
    // and the durable row keeps whatever tag the build that wrote it meant.
    status: decoded(() => decodeStatus(row)) ?? { _tag: "Pending" },
    // A quarantined row that was already unreadable once keeps the reason it was quarantined for.
    reason: decoded(() => columnString(row["reason"])) ?? fallbackReason,
  };
}

interface RawSnapshot {
  readonly checkpoints: ReadonlyArray<SqliteSyncRow>;
  readonly entities: ReadonlyArray<SqliteSyncRow>;
  readonly outbox: ReadonlyArray<SqliteSyncRow>;
  readonly rejected: ReadonlyArray<SqliteSyncRow>;
  readonly quarantined: ReadonlyArray<SqliteSyncRow>;
  readonly sequences: ReadonlyArray<SqliteSyncRow>;
}

type DecodedSnapshot =
  | { readonly ok: true; readonly state: StoredSyncState }
  | { readonly ok: false; readonly error: SyncStoreError };

/**
 * Decodes one company's rows, each on its own.
 *
 * An outbox, rejected, or quarantine row this build cannot read is not corruption — some build
 * wrote it, and what it holds is a user's work — so it reads back as a quarantined row rather than
 * failing the whole read, exactly as an operation whose arguments the domain adapter cannot decode
 * does. The stored row itself is left in the table it came from, so the build that understands it
 * again still finds it in the outbox and sends it; that is why a discard has to reach all three
 * tables (see {@link commitStatements}). Only a row too damaged to name its operation, and any
 * undecodable replica row, fail the read loudly.
 */
function decodeSnapshot(raw: RawSnapshot): DecodedSnapshot {
  const bad = (what: string): DecodedSnapshot => ({
    ok: false,
    error: new SyncStoreError({
      operation: "read",
      message: `unreadable stored row: the store holds ${what} this build cannot read`,
    }),
  });

  const entities: Array<StoredSyncEntity> = [];
  for (const row of raw.entities) {
    const entity = decodeEntity(row);
    if (entity === null) return bad("a replica row");
    entities.push(entity);
  }

  // Quarantine first, in its own order: a row this build cannot read there keeps the place — and
  // the reason — the build that quarantined it gave it. Rows salvaged out of the other two tables
  // follow, in the order those tables are read.
  const quarantined: Array<StoredSyncQuarantine> = [];
  for (const row of raw.quarantined) {
    const quarantine = decodeQuarantineRow(row);
    if (quarantine !== null) {
      quarantined.push(quarantine);
      continue;
    }
    const salvaged = salvageRow(
      row,
      "This build cannot read the stored shape of this quarantined row.",
    );
    if (salvaged === null) return bad("a quarantined row");
    quarantined.push(salvaged);
  }

  const rejected: Array<StoredSyncRejection> = [];
  for (const row of raw.rejected) {
    const rejection = decodeRejectedRow(row);
    if (rejection !== null) {
      rejected.push(rejection);
      continue;
    }
    const salvaged = salvageRow(
      row,
      "This build cannot read the stored shape of this rejected row.",
    );
    if (salvaged === null) return bad("a rejected row");
    quarantined.push(salvaged);
  }

  const outbox: Array<StoredOutboxEntry> = [];
  for (const row of raw.outbox) {
    const entry = decodeOutboxRow(row);
    if (entry !== null) {
      outbox.push(entry);
      continue;
    }
    const salvaged = salvageRow(row, "This build cannot read the stored shape of this outbox row.");
    if (salvaged === null) return bad("an outbox row");
    quarantined.push(salvaged);
  }

  const sequenceRow = raw.sequences[0];
  const highWater =
    sequenceRow === undefined ? 0 : decoded(() => columnNumber(sequenceRow["high_water"]));
  if (highWater === null) return bad("a local-sequence high-water mark");

  const checkpointRow = raw.checkpoints[0];
  return {
    ok: true,
    state: {
      // A checkpoint this build cannot read reads as "no checkpoint": the engine re-bootstraps,
      // exactly as it does for an explicit schema-version mismatch. The other tables never take
      // that shortcut — their rows carry user work.
      checkpoint: checkpointRow === undefined ? null : decodeCheckpoint(checkpointRow),
      entities,
      outbox,
      rejected,
      quarantined,
      localSequenceHighWater: LocalSequence.make(highWater),
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface SqliteSyncStore {
  readonly service: SyncStore["Service"];
}

/**
 * Opens (creating or migrating the `cloud_sync_*` tables as needed) a {@link SyncStore} over the
 * given executor. Safe to call more than once against the same database.
 */
export const makeSqliteSyncStore = Effect.fn("makeSqliteSyncStore")(function* (
  executor: SqliteSyncExecutor,
) {
  yield* migrateSqliteSyncStore(executor);

  const storeError =
    (operation: "read" | "commit" | "clear") =>
    (error: SqliteSyncExecutorError): SyncStoreError =>
      new SyncStoreError({ operation, message: error.message });

  const read = Effect.fn("SqliteSyncStore.read")(function* (companyId: CompanyId) {
    const state = yield* executor
      .withTransaction(
        Effect.gen(function* () {
          const byCompany = (statement: string) => executor.all(statement, [companyId]);
          const checkpoints = yield* byCompany(
            `SELECT company_id, schema_version, cursor, authorization_epoch, bootstrapped
              FROM cloud_sync_checkpoints WHERE company_id = ?`,
          );
          const entities = yield* byCompany(
            `SELECT entity_kind, entity_id, version, payload
              FROM cloud_sync_entities WHERE company_id = ? ORDER BY rowid`,
          );
          // `operation_id` (and the outbox's `local_sequence`) are selected for salvage, not for
          // the happy path: they are what names a row whose envelope blob is unreadable.
          const outbox = yield* byCompany(
            `SELECT operation_id, local_sequence, envelope, status_tag, acknowledged_version
              FROM cloud_sync_outbox WHERE company_id = ? ORDER BY local_sequence`,
          );
          const rejected = yield* byCompany(
            `SELECT operation_id, envelope, code, message
              FROM cloud_sync_rejected WHERE company_id = ? ORDER BY rowid`,
          );
          const quarantined = yield* byCompany(
            `SELECT operation_id, envelope, status_tag, acknowledged_version, reason
              FROM cloud_sync_quarantine WHERE company_id = ? ORDER BY rowid`,
          );
          const sequences = yield* byCompany(
            `SELECT high_water FROM cloud_sync_local_sequences WHERE company_id = ?`,
          );
          return { checkpoints, entities, outbox, rejected, quarantined, sequences };
        }),
      )
      .pipe(Effect.mapError(storeError("read")));

    const snapshot = decodeSnapshot(state);
    return snapshot.ok ? snapshot.state : yield* snapshot.error;
  });

  const commit = Effect.fn("SqliteSyncStore.commit")(function* (
    companyId: CompanyId,
    batch: SyncStoreBatch,
  ) {
    // Serialize everything before the transaction opens: a JSON failure must not abort a
    // half-written batch, it must abort a batch that never started.
    const statements = yield* Effect.try({
      try: () => commitStatements(companyId, batch),
      catch: (cause) =>
        new SyncStoreError({
          operation: "commit",
          message: `unserializable batch: ${String(cause)}`,
        }),
    });
    yield* executor
      .withTransaction(
        Effect.gen(function* () {
          for (const [statement, params] of statements) {
            yield* executor.run(statement, params);
          }
        }),
      )
      .pipe(Effect.mapError(storeError("commit")));
  });

  const clear = Effect.fn("SqliteSyncStore.clear")(function* (companyId: CompanyId) {
    yield* executor
      .withTransaction(
        Effect.gen(function* () {
          for (const table of [
            "cloud_sync_checkpoints",
            "cloud_sync_entities",
            "cloud_sync_outbox",
            "cloud_sync_rejected",
            "cloud_sync_quarantine",
            "cloud_sync_local_sequences",
          ]) {
            yield* executor.run(`DELETE FROM ${table} WHERE company_id = ?`, [companyId]);
          }
        }),
      )
      .pipe(Effect.mapError(storeError("clear")));
  });

  const service = SyncStore.of({ read, commit, clear });

  return { service } satisfies SqliteSyncStore;
});

type CommitStatement = readonly [string, ReadonlyArray<SqliteSyncValue>];

/**
 * The SQL translation of `applySyncStoreBatch`. Ordering matters exactly where it matters there:
 * removals run before upserts so a row both replaced and removed in one batch ends up removed,
 * and delete-then-insert upserts move re-written rows to the end of rowid order.
 */
function commitStatements(
  companyId: CompanyId,
  batch: SyncStoreBatch,
): ReadonlyArray<CommitStatement> {
  const statements: Array<CommitStatement> = [];

  if (batch.checkpoint !== undefined) {
    const checkpoint = batch.checkpoint;
    statements.push([
      `INSERT OR REPLACE INTO cloud_sync_checkpoints
        (company_id, schema_version, cursor, authorization_epoch, bootstrapped)
        VALUES (?, ?, ?, ?, ?)`,
      [
        companyId,
        checkpoint.schemaVersion,
        checkpoint.cursor,
        checkpoint.authorizationEpoch,
        checkpoint.bootstrapped ? 1 : 0,
      ],
    ]);
  }

  if (batch.resetEntities === true) {
    statements.push([`DELETE FROM cloud_sync_entities WHERE company_id = ?`, [companyId]]);
  }
  for (const key of batch.deleteEntities ?? []) {
    statements.push([
      `DELETE FROM cloud_sync_entities WHERE company_id = ? AND entity_kind = ? AND entity_id = ?`,
      [companyId, key.entityKind, key.entityId],
    ]);
  }
  for (const entity of batch.upsertEntities ?? []) {
    statements.push([
      `INSERT OR REPLACE INTO cloud_sync_entities
        (company_id, entity_kind, entity_id, version, payload)
        VALUES (?, ?, ?, ?, ?)`,
      [companyId, entity.entityKind, entity.entityId, entity.version, encodeJson(entity.payload)],
    ]);
  }

  const removedOutbox = new Set(batch.removeOutbox ?? []);
  for (const operationId of removedOutbox) {
    statements.push([
      `DELETE FROM cloud_sync_outbox WHERE company_id = ? AND operation_id = ?`,
      [companyId, operationId],
    ]);
  }
  for (const entry of batch.upsertOutbox ?? []) {
    if (removedOutbox.has(entry.envelope.operationId)) continue;
    const [statusTag, acknowledgedVersion] = statusColumns(entry.status);
    statements.push([
      `INSERT OR REPLACE INTO cloud_sync_outbox
        (company_id, operation_id, local_sequence, envelope, status_tag, acknowledged_version)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        entry.envelope.operationId,
        entry.envelope.localSequence,
        encodeJson(entry.envelope),
        statusTag,
        acknowledgedVersion,
      ],
    ]);
  }

  const removedRejected = new Set(batch.removeRejected ?? []);
  for (const operationId of removedRejected) {
    statements.push([
      `DELETE FROM cloud_sync_rejected WHERE company_id = ? AND operation_id = ?`,
      [companyId, operationId],
    ]);
  }
  for (const rejection of batch.appendRejected ?? []) {
    if (removedRejected.has(rejection.envelope.operationId)) continue;
    statements.push([
      `INSERT OR REPLACE INTO cloud_sync_rejected
        (company_id, operation_id, envelope, code, message)
        VALUES (?, ?, ?, ?, ?)`,
      [
        companyId,
        rejection.envelope.operationId,
        encodeJson(rejection.envelope),
        rejection.code,
        rejection.message,
      ],
    ]);
  }

  const removedQuarantined = new Set(batch.removeQuarantined ?? []);
  for (const operationId of removedQuarantined) {
    for (const table of [
      "cloud_sync_quarantine",
      // A quarantined operation is neither sendable nor rejected, so these two are no-ops for a
      // row this store moved itself — but a row it only *read* as quarantined, because it could
      // not decode it, is still sitting in the table it came from, and a discard has to reach it.
      "cloud_sync_outbox",
      "cloud_sync_rejected",
    ]) {
      statements.push([
        `DELETE FROM ${table} WHERE company_id = ? AND operation_id = ?`,
        [companyId, operationId],
      ]);
    }
  }
  for (const row of batch.quarantineOutbox ?? []) {
    if (removedQuarantined.has(row.envelope.operationId)) continue;
    const [statusTag, acknowledgedVersion] = statusColumns(row.status);
    statements.push([
      `INSERT OR REPLACE INTO cloud_sync_quarantine
        (company_id, operation_id, envelope, status_tag, acknowledged_version, reason)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        row.envelope.operationId,
        encodeJson(row.envelope),
        statusTag,
        acknowledgedVersion,
        row.reason,
      ],
    ]);
  }

  if (batch.localSequenceHighWater !== undefined) {
    statements.push([
      `INSERT INTO cloud_sync_local_sequences (company_id, high_water) VALUES (?, ?)
        ON CONFLICT(company_id) DO UPDATE SET
          high_water = MAX(high_water, excluded.high_water)`,
      [companyId, batch.localSequenceHighWater],
    ]);
  }

  return statements;
}

export const sqliteSyncStoreLayer = (
  executor: SqliteSyncExecutor,
): Layer.Layer<SyncStore, SqliteSyncExecutorError> =>
  Layer.effect(SyncStore, makeSqliteSyncStore(executor).pipe(Effect.map((store) => store.service)));
