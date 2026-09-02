import { describe, expect, it } from "@effect/vitest";
import {
  CompanyVersion,
  SYNC_ENTITY_KINDS,
  SyncEntityId,
  type SyncChangeEnvelope,
  type SyncEntityKind,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";

import {
  CALENDAR_SYNC_ENTITY_KINDS,
  calendarEntityCodec,
  calendarSyncTombstoneCascade,
  isCalendarSyncEntityKind,
  type CalendarSyncEntity,
  type CalendarSyncEntityKind,
} from "./calendarDomain.ts";
import {
  EMPTY_SYNCED_CALENDAR,
  calendarEventsByCalendar,
  syncedCalendarFromEntities,
  syncedCalendarFromReplica,
} from "./calendarReadModel.ts";
import { COMPANY_SYNC_ENTITY_KINDS } from "./companyDomain.ts";
import {
  ISSUE_SYNC_ENTITY_KINDS,
  cloudEntityCodec,
  issueSyncDomainAdapter,
  type CloudSyncEntity,
} from "./issueDomain.ts";
import { SYNC_INITIAL_EPOCH, syncEntityKey } from "./model.ts";
import { applyConfirmedChanges, emptyConfirmedReplica } from "./replica.ts";

const MEMBERSHIP_ID = "0191f0a0-0000-7000-8000-0000000000m1";
const ACCOUNT_ID = "0191f0a0-0000-7000-8000-0000000000n1";
const OTHER_ACCOUNT_ID = "0191f0a0-0000-7000-8000-0000000000n2";
const CALENDAR_ID = "0191f0a0-0000-7000-8000-0000000000k1";
const OTHER_CALENDAR_ID = "0191f0a0-0000-7000-8000-0000000000k2";
const EVENT_ID = "0191f0a0-0000-7000-8000-0000000000v1";
const OTHER_EVENT_ID = "0191f0a0-0000-7000-8000-0000000000v2";
const LINK_ID = "0191f0a0-0000-7000-8000-0000000000l1";
const ISSUE_ID = "0191f0a0-0000-7000-8000-0000000000i1";
const TEAM_ID = "0191f0a0-0000-7000-8000-0000000000t1";

/**
 * One representative payload per kind, exactly as Convex appends it: no `companyId`, no `version`,
 * no `deletedAt`. The nullable fields are exercised in both directions across the set — the
 * calendar here is a mirror, so `teamId` is null while `accountId` and `googleCalendarId` are set —
 * so a schema that accidentally required or forbade one would fail on this table alone.
 */
const ENTITY_PAYLOADS: Record<CalendarSyncEntityKind, Record<string, unknown>> = {
  calendarAccount: {
    id: ACCOUNT_ID,
    ownerMembershipId: MEMBERSHIP_ID,
    provider: "google",
    providerAccountId: "108844",
    email: "darren@spiritdevs.com",
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
  },
  calendar: {
    id: CALENDAR_ID,
    ownerMembershipId: MEMBERSHIP_ID,
    name: "Darren — Work",
    sharing: "private",
    teamId: null,
    kind: "google",
    accountId: ACCOUNT_ID,
    googleCalendarId: "darren@spiritdevs.com",
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
  },
  calendarEvent: {
    id: EVENT_ID,
    calendarId: CALENDAR_ID,
    ownerMembershipId: MEMBERSHIP_ID,
    title: "Design review",
    startAt: 1_760_003_600_000,
    endAt: 1_760_007_200_000,
    timeZone: "Europe/London",
    allDay: false,
    notes: "",
    reminderMinutes: [],
    urls: [],
    location: null,
    invitees: [],
    attachments: [],
    visibility: "default",
    googleEventId: "abc123",
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
  },
  calendarEventLink: {
    id: LINK_ID,
    issueId: ISSUE_ID,
    googleEventId: "abc123",
    createdByMembershipId: MEMBERSHIP_ID,
    createdAt: 1_760_000_000_000,
  },
};

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

describe("calendar entity kinds", () => {
  it("covers the protocol's four calendar tables and nothing else", () => {
    expect([...CALENDAR_SYNC_ENTITY_KINDS].sort()).toEqual(
      ["calendar", "calendarAccount", "calendarEvent", "calendarEventLink"].sort(),
    );
    for (const kind of CALENDAR_SYNC_ENTITY_KINDS) {
      expect(SYNC_ENTITY_KINDS).toContain(kind);
    }
  });

  it("does not replicate grants: authorization input never becomes a replica row", () => {
    expect(SYNC_ENTITY_KINDS).not.toContain("calendarGrant");
    expect(isCalendarSyncEntityKind("calendarGrant")).toBe(false);
  });

  it("is disjoint from the issue and company domains, so the dispatch cannot be ambiguous", () => {
    for (const kind of ISSUE_SYNC_ENTITY_KINDS) expect(isCalendarSyncEntityKind(kind)).toBe(false);
    for (const kind of COMPANY_SYNC_ENTITY_KINDS) {
      expect(isCalendarSyncEntityKind(kind)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Entity codecs
// ---------------------------------------------------------------------------

describe("calendar entity codecs", () => {
  it.each([...CALENDAR_SYNC_ENTITY_KINDS])("round-trips a %s payload", (kind) => {
    const codec = calendarEntityCodec(kind);
    expect(codec).not.toBeNull();
    const decoded = codec?.decode(ENTITY_PAYLOADS[kind]);
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    const entity = Option.getOrThrow(decoded ?? Option.none<CalendarSyncEntity>());
    expect(entity.entityKind).toBe(kind);
    // The tag is local; what goes back out is the payload the server would have sent.
    expect(codec?.encode(entity)).toEqual(ENTITY_PAYLOADS[kind]);
  });

  it("takes a Pathway-owned calendar, whose account and Google id are both absent", () => {
    const decoded = calendarEntityCodec("calendar")?.decode({
      ...ENTITY_PAYLOADS["calendar"],
      sharing: "team",
      teamId: TEAM_ID,
      kind: "pathway",
      accountId: null,
      googleCalendarId: null,
    });
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
  });

  it("quarantines an event with no time zone rather than guessing one", () => {
    const decoded = calendarEntityCodec("calendarEvent")?.decode({
      ...ENTITY_PAYLOADS["calendarEvent"],
      timeZone: "",
    });
    expect(decoded !== undefined && Option.isNone(decoded)).toBe(true);
  });

  it("answers null for a kind it does not own, and is reachable through the union codec", () => {
    expect(calendarEntityCodec("issue" satisfies SyncEntityKind)).toBeNull();
    for (const kind of SYNC_ENTITY_KINDS) {
      const expected = isCalendarSyncEntityKind(kind) ? "codec" : "none";
      expect(calendarEntityCodec(kind) === null ? "none" : "codec").toBe(expected);
      // Whatever the calendar domain reads, the engine's own dispatch reads too.
      if (expected === "codec") expect(cloudEntityCodec(kind)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The confirmed replica and the ADR 0013 cascade
// ---------------------------------------------------------------------------

const upsert = (
  entityKind: SyncEntityKind,
  entityId: string,
  version: number,
): SyncChangeEnvelope =>
  ({
    version: CompanyVersion.make(version),
    entityKind,
    entityId: SyncEntityId.make(entityId),
    changeKind: "upsert",
    payload: {
      ...ENTITY_PAYLOADS[entityKind as CalendarSyncEntityKind],
      id: entityId,
    },
  }) satisfies SyncChangeEnvelope;

const eventUpsert = (
  entityId: string,
  calendarId: string,
  version: number,
): SyncChangeEnvelope => ({
  version: CompanyVersion.make(version),
  entityKind: "calendarEvent",
  entityId: SyncEntityId.make(entityId),
  changeKind: "upsert",
  payload: { ...ENTITY_PAYLOADS["calendarEvent"], id: entityId, calendarId },
});

const calendarUpsert = (
  entityId: string,
  accountId: string | null,
  version: number,
): SyncChangeEnvelope => ({
  version: CompanyVersion.make(version),
  entityKind: "calendar",
  entityId: SyncEntityId.make(entityId),
  changeKind: "upsert",
  payload: {
    ...ENTITY_PAYLOADS["calendar"],
    id: entityId,
    accountId,
    kind: accountId === null ? "pathway" : "google",
    googleCalendarId: accountId === null ? null : "darren@spiritdevs.com",
  },
});

const tombstone = (
  entityKind: SyncEntityKind,
  entityId: string,
  version: number,
): SyncChangeEnvelope => ({
  version: CompanyVersion.make(version),
  entityKind,
  entityId: SyncEntityId.make(entityId),
  changeKind: "tombstone",
  payload: null,
});

/** The whole replica, seeded and then drained, through the adapter the app actually wires in. */
function fold(seed: ReadonlyArray<SyncChangeEnvelope>, drain: ReadonlyArray<SyncChangeEnvelope>) {
  const seeded = applyConfirmedChanges({
    replica: emptyConfirmedReplica<CloudSyncEntity>({
      cursor: CompanyVersion.make(0),
      authorizationEpoch: SYNC_INITIAL_EPOCH,
    }),
    adapter: issueSyncDomainAdapter,
    changes: seed,
    cursor: CompanyVersion.make(seed.length),
    authorizationEpoch: SYNC_INITIAL_EPOCH,
  });
  return applyConfirmedChanges({
    replica: seeded.replica,
    adapter: issueSyncDomainAdapter,
    changes: drain,
    cursor: CompanyVersion.make(seed.length + drain.length),
    authorizationEpoch: SYNC_INITIAL_EPOCH,
  });
}

const has = (result: ReturnType<typeof fold>, entityKind: SyncEntityKind, entityId: string) =>
  result.replica.entities.has(syncEntityKey({ entityKind, entityId: SyncEntityId.make(entityId) }));

const deletedKeys = (result: ReturnType<typeof fold>) =>
  result.deletes.map((key) => `${key.entityKind}:${key.entityId}`).sort();

describe("calendar rows on the confirmed replica", () => {
  it("applies the four kinds the feed emits", () => {
    const result = fold(
      [
        upsert("calendarAccount", ACCOUNT_ID, 1),
        upsert("calendar", CALENDAR_ID, 2),
        upsert("calendarEvent", EVENT_ID, 3),
        upsert("calendarEventLink", LINK_ID, 4),
      ],
      [],
    );
    expect(has(result, "calendarAccount", ACCOUNT_ID)).toBe(true);
    expect(has(result, "calendar", CALENDAR_ID)).toBe(true);
    expect(has(result, "calendarEvent", EVENT_ID)).toBe(true);
    expect(has(result, "calendarEventLink", LINK_ID)).toBe(true);
  });

  it("drops every event of a tombstoned calendar, and only that calendar's", () => {
    const result = fold(
      [
        calendarUpsert(CALENDAR_ID, null, 1),
        calendarUpsert(OTHER_CALENDAR_ID, null, 2),
        eventUpsert(EVENT_ID, CALENDAR_ID, 3),
        eventUpsert(OTHER_EVENT_ID, OTHER_CALENDAR_ID, 4),
      ],
      [tombstone("calendar", CALENDAR_ID, 5)],
    );

    expect(has(result, "calendar", CALENDAR_ID)).toBe(false);
    expect(has(result, "calendarEvent", EVENT_ID)).toBe(false);
    // The calendar next door is untouched: the cascade is keyed on `calendarId`, not on the kind.
    expect(has(result, "calendar", OTHER_CALENDAR_ID)).toBe(true);
    expect(has(result, "calendarEvent", OTHER_EVENT_ID)).toBe(true);
  });

  it("persists the cascade, so a restart does not resurrect what the revoke dropped", () => {
    const result = fold(
      [calendarUpsert(CALENDAR_ID, null, 1), eventUpsert(EVENT_ID, CALENDAR_ID, 2)],
      [tombstone("calendar", CALENDAR_ID, 3)],
    );
    expect(deletedKeys(result)).toEqual([`calendar:${CALENDAR_ID}`, `calendarEvent:${EVENT_ID}`]);
    expect(result.upserts).toEqual([]);
  });

  it("cascades two levels from a disconnected account: its calendars, then their events", () => {
    const result = fold(
      [
        upsert("calendarAccount", ACCOUNT_ID, 1),
        calendarUpsert(CALENDAR_ID, ACCOUNT_ID, 2),
        calendarUpsert(OTHER_CALENDAR_ID, OTHER_ACCOUNT_ID, 3),
        eventUpsert(EVENT_ID, CALENDAR_ID, 4),
        eventUpsert(OTHER_EVENT_ID, OTHER_CALENDAR_ID, 5),
      ],
      [tombstone("calendarAccount", ACCOUNT_ID, 6)],
    );

    expect(has(result, "calendarAccount", ACCOUNT_ID)).toBe(false);
    expect(has(result, "calendar", CALENDAR_ID)).toBe(false);
    expect(has(result, "calendarEvent", EVENT_ID)).toBe(false);
    expect(has(result, "calendar", OTHER_CALENDAR_ID)).toBe(true);
    expect(has(result, "calendarEvent", OTHER_EVENT_ID)).toBe(true);
  });

  it("keeps the issue link alive through both cascades: it names a Google id, not a row", () => {
    const result = fold(
      [
        upsert("calendarAccount", ACCOUNT_ID, 1),
        calendarUpsert(CALENDAR_ID, ACCOUNT_ID, 2),
        eventUpsert(EVENT_ID, CALENDAR_ID, 3),
        upsert("calendarEventLink", LINK_ID, 4),
      ],
      [tombstone("calendarAccount", ACCOUNT_ID, 5)],
    );
    expect(has(result, "calendarEvent", EVENT_ID)).toBe(false);
    expect(has(result, "calendarEventLink", LINK_ID)).toBe(true);
  });

  it("leaves issue rows alone: nothing outside the calendar domain cascades", () => {
    const issue: SyncChangeEnvelope = {
      version: CompanyVersion.make(1),
      entityKind: "issueMilestone",
      entityId: SyncEntityId.make("0191f0a0-0000-7000-8000-0000000000s1"),
      changeKind: "upsert",
      payload: {
        id: "0191f0a0-0000-7000-8000-0000000000s1",
        cloudProjectId: "0191f0a0-0000-7000-8000-0000000000p1",
        name: "Beta",
        description: null,
        startDate: null,
        targetDate: null,
        position: 0,
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_000_000,
      },
    };
    const result = fold(
      [issue, calendarUpsert(CALENDAR_ID, null, 2), eventUpsert(EVENT_ID, CALENDAR_ID, 3)],
      [tombstone("calendar", CALENDAR_ID, 4)],
    );
    expect(has(result, "issueMilestone", "0191f0a0-0000-7000-8000-0000000000s1")).toBe(true);
  });

  it("re-accepts an event after the calendar comes back, because a drop bumps no version", () => {
    const revoked = fold(
      [calendarUpsert(CALENDAR_ID, null, 1), eventUpsert(EVENT_ID, CALENDAR_ID, 2)],
      [tombstone("calendar", CALENDAR_ID, 3)],
    );
    const regranted = applyConfirmedChanges({
      replica: revoked.replica,
      adapter: issueSyncDomainAdapter,
      changes: [calendarUpsert(CALENDAR_ID, null, 4), eventUpsert(EVENT_ID, CALENDAR_ID, 5)],
      cursor: CompanyVersion.make(5),
      authorizationEpoch: SYNC_INITIAL_EPOCH,
    });
    expect(
      regranted.replica.entities.has(
        syncEntityKey({ entityKind: "calendarEvent", entityId: SyncEntityId.make(EVENT_ID) }),
      ),
    ).toBe(true);
  });
});

describe("calendarSyncTombstoneCascade", () => {
  it("answers null for every kind that takes nothing with it", () => {
    for (const entityKind of SYNC_ENTITY_KINDS) {
      if (entityKind === "calendar" || entityKind === "calendarAccount") continue;
      expect(
        calendarSyncTombstoneCascade({ entityKind, entityId: SyncEntityId.make(CALENDAR_ID) }),
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

describe("synced calendar read model", () => {
  const decode = (kind: CalendarSyncEntityKind, payload: Record<string, unknown>) =>
    Option.getOrThrow(
      calendarEntityCodec(kind)?.decode(payload) ?? Option.none<CalendarSyncEntity>(),
    );

  it("narrows the heterogeneous replica and orders events by start instant", () => {
    const later = decode("calendarEvent", {
      ...ENTITY_PAYLOADS["calendarEvent"],
      id: OTHER_EVENT_ID,
      startAt: 1_760_090_000_000,
    });
    const earlier = decode("calendarEvent", ENTITY_PAYLOADS["calendarEvent"]);
    const model = syncedCalendarFromEntities([
      later,
      decode("calendar", ENTITY_PAYLOADS["calendar"]),
      earlier,
      decode("calendarAccount", ENTITY_PAYLOADS["calendarAccount"]),
      decode("calendarEventLink", ENTITY_PAYLOADS["calendarEventLink"]),
      { entityKind: "issue", id: ISSUE_ID },
    ]);

    expect(model.calendarEvents.map((event) => event.id)).toEqual([EVENT_ID, OTHER_EVENT_ID]);
    expect(model.calendars).toHaveLength(1);
    expect(model.calendarAccounts).toHaveLength(1);
    expect(model.calendarEventLinks).toHaveLength(1);
  });

  it("reads an absent replica as empty rather than as a load failure", () => {
    expect(syncedCalendarFromReplica(null)).toBe(EMPTY_SYNCED_CALENDAR);
  });

  it("buckets events by the calendar the cascade is keyed on", () => {
    const mine = decode("calendarEvent", ENTITY_PAYLOADS["calendarEvent"]);
    const theirs = decode("calendarEvent", {
      ...ENTITY_PAYLOADS["calendarEvent"],
      id: OTHER_EVENT_ID,
      calendarId: OTHER_CALENDAR_ID,
    });
    const model = syncedCalendarFromEntities([mine, theirs]);
    const byCalendar = calendarEventsByCalendar(model.calendarEvents);
    const idsOn = (calendarId: string) =>
      [...byCalendar]
        .filter(([key]) => key === calendarId)
        .flatMap(([, held]) => held.map((event) => event.id));
    expect(idsOn(CALENDAR_ID)).toEqual([EVENT_ID]);
    expect(idsOn(OTHER_CALENDAR_ID)).toEqual([OTHER_EVENT_ID]);
  });
});
