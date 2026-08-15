import { describe, expect, it } from "@effect/vitest";
import {
  AuthorizationEpoch,
  CompanyVersion,
  SyncEntityId,
  type SyncChangeEnvelope,
} from "@spiritdevs/contracts/cloudSync";

import { syncEntityKey } from "./model.ts";
import { applyConfirmedChanges, emptyConfirmedReplica } from "./replica.ts";
import {
  testNoteAdapter,
  testNoteKey,
  type TestNote,
  type TestNoteOperation,
} from "./testDomain.ts";

const NOTE_ID = SyncEntityId.make("legacy-note");

const change = (version: number, title: string): SyncChangeEnvelope => ({
  version: CompanyVersion.make(version),
  entityKind: "issue",
  entityId: NOTE_ID,
  changeKind: "upsert",
  payload: { id: NOTE_ID, title, body: "", tags: [], orderKey: "a0" },
});

describe("applyConfirmedChanges", () => {
  it("folds version-0 seed rows and lets the last same-version delivery win", () => {
    const result = applyConfirmedChanges<TestNote, TestNoteOperation>({
      replica: emptyConfirmedReplica<TestNote>({
        cursor: CompanyVersion.make(0),
        authorizationEpoch: AuthorizationEpoch.make(0),
      }),
      adapter: testNoteAdapter,
      changes: [change(0, "first"), change(0, "last")],
      cursor: CompanyVersion.make(7),
      authorizationEpoch: AuthorizationEpoch.make(0),
      mode: "seed",
    });

    expect(result.replica.entities.get(syncEntityKey(testNoteKey(NOTE_ID)))?.entity.title).toBe(
      "last",
    );
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.version).toBe(0);
  });

  it("still suppresses a drained change at or below the replica cursor", () => {
    const seeded = applyConfirmedChanges<TestNote, TestNoteOperation>({
      replica: emptyConfirmedReplica<TestNote>({
        cursor: CompanyVersion.make(0),
        authorizationEpoch: AuthorizationEpoch.make(0),
      }),
      adapter: testNoteAdapter,
      changes: [change(5, "confirmed")],
      cursor: CompanyVersion.make(5),
      authorizationEpoch: AuthorizationEpoch.make(0),
      mode: "seed",
    }).replica;

    const drained = applyConfirmedChanges<TestNote, TestNoteOperation>({
      replica: seeded,
      adapter: testNoteAdapter,
      changes: [change(5, "redelivered")],
      cursor: CompanyVersion.make(5),
      authorizationEpoch: AuthorizationEpoch.make(0),
    });

    expect(drained.replica.entities.get(syncEntityKey(testNoteKey(NOTE_ID)))?.entity.title).toBe(
      "confirmed",
    );
    expect(drained.upserts).toEqual([]);
  });

  it("keeps a higher-version tombstone across seed pages", () => {
    const firstPage = applyConfirmedChanges<TestNote, TestNoteOperation>({
      replica: emptyConfirmedReplica<TestNote>({
        cursor: CompanyVersion.make(0),
        authorizationEpoch: AuthorizationEpoch.make(0),
      }),
      adapter: testNoteAdapter,
      changes: [
        change(0, "legacy"),
        { ...change(5, "deleted"), changeKind: "tombstone", payload: null },
      ],
      cursor: CompanyVersion.make(0),
      authorizationEpoch: AuthorizationEpoch.make(0),
      mode: "seed",
    });
    const secondPage = applyConfirmedChanges<TestNote, TestNoteOperation>({
      replica: firstPage.replica,
      adapter: testNoteAdapter,
      changes: [change(4, "stale delivery")],
      cursor: CompanyVersion.make(5),
      authorizationEpoch: AuthorizationEpoch.make(0),
      mode: "seed",
    });

    expect(secondPage.replica.entities.has(syncEntityKey(testNoteKey(NOTE_ID)))).toBe(false);
    expect(secondPage.upserts).toEqual([]);
  });
});
