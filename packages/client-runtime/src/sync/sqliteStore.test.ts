/**
 * The SQLite adapter against an in-memory fake of its executor seam.
 *
 * `@spiritdevs/client-runtime` links no SQLite (that is the whole point of the seam) and its
 * typecheck forbids Node built-ins, so these tests run over a small fake that interprets exactly
 * the SQL dialect the adapter emits. Fidelity limits, deliberately accepted:
 *
 * - Only the statement shapes the adapter produces are understood (`CREATE TABLE [IF NOT EXISTS]`,
 *   `CREATE INDEX`, `ALTER TABLE ... ADD COLUMN`, `INSERT [OR REPLACE] INTO ... VALUES`, the one
 *   `ON CONFLICT ... MAX` upsert, `DELETE ... WHERE` on equality,
 *   `SELECT ... WHERE company_id = ? [ORDER BY ...]`, and the two migration-table queries).
 *   Anything else throws, which doubles as a canary for new SQL.
 * - Primary keys come from a per-table registry rather than the DDL, and `rowid` order is array
 *   order with replace-moves-to-end — the observable behavior the adapter relies on.
 * - "Reopen" is a second `makeSqliteSyncStore` over the same fake; a real close-and-reopen of a
 *   database file, and real BEGIN/ROLLBACK, are covered by the server-side test that wires the
 *   real `node:sqlite`-backed executor (`apps/server/src/cloud/syncSqliteExecutor.test.ts`).
 */
import { describe, expect, it } from "@effect/vitest";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncActor,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  EMPTY_STORED_SYNC_STATE,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type StoredSyncCheckpoint,
  type StoredSyncEntity,
  type StoredSyncState,
  type SyncStoreBatch,
} from "./document.ts";
import { makeMemorySyncStore } from "./memoryStore.ts";
import { syncEntityKey } from "./model.ts";
import {
  makeSqliteSyncStore,
  SqliteSyncExecutorError,
  type SqliteSyncExecutor,
  type SqliteSyncRow,
  type SqliteSyncValue,
} from "./sqliteStore.ts";

// ---------------------------------------------------------------------------
// Fake executor
// ---------------------------------------------------------------------------

type FakeRow = Record<string, SqliteSyncValue>;
type FakeState = Map<string, Array<FakeRow>>;

/** Primary keys per table; SQLite derives these from DDL, the fake keeps a registry. */
const TABLE_KEYS: Record<string, ReadonlyArray<string>> = {
  cloud_sync_store_migrations: ["version"],
  cloud_sync_checkpoints: ["company_id"],
  cloud_sync_entities: ["company_id", "entity_kind", "entity_id"],
  cloud_sync_outbox: ["company_id", "operation_id"],
  cloud_sync_rejected: ["company_id", "operation_id"],
  cloud_sync_quarantine: ["company_id", "operation_id"],
  cloud_sync_local_sequences: ["company_id"],
};

const normalizeSql = (statement: string) => statement.replace(/\s+/g, " ").trim();

const sameKey = (keys: ReadonlyArray<string>, left: FakeRow, right: FakeRow) =>
  keys.every((key) => left[key] === right[key]);

interface FakeSqliteDatabase {
  readonly executor: SqliteSyncExecutor;
}

const makeFakeSqliteExecutor = (): FakeSqliteDatabase => {
  const tables: FakeState = new Map();
  const snapshots: Array<FakeState> = [];

  const cloneState = (): FakeState => {
    const next: FakeState = new Map();
    for (const [name, rows] of tables)
      next.set(
        name,
        rows.map((row) => ({ ...row })),
      );
    return next;
  };
  const restoreState = (snapshot: FakeState) => {
    tables.clear();
    for (const [name, rows] of snapshot) tables.set(name, rows);
  };

  const requireTable = (name: string): Array<FakeRow> => {
    const rows = tables.get(name);
    if (rows === undefined) throw new Error(`no such table: ${name}`);
    return rows;
  };
  const requireKeys = (name: string): ReadonlyArray<string> => {
    const keys = TABLE_KEYS[name];
    if (keys === undefined) throw new Error(`fake executor has no key registry for: ${name}`);
    return keys;
  };

  const execute = (statement: string, params: ReadonlyArray<SqliteSyncValue>): Array<FakeRow> => {
    const sql = normalizeSql(statement);

    const createIfMissing = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql);
    if (createIfMissing !== null) {
      const name = createIfMissing[1] ?? "";
      if (!tables.has(name)) tables.set(name, []);
      return [];
    }
    const create = /^CREATE TABLE (\w+)/.exec(sql);
    if (create !== null) {
      const name = create[1] ?? "";
      if (tables.has(name)) throw new Error(`table ${name} already exists`);
      tables.set(name, []);
      return [];
    }
    if (/^CREATE INDEX /.test(sql)) return [];

    const alter = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(sql);
    if (alter !== null) {
      // Columns are implicit in the fake — a row is a record — so adding one is only an existence
      // check on the table. Rows written before it have no such key, and the SELECT projection
      // below reads a missing key back as NULL, which is what SQLite does with a fresh column.
      requireTable(alter[1] ?? "");
      return [];
    }

    // The single ON CONFLICT statement the adapter emits: the monotonic high-water upsert.
    if (/^INSERT INTO cloud_sync_local_sequences .* ON CONFLICT/.test(sql)) {
      const rows = requireTable("cloud_sync_local_sequences");
      const [companyId, highWater] = params;
      const existing = rows.find((row) => row["company_id"] === companyId);
      if (existing === undefined) {
        rows.push({ company_id: companyId ?? null, high_water: highWater ?? null });
      } else {
        existing["high_water"] = Math.max(Number(existing["high_water"]), Number(highWater));
      }
      return [];
    }

    const insert = /^INSERT (OR REPLACE )?INTO (\w+) \(([^)]+)\) VALUES/.exec(sql);
    if (insert !== null) {
      const replace = insert[1] !== undefined;
      const name = insert[2] ?? "";
      const columns = (insert[3] ?? "").split(",").map((column) => column.trim());
      const rows = requireTable(name);
      const keys = requireKeys(name);
      const row: FakeRow = {};
      columns.forEach((column, index) => {
        row[column] = params[index] ?? null;
      });
      const conflictIndex = rows.findIndex((existing) => sameKey(keys, existing, row));
      if (conflictIndex >= 0) {
        if (!replace) throw new Error(`UNIQUE constraint failed: ${name}`);
        rows.splice(conflictIndex, 1); // OR REPLACE deletes, so the fresh row lands at the end.
      }
      rows.push(row);
      return [];
    }

    const remove = /^DELETE FROM (\w+)(?: WHERE (.+))?$/.exec(sql);
    if (remove !== null) {
      const name = remove[1] ?? "";
      const rows = requireTable(name);
      const columns =
        remove[2] === undefined
          ? []
          : remove[2].split(" AND ").map((clause) => clause.replace(/ = \?$/, "").trim());
      const matches = (row: FakeRow) =>
        columns.every((column, index) => row[column] === params[index]);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row !== undefined && matches(row)) rows.splice(index, 1);
      }
      return [];
    }

    if (/^SELECT COALESCE\(MAX\(version\), 0\) AS version FROM (\w+)$/.test(sql)) {
      const name = /FROM (\w+)$/.exec(sql)?.[1] ?? "";
      const versions = requireTable(name).map((row) => Number(row["version"]));
      return [{ version: versions.length === 0 ? 0 : Math.max(...versions) }];
    }

    const select = /^SELECT (.+) FROM (\w+)(?: WHERE company_id = \?)?(?: ORDER BY (\w+))?$/.exec(
      sql,
    );
    if (select !== null) {
      const columns = (select[1] ?? "").split(",").map((column) => column.trim());
      const name = select[2] ?? "";
      const orderBy = select[3];
      let rows = [...requireTable(name)];
      if (sql.includes("WHERE company_id = ?")) {
        rows = rows.filter((row) => row["company_id"] === params[0]);
      }
      if (orderBy !== undefined && orderBy !== "rowid") {
        rows.sort((left, right) => Number(left[orderBy]) - Number(right[orderBy]));
      }
      return rows.map((row) => {
        const projected: FakeRow = {};
        for (const column of columns) projected[column] = row[column] ?? null;
        return projected;
      });
    }

    throw new Error(`fake executor cannot interpret: ${sql}`);
  };

  const attempt = <A>(evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) =>
        new SqliteSyncExecutorError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

  const executor: SqliteSyncExecutor = {
    exec: (statement) => attempt(() => void execute(statement, [])),
    run: (statement, params) => attempt(() => void execute(statement, params)),
    all: (statement, params) =>
      attempt(() => execute(statement, params) as ReadonlyArray<SqliteSyncRow>),
    withTransaction: <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | SqliteSyncExecutorError> =>
      Effect.suspend(() => {
        snapshots.push(cloneState());
        return effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const snapshot = snapshots.pop();
              if (Exit.isFailure(exit) && snapshot !== undefined) restoreState(snapshot);
            }),
          ),
        );
      }),
  };

  return { executor };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Every migration the adapter owns, in order — what the bookkeeping table must hold after any
 * number of opens. Restated here rather than imported so a migration added without a thought about
 * reopening has to be acknowledged in a test.
 */
const APPLIED_MIGRATIONS = [{ version: 1 }, { version: 2 }, { version: 3 }];

const COMPANY_ID = CompanyId.make("company-sqlite");
const OTHER_COMPANY_ID = CompanyId.make("company-other");
const CLIENT_ID = SyncClientId.make("client-sqlite");
const ACTOR: SyncActor = { kind: "member", membershipId: MembershipId.make("membership-a") };

const envelope = (input: {
  readonly id: string;
  readonly sequence: number;
  readonly baseVersion?: number;
}): SyncOperationEnvelope => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make(input.id),
  companyId: COMPANY_ID,
  clientId: CLIENT_ID,
  environmentId: null,
  actor: ACTOR,
  localSequence: LocalSequence.make(input.sequence),
  baseVersion: CompanyVersion.make(input.baseVersion ?? 0),
  entityId: SyncEntityId.make(`entity-${input.id}`),
  dependsOn: [],
  kind: "issue.create",
  args: { title: `title ${input.id}`, nested: { flag: true, list: [1, "two", null] } },
});

const entity = (input: {
  readonly id: string;
  readonly version: number;
  readonly payload?: unknown;
}): StoredSyncEntity => ({
  entityKind: "issue",
  entityId: SyncEntityId.make(input.id),
  version: CompanyVersion.make(input.version),
  payload: input.payload ?? { id: input.id, title: `issue ${input.id}` },
});

const checkpoint = (input: {
  readonly cursor: number;
  readonly bootstrapped?: boolean;
}): StoredSyncCheckpoint => ({
  schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
  bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
  companyId: COMPANY_ID,
  cursor: CompanyVersion.make(input.cursor),
  authorizationEpoch: AuthorizationEpoch.make(0),
  bootstrapped: input.bootstrapped ?? true,
});

const operationId = (value: string) => SyncOperationId.make(value);

/** Entity array order is a Map artifact in the reference; compare it as a set. */
const normalize = (state: StoredSyncState) => ({
  ...state,
  entities: [...state.entities].sort((left, right) =>
    syncEntityKey(left) < syncEntityKey(right) ? -1 : 1,
  ),
});

const openStore = Effect.fn("openStore")(function* (executor: SqliteSyncExecutor) {
  const store = yield* makeSqliteSyncStore(executor);
  return store.service;
});

/** The envelope column holds JSON text; a raw write puts it there the way the adapter would. */
const storedEnvelope = (value: SyncOperationEnvelope): string => JSON.stringify(value);

/** Writes a row the adapter itself would never write: what another build, or a torn write, left. */
const writeRaw = (
  executor: SqliteSyncExecutor,
  table: string,
  row: Record<string, SqliteSyncValue>,
) => {
  const columns = Object.keys(row);
  return executor.run(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SqliteSyncStore", () => {
  it.effect("matches the reference in-memory semantics across a scripted history", () =>
    Effect.gen(function* () {
      const sqlite = yield* openStore(makeFakeSqliteExecutor().executor);
      const memory = yield* makeMemorySyncStore();

      const script: ReadonlyArray<SyncStoreBatch> = [
        // Enqueue before the first bootstrap: outbox and high-water without a checkpoint.
        {
          upsertOutbox: [
            { envelope: envelope({ id: "op-1", sequence: 1 }), status: { _tag: "Pending" } },
          ],
          localSequenceHighWater: LocalSequence.make(1),
        },
        // Bootstrap: checkpoint plus a full reset of confirmed rows.
        {
          checkpoint: checkpoint({ cursor: 5 }),
          resetEntities: true,
          upsertEntities: [entity({ id: "e-1", version: 4 }), entity({ id: "e-2", version: 5 })],
        },
        // Acknowledge op-1, confirm its entity, delete another, enqueue two more out of order.
        {
          checkpoint: checkpoint({ cursor: 6 }),
          upsertOutbox: [
            {
              envelope: envelope({ id: "op-1", sequence: 1 }),
              status: { _tag: "Acknowledged", version: CompanyVersion.make(6) },
            },
            { envelope: envelope({ id: "op-3", sequence: 3 }), status: { _tag: "Pending" } },
            { envelope: envelope({ id: "op-2", sequence: 2 }), status: { _tag: "Pending" } },
          ],
          upsertEntities: [entity({ id: "e-1", version: 6, payload: { rewritten: true } })],
          deleteEntities: [{ entityKind: "issue", entityId: SyncEntityId.make("e-2") }],
          localSequenceHighWater: LocalSequence.make(3),
        },
        // Prune the covered operation; reject one row and quarantine the other — the paired move.
        {
          removeOutbox: [operationId("op-1"), operationId("op-2"), operationId("op-3")],
          appendRejected: [
            {
              envelope: envelope({ id: "op-2", sequence: 2 }),
              code: "permission-denied",
              message: "membership revoked",
            },
          ],
          quarantineOutbox: [
            {
              envelope: envelope({ id: "op-3", sequence: 3 }),
              status: { _tag: "Pending" },
              reason: "payload written by a newer build",
            },
          ],
        },
        // A stale high-water write must not regress the mark.
        { localSequenceHighWater: LocalSequence.make(2) },
        // Dismiss the rejection, discard the quarantined row.
        {
          removeRejected: [operationId("op-2")],
          removeQuarantined: [operationId("op-3")],
        },
      ];

      for (const batch of script) {
        yield* sqlite.commit(COMPANY_ID, batch);
        yield* memory.service.commit(COMPANY_ID, batch);
        const stored = yield* sqlite.read(COMPANY_ID);
        const reference = yield* memory.snapshot(COMPANY_ID);
        expect(normalize(stored)).toEqual(normalize(reference));
      }

      const final = yield* sqlite.read(COMPANY_ID);
      expect(final.localSequenceHighWater).toBe(3);
      expect(final.outbox).toEqual([]);
      expect(final.rejected).toEqual([]);
      expect(final.quarantined).toEqual([]);
    }),
  );

  it.effect("quarantine is a move: the row leaves the outbox but keeps its bytes", () =>
    Effect.gen(function* () {
      const store = yield* openStore(makeFakeSqliteExecutor().executor);
      const stuck = envelope({ id: "op-stuck", sequence: 7 });

      yield* store.commit(COMPANY_ID, {
        upsertOutbox: [
          { envelope: stuck, status: { _tag: "Pending" } },
          { envelope: envelope({ id: "op-fine", sequence: 8 }), status: { _tag: "Pending" } },
        ],
        localSequenceHighWater: LocalSequence.make(8),
      });
      yield* store.commit(COMPANY_ID, {
        removeOutbox: [stuck.operationId],
        quarantineOutbox: [
          { envelope: stuck, status: { _tag: "Pending" }, reason: "undecodable arguments" },
        ],
      });

      const moved = yield* store.read(COMPANY_ID);
      expect(moved.outbox.map((entry) => entry.envelope.operationId)).toEqual(["op-fine"]);
      expect(moved.quarantined).toEqual([
        { envelope: stuck, status: { _tag: "Pending" }, reason: "undecodable arguments" },
      ]);
      // The mark still covers the quarantined row's sequence.
      expect(moved.localSequenceHighWater).toBe(8);

      yield* store.commit(COMPANY_ID, { removeQuarantined: [stuck.operationId] });
      const discarded = yield* store.read(COMPANY_ID);
      expect(discarded.quarantined).toEqual([]);
      expect(discarded.localSequenceHighWater).toBe(8);
    }),
  );

  it.effect("quarantines rows it cannot read instead of failing the whole read", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();
      const store = yield* openStore(executor);

      const fine = envelope({ id: "op-fine", sequence: 1 });
      const rejectedFine = envelope({ id: "op-rejected-fine", sequence: 2 });
      yield* store.commit(COMPANY_ID, {
        upsertOutbox: [{ envelope: fine, status: { _tag: "Pending" } }],
        appendRejected: [
          { envelope: rejectedFine, code: "permission-denied", message: "membership revoked" },
        ],
        localSequenceHighWater: LocalSequence.make(2),
      });

      // One row per table that this build cannot read: a torn envelope blob, a rejection whose
      // code column came back as nothing, and a quarantined row carrying a status tag only some
      // other build knows. None of them is corruption — each is a user's work.
      yield* writeRaw(executor, "cloud_sync_outbox", {
        company_id: COMPANY_ID,
        operation_id: "op-torn",
        local_sequence: 3,
        envelope: '{"operationId":"op-torn","localSequence":3,"kind":"issue.crea',
        status_tag: "Pending",
        acknowledged_version: null,
      });
      const rejectedTorn = envelope({ id: "op-code-gone", sequence: 4 });
      yield* writeRaw(executor, "cloud_sync_rejected", {
        company_id: COMPANY_ID,
        operation_id: "op-code-gone",
        envelope: storedEnvelope(rejectedTorn),
        code: null,
        message: "",
      });
      const futureQuarantined = envelope({ id: "op-future", sequence: 5 });
      yield* writeRaw(executor, "cloud_sync_quarantine", {
        company_id: COMPANY_ID,
        operation_id: "op-future",
        envelope: storedEnvelope(futureQuarantined),
        status_tag: "Superseded",
        acknowledged_version: null,
        reason: "A newer build could not read this either.",
      });

      // The readable rows still read, and the unreadable ones come back whole rather than taking
      // the whole replica down with them: quarantine's own row keeps its place and its reason,
      // then the rejected salvage, then the outbox salvage.
      const state = yield* store.read(COMPANY_ID);
      expect(state.outbox).toEqual([{ envelope: fine, status: { _tag: "Pending" } }]);
      expect(state.rejected).toEqual([
        { envelope: rejectedFine, code: "permission-denied", message: "membership revoked" },
      ]);
      expect(state.quarantined).toEqual([
        {
          envelope: futureQuarantined,
          status: { _tag: "Pending" },
          reason: "A newer build could not read this either.",
        },
        {
          envelope: rejectedTorn,
          status: { _tag: "Pending" },
          reason: "This build cannot read the stored shape of this rejected row.",
        },
        {
          // The blob could not be parsed at all, so the columns beside it name the operation.
          envelope: { operationId: "op-torn", localSequence: 3 },
          status: { _tag: "Pending" },
          reason: "This build cannot read the stored shape of this outbox row.",
        },
      ]);
      expect(state.localSequenceHighWater).toBe(2);

      // Discarding a salvaged row reaches the table it actually lives in, so it stays discarded.
      yield* store.commit(COMPANY_ID, {
        removeQuarantined: [operationId("op-torn"), operationId("op-code-gone")],
      });
      const discarded = yield* store.read(COMPANY_ID);
      expect(discarded.quarantined.map((row) => row.envelope.operationId)).toEqual(["op-future"]);
      expect(discarded.outbox.map((entry) => entry.envelope.operationId)).toEqual(["op-fine"]);
      expect(discarded.rejected.map((row) => row.envelope.operationId)).toEqual([
        "op-rejected-fine",
      ]);
    }),
  );

  it.effect("keeps an outbox row's enqueue stamp, and reads a row written without one", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();
      const store = yield* openStore(executor);
      const stamped = envelope({ id: "op-stamped", sequence: 1 });

      yield* store.commit(COMPANY_ID, {
        upsertOutbox: [{ envelope: stamped, status: { _tag: "Pending" }, occurredAt: 1_700_000 }],
        localSequenceHighWater: LocalSequence.make(1),
      });
      // What the previous schema left behind: the migration adds the column, but no build that
      // wrote this row ever filled it. Refusing it would throw away unsent work over a timestamp.
      yield* writeRaw(executor, "cloud_sync_outbox", {
        company_id: COMPANY_ID,
        operation_id: "op-unstamped",
        local_sequence: 2,
        envelope: storedEnvelope(envelope({ id: "op-unstamped", sequence: 2 })),
        status_tag: "Pending",
        acknowledged_version: null,
      });

      // Read through a second open, so the value survives the round trip rather than a live cache.
      const reopened = yield* openStore(executor);
      const state = yield* reopened.read(COMPANY_ID);
      expect(state.quarantined).toEqual([]);
      expect(
        state.outbox.map((entry) => [entry.envelope.operationId, entry.occurredAt] as const),
      ).toEqual([
        ["op-stamped", 1_700_000],
        ["op-unstamped", undefined],
      ]);

      // Acknowledging rewrites the row; the stamp is not a casualty of the status change.
      yield* reopened.commit(COMPANY_ID, {
        upsertOutbox: [
          {
            envelope: stamped,
            status: { _tag: "Acknowledged", version: CompanyVersion.make(4) },
            occurredAt: 1_700_000,
          },
        ],
      });
      expect((yield* reopened.read(COMPANY_ID)).outbox[0]).toEqual({
        envelope: stamped,
        status: { _tag: "Acknowledged", version: CompanyVersion.make(4) },
        occurredAt: 1_700_000,
      });
    }),
  );

  it.effect("an outbox status tag this build does not know never reads as pending", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();
      const store = yield* openStore(executor);

      // A build that knows a third outbox status wrote this row. Reading it as "Pending" would
      // resend an operation that build may already consider applied, so it leaves the send path.
      const superseded = envelope({ id: "op-superseded", sequence: 1 });
      yield* writeRaw(executor, "cloud_sync_outbox", {
        company_id: COMPANY_ID,
        operation_id: "op-superseded",
        local_sequence: 1,
        envelope: storedEnvelope(superseded),
        status_tag: "Superseded",
        acknowledged_version: 12,
      });

      const state = yield* store.read(COMPANY_ID);
      expect(state.outbox).toEqual([]);
      expect(state.quarantined).toEqual([
        {
          envelope: superseded,
          status: { _tag: "Pending" },
          reason: "This build cannot read the stored shape of this outbox row.",
        },
      ]);
    }),
  );

  it.effect("a checkpoint it cannot read re-bootstraps; a replica row it cannot read fails", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();
      const store = yield* openStore(executor);
      yield* store.commit(COMPANY_ID, {
        checkpoint: checkpoint({ cursor: 3 }),
        upsertEntities: [entity({ id: "e-1", version: 3 })],
      });

      yield* writeRaw(executor, "cloud_sync_checkpoints", {
        company_id: COMPANY_ID,
        schema_version: SYNC_DOCUMENT_SCHEMA_VERSION,
        cursor: null,
        authorization_epoch: 0,
        bootstrapped: 1,
      });
      const rebootstrapping = yield* store.read(COMPANY_ID);
      expect(rebootstrapping.checkpoint).toBeNull();
      expect(rebootstrapping.entities.map((row) => row.entityId)).toEqual(["e-1"]);

      // Replica rows are not user work — they come back on the next bootstrap — so an unreadable
      // one is still loud rather than silently dropped.
      yield* writeRaw(executor, "cloud_sync_entities", {
        company_id: COMPANY_ID,
        entity_kind: "issue",
        entity_id: "e-torn",
        version: 4,
        payload: '{"title": "half a',
      });
      const error = yield* Effect.flip(store.read(COMPANY_ID));
      expect(error._tag).toBe("SyncStoreError");
      expect(error.operation).toBe("read");
    }),
  );

  it.effect("high-water mark survives reopen and never regresses", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();

      const store = yield* openStore(executor);
      yield* store.commit(COMPANY_ID, {
        upsertOutbox: [
          { envelope: envelope({ id: "op-9", sequence: 9 }), status: { _tag: "Pending" } },
        ],
        localSequenceHighWater: LocalSequence.make(9),
      });
      // Prune the row; the mark must outlive it — sequences are never reused.
      yield* store.commit(COMPANY_ID, { removeOutbox: [operationId("op-9")] });

      const reopened = yield* openStore(executor);
      const stored = yield* reopened.read(COMPANY_ID);
      expect(stored.outbox).toEqual([]);
      expect(stored.localSequenceHighWater).toBe(9);

      yield* reopened.commit(COMPANY_ID, { localSequenceHighWater: LocalSequence.make(4) });
      expect((yield* reopened.read(COMPANY_ID)).localSequenceHighWater).toBe(9);
      yield* reopened.commit(COMPANY_ID, { localSequenceHighWater: LocalSequence.make(11) });
      expect((yield* reopened.read(COMPANY_ID)).localSequenceHighWater).toBe(11);
    }),
  );

  it.effect("opening the store twice migrates once and keeps existing rows", () =>
    Effect.gen(function* () {
      const { executor } = makeFakeSqliteExecutor();

      const first = yield* openStore(executor);
      yield* first.commit(COMPANY_ID, {
        checkpoint: checkpoint({ cursor: 2, bootstrapped: false }),
        upsertEntities: [entity({ id: "e-keep", version: 2 })],
      });

      // A re-run of migration 1 would throw "table already exists"; the version guard prevents it.
      const second = yield* openStore(executor);
      const stored = yield* second.read(COMPANY_ID);
      expect(stored.checkpoint?.cursor).toBe(2);
      expect(stored.checkpoint?.bootstrapped).toBe(false);
      expect(stored.entities.map((row) => row.entityId)).toEqual(["e-keep"]);

      const versions = yield* executor.all(
        "SELECT version FROM cloud_sync_store_migrations ORDER BY version",
        [],
      );
      expect(versions).toEqual(APPLIED_MIGRATIONS);
    }),
  );

  it.effect("two first opens racing on the same file converge instead of failing", () =>
    Effect.gen(function* () {
      const { executor: base } = makeFakeSqliteExecutor();
      let transactions = 0;

      // This is the loser of a first-open race: both connections read version 0, the winner
      // commits the v1 DDL first, and the loser's `CREATE TABLE` fails against the schema that
      // just appeared. The winner's rows only become visible to the loser's *next* transaction,
      // exactly as a committed write would be.
      const racing: SqliteSyncExecutor = {
        ...base,
        exec: (statement) =>
          transactions === 1 && statement.includes("CREATE TABLE cloud_sync_checkpoints")
            ? Effect.fail(
                new SqliteSyncExecutorError({
                  message: "table cloud_sync_checkpoints already exists",
                }),
              )
            : base.exec(statement),
        withTransaction: <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, E | SqliteSyncExecutorError> =>
          Effect.gen(function* () {
            transactions += 1;
            // Between the failed attempt and the retry, the winner's open commits.
            if (transactions === 2) yield* makeSqliteSyncStore(base);
            return yield* base.withTransaction(effect);
          }),
      };

      const store = yield* openStore(racing);
      expect(transactions).toBe(2);

      // Converged on the winner's schema, applied exactly once, and fully usable.
      yield* store.commit(COMPANY_ID, {
        checkpoint: checkpoint({ cursor: 7 }),
        upsertEntities: [entity({ id: "e-raced", version: 7 })],
      });
      const stored = yield* store.read(COMPANY_ID);
      expect(stored.checkpoint?.cursor).toBe(7);
      expect(stored.entities.map((row) => row.entityId)).toEqual(["e-raced"]);
      expect(
        yield* base.all("SELECT version FROM cloud_sync_store_migrations ORDER BY version", []),
      ).toEqual(APPLIED_MIGRATIONS);
    }),
  );

  it.effect("a statement failing mid-commit leaves no partial state behind", () =>
    Effect.gen(function* () {
      const { executor: base } = makeFakeSqliteExecutor();
      const store = yield* openStore(base);

      yield* store.commit(COMPANY_ID, {
        checkpoint: checkpoint({ cursor: 3 }),
        upsertEntities: [entity({ id: "e-before", version: 3 })],
        localSequenceHighWater: LocalSequence.make(1),
      });
      const before = yield* store.read(COMPANY_ID);

      // Same database, but every write to the outbox table blows up — after the checkpoint and
      // entity statements of the same batch have already executed inside the transaction.
      const failing: SqliteSyncExecutor = {
        ...base,
        run: (statement, params: ReadonlyArray<SqliteSyncValue>) =>
          statement.includes("cloud_sync_outbox")
            ? Effect.fail(new SqliteSyncExecutorError({ message: "injected failure" }))
            : base.run(statement, params),
      };
      const broken = yield* openStore(failing);

      const exit = yield* Effect.exit(
        broken.commit(COMPANY_ID, {
          checkpoint: checkpoint({ cursor: 4 }),
          upsertEntities: [entity({ id: "e-torn", version: 4 })],
          upsertOutbox: [
            { envelope: envelope({ id: "op-torn", sequence: 2 }), status: { _tag: "Pending" } },
          ],
          localSequenceHighWater: LocalSequence.make(2),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      // Nothing from the failed batch is visible: not the checkpoint written before the failing
      // statement, not the entity, not the high-water mark.
      expect(yield* store.read(COMPANY_ID)).toEqual(before);
    }),
  );

  it.effect("clear drops one company and leaves the other untouched", () =>
    Effect.gen(function* () {
      const store = yield* openStore(makeFakeSqliteExecutor().executor);

      const seed = (companyId: typeof COMPANY_ID) =>
        store.commit(companyId, {
          checkpoint: { ...checkpoint({ cursor: 1 }), companyId },
          upsertEntities: [entity({ id: `e-${companyId}`, version: 1 })],
          upsertOutbox: [
            {
              envelope: envelope({ id: `op-${companyId}`, sequence: 1 }),
              status: { _tag: "Pending" },
            },
          ],
          quarantineOutbox: [
            {
              envelope: envelope({ id: `q-${companyId}`, sequence: 2 }),
              status: { _tag: "Pending" },
              reason: "unreadable",
            },
          ],
          localSequenceHighWater: LocalSequence.make(2),
        });
      yield* seed(COMPANY_ID);
      yield* seed(OTHER_COMPANY_ID);
      expect(new Set(yield* store.listCompanyIds)).toEqual(new Set([COMPANY_ID, OTHER_COMPANY_ID]));

      yield* store.clear(COMPANY_ID);

      expect(yield* store.read(COMPANY_ID)).toEqual(EMPTY_STORED_SYNC_STATE);
      const other = yield* store.read(OTHER_COMPANY_ID);
      expect(other.checkpoint?.cursor).toBe(1);
      expect(other.entities).toHaveLength(1);
      expect(other.outbox).toHaveLength(1);
      expect(other.quarantined).toHaveLength(1);
      expect(other.localSequenceHighWater).toBe(2);
      expect(yield* store.listCompanyIds).toEqual([OTHER_COMPANY_ID]);
    }),
  );
});
