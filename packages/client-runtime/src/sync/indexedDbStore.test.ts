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
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { IDBFactory } from "fake-indexeddb";

import { CloudSyncCapability } from "./capability.ts";
import {
  applySyncStoreBatch,
  EMPTY_STORED_SYNC_STATE,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type StoredOutboxEntry,
  type StoredSyncCheckpoint,
  type StoredSyncEntity,
  type StoredSyncQuarantine,
  type StoredSyncRejection,
  type StoredSyncState,
  type SyncStoreBatch,
} from "./document.ts";
import { makeSyncEngine } from "./engine.ts";
import {
  makeIndexedDbSyncStore,
  openSyncDatabase,
  SYNC_INDEXED_DB_VERSION,
  syncDatabaseMigrations,
  type SyncDatabaseMigration,
} from "./indexedDbStore.ts";
import { syncEntityKey } from "./model.ts";
import { syncOrderKeyAfter } from "./orderKey.ts";
import { SyncStore } from "./persistence.ts";
import { makeTestSyncServer, testNoteAdapter, testNoteKey } from "./testDomain.ts";
import { SyncTransport } from "./transport.ts";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const ACTOR: SyncActor = { kind: "member", membershipId: MembershipId.make("membership-a") };

const operationId = (value: string) => SyncOperationId.make(value);

const envelope = (input: {
  readonly id: string;
  readonly sequence: number;
}): SyncOperationEnvelope => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: operationId(input.id),
  companyId: COMPANY_A,
  clientId: SyncClientId.make("client-a"),
  environmentId: null,
  actor: ACTOR,
  localSequence: LocalSequence.make(input.sequence),
  baseVersion: CompanyVersion.make(0),
  kind: "issue.update",
  entityId: SyncEntityId.make("note-a"),
  dependsOn: [],
  args: { _tag: "SetNoteFields", id: "note-a", title: `title-${input.id}` },
});

const pendingEntry = (id: string, sequence: number): StoredOutboxEntry => ({
  envelope: envelope({ id, sequence }),
  status: { _tag: "Pending" },
});

const acknowledgedEntry = (id: string, sequence: number, version: number): StoredOutboxEntry => ({
  envelope: envelope({ id, sequence }),
  status: { _tag: "Acknowledged", version: CompanyVersion.make(version) },
});

const entity = (id: string, version: number): StoredSyncEntity => ({
  entityKind: "issue",
  entityId: SyncEntityId.make(id),
  version: CompanyVersion.make(version),
  payload: { id, title: `title-v${version}` },
});

const rejection = (id: string, sequence: number): StoredSyncRejection => ({
  envelope: envelope({ id, sequence }),
  code: "permission-denied",
  message: `Rejected ${id}.`,
});

const quarantineRow = (id: string, sequence: number): StoredSyncQuarantine => ({
  envelope: envelope({ id, sequence }),
  status: { _tag: "Pending" },
  reason: `Unreadable ${id}.`,
});

const checkpointAt = (cursor: number): StoredSyncCheckpoint => ({
  schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
  bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
  companyId: COMPANY_A,
  cursor: CompanyVersion.make(cursor),
  authorizationEpoch: AuthorizationEpoch.make(0),
  bootstrapped: true,
});

/** Entity order is unspecified by the port, so both sides are compared sorted. */
const normalize = (state: StoredSyncState) => ({
  ...state,
  entities: [...state.entities].sort((left, right) =>
    syncEntityKey(left) < syncEntityKey(right) ? -1 : 1,
  ),
});

const openStore = (factory: IDBFactory, scope = "user-a") =>
  makeIndexedDbSyncStore({ scope, factory });

/** Writes a row no adapter API would produce: what some other build left in the store. */
const putRaw = (input: {
  readonly factory: IDBFactory;
  readonly name: string;
  readonly store: string;
  readonly value: unknown;
}) =>
  Effect.promise(async () => {
    const database = await openSyncDatabase({ factory: input.factory, name: input.name });
    const transaction = database.transaction(input.store, "readwrite");
    transaction.objectStore(input.store).put(input.value);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("The write was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("The write failed."));
    });
    database.close();
  });

describe("IndexedDbSyncStore", () => {
  it.effect("returns the empty state for a database that has never been written", () =>
    Effect.gen(function* () {
      const store = yield* openStore(new IDBFactory());
      expect(yield* store.service.read(COMPANY_A)).toEqual(EMPTY_STORED_SYNC_STATE);
    }),
  );

  it.effect("replays every batch with the reference semantics", () =>
    Effect.gen(function* () {
      const store = yield* openStore(new IDBFactory());
      const batches: ReadonlyArray<SyncStoreBatch> = [
        { upsertOutbox: [pendingEntry("op-1", 1)], localSequenceHighWater: LocalSequence.make(1) },
        { upsertEntities: [entity("note-a", 1)], checkpoint: checkpointAt(1) },
        {
          upsertOutbox: [pendingEntry("op-2", 2), pendingEntry("op-3", 3)],
          localSequenceHighWater: LocalSequence.make(3),
        },
        // Status rewrite of an existing row.
        { upsertOutbox: [acknowledgedEntry("op-1", 1, 2)] },
        {
          removeOutbox: [operationId("op-1")],
          upsertEntities: [entity("note-b", 2)],
          checkpoint: checkpointAt(2),
        },
        { appendRejected: [rejection("op-2", 2)], removeOutbox: [operationId("op-2")] },
        // Quarantine is a move: the outbox row leaves in the same batch.
        { quarantineOutbox: [quarantineRow("op-3", 3)], removeOutbox: [operationId("op-3")] },
        // An entity named in both lists lands upserted.
        {
          deleteEntities: [{ entityKind: "issue", entityId: SyncEntityId.make("note-a") }],
          upsertEntities: [entity("note-a", 3)],
        },
        // A removal named in the same batch beats the upsert.
        { upsertOutbox: [pendingEntry("op-4", 4)], removeOutbox: [operationId("op-4")] },
        // The high-water mark never moves down.
        { localSequenceHighWater: LocalSequence.make(2) },
        { appendRejected: [rejection("op-5", 5), rejection("op-6", 6)] },
        // Re-appending an existing rejection moves it to the end.
        { appendRejected: [rejection("op-5", 5)] },
        { removeQuarantined: [operationId("op-3")] },
        { resetEntities: true, upsertEntities: [entity("note-c", 5)], checkpoint: checkpointAt(5) },
      ];

      let expected = EMPTY_STORED_SYNC_STATE;
      for (const batch of batches) {
        yield* store.service.commit(COMPANY_A, batch);
        expected = applySyncStoreBatch(expected, batch);
        expect(normalize(yield* store.service.read(COMPANY_A))).toEqual(normalize(expected));
      }
    }),
  );

  it.effect("carries an outbox row's enqueue stamp, and reads a row written without one", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const first = yield* openStore(factory);
      yield* first.service.commit(COMPANY_A, {
        upsertOutbox: [
          { ...pendingEntry("op-stamped", 1), occurredAt: 1_700_000 },
          // A row from a build that predates the field: the schema is deliberately unversioned
          // here, so it must read back as an unstamped row rather than take the replica down.
          pendingEntry("op-unstamped", 2),
        ],
        localSequenceHighWater: LocalSequence.make(2),
      });

      const reopened = yield* openStore(factory);
      const state = yield* reopened.service.read(COMPANY_A);
      expect(state.quarantined).toEqual([]);
      expect(
        state.outbox.map((entry) => [entry.envelope.operationId, entry.occurredAt] as const),
      ).toEqual([
        ["op-stamped", 1_700_000],
        ["op-unstamped", undefined],
      ]);
    }),
  );

  it.effect("round-trips quarantined rows verbatim and only discards them on request", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const first = yield* openStore(factory);
      yield* first.service.commit(COMPANY_A, {
        upsertOutbox: [pendingEntry("op-1", 1)],
        localSequenceHighWater: LocalSequence.make(1),
      });
      const row = quarantineRow("op-1", 1);
      yield* first.service.commit(COMPANY_A, {
        removeOutbox: [operationId("op-1")],
        quarantineOutbox: [row],
      });
      yield* first.close;

      // A restart is a second adapter over the same IndexedDB.
      const second = yield* openStore(factory);
      const reopened = yield* second.service.read(COMPANY_A);
      expect(reopened.outbox).toEqual([]);
      expect(reopened.quarantined).toEqual([row]);
      // The row is never both sendable and quarantined, and never neither.
      expect(reopened.localSequenceHighWater).toBe(1);

      yield* second.service.commit(COMPANY_A, { removeQuarantined: [operationId("op-1")] });
      expect((yield* second.service.read(COMPANY_A)).quarantined).toEqual([]);
    }),
  );

  it.effect("quarantines rows a newer build wrote instead of failing the whole read", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const store = yield* openStore(factory);
      const name = store.databaseName(COMPANY_A);
      yield* store.service.commit(COMPANY_A, {
        upsertOutbox: [pendingEntry("op-1", 1)],
        localSequenceHighWater: LocalSequence.make(1),
      });

      // A build that knows an operation kind this one has never heard of shares this database: it
      // enqueued one operation and already quarantined another.
      const futureOutbox = {
        envelope: { ...envelope({ id: "op-2", sequence: 2 }), kind: "future.create" },
        status: { _tag: "Pending" },
      };
      const futureQuarantine = {
        order: 1,
        row: {
          envelope: { ...envelope({ id: "op-3", sequence: 3 }), kind: "future.create" },
          status: { _tag: "Pending" },
          reason: "A newer build could not read this either.",
        },
      };
      yield* putRaw({ factory, name, store: "outbox", value: futureOutbox });
      yield* putRaw({ factory, name, store: "quarantine", value: futureQuarantine });

      // The readable rows still read, and the unreadable ones come back whole rather than taking
      // the whole replica down with them.
      const state = yield* store.service.read(COMPANY_A);
      expect(state.outbox).toEqual([pendingEntry("op-1", 1)]);
      expect(state.quarantined).toEqual([
        futureQuarantine.row,
        {
          envelope: futureOutbox.envelope,
          status: { _tag: "Pending" },
          reason: "This build cannot read the stored shape of this outbox row.",
        },
      ]);

      // Discarding one reaches the row where it actually lives, so it stays discarded.
      yield* store.service.commit(COMPANY_A, { removeQuarantined: [operationId("op-2")] });
      expect((yield* store.service.read(COMPANY_A)).quarantined).toEqual([futureQuarantine.row]);
    }),
  );

  it.effect("still fails the read on a row too damaged to name its operation", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const store = yield* openStore(factory);
      yield* putRaw({
        factory,
        name: store.databaseName(COMPANY_A),
        store: "outbox",
        value: { envelope: { operationId: "op-1" } },
      });

      const error = yield* Effect.flip(store.service.read(COMPANY_A));
      expect(error._tag).toBe("SyncStoreError");
      expect(error.operation).toBe("read");
    }),
  );

  it.effect("reopens a database a newer build upgraded past this build's version", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const store = yield* openStore(factory);
      yield* store.service.commit(COMPANY_A, {
        upsertOutbox: [pendingEntry("op-1", 1)],
        localSequenceHighWater: LocalSequence.make(1),
      });
      yield* store.close;

      // Another tab running a newer build upgrades the shared database; this one must not spend
      // the rest of its life failing every read with a VersionError.
      const upgraded = yield* Effect.promise(() =>
        openSyncDatabase({
          factory,
          name: store.databaseName(COMPANY_A),
          version: SYNC_INDEXED_DB_VERSION + 1,
          migrations: [
            ...syncDatabaseMigrations,
            (database) => database.createObjectStore("later"),
          ],
        }),
      );
      upgraded.close();

      const reopened = yield* openStore(factory);
      const state = yield* reopened.service.read(COMPANY_A);
      expect(state.outbox).toEqual([pendingEntry("op-1", 1)]);
      expect(state.localSequenceHighWater).toBe(1);
    }),
  );

  it.effect("persists the high-water mark across a reopen and never lowers it", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const first = yield* openStore(factory);
      yield* first.service.commit(COMPANY_A, { localSequenceHighWater: LocalSequence.make(5) });
      yield* first.service.commit(COMPANY_A, { localSequenceHighWater: LocalSequence.make(3) });
      expect((yield* first.service.read(COMPANY_A)).localSequenceHighWater).toBe(5);
      yield* first.close;

      const second = yield* openStore(factory);
      expect((yield* second.service.read(COMPANY_A)).localSequenceHighWater).toBe(5);
    }),
  );

  it.effect("aborts a failing commit without leaving partial writes behind", () =>
    Effect.gen(function* () {
      const store = yield* openStore(new IDBFactory());
      yield* store.service.commit(COMPANY_A, { upsertEntities: [entity("note-a", 1)] });
      const before = yield* store.service.read(COMPANY_A);

      // The quarantine store's key path cannot be evaluated on an empty row, which throws after
      // the entity and outbox writes of the same batch were already issued.
      const error = yield* Effect.flip(
        store.service.commit(COMPANY_A, {
          upsertEntities: [entity("note-b", 2)],
          upsertOutbox: [pendingEntry("op-1", 1)],
          localSequenceHighWater: LocalSequence.make(1),
          quarantineOutbox: [{} as StoredSyncQuarantine],
        }),
      );
      expect(error._tag).toBe("SyncStoreError");
      expect(error.operation).toBe("commit");
      expect(normalize(yield* store.service.read(COMPANY_A))).toEqual(normalize(before));
    }),
  );

  it.effect("clears one company's database and leaves the others alone", () =>
    Effect.gen(function* () {
      const store = yield* openStore(new IDBFactory());
      yield* store.service.commit(COMPANY_A, {
        upsertEntities: [entity("note-a", 1)],
        upsertOutbox: [pendingEntry("op-1", 1)],
        checkpoint: checkpointAt(1),
        localSequenceHighWater: LocalSequence.make(1),
      });
      yield* store.service.commit(COMPANY_B, { upsertEntities: [entity("note-b", 1)] });

      expect(new Set(yield* store.service.listCompanyIds)).toEqual(new Set([COMPANY_A, COMPANY_B]));

      yield* store.service.clear(COMPANY_A);
      expect(yield* store.service.read(COMPANY_A)).toEqual(EMPTY_STORED_SYNC_STATE);
      expect((yield* store.service.read(COMPANY_B)).entities).toHaveLength(1);
      expect(yield* store.service.listCompanyIds).toEqual([COMPANY_B]);
    }),
  );

  it.effect("keeps scopes apart: two users on one origin never share rows", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const userA = yield* openStore(factory, "user-a");
      const userB = yield* openStore(factory, "user-b");
      yield* userA.service.commit(COMPANY_A, { upsertEntities: [entity("note-a", 1)] });
      expect(yield* userB.service.read(COMPANY_A)).toEqual(EMPTY_STORED_SYNC_STATE);
    }),
  );

  it.effect("runs only the pending migrations on upgrade and preserves existing rows", () =>
    Effect.gen(function* () {
      const factory = new IDBFactory();
      const store = yield* openStore(factory);
      yield* store.service.commit(COMPANY_A, {
        upsertOutbox: [pendingEntry("op-1", 1)],
        localSequenceHighWater: LocalSequence.make(1),
      });
      yield* store.close;

      // A future build opens the same database one version ahead: the shipped migrations must
      // not rerun, the new one must, and the outbox must carry over untouched.
      let rerananShipped = 0;
      const countedShipped: ReadonlyArray<SyncDatabaseMigration> = syncDatabaseMigrations.map(
        (migration) => (database, transaction) => {
          rerananShipped += 1;
          migration(database, transaction);
        },
      );
      const database = yield* Effect.promise(() =>
        openSyncDatabase({
          factory,
          name: store.databaseName(COMPANY_A),
          version: SYNC_INDEXED_DB_VERSION + 1,
          migrations: [...countedShipped, (upgraded) => upgraded.createObjectStore("scratch")],
        }),
      );
      expect(rerananShipped).toBe(0);
      expect(database.version).toBe(SYNC_INDEXED_DB_VERSION + 1);
      expect(database.objectStoreNames.contains("scratch")).toBe(true);
      expect(database.objectStoreNames.contains("outbox")).toBe(true);

      const rows = yield* Effect.promise(
        () =>
          new Promise<ReadonlyArray<unknown>>((resolve, reject) => {
            const request = database
              .transaction("outbox", "readonly")
              .objectStore("outbox")
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("getAll failed"));
          }),
      );
      expect(rows).toHaveLength(1);
      expect((rows[0] as StoredOutboxEntry).envelope.operationId).toBe("op-1");
      database.close();
    }),
  );

  it.effect("backs the sync engine across a restart", () =>
    Effect.gen(function* () {
      const noteId = SyncEntityId.make("note-a");
      const store = yield* openStore(new IDBFactory());
      const server = yield* makeTestSyncServer();
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, store.service),
        Layer.succeed(SyncTransport, server.transport),
      );

      yield* Effect.gen(function* () {
        const first = yield* makeSyncEngine({
          companyId: COMPANY_A,
          clientId: SyncClientId.make("client-a"),
          actor: ACTOR,
          adapter: testNoteAdapter,
        });
        yield* first.enqueue({
          operationId: operationId("op-create"),
          operation: {
            _tag: "CreateNote",
            id: noteId,
            title: "Durable",
            body: "",
            orderKey: syncOrderKeyAfter(null),
          },
        });

        // A restart is a second engine over the same IndexedDB. The unsent operation must come
        // back into the optimistic view before any network work happens.
        const second = yield* makeSyncEngine({
          companyId: COMPANY_A,
          clientId: SyncClientId.make("client-a"),
          actor: ACTOR,
          adapter: testNoteAdapter,
        });
        const initial = yield* SubscriptionRef.get(second.state);
        expect(initial.view.get(syncEntityKey(testNoteKey(noteId)))?.title).toBe("Durable");

        const receipt = yield* second.sync;
        expect(receipt.outcome).toBe("bootstrapped");
        expect((yield* server.note(noteId))?.title).toBe("Durable");
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, { enabled: true }));
    }),
  );
});
