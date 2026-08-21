import { describe, expect, it } from "@effect/vitest";
import {
  makeMemorySyncStore,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  SyncStore,
  type MemorySyncStore,
} from "@spiritdevs/client-runtime/sync";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";

import {
  clearCloudSyncNamespaceKeys,
  clearCloudSyncReset,
  cloudSyncResetMarkerKey,
  markCloudSyncReset,
  readCloudSyncReset,
  type SyncResetStorage,
} from "./syncReset";
import { discardCloudSyncLocalReplicaIfResetPending } from "./syncRuntime";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const SCOPE = "user_123";

const makeFakeStorage = (
  initial: Record<string, string> = {},
): SyncResetStorage & { readonly entries: Map<string, string> } => {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    get length() {
      return entries.size;
    },
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

describe("cloud sync reset marker", () => {
  it("round-trips per scope", () => {
    const storage = makeFakeStorage();
    expect(readCloudSyncReset(SCOPE, storage)).toBe(false);
    markCloudSyncReset(SCOPE, storage);
    expect(readCloudSyncReset(SCOPE, storage)).toBe(true);
    expect(readCloudSyncReset("user_456", storage)).toBe(false);
    clearCloudSyncReset(SCOPE, storage);
    expect(readCloudSyncReset(SCOPE, storage)).toBe(false);
  });

  it("degrades to no reset when storage is unavailable", () => {
    markCloudSyncReset(SCOPE, null);
    expect(readCloudSyncReset(SCOPE, null)).toBe(false);
    clearCloudSyncReset(SCOPE, null);
  });
});

describe("clearCloudSyncNamespaceKeys", () => {
  it("removes every key in the scope namespace and nothing else", () => {
    const storage = makeFakeStorage({
      [cloudSyncResetMarkerKey(SCOPE)]: "pending",
      [`pathway:cloud-sync/${SCOPE}/client-id`]: "client-1",
      [`pathway:cloud-sync/${SCOPE}/active-company-id`]: COMPANY_A,
      "pathway:cloud-sync/user_456/client-id": "client-2",
      "pathway:theme": "dark",
    });
    expect(clearCloudSyncNamespaceKeys(SCOPE, storage)).toBe(2);
    expect(storage.entries.has(`pathway:cloud-sync/${SCOPE}/client-id`)).toBe(false);
    expect(storage.entries.has(`pathway:cloud-sync/${SCOPE}/active-company-id`)).toBe(false);
    // The marker survives: it outlives the wipe it asked for until the runtime consumes it.
    expect(storage.entries.get(cloudSyncResetMarkerKey(SCOPE))).toBe("pending");
    expect(storage.entries.get("pathway:cloud-sync/user_456/client-id")).toBe("client-2");
    expect(storage.entries.get("pathway:theme")).toBe("dark");
  });
});

describe("discardCloudSyncLocalReplicaIfResetPending", () => {
  const seedReplica = (store: MemorySyncStore, companyId: CompanyId) =>
    store.service.commit(companyId, {
      upsertEntities: [
        {
          entityKind: "issue",
          entityId: SyncEntityId.make(`issue-${companyId}`),
          version: CompanyVersion.make(3),
          payload: { id: `issue-${companyId}`, title: "kept on the server" },
        },
      ],
      checkpoint: {
        schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
        bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
        companyId,
        cursor: CompanyVersion.make(30),
        authorizationEpoch: AuthorizationEpoch.make(0),
        bootstrapped: true,
      },
    });

  it.effect("leaves the replica alone when sign-out marked no reset", () =>
    Effect.gen(function* () {
      const store = yield* makeMemorySyncStore();
      yield* seedReplica(store, COMPANY_A);
      const storage = makeFakeStorage();

      yield* discardCloudSyncLocalReplicaIfResetPending(SCOPE, storage).pipe(
        Effect.provideService(SyncStore, store.service),
      );

      expect(yield* store.service.listCompanyIds).toEqual([COMPANY_A]);
      expect(readCloudSyncReset(SCOPE, storage)).toBe(false);
    }),
  );

  it.effect("discards every replica and scoped key, then clears the marker", () =>
    Effect.gen(function* () {
      const store = yield* makeMemorySyncStore();
      yield* Effect.all([seedReplica(store, COMPANY_A), seedReplica(store, COMPANY_B)], {
        discard: true,
      });
      yield* store.service.commit(COMPANY_A, {
        upsertOutbox: [
          {
            envelope: {
              protocolVersion: SYNC_PROTOCOL_VERSION,
              operationId: SyncOperationId.make(`op-${COMPANY_A}`),
              companyId: COMPANY_A,
              clientId: SyncClientId.make("client-1"),
              environmentId: null,
              actor: { kind: "member", membershipId: MembershipId.make("membership-a") },
              localSequence: LocalSequence.make(1),
              baseVersion: CompanyVersion.make(0),
              entityId: SyncEntityId.make(`issue-${COMPANY_A}`),
              dependsOn: [],
              kind: "issue.create",
              args: { title: "offline draft" },
            },
            status: { _tag: "Pending" },
          },
        ],
        localSequenceHighWater: LocalSequence.make(1),
      });
      const storage = makeFakeStorage({
        [cloudSyncResetMarkerKey(SCOPE)]: "pending",
        [`pathway:cloud-sync/${SCOPE}/client-id`]: "client-1",
        "pathway:cloud-sync/user_456/client-id": "client-2",
      });

      yield* discardCloudSyncLocalReplicaIfResetPending(SCOPE, storage).pipe(
        Effect.provideService(SyncStore, store.service),
      );

      expect(yield* store.service.listCompanyIds).toEqual([]);
      expect((yield* store.snapshot(COMPANY_A)).entities).toEqual([]);
      expect((yield* store.snapshot(COMPANY_A)).outbox).toEqual([]);
      expect((yield* store.snapshot(COMPANY_A)).checkpoint).toBeNull();
      expect(readCloudSyncReset(SCOPE, storage)).toBe(false);
      expect(storage.entries.has(`pathway:cloud-sync/${SCOPE}/client-id`)).toBe(false);
      expect(storage.entries.get("pathway:cloud-sync/user_456/client-id")).toBe("client-2");
    }),
  );
});
