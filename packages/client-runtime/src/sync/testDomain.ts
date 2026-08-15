/**
 * Test-only domain and Convex stand-in for the sync engine.
 *
 * The domain is one entity ("note") with four operations, chosen to exercise the conflict rules:
 * `SetNoteFields` merges per field, `AppendNoteTag` is order- and count-sensitive so a duplicated
 * operation is visible, and `DeleteNote` blocks later edits. The server applies operations with
 * the same adapter reducer the client uses optimistically, which is exactly the arrangement the
 * issue domain will have.
 *
 * The protocol's entity and operation kinds are a closed set, so the notes borrow the `issue` kinds
 * rather than inventing their own: the engine only ever forwards them, and using real ones keeps
 * the fixture on the same envelope Convex validates.
 *
 * @module sync/testDomain
 */
import {
  AuthorizationEpoch,
  CompanyVersion,
  ISSUE_KEY_BLOCK_SIZE,
  SyncEntityId,
  type SyncApplyOperationsResponse,
  type SyncBootstrapResponse,
  type SyncChangeEnvelope,
  type SyncEntityKind,
  type SyncLatestVersionResponse,
  type SyncListChangesResponse,
  type SyncOperationId,
  type SyncOperationKind,
  type SyncOperationReceipt,
  type SyncRejectionCode,
} from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { applied, blocked, deleted, type SyncDomainAdapter } from "./adapter.ts";
import { syncCodec } from "./codec.ts";
import { SYNC_INITIAL_EPOCH, type SyncEntityKey } from "./model.ts";
import { SyncTransport, SyncTransportError } from "./transport.ts";

export const NOTE_ENTITY_KIND: SyncEntityKind = "issue";

export const TestNote = Schema.Struct({
  id: SyncEntityId,
  title: Schema.String,
  body: Schema.String,
  tags: Schema.Array(Schema.String),
  orderKey: Schema.String,
});
export type TestNote = typeof TestNote.Type;

export const TestNoteOperation = Schema.Union([
  Schema.TaggedStruct("CreateNote", {
    id: SyncEntityId,
    title: Schema.String,
    body: Schema.String,
    orderKey: Schema.String,
  }),
  Schema.TaggedStruct("SetNoteFields", {
    id: SyncEntityId,
    title: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("AppendNoteTag", { id: SyncEntityId, tag: Schema.String }),
  Schema.TaggedStruct("DeleteNote", { id: SyncEntityId }),
]);
export type TestNoteOperation = typeof TestNoteOperation.Type;

const noteCodec = syncCodec(TestNote);
const operationCodec = syncCodec(TestNoteOperation);

export function testNoteKey(id: SyncEntityId): SyncEntityKey {
  return { entityKind: NOTE_ENTITY_KIND, entityId: id };
}

const testNoteOperationKind = (operation: TestNoteOperation): SyncOperationKind => {
  switch (operation._tag) {
    case "CreateNote":
      return "issue.create";
    case "DeleteNote":
      return "issue.delete";
    default:
      return "issue.update";
  }
};

/**
 * The reducer both sides run. Field patches merge (a title edit and a body edit converge), while
 * an edit against a missing or deleted note blocks with a reason rather than resurrecting it.
 */
export const testNoteAdapter: SyncDomainAdapter<TestNote, TestNoteOperation> = {
  domain: "test-notes",
  entityCodec: (entityKind) => (entityKind === NOTE_ENTITY_KIND ? noteCodec : null),
  operationCodec,
  operationKind: testNoteOperationKind,
  operationTarget: (operation) => testNoteKey(operation.id),
  apply: ({ current, operation }) => {
    switch (operation._tag) {
      case "CreateNote":
        return applied(
          current ?? {
            id: operation.id,
            title: operation.title,
            body: operation.body,
            tags: [],
            orderKey: operation.orderKey,
          },
        );
      case "SetNoteFields":
        if (current === null) return blocked("The note was deleted before this edit applied.");
        return applied({
          ...current,
          title: operation.title ?? current.title,
          body: operation.body ?? current.body,
        });
      case "AppendNoteTag":
        if (current === null) return blocked("The note was deleted before this tag applied.");
        return applied({ ...current, tags: [...current.tags, operation.tag] });
      case "DeleteNote":
        return deleted();
    }
  },
};

export interface TestSyncServerOptions {
  /** Rejects matching operations, standing in for a Convex permission check. */
  readonly reject?: (operation: TestNoteOperation) => {
    readonly code: SyncRejectionCode;
    readonly message: string;
  } | null;
  /** Hides entities from the feed, standing in for team/authorization filtering. */
  readonly visible?: (note: TestNote) => boolean;
}

interface ServerChange {
  readonly version: CompanyVersion;
  readonly entityId: SyncEntityId;
  readonly deleted: boolean;
  readonly note: TestNote | null;
}

interface ServerState {
  readonly notes: ReadonlyMap<SyncEntityId, TestNote>;
  readonly changes: ReadonlyArray<ServerChange>;
  readonly receipts: ReadonlyMap<SyncOperationId, SyncOperationReceipt>;
  /** Changes below this version are outside the retention window; cursors there are expired. */
  readonly retainedFrom: CompanyVersion;
  readonly version: CompanyVersion;
  readonly epoch: AuthorizationEpoch;
}

export interface TestSyncServer {
  readonly transport: SyncTransport["Service"];
  /** Applies an operation as if another client had submitted it. */
  readonly applyExternal: (
    operation: TestNoteOperation,
    operationId: SyncOperationId,
  ) => Effect.Effect<SyncOperationReceipt>;
  readonly setEpoch: (epoch: AuthorizationEpoch) => Effect.Effect<void>;
  readonly setVisibility: (visible: (note: TestNote) => boolean) => Effect.Effect<void>;
  readonly setRejection: (
    reject: NonNullable<TestSyncServerOptions["reject"]>,
  ) => Effect.Effect<void>;
  /** Drops retention below `version`, so older cursors must re-bootstrap. */
  readonly expireBefore: (version: CompanyVersion) => Effect.Effect<void>;
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  /**
   * Applies operations but loses the answer, the case operation-id deduplication exists for: the
   * client cannot tell "not applied" from "applied, answer lost" and must resend.
   */
  readonly setDropAcks: (drop: boolean) => Effect.Effect<void>;
  readonly note: (id: SyncEntityId) => Effect.Effect<TestNote | null>;
  readonly head: Effect.Effect<SyncLatestVersionResponse>;
  /** How many times each operation id reached the server; duplicates must still apply once. */
  readonly submissions: Effect.Effect<ReadonlyMap<SyncOperationId, number>>;
}

export const makeTestSyncServer = Effect.fn("makeTestSyncServer")(function* (
  options?: TestSyncServerOptions,
) {
  const state = yield* Ref.make<ServerState>({
    notes: new Map(),
    changes: [],
    receipts: new Map(),
    retainedFrom: CompanyVersion.make(0),
    version: CompanyVersion.make(0),
    epoch: SYNC_INITIAL_EPOCH,
  });
  const reject = yield* Ref.make(options?.reject ?? (() => null));
  const visible = yield* Ref.make(options?.visible ?? (() => true));
  const offline = yield* Ref.make(false);
  const dropAcks = yield* Ref.make(false);
  const submissions = yield* Ref.make(new Map<SyncOperationId, number>());
  const head = yield* SubscriptionRef.make<SyncLatestVersionResponse>({
    version: CompanyVersion.make(0),
    authorizationEpoch: SYNC_INITIAL_EPOCH,
  });

  const publishHead = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    yield* SubscriptionRef.set(head, {
      version: current.version,
      authorizationEpoch: current.epoch,
    });
  });

  const requireOnline = Effect.gen(function* () {
    if (yield* Ref.get(offline)) {
      return yield* new SyncTransportError({ reason: "offline", message: "Test server offline." });
    }
  });

  const applyOne = Effect.fn("TestSyncServer.applyOne")(function* (
    operationId: SyncOperationId,
    operation: TestNoteOperation,
  ) {
    yield* Ref.update(submissions, (current) => {
      const next = new Map(current);
      next.set(operationId, (next.get(operationId) ?? 0) + 1);
      return next;
    });
    const current = yield* Ref.get(state);
    // Deduplicated by operation id: a resubmitted operation replays its original receipt, outcome
    // included. A rejection stays a rejection on every retry — a resend must never launder one
    // into a success just because the server has seen the id before.
    const known = current.receipts.get(operationId);
    if (known !== undefined) return { ...known, duplicate: true };

    const rejection = (yield* Ref.get(reject))(operation);
    if (rejection !== null) {
      const receipt: SyncOperationReceipt = {
        operationId,
        status: "rejected",
        duplicate: false,
        code: rejection.code,
        message: rejection.message,
      };
      yield* Ref.set(state, {
        ...current,
        receipts: new Map(current.receipts).set(operationId, receipt),
      });
      return receipt;
    }

    const outcome = testNoteAdapter.apply({
      current: current.notes.get(operation.id) ?? null,
      operation,
    });
    if (outcome._tag === "Blocked") {
      const receipt: SyncOperationReceipt = {
        operationId,
        status: "rejected",
        duplicate: false,
        code: "entity-deleted",
        message: outcome.reason,
      };
      yield* Ref.set(state, {
        ...current,
        receipts: new Map(current.receipts).set(operationId, receipt),
      });
      return receipt;
    }

    const version = CompanyVersion.make(current.version + 1);
    const notes = new Map(current.notes);
    if (outcome._tag === "Deleted") notes.delete(operation.id);
    else notes.set(operation.id, outcome.entity);
    const receipt: SyncOperationReceipt = {
      operationId,
      status: "accepted",
      duplicate: false,
      firstVersion: version,
      lastVersion: version,
    };
    yield* Ref.set(state, {
      ...current,
      notes,
      version,
      changes: [
        ...current.changes,
        {
          version,
          entityId: operation.id,
          deleted: outcome._tag === "Deleted",
          note: outcome._tag === "Deleted" ? null : outcome.entity,
        },
      ],
      receipts: new Map(current.receipts).set(operationId, receipt),
    });
    return receipt;
  });

  const encodeChange = (change: ServerChange): SyncChangeEnvelope => ({
    version: change.version,
    entityKind: NOTE_ENTITY_KIND,
    entityId: change.entityId,
    changeKind: change.deleted ? "tombstone" : "upsert",
    payload: change.note === null ? null : noteCodec.encode(change.note),
  });

  const transport = SyncTransport.of({
    bootstrap: (input) =>
      Effect.gen(function* () {
        yield* requireOnline;
        const current = yield* Ref.get(state);
        const isVisible = yield* Ref.get(visible);
        const rows = [...current.notes.values()].filter(isVisible);
        const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10);
        const pageSize = input.pageSize ?? rows.length;
        const page = rows.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        const isDone = nextOffset >= rows.length;
        const versionOf = (id: SyncEntityId) =>
          current.changes.reduce(
            (latest, change) => (change.entityId === id ? change.version : latest),
            CompanyVersion.make(0),
          );
        return {
          version: current.version,
          authorizationEpoch: current.epoch,
          entities: page.map((note) => ({
            version: versionOf(note.id),
            entityKind: NOTE_ENTITY_KIND,
            entityId: note.id,
            changeKind: "upsert" as const,
            payload: noteCodec.encode(note),
          })),
          cursor: isDone ? null : String(nextOffset),
          isDone,
        } satisfies SyncBootstrapResponse;
      }),
    latestVersion: () => SubscriptionRef.changes(head),
    listChanges: (input) =>
      Effect.gen(function* () {
        yield* requireOnline;
        const current = yield* Ref.get(state);
        const isVisible = yield* Ref.get(visible);
        if (input.cursor < current.retainedFrom) {
          return {
            _tag: "CursorExpired",
            latestVersion: current.version,
            authorizationEpoch: current.epoch,
          } satisfies SyncListChangesResponse;
        }
        const window = current.changes
          .filter((change) => change.version > input.cursor)
          .slice(0, input.limit ?? current.changes.length);
        const lastVersion = window.at(-1)?.version ?? input.cursor;
        const remaining = current.changes.filter((change) => change.version > lastVersion);
        return {
          _tag: "Changes",
          // Filtering happens after the window is chosen, so a page that authorization empties
          // still advances the cursor past the versions it covered.
          changes: window
            .filter((change) => change.note === null || isVisible(change.note))
            .map(encodeChange),
          cursor: lastVersion,
          hasMore: remaining.length > 0,
          latestVersion: current.version,
          authorizationEpoch: current.epoch,
        } satisfies SyncListChangesResponse;
      }),
    applyOperations: (input) =>
      Effect.gen(function* () {
        yield* requireOnline;
        const versionFrom = (yield* Ref.get(state)).version;
        const receipts: Array<SyncOperationReceipt> = [];
        for (const envelope of input.operations) {
          const operation = operationCodec.decode(envelope.args);
          if (operation._tag === "None") {
            receipts.push({
              operationId: envelope.operationId,
              status: "rejected",
              duplicate: false,
              code: "invalid-arguments",
              message: "Unreadable operation arguments.",
            });
            continue;
          }
          receipts.push(yield* applyOne(envelope.operationId, operation.value));
        }
        yield* publishHead;
        if (yield* Ref.get(dropAcks)) {
          return yield* new SyncTransportError({
            reason: "transport",
            message: "Connection dropped before the answer arrived.",
          });
        }
        const current = yield* Ref.get(state);
        return {
          receipts,
          versionFrom,
          versionTo: current.version,
          authorizationEpoch: current.epoch,
        } satisfies SyncApplyOperationsResponse;
      }),
    reserveIssueKeys: (input) =>
      Effect.succeed({
        prefix: "TEST",
        blockStart: 1,
        blockEnd: input.blockSize ?? ISSUE_KEY_BLOCK_SIZE,
        firstKey: "TEST-1",
      }),
  });

  return {
    transport,
    applyExternal: (operation, operationId) =>
      applyOne(operationId, operation).pipe(Effect.tap(() => publishHead)),
    setEpoch: (epoch) =>
      Ref.update(state, (current) => ({ ...current, epoch })).pipe(Effect.andThen(publishHead)),
    setVisibility: (next) => Ref.set(visible, next),
    setRejection: (next) => Ref.set(reject, next),
    expireBefore: (version) =>
      Ref.update(state, (current) => ({ ...current, retainedFrom: version })),
    setOffline: (next) => Ref.set(offline, next),
    setDropAcks: (next) => Ref.set(dropAcks, next),
    note: (id) => Ref.get(state).pipe(Effect.map((current) => current.notes.get(id) ?? null)),
    head: Ref.get(state).pipe(
      Effect.map((current) => ({ version: current.version, authorizationEpoch: current.epoch })),
    ),
    submissions: Ref.get(submissions),
  } satisfies TestSyncServer;
});
