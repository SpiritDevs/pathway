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
} from "@t3tools/contracts/cloudSync";
import { CompanyId, MembershipId } from "@t3tools/contracts/company";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { CloudSyncCapability } from "./capability.ts";
import { clampSyncBound, makeSyncEngine, type SyncEngineState } from "./engine.ts";
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
  it.effect("does nothing at all while the cloud sync capability is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: operationId("op-create"),
          operation: createNote({ id: NOTE_A, title: "A", body: "" }),
        });
        const receipt = yield* engine.sync;
        yield* engine.run;

        expect(receipt.outcome).toBe("disabled");
        expect(yield* harness.server.submissions).toEqual(new Map());
        // The optimistic overlay is local-only, so the row is still there for the user.
        expect(viewNote(yield* SubscriptionRef.get(engine.state), NOTE_A)?.title).toBe("A");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

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
