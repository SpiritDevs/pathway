import { describe, expect, it } from "@effect/vitest";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_MAX_CHANGES_PER_PAGE,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncActor,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { CloudSyncCapability } from "./capability.ts";
import { SYNC_BOOTSTRAP_GENERATION, SYNC_DOCUMENT_SCHEMA_VERSION } from "./document.ts";
import {
  clampSyncBound,
  makeSyncEngine,
  SYNC_BOOTSTRAP_MAX_ATTEMPTS,
  SYNC_RETRY_MIN_DELAY,
  type SyncEngineState,
} from "./engine.ts";
import { makeMemorySyncStore } from "./memoryStore.ts";
import { syncEntityKey } from "./model.ts";
import { syncOrderKeyAfter } from "./orderKey.ts";
import { SyncStore } from "./persistence.ts";
import {
  makeTestSyncServer,
  testNoteAdapter,
  testNoteKey,
  type TestNote,
  type TestNoteOperation,
  type TestSyncServerOptions,
} from "./testDomain.ts";
import { SyncTransport } from "./transport.ts";

const COMPANY_ID = CompanyId.make("company-notes");
const NOTE_A = SyncEntityId.make("note-a");
const NOTE_B = SyncEntityId.make("note-b");
const ENABLED = { enabled: true } as const;
const ACTOR: SyncActor = { kind: "member", membershipId: MembershipId.make("membership-a") };

type NoteState = SyncEngineState<TestNote, TestNoteOperation>;

const operationId = (value: string) => SyncOperationId.make(value);

const makeHarness = Effect.fn("makeHarness")(function* (options?: TestSyncServerOptions) {
  const store = yield* makeMemorySyncStore();
  const server = yield* makeTestSyncServer(options);
  const layer = Layer.mergeAll(
    Layer.succeed(SyncStore, store.service),
    Layer.succeed(SyncTransport, server.transport),
  );
  return { store, server, layer };
});

/** A restart is a second engine over the same store, which is exactly what the app does. */
const openEngine = (
  clientId: string,
  bounds?: { readonly pageSize?: number; readonly batchSize?: number },
) =>
  makeSyncEngine({
    companyId: COMPANY_ID,
    clientId: SyncClientId.make(clientId),
    actor: ACTOR,
    adapter: testNoteAdapter,
    ...bounds,
  });

const createNote = (input: {
  readonly id: SyncEntityId;
  readonly title: string;
  readonly body: string;
}): TestNoteOperation => ({
  _tag: "CreateNote",
  id: input.id,
  title: input.title,
  body: input.body,
  orderKey: syncOrderKeyAfter(null),
});

const viewNote = (state: NoteState, id: SyncEntityId): TestNote | null =>
  state.view.get(syncEntityKey(testNoteKey(id))) ?? null;

const confirmedNote = (state: NoteState, id: SyncEntityId): TestNote | null =>
  state.confirmed.get(syncEntityKey(testNoteKey(id))) ?? null;

describe("SyncEngine", () => {
  it.effect("merges edits to different fields of the same entity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "title-original", body: "body-original" }),
        });
        yield* engine.sync;

        // The local client edits the body offline while another client edits the title.
        yield* harness.server.setOffline(true);
        yield* engine.enqueue({
          operationId: operationId("op-body"),
          operation: { _tag: "SetNoteFields", id: NOTE_A, body: "body-local" },
        });
        const offline = yield* engine.sync;
        expect(offline.outcome).toBe("offline");
        expect(viewNote(yield* SubscriptionRef.get(engine.state), NOTE_A)).toMatchObject({
          title: "title-original",
          body: "body-local",
        });

        yield* harness.server.applyExternal(
          { _tag: "SetNoteFields", id: NOTE_A, title: "title-remote" },
          operationId("op-title-remote"),
        );
        yield* harness.server.setOffline(false);
        yield* engine.sync;

        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)).toMatchObject({
          title: "title-remote",
          body: "body-local",
        });
        expect(state.pending).toEqual([]);
        expect(state.presentation.status).toBe("live");
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("lets the later server-accepted write win the same field", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "title-original", body: "" }),
        });
        yield* engine.enqueue({
          operationId: operationId("op-title-local"),
          operation: { _tag: "SetNoteFields", id: NOTE_A, title: "title-local" },
        });
        yield* engine.sync;
        expect(viewNote(yield* SubscriptionRef.get(engine.state), NOTE_A)?.title).toBe(
          "title-local",
        );

        // Accepted after ours, so it wins — no client clock is consulted.
        yield* harness.server.applyExternal(
          { _tag: "SetNoteFields", id: NOTE_A, title: "title-remote" },
          operationId("op-title-remote"),
        );
        yield* engine.sync;

        const state = yield* SubscriptionRef.get(engine.state);
        expect(viewNote(state, NOTE_A)?.title).toBe("title-remote");
        expect(confirmedNote(state, NOTE_A)?.title).toBe("title-remote");
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("applies a resent operation exactly once when the acknowledgement is lost", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.sync;

        yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        // The server applies the tag but the answer never arrives.
        yield* harness.server.setDropAcks(true);
        const lost = yield* engine.sync;
        expect(lost.outcome).toBe("offline");

        yield* harness.server.setDropAcks(false);
        const resent = yield* engine.sync;
        expect(resent.acceptedOperations).toBe(1);

        const submissions = yield* harness.server.submissions;
        expect(submissions.get(operationId("op-tag"))).toBe(2);
        // Appending is not idempotent, so a second application would be visible.
        expect((yield* harness.server.note(NOTE_A))?.tags).toEqual(["urgent"]);
        const state = yield* SubscriptionRef.get(engine.state);
        expect(viewNote(state, NOTE_A)?.tags).toEqual(["urgent"]);
        expect(state.pending).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("refuses a second enqueue of the same operation id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        const first = yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        const second = yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });

        expect(first.accepted).toBe(true);
        expect(second.accepted).toBe(false);
        expect(viewNote(yield* SubscriptionRef.get(engine.state), NOTE_A)?.tags).toEqual([
          "urgent",
        ]);

        yield* engine.sync;
        expect((yield* harness.server.note(NOTE_A))?.tags).toEqual(["urgent"]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("replays a restarted outbox exactly once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const first = yield* openEngine("client-a");
        yield* harness.server.setOffline(true);
        yield* first.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "offline-draft" }),
        });
        yield* first.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        expect((yield* first.sync).outcome).toBe("offline");
        expect((yield* harness.store.snapshot(COMPANY_ID)).outbox).toHaveLength(2);

        // Restart: a fresh engine over the same store, with the network back.
        yield* harness.server.setOffline(false);
        const restarted = yield* openEngine("client-a");
        const state = yield* SubscriptionRef.get(restarted.state);
        expect(viewNote(state, NOTE_A)?.body).toBe("offline-draft");

        yield* restarted.sync;
        const submissions = yield* harness.server.submissions;
        expect(submissions.get(operationId("op-create"))).toBe(1);
        expect(submissions.get(operationId("op-tag"))).toBe(1);
        expect((yield* harness.server.note(NOTE_A))?.tags).toEqual(["urgent"]);
        // Confirmed by the feed, so the outbox is empty again.
        expect((yield* harness.store.snapshot(COMPANY_ID)).outbox).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("rolls back only the rejected operation and blocks its dependents with a reason", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create-a"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.enqueue({
          operationId: operationId("op-create-b"),
          operation: createNote({ id: NOTE_B, title: "B", body: "" }),
        });
        yield* engine.sync;

        yield* harness.server.setRejection((operation) =>
          operation._tag === "SetNoteFields" && operation.title === "denied"
            ? { code: "permission-denied", message: "You cannot rename this note." }
            : null,
        );
        yield* engine.enqueue({
          operationId: operationId("op-denied"),
          operation: { _tag: "SetNoteFields", id: NOTE_A, title: "denied" },
        });
        yield* engine.enqueue({
          operationId: operationId("op-allowed"),
          operation: { _tag: "SetNoteFields", id: NOTE_B, title: "B-renamed" },
        });
        const receipt = yield* engine.sync;
        expect(receipt.rejectedOperations).toBe(1);
        expect(receipt.acceptedOperations).toBe(1);

        const afterReject = yield* SubscriptionRef.get(engine.state);
        // Only the rejected operation loses its overlay.
        expect(viewNote(afterReject, NOTE_A)?.title).toBe("A");
        expect(viewNote(afterReject, NOTE_B)?.title).toBe("B-renamed");
        expect(afterReject.rejected).toHaveLength(1);
        expect(afterReject.rejected[0]?.code).toBe("permission-denied");
        expect(afterReject.rejected[0]?.message).toBe("You cannot rename this note.");

        // A dependent enqueued afterwards is held back rather than applied against missing state.
        yield* engine.enqueue({
          operationId: operationId("op-dependent"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "renamed" },
          dependsOn: [operationId("op-denied")],
        });
        const blocked = yield* SubscriptionRef.get(engine.state);
        const dependent = blocked.pending.find(
          (entry) => entry.operation.operationId === operationId("op-dependent"),
        );
        expect(dependent?.status).toMatchObject({ _tag: "Blocked" });
        expect(dependent?.status._tag === "Blocked" ? dependent.status.reason : null).toContain(
          "op-denied",
        );
        expect(viewNote(blocked, NOTE_A)?.tags).toEqual([]);
        expect(blocked.presentation.status).toBe("blocked");

        yield* engine.sync;
        expect(
          (yield* harness.server.submissions).get(operationId("op-dependent")),
        ).toBeUndefined();

        // Dismissing the rejection releases the dependent.
        yield* engine.discardRejected([operationId("op-denied")]);
        yield* engine.sync;
        expect((yield* harness.server.note(NOTE_A))?.tags).toEqual(["renamed"]);
        expect((yield* SubscriptionRef.get(engine.state)).rejected).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("reseeds and purges when the authorization epoch changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create-a"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.enqueue({
          operationId: operationId("op-create-b"),
          operation: createNote({ id: NOTE_B, title: "B", body: "" }),
        });
        yield* engine.sync;
        expect((yield* SubscriptionRef.get(engine.state)).confirmed.size).toBe(2);

        // The actor lost access to note B, which is a membership change, not a delete.
        yield* harness.server.setVisibility((note) => note.id !== NOTE_B);
        yield* harness.server.setEpoch(AuthorizationEpoch.make(1));
        const receipt = yield* engine.sync;

        expect(receipt.outcome).toBe("reseeded");
        expect(receipt.authorizationEpoch).toBe(1);
        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)?.title).toBe("A");
        expect(confirmedNote(state, NOTE_B)).toBeNull();
        // The purge is durable, not just in memory.
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.entities.map((entity) => entity.entityId)).toEqual([NOTE_A]);
        expect(stored.checkpoint?.authorizationEpoch).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("bootstraps again when the feed no longer retains the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create-a"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.sync;
        const cursor = (yield* SubscriptionRef.get(engine.state)).cursor;

        // Changes the client missed, then retention moves past its cursor.
        yield* harness.server.applyExternal(
          { _tag: "SetNoteFields", id: NOTE_A, title: "A-renamed" },
          operationId("op-remote-rename"),
        );
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-create-b"),
        );
        yield* harness.server.expireBefore(CompanyVersion.make(cursor + 1));

        const receipt = yield* engine.sync;
        expect(receipt.outcome).toBe("bootstrapped");
        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)?.title).toBe("A-renamed");
        expect(confirmedNote(state, NOTE_B)?.title).toBe("B");
        expect(state.cursor).toBe((yield* harness.server.head).version);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("folds legacy version-0 rows during the first seed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const transport = SyncTransport.of({
        ...harness.server.transport,
        bootstrap: (input) =>
          harness.server.transport.bootstrap(input).pipe(
            Effect.map((page) => ({
              ...page,
              entities: page.entities.map((entity) => ({
                ...entity,
                version: CompanyVersion.make(0),
              })),
            })),
          ),
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "legacy", body: "" }),
          operationId("op-legacy"),
        );
        const engine = yield* openEngine("client-a");
        const receipt = yield* engine.sync;

        expect(receipt.outcome).toBe("bootstrapped");
        expect(confirmedNote(yield* SubscriptionRef.get(engine.state), NOTE_A)?.title).toBe(
          "legacy",
        );
        expect((yield* harness.store.snapshot(COMPANY_ID)).entities[0]?.version).toBe(0);
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("folds legacy version-0 rows again after an authorization-epoch reseed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const transport = SyncTransport.of({
        ...harness.server.transport,
        bootstrap: (input) =>
          harness.server.transport.bootstrap(input).pipe(
            Effect.map((page) => ({
              ...page,
              entities: page.entities.map((entity) => ({
                ...entity,
                version: CompanyVersion.make(0),
              })),
            })),
          ),
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "legacy-a", body: "" }),
          operationId("op-legacy-a"),
        );
        const engine = yield* openEngine("client-a");
        yield* engine.sync;

        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "legacy-b", body: "" }),
          operationId("op-legacy-b"),
        );
        yield* harness.server.setEpoch(AuthorizationEpoch.make(1));
        const receipt = yield* engine.sync;

        expect(receipt.outcome).toBe("reseeded");
        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)?.title).toBe("legacy-a");
        expect(confirmedNote(state, NOTE_B)?.title).toBe("legacy-b");
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("reseeds an old-generation checkpoint and sends its surviving outbox", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const old = yield* openEngine("client-a");
        yield* old.enqueue({
          operationId: operationId("op-offline"),
          operation: createNote({ id: NOTE_B, title: "offline", body: "draft" }),
        });
        // Generation 1 was implicit, so an upgraded client reads a perfectly valid checkpoint
        // with no marker. Its confirmed rows are incomplete, but its outbox is user work.
        yield* harness.store.service.commit(COMPANY_ID, {
          checkpoint: {
            schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
            companyId: COMPANY_ID,
            cursor: CompanyVersion.make(9),
            authorizationEpoch: AuthorizationEpoch.make(0),
            bootstrapped: true,
          },
          upsertEntities: [
            {
              entityKind: "issue",
              entityId: NOTE_A,
              version: CompanyVersion.make(9),
              payload: { id: NOTE_A, title: "stale", body: "", tags: [], orderKey: "a0" },
            },
          ],
        });

        const upgraded = yield* openEngine("client-a");
        const cold = yield* SubscriptionRef.get(upgraded.state);
        expect(cold.bootstrapped).toBe(false);
        expect(cold.confirmed.size).toBe(0);
        expect(viewNote(cold, NOTE_B)?.title).toBe("offline");

        const receipt = yield* upgraded.sync;
        expect(receipt.outcome).toBe("bootstrapped");
        expect((yield* harness.server.submissions).get(operationId("op-offline"))).toBe(1);
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.outbox).toEqual([]);
        expect(stored.checkpoint?.bootstrapGeneration).toBe(SYNC_BOOTSTRAP_GENERATION);
        expect(stored.entities.map((entity) => entity.entityId)).toEqual([NOTE_B]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("does not reseed a checkpoint at the current bootstrap generation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "current", body: "" }),
          operationId("op-current"),
        );
        const first = yield* openEngine("client-a");
        yield* first.sync;

        const bootstraps = yield* Ref.make(0);
        const transport = SyncTransport.of({
          ...harness.server.transport,
          bootstrap: (input) =>
            Ref.update(bootstraps, (count) => count + 1).pipe(
              Effect.andThen(harness.server.transport.bootstrap(input)),
            ),
        });
        const restarted = yield* openEngine("client-a").pipe(
          Effect.provideService(SyncTransport, transport),
        );
        const receipt = yield* restarted.sync;

        expect(receipt.outcome).toBe("synced");
        expect(yield* Ref.get(bootstraps)).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("starts the seed over when the authorization epoch moves between bootstrap pages", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const cursors = yield* Ref.make<ReadonlyArray<string | null>>([]);
      const revoked = yield* Ref.make(false);
      // Access to note A is taken away between page one and page two of the very first seed. Each
      // page is filtered on its own, and the bootstrap cursor is pagination state that carries no
      // epoch, so page one holds a row chosen under permissions the actor no longer has.
      const transport = SyncTransport.of({
        ...harness.server.transport,
        bootstrap: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(cursors, (seen) => [...seen, input.cursor]);
            const page = yield* harness.server.transport.bootstrap(input);
            if (!(yield* Ref.get(revoked))) {
              yield* Ref.set(revoked, true);
              yield* harness.server.setVisibility((note) => note.id !== NOTE_A);
              yield* harness.server.setEpoch(AuthorizationEpoch.make(1));
            }
            return page;
          }),
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "A", body: "" }),
          operationId("op-remote-a"),
        );
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-b"),
        );

        const engine = yield* openEngine("client-a", { pageSize: 1 });
        const receipt = yield* engine.sync;

        expect(receipt.outcome).toBe("bootstrapped");
        expect(receipt.authorizationEpoch).toBe(1);
        // Only what the final epoch delivered survives. Keeping page one would have left a row the
        // actor cannot read under a checkpoint claiming the new epoch, which every later drain
        // would then agree with — the row would never be purged.
        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)).toBeNull();
        expect(confirmedNote(state, NOTE_B)?.title).toBe("B");
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.entities.map((entity) => entity.entityId)).toEqual([NOTE_B]);
        expect(stored.checkpoint?.authorizationEpoch).toBe(1);
        expect(stored.checkpoint?.bootstrapped).toBe(true);
        // The restart went back to the first page rather than resuming the abandoned pagination.
        expect(yield* Ref.get(cursors)).toEqual([null, "1", null]);
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("shows nothing from a seed that was interrupted before it finished", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // What a crash between two bootstrap pages leaves on disk: page one's rows, under a
      // checkpoint that says the snapshot is not whole. Half a seed is not a replica — it may be
      // half of two, filtered under permissions that no longer hold — so it must not be shown.
      yield* harness.store.service.commit(COMPANY_ID, {
        resetEntities: true,
        upsertEntities: [
          {
            entityKind: "issue",
            entityId: NOTE_A,
            version: CompanyVersion.make(0),
            payload: { id: NOTE_A, title: "A", body: "", tags: [], orderKey: "a0" },
          },
        ],
        checkpoint: {
          schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
          companyId: COMPANY_ID,
          cursor: CompanyVersion.make(0),
          authorizationEpoch: AuthorizationEpoch.make(0),
          bootstrapped: false,
        },
      });

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        const cold = yield* SubscriptionRef.get(engine.state);
        expect(cold.bootstrapped).toBe(false);
        expect(cold.confirmed.size).toBe(0);
        expect(cold.view.size).toBe(0);

        // The seed that follows is the only thing that puts rows back, and it puts back the
        // server's — the abandoned row is not among them.
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-b"),
        );
        expect((yield* engine.sync).outcome).toBe("bootstrapped");
        const seeded = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(seeded, NOTE_A)).toBeNull();
        expect(confirmedNote(seeded, NOTE_B)?.title).toBe("B");
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.entities.map((row) => row.entityId)).toEqual([NOTE_B]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("gives up on a bootstrap whose epoch keeps moving, and keeps nothing from it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const calls = yield* Ref.make(0);
      const flapping = yield* Ref.make(true);
      // A deployment whose epoch moves under every page: no attempt can ever agree with itself, so
      // restarting without a cap would spin here forever with the cycle lock held.
      const transport = SyncTransport.of({
        ...harness.server.transport,
        bootstrap: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (count) => count + 1);
            const page = yield* harness.server.transport.bootstrap(input);
            if ((yield* Ref.get(flapping)) && !page.isDone) {
              yield* harness.server.setEpoch(AuthorizationEpoch.make(page.authorizationEpoch + 1));
            }
            return page;
          }),
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "A", body: "" }),
          operationId("op-remote-a"),
        );
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-b"),
        );

        const engine = yield* openEngine("client-a", { pageSize: 1 });
        const receipt = yield* engine.sync;

        // Reported as retryable transport trouble, which is what the engine's own backoff owns.
        expect(receipt.outcome).toBe("offline");
        expect(receipt.error?.reason).toBe("transport");
        expect(receipt.error?.message).toContain("authorization epoch changed");
        // Two pages per attempt, and no attempt beyond the cap.
        expect(yield* Ref.get(calls)).toBe(SYNC_BOOTSTRAP_MAX_ATTEMPTS * 2);

        const abandoned = yield* SubscriptionRef.get(engine.state);
        expect(abandoned.confirmed.size).toBe(0);
        expect(abandoned.presentation.status).toBe("offline");
        // The half-seeds are gone rather than left behind as the mixed-epoch replica this path
        // exists to prevent, and the checkpoint says so, so the next cycle seeds again.
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.entities).toEqual([]);
        expect(stored.checkpoint?.bootstrapped).toBe(false);

        yield* Ref.set(flapping, false);
        const settled = yield* engine.sync;
        expect(settled.outcome).toBe("bootstrapped");
        const live = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(live, NOTE_A)?.title).toBe("A");
        expect(confirmedNote(live, NOTE_B)?.title).toBe("B");
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("advances the cursor when authorization filtering empties a page", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ visible: (note) => !note.title.startsWith("secret") });

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create-a"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.sync;

        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "secret-b", body: "" }),
          operationId("op-remote-secret"),
        );
        const receipt = yield* engine.sync;

        expect(receipt.appliedChanges).toBe(0);
        // Cursor still moved, so the same invisible range is never re-read.
        expect(receipt.cursor).toBe((yield* harness.server.head).version);
        expect(confirmedNote(yield* SubscriptionRef.get(engine.state), NOTE_B)).toBeNull();
        expect((yield* harness.store.snapshot(COMPANY_ID)).checkpoint?.cursor).toBe(receipt.cursor);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("syncs whenever the subscribed company head moves", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        const driver = yield* Effect.forkChild(engine.run);

        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "from-another-client", body: "" }),
          operationId("op-remote-create"),
        );
        const arrived = yield* SubscriptionRef.changes(engine.state).pipe(
          Stream.filter((state) => confirmedNote(state, NOTE_A) !== null),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        expect(confirmedNote(arrived, NOTE_A)?.title).toBe("from-another-client");
        yield* Fiber.interrupt(driver);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("syncs an enqueue while running without waiting for the remote head to move", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // This feed deliberately never announces anything. The only event capable of starting a
      // cycle is the local enqueue wakeup; once that cycle applies the operation, its own server
      // write still cannot feed back through this stream.
      const transport = SyncTransport.of({
        ...harness.server.transport,
        latestVersion: () => Stream.never,
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.sync;
        const headBeforeEnqueue = yield* harness.server.head;
        const driver = yield* Effect.forkChild(engine.run, { startImmediately: true });
        yield* Effect.yieldNow;

        yield* engine.enqueue({
          operationId: operationId("op-local-create"),
          operation: createNote({ id: NOTE_A, title: "from-this-client", body: "" }),
        });
        const flushed = yield* SubscriptionRef.changes(engine.state).pipe(
          Stream.filter(
            (state) => confirmedNote(state, NOTE_A) !== null && state.pending.length === 0,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        expect(confirmedNote(flushed, NOTE_A)?.title).toBe("from-this-client");
        expect((yield* harness.server.submissions).get(operationId("op-local-create"))).toBe(1);
        expect((yield* harness.server.head).version).toBeGreaterThan(headBeforeEnqueue.version);
        yield* Fiber.interrupt(driver);
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("re-arms a cycle that failed, without waiting for the head to move again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        // The change is on the server *before* the engine subscribes, so the one head the stream
        // announces is the head the failing cycle already saw. Nothing will announce it again: a
        // transport only reports a version that moved, and on a quiet company it never does.
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "from-another-client", body: "" }),
          operationId("op-remote-create"),
        );
        const head = yield* harness.server.head;
        yield* harness.server.setOffline(true);

        const engine = yield* openEngine("client-a");
        const driver = yield* Effect.forkChild(engine.run);
        const failed = yield* SubscriptionRef.changes(engine.state).pipe(
          Stream.filter((state) => state.lastError !== null),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(failed.presentation.status).toBe("offline");
        expect(confirmedNote(failed, NOTE_A)).toBeNull();

        // The blip is over, but the head is exactly where it was when the cycle died.
        yield* harness.server.setOffline(false);
        yield* TestClock.adjust(SYNC_RETRY_MIN_DELAY);
        const recovered = yield* SubscriptionRef.changes(engine.state).pipe(
          Stream.filter((state) => confirmedNote(state, NOTE_A) !== null),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        expect(confirmedNote(recovered, NOTE_A)?.title).toBe("from-another-client");
        expect(recovered.presentation.status).toBe("live");
        // The retry brought the replica forward, not a new version: the head never moved.
        expect(yield* harness.server.head).toEqual(head);
        yield* Fiber.interrupt(driver);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("keeps a lost rejection a rejection when the operation is resent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reject: (operation) =>
          operation._tag === "SetNoteFields" && operation.title === "denied"
            ? { code: "permission-denied", message: "You cannot rename this note." }
            : null,
      });

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        yield* engine.sync;

        yield* engine.enqueue({
          operationId: operationId("op-denied"),
          operation: { _tag: "SetNoteFields", id: NOTE_A, title: "denied" },
        });
        // The server refuses it and records that refusal, then the answer is lost on the way back.
        yield* harness.server.setDropAcks(true);
        expect((yield* engine.sync).outcome).toBe("offline");
        const lost = yield* SubscriptionRef.get(engine.state);
        expect(lost.rejected).toEqual([]);
        expect(viewNote(lost, NOTE_A)?.title).toBe("denied");

        // The resend replays the stored receipt. It is a duplicate *and* a rejection, and the
        // rejection is what matters: laundering it into an accepted duplicate would keep an edit
        // the server never applied.
        yield* harness.server.setDropAcks(false);
        const resent = yield* engine.sync;
        expect(resent.rejectedOperations).toBe(1);
        expect(resent.acceptedOperations).toBe(0);
        expect((yield* harness.server.submissions).get(operationId("op-denied"))).toBe(2);

        const state = yield* SubscriptionRef.get(engine.state);
        expect(state.rejected).toHaveLength(1);
        expect(state.rejected[0]?.code).toBe("permission-denied");
        expect(state.rejected[0]?.operation.operationId).toBe(operationId("op-denied"));
        // Rolled back, not acknowledged, and gone from the outbox rather than resent forever.
        expect(viewNote(state, NOTE_A)?.title).toBe("A");
        expect(state.pending).toEqual([]);
        expect((yield* harness.store.snapshot(COMPANY_ID)).outbox).toEqual([]);
        expect(state.presentation.rejectedCount).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("quarantines an unreadable outbox row instead of deleting it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const unreadable = operationId("op-from-a-newer-build");
      const args = { _tag: "TeleportNote", id: NOTE_A, destination: "somewhere-new" };
      const envelope: SyncOperationEnvelope = {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operationId: unreadable,
        companyId: COMPANY_ID,
        clientId: SyncClientId.make("client-a"),
        environmentId: null,
        actor: ACTOR,
        localSequence: LocalSequence.make(7),
        baseVersion: CompanyVersion.make(0),
        entityId: NOTE_A,
        dependsOn: [],
        kind: "issue.update",
        args,
      };
      // A newer build wrote an operation this one has no reducer for.
      yield* harness.store.service.commit(COMPANY_ID, {
        upsertOutbox: [{ envelope, status: { _tag: "Pending" } }],
      });

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        const state = yield* SubscriptionRef.get(engine.state);
        // Out of the send path and out of the overlay, but still here, arguments and all.
        expect(state.pending).toEqual([]);
        expect(state.quarantined).toHaveLength(1);
        expect(state.quarantined[0]?.envelope.args).toEqual(args);
        expect(state.quarantined[0]?.reason).toContain("test-notes");

        const afterStart = yield* harness.store.snapshot(COMPANY_ID);
        expect(afterStart.outbox).toEqual([]);
        expect(afterStart.quarantined).toHaveLength(1);
        expect(afterStart.quarantined[0]?.envelope.operationId).toBe(unreadable);

        yield* engine.sync;
        expect((yield* harness.server.submissions).get(unreadable)).toBeUndefined();

        // Survives a restart: this build still cannot read it, and still must not lose it.
        const restarted = yield* openEngine("client-a");
        const reopened = yield* SubscriptionRef.get(restarted.state);
        expect(reopened.quarantined).toHaveLength(1);
        expect(reopened.quarantined[0]?.envelope.args).toEqual(args);

        // And an explicit discard is the only thing that removes it.
        yield* restarted.discardQuarantined([unreadable]);
        expect((yield* SubscriptionRef.get(restarted.state)).quarantined).toEqual([]);
        expect((yield* harness.store.snapshot(COMPANY_ID)).quarantined).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("reseeds when only the drain after the flush sees the epoch move", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const shifting = yield* Ref.make(false);
      // A membership change that lands while our own batch is in flight: the first drain of the
      // cycle read the old epoch, so only the confirming drain can notice.
      const transport = SyncTransport.of({
        ...harness.server.transport,
        applyOperations: (input) =>
          harness.server.transport.applyOperations(input).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (!(yield* Ref.get(shifting))) return;
                yield* Ref.set(shifting, false);
                yield* harness.server.setVisibility((note) => note.id !== NOTE_B);
                yield* harness.server.setEpoch(AuthorizationEpoch.make(1));
              }),
            ),
          ),
      });
      const layer = Layer.mergeAll(
        Layer.succeed(SyncStore, harness.store.service),
        Layer.succeed(SyncTransport, transport),
      );

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "A", body: "" }),
          operationId("op-remote-a"),
        );
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-b"),
        );
        yield* engine.sync;
        expect((yield* SubscriptionRef.get(engine.state)).confirmed.size).toBe(2);

        yield* Ref.set(shifting, true);
        yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        const receipt = yield* engine.sync;

        expect(receipt.outcome).toBe("reseeded");
        expect(receipt.authorizationEpoch).toBe(1);
        const state = yield* SubscriptionRef.get(engine.state);
        expect(state.authorizationEpoch).toBe(1);
        // The purge actually happened rather than being reported as a live sync.
        expect(confirmedNote(state, NOTE_B)).toBeNull();
        expect(confirmedNote(state, NOTE_A)?.tags).toEqual(["urgent"]);
        const stored = yield* harness.store.snapshot(COMPANY_ID);
        expect(stored.checkpoint?.authorizationEpoch).toBe(1);
        expect(stored.entities.map((entity) => entity.entityId)).toEqual([NOTE_A]);
      }).pipe(Effect.provide(layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("clamps a caller's zero page and batch size instead of draining forever", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        // A page size of 0 asks the feed for empty pages: the cursor cannot advance, `hasMore`
        // stays true, and an unclamped drain never returns.
        const engine = yield* openEngine("client-a", { pageSize: 0, batchSize: 0 });
        yield* harness.server.applyExternal(
          createNote({ id: NOTE_A, title: "A", body: "" }),
          operationId("op-remote-a"),
        );
        yield* engine.sync;

        yield* harness.server.applyExternal(
          createNote({ id: NOTE_B, title: "B", body: "" }),
          operationId("op-remote-b"),
        );
        yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        const receipt = yield* engine.sync;

        expect(receipt.acceptedOperations).toBe(1);
        const state = yield* SubscriptionRef.get(engine.state);
        expect(confirmedNote(state, NOTE_A)?.title).toBe("A");
        expect(confirmedNote(state, NOTE_B)?.title).toBe("B");
        expect(state.pending).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("never reuses a local sequence a pruned operation already had", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        const first = yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        expect(first.localSequence).toBe(1);

        yield* engine.sync;
        // Accepted and confirmed, so the row that held sequence 1 is gone from the outbox.
        expect((yield* harness.store.snapshot(COMPANY_ID)).outbox).toEqual([]);

        const second = yield* engine.enqueue({
          operationId: operationId("op-tag"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "urgent" },
        });
        expect(second.localSequence).toBe(2);

        yield* engine.sync;
        // A restart reads the mark from the document, not from the rows that are left.
        const restarted = yield* openEngine("client-a");
        const third = yield* restarted.enqueue({
          operationId: operationId("op-tag-again"),
          operation: { _tag: "AppendNoteTag", id: NOTE_A, tag: "later" },
        });
        expect(third.localSequence).toBe(3);
        expect((yield* harness.store.snapshot(COMPANY_ID)).localSequenceHighWater).toBe(3);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );
});

describe("clampSyncBound", () => {
  it("takes the maximum when the caller has no preference", () => {
    expect(clampSyncBound(undefined, SYNC_MAX_CHANGES_PER_PAGE)).toBe(SYNC_MAX_CHANGES_PER_PAGE);
    expect(clampSyncBound(Number.NaN, SYNC_MAX_CHANGES_PER_PAGE)).toBe(SYNC_MAX_CHANGES_PER_PAGE);
    expect(clampSyncBound(Number.POSITIVE_INFINITY, 100)).toBe(100);
  });

  it("keeps every other answer inside 1..max", () => {
    expect(clampSyncBound(0, 100)).toBe(1);
    expect(clampSyncBound(-5, 100)).toBe(1);
    expect(clampSyncBound(0.5, 100)).toBe(1);
    expect(clampSyncBound(10.9, 100)).toBe(10);
    expect(clampSyncBound(1000, 100)).toBe(100);
    expect(clampSyncBound(25, 100)).toBe(25);
  });
});
