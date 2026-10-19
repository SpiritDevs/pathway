// @effect-diagnostics nodeBuiltinImport:off -- the durability test needs a throwaway on-disk database file; plain node:fs/node:path keep that setup out of the FileSystem layer the code under test never uses
/**
 * The cloud-sync SQLite adapter wired to the server's real SQLite stack.
 *
 * The client-runtime suite proves the adapter's semantics over a fake executor; this one proves
 * the seams that only a real driver can: DDL and `ON CONFLICT` accepted by SQLite, rollback via
 * `SqlClient.withTransaction`'s actual ROLLBACK, migration idempotency where a re-run would be a
 * hard `table already exists` error, and durability across a real close-and-reopen of a database
 * file.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import {
  makeSqliteSyncStore,
  SqliteSyncExecutorError,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type SqliteSyncExecutor,
  type SqliteSyncValue,
  type StoredSyncCheckpoint,
  type StoredSyncEntity,
} from "@spiritdevs/client-runtime/sync";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

const CLIENT_ID = SyncClientId.make("client-server");
const ACTOR: SyncActor = { kind: "member", membershipId: MembershipId.make("membership-a") };

const envelope = (input: {
  readonly companyId: CompanyId;
  readonly id: string;
  readonly sequence: number;
}): SyncOperationEnvelope => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make(input.id),
  companyId: input.companyId,
  clientId: CLIENT_ID,
  environmentId: null,
  actor: ACTOR,
  localSequence: LocalSequence.make(input.sequence),
  baseVersion: CompanyVersion.make(0),
  entityId: SyncEntityId.make(`entity-${input.id}`),
  dependsOn: [],
  kind: "issue.create",
  args: { title: `title ${input.id}`, nested: { flag: true, list: [1, "two", null] } },
});

const entity = (input: { readonly id: string; readonly version: number }): StoredSyncEntity => ({
  entityKind: "issue",
  entityId: SyncEntityId.make(input.id),
  version: CompanyVersion.make(input.version),
  payload: { id: input.id, title: `issue ${input.id}` },
});

const checkpoint = (input: {
  readonly companyId: CompanyId;
  readonly cursor: number;
}): StoredSyncCheckpoint => ({
  schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
  companyId: input.companyId,
  cursor: CompanyVersion.make(input.cursor),
  authorizationEpoch: AuthorizationEpoch.make(1),
  bootstrapped: true,
});

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("syncSqliteExecutor", (it) => {
  it.effect("round-trips a full replica through the real SQLite stack", () =>
    Effect.gen(function* () {
      const companyId = CompanyId.make("company-roundtrip");
      const executor = yield* makeSyncSqliteExecutor;
      const store = yield* makeSqliteSyncStore(executor);

      const acknowledged = envelope({ companyId, id: "op-ack", sequence: 1 });
      const pending = envelope({ companyId, id: "op-pending", sequence: 2 });
      const rejected = envelope({ companyId, id: "op-rejected", sequence: 3 });
      const stuck = envelope({ companyId, id: "op-stuck", sequence: 4 });

      yield* store.service.commit(companyId, {
        checkpoint: checkpoint({ companyId, cursor: 9 }),
        upsertEntities: [entity({ id: "e-1", version: 8 }), entity({ id: "e-2", version: 9 })],
        upsertOutbox: [
          // One row carries the enqueue stamp and one does not, which is what the `occurred_at`
          // column has to survive: a build that writes it and rows an older build left behind.
          { envelope: pending, status: { _tag: "Pending" }, occurredAt: 1_700_000 },
          {
            envelope: acknowledged,
            status: { _tag: "Acknowledged", version: CompanyVersion.make(9) },
          },
        ],
        appendRejected: [
          { envelope: rejected, code: "permission-denied", message: "membership revoked" },
        ],
        quarantineOutbox: [
          { envelope: stuck, status: { _tag: "Pending" }, reason: "written by a newer build" },
        ],
        localSequenceHighWater: LocalSequence.make(4),
      });

      const stored = yield* store.service.read(companyId);
      expect(stored.checkpoint).toEqual(checkpoint({ companyId, cursor: 9 }));
      expect(stored.entities).toEqual([
        entity({ id: "e-1", version: 8 }),
        entity({ id: "e-2", version: 9 }),
      ]);
      // The outbox comes back in local-sequence order regardless of write order, and the stamp
      // reads back as the number it was written as — SQL `NULL` on the row that had none.
      expect(stored.outbox).toEqual([
        {
          envelope: acknowledged,
          status: { _tag: "Acknowledged", version: 9 },
          occurredAt: undefined,
        },
        { envelope: pending, status: { _tag: "Pending" }, occurredAt: 1_700_000 },
      ]);
      expect(stored.rejected).toEqual([
        { envelope: rejected, code: "permission-denied", message: "membership revoked" },
      ]);
      expect(stored.quarantined).toEqual([
        { envelope: stuck, status: { _tag: "Pending" }, reason: "written by a newer build" },
      ]);
      expect(stored.localSequenceHighWater).toBe(4);

      yield* store.service.clear(companyId);
      expect((yield* store.service.read(companyId)).checkpoint).toBeNull();
    }),
  );

  it.effect("opens idempotently: the version guard skips DDL that would otherwise throw", () =>
    Effect.gen(function* () {
      const companyId = CompanyId.make("company-reopen");
      const executor = yield* makeSyncSqliteExecutor;

      const first = yield* makeSqliteSyncStore(executor);
      yield* first.service.commit(companyId, {
        upsertOutbox: [
          {
            envelope: envelope({ companyId, id: "op-keep", sequence: 5 }),
            status: { _tag: "Pending" },
          },
        ],
        localSequenceHighWater: LocalSequence.make(5),
      });

      // Real SQLite would fail `CREATE TABLE cloud_sync_outbox` on a second run — and the
      // `ADD COLUMN` migrations with "duplicate column name" — so the migration version guard is
      // what makes this open succeed. This is the fake-free half of the SQLite store's own reopen
      // test: there, adding a column to a record is a no-op and cannot catch a re-run.
      const second = yield* makeSqliteSyncStore(executor);
      const stored = yield* second.service.read(companyId);
      expect(stored.outbox.map((entry) => entry.envelope.operationId)).toEqual(["op-keep"]);
      expect(stored.localSequenceHighWater).toBe(5);

      const versions = yield* executor.all(
        "SELECT version FROM cloud_sync_store_migrations ORDER BY version",
        [],
      );
      // Every migration the store owns, applied exactly once across both opens.
      expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    }),
  );

  it.effect("a failing statement mid-commit rolls the whole batch back", () =>
    Effect.gen(function* () {
      const companyId = CompanyId.make("company-atomic");
      const base = yield* makeSyncSqliteExecutor;
      const store = yield* makeSqliteSyncStore(base);

      yield* store.service.commit(companyId, {
        checkpoint: checkpoint({ companyId, cursor: 3 }),
        upsertEntities: [entity({ id: "e-before", version: 3 })],
        localSequenceHighWater: LocalSequence.make(1),
      });
      const before = yield* store.service.read(companyId);

      // Writes to the outbox table fail after the checkpoint and entity statements of the same
      // batch have already executed inside the transaction.
      const failing: SqliteSyncExecutor = {
        ...base,
        run: (statement, params: ReadonlyArray<SqliteSyncValue>) =>
          statement.includes("cloud_sync_outbox")
            ? Effect.fail(new SqliteSyncExecutorError({ message: "injected failure" }))
            : base.run(statement, params),
      };
      const broken = yield* makeSqliteSyncStore(failing);

      const exit = yield* Effect.exit(
        broken.service.commit(companyId, {
          checkpoint: checkpoint({ companyId, cursor: 4 }),
          upsertEntities: [entity({ id: "e-torn", version: 4 })],
          upsertOutbox: [
            {
              envelope: envelope({ companyId, id: "op-torn", sequence: 2 }),
              status: { _tag: "Pending" },
            },
          ],
          localSequenceHighWater: LocalSequence.make(2),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* store.service.read(companyId)).toEqual(before);
    }),
  );
});

describe("syncSqliteExecutor commit failures", () => {
  it.effect("a COMMIT that fails at the driver level stays in the executor's failure channel", () =>
    Effect.gen(function* () {
      const executor = yield* makeSyncSqliteExecutor;

      // A deferred foreign key is the portable way to make SQLite fail at COMMIT rather than at
      // the statement: the violating INSERT is accepted and the constraint is only checked when
      // the transaction is flushed — the same shape a disk-full or I/O error takes there.
      yield* executor.exec("CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)");
      yield* executor.exec(
        `CREATE TABLE commit_child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED
        )`,
      );

      // `SqlClient.withTransaction` runs COMMIT under `Effect.orDie`, so without the executor's
      // defect conversion this dies mid-test instead of failing — and `SqliteSyncStore` would
      // never map it to a `SyncStoreError` for the engine to handle.
      const outcome = yield* executor
        .withTransaction(
          Effect.gen(function* () {
            yield* executor.run("INSERT INTO commit_child (id, parent_id) VALUES (?, ?)", [1, 404]);
            // Every statement of the batch succeeded: only COMMIT can fail from here.
            expect(yield* executor.all("SELECT id FROM commit_child", [])).toEqual([{ id: 1 }]);
          }),
        )
        .pipe(
          Effect.as("committed"),
          Effect.catchTag("SqliteSyncExecutorError", (error) =>
            Effect.succeed(`executor error: ${error.message}`),
          ),
        );
      expect(outcome).toBe("executor error: Failed to execute statement");
      // A failed COMMIT leaves SQLite's transaction open, so this connection is spent; the layer
      // is scoped to this test and closes it.
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

describe("syncSqliteExecutor durability", () => {
  it.effect("outbox, quarantine, and high-water mark survive a real close-and-reopen", () =>
    Effect.gen(function* () {
      const companyId = CompanyId.make("company-durable");
      const directory = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-sync-store-")),
      );
      const filename = NodePath.join(directory, "sync.sqlite");
      const stuck = envelope({ companyId, id: "op-stuck", sequence: 6 });

      const write = Effect.gen(function* () {
        const executor = yield* makeSyncSqliteExecutor;
        const store = yield* makeSqliteSyncStore(executor);
        yield* store.service.commit(companyId, {
          upsertOutbox: [
            { envelope: stuck, status: { _tag: "Pending" } },
            {
              envelope: envelope({ companyId, id: "op-live", sequence: 7 }),
              status: { _tag: "Pending" },
            },
          ],
          localSequenceHighWater: LocalSequence.make(7),
        });
        yield* store.service.commit(companyId, {
          removeOutbox: [stuck.operationId],
          quarantineOutbox: [
            { envelope: stuck, status: { _tag: "Pending" }, reason: "undecodable arguments" },
          ],
        });
      });

      const reopenAndCheck = Effect.gen(function* () {
        const executor = yield* makeSyncSqliteExecutor;
        const store = yield* makeSqliteSyncStore(executor);
        const stored = yield* store.service.read(companyId);
        expect(stored.outbox.map((entry) => entry.envelope.operationId)).toEqual(["op-live"]);
        expect(stored.quarantined).toEqual([
          { envelope: stuck, status: { _tag: "Pending" }, reason: "undecodable arguments" },
        ]);
        expect(stored.localSequenceHighWater).toBe(7);

        // The mark never regresses, even straight after a reopen.
        yield* store.service.commit(companyId, {
          localSequenceHighWater: LocalSequence.make(3),
        });
        expect((yield* store.service.read(companyId)).localSequenceHighWater).toBe(7);
      });

      yield* Effect.gen(function* () {
        yield* write.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        yield* reopenAndCheck.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
