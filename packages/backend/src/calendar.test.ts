// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/calendars.ts": () => import("../convex/calendars.ts"),
  "../convex/calendarAccounts.ts": () => import("../convex/calendarAccounts.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const ISSUER = "https://clerk.example.test";
const COMPANY = "company-calendar";
const PRIVATE_CALENDAR = "calendar-private";
const COMPANY_CALENDAR = "calendar-company";
const TEAM_CALENDAR = "calendar-team";
const PUBLIC_EVENT = "event-public";
const PRIVATE_EVENT = "event-private";
const TEAM = "team-calendar";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asUser(t: Harness, subject: string) {
  return t.withIdentity({
    issuer: ISSUER,
    subject,
    tokenIdentifier: `${ISSUER}|${subject}`,
    email: `${subject}@example.test`,
    name: subject,
  });
}

async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY,
      name: "Calendar Co",
      issueKeyPrefix: "CAL",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 7,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const member = async (subject: string) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: `membership-${subject}`,
        companyId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return membershipId;
    };

    const alice = await member("alice");
    const bob = await member("bob");
    const carol = await member("carol");
    const dave = await member("dave");
    const blind = await member("blind");
    await ctx.db.insert("companyOwners", {
      companyId,
      membershipId: alice,
      grantedByMembershipId: null,
      createdAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      id: TEAM,
      companyId,
      name: "Calendar Team",
      description: "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const role = async (id: string, permissions: string[]) =>
      await ctx.db.insert("roles", {
        id,
        companyId,
        name: id,
        description: "",
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
    const reader = await role("role-reader", ["calendar.read"]);
    const readerAll = await role("role-reader-all", ["calendar.read", "calendar.readAll"]);
    const noCalendar = await role("role-blind", []);
    const assignment = async (
      id: string,
      membershipId: typeof bob,
      roleId: typeof reader,
      scope: "company" | "team",
      teamDomainId: string | null,
    ) =>
      await ctx.db.insert("roleAssignments", {
        id,
        companyId,
        membershipId,
        roleId,
        scope,
        teamId: teamDomainId,
        createdAt: now,
      });
    await assignment("assignment-bob", bob, reader, "company", null);
    await assignment("assignment-carol", carol, readerAll, "company", null);
    await assignment("assignment-dave", dave, readerAll, "team", TEAM);
    await assignment("assignment-blind", blind, noCalendar, "company", null);

    return { companyId, alice, bob, carol, dave, blind, teamId };
  });
}

async function buildCalendarFixture(t: Harness) {
  const ids = await seed(t);
  const alice = asUser(t, "alice");
  await alice.mutation(api.calendars.create, {
    companyId: COMPANY,
    id: PRIVATE_CALENDAR,
    name: "Alice private",
    sharing: "private",
    teamId: null,
  });
  await alice.mutation(api.calendars.create, {
    companyId: COMPANY,
    id: COMPANY_CALENDAR,
    name: "Company",
    sharing: "company",
    teamId: null,
  });
  await alice.mutation(api.calendars.create, {
    companyId: COMPANY,
    id: TEAM_CALENDAR,
    name: "Team",
    sharing: "team",
    teamId: TEAM,
  });
  await alice.mutation(api.calendars.share, {
    companyId: COMPANY,
    id: "grant-bob",
    calendarId: PRIVATE_CALENDAR,
    granteeMembershipId: "membership-bob",
  });
  await alice.mutation(api.calendars.share, {
    companyId: COMPANY,
    id: "grant-blind",
    calendarId: PRIVATE_CALENDAR,
    granteeMembershipId: "membership-blind",
  });
  await alice.mutation(api.calendars.createEvent, {
    companyId: COMPANY,
    id: PUBLIC_EVENT,
    calendarId: PRIVATE_CALENDAR,
    title: "Shared details",
    startAt: 1_800_000_000_000,
    endAt: 1_800_003_600_000,
    timeZone: "Australia/Sydney",
    allDay: false,
    visibility: "default",
  });
  await alice.mutation(api.calendars.createEvent, {
    companyId: COMPANY,
    id: PRIVATE_EVENT,
    calendarId: PRIVATE_CALENDAR,
    title: "Owner only",
    startAt: 1_800_010_000_000,
    endAt: 1_800_013_600_000,
    timeZone: "Australia/Sydney",
    allDay: true,
    visibility: "private",
  });
  return ids;
}

async function visibleIds(t: Harness, subject: string) {
  const result = await asUser(t, subject).query(api.sync.listChanges, {
    companyId: COMPANY,
    cursor: 0,
    limit: 100,
  });
  if (result._tag !== "Changes") throw new Error("Expected a live change page.");
  return new Set(result.changes.map((change) => change.entityId));
}

describe("calendar change-feed visibility", () => {
  it("supports ownership, named grants, and company/team readAll at matching scope", async () => {
    const t = harness();
    await buildCalendarFixture(t);

    const owner = await visibleIds(t, "alice");
    const granted = await visibleIds(t, "bob");
    const companyWide = await visibleIds(t, "carol");
    const teamScoped = await visibleIds(t, "dave");

    expect(owner.has(PRIVATE_CALENDAR)).toBe(true);
    expect(owner.has(COMPANY_CALENDAR)).toBe(true);
    expect(owner.has(TEAM_CALENDAR)).toBe(true);
    expect(granted.has(PRIVATE_CALENDAR)).toBe(true);
    expect(companyWide.has(COMPANY_CALENDAR)).toBe(true);
    expect(teamScoped.has(TEAM_CALENDAR)).toBe(true);
    expect(teamScoped.has(COMPANY_CALENDAR)).toBe(false);
  });

  it("does not let a grant substitute for calendar.read and keeps private events owner-only", async () => {
    const t = harness();
    await buildCalendarFixture(t);

    const blind = await visibleIds(t, "blind");
    const granted = await visibleIds(t, "bob");
    const owner = await visibleIds(t, "alice");

    expect(blind.has(PRIVATE_CALENDAR)).toBe(false);
    expect(blind.has(PUBLIC_EVENT)).toBe(false);
    expect(granted.has(PUBLIC_EVENT)).toBe(true);
    expect(granted.has(PRIVATE_EVENT)).toBe(false);
    expect(owner.has(PRIVATE_EVENT)).toBe(true);
  });
});

describe("calendar revocation cascades", () => {
  it("emits one grantee-addressed calendar tombstone without changing authorizationEpoch", async () => {
    const t = harness();
    const ids = await buildCalendarFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("calendarEventLink", {
        id: "link-survives-revoke",
        companyId: ids.companyId,
        issueId: "issue-stable",
        googleEventId: "stable-google-event",
        createdByMembershipId: ids.alice,
        createdAt: 1_700_000_000_000,
        deletedAt: null,
      });
    });
    const before = await t.run(async (ctx) => {
      const company = await companyDoc(ctx);
      const changes = await ctx.db.query("syncChanges").collect();
      return {
        epoch: company?.authorizationEpoch,
        head: company?.syncVersion ?? 0,
        count: changes.length,
      };
    });

    await asUser(t, "alice").mutation(api.calendars.revoke, {
      companyId: COMPANY,
      calendarId: PRIVATE_CALENDAR,
      granteeMembershipId: "membership-bob",
    });

    const after = await t.run(async (ctx) => {
      const company = await companyDoc(ctx);
      const changes = (await ctx.db.query("syncChanges").collect()).sort(
        (a, b) => a.version - b.version,
      );
      const links = await ctx.db.query("calendarEventLink").collect();
      return { company, changes, links };
    });
    expect(after.company?.authorizationEpoch).toBe(before.epoch);
    expect(after.changes).toHaveLength(before.count + 1);
    expect(after.changes.at(-1)).toMatchObject({
      entityKind: "calendar",
      entityId: PRIVATE_CALENDAR,
      changeKind: "tombstone",
      calendarDepartureMembershipIds: [expect.any(String)],
    });
    expect(after.links).toHaveLength(1);

    const page = await asUser(t, "bob").query(api.sync.listChanges, {
      companyId: COMPANY,
      cursor: before.head,
      limit: 10,
    });
    expect(page._tag).toBe("Changes");
    if (page._tag === "Changes") {
      expect(page.changes).toEqual([
        expect.objectContaining({
          entityKind: "calendar",
          entityId: PRIVATE_CALENDAR,
          changeKind: "tombstone",
        }),
      ]);
    }
  });

  it("disconnects an account through calendars, events, and grants while preserving event links", async () => {
    const t = harness();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      const now = 1_700_000_000_000;
      const accountId = await ctx.db.insert("calendarAccount", {
        id: "account-google",
        companyId: ids.companyId,
        ownerMembershipId: ids.alice,
        provider: "google",
        providerAccountId: "google-user-1",
        email: "alice@example.test",
        credentialCiphertext: "encrypted:test-credential",
        createdAt: now,
        updatedAt: now,
        disconnectedAt: null,
      });
      await ctx.db.insert("calendar", {
        id: "calendar-google",
        companyId: ids.companyId,
        ownerMembershipId: ids.alice,
        name: "Google private by default",
        sharing: "private",
        teamId: null,
        kind: "google",
        accountId,
        googleCalendarId: "primary",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await ctx.db.insert("calendarEvent", {
        id: "event-google-row",
        companyId: ids.companyId,
        calendarId: "calendar-google",
        ownerMembershipId: ids.alice,
        title: "Mirrored",
        startAt: now,
        endAt: now + 3_600_000,
        timeZone: "Australia/Sydney",
        allDay: false,
        visibility: "default",
        googleEventId: "stable-google-event",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await ctx.db.insert("calendarGrant", {
        id: "grant-google",
        companyId: ids.companyId,
        calendarId: "calendar-google",
        granteeMembershipId: ids.bob,
        grantedByMembershipId: ids.alice,
        createdAt: now,
      });
      await ctx.db.insert("calendarEventLink", {
        id: "link-google",
        companyId: ids.companyId,
        issueId: "issue-stable",
        googleEventId: "stable-google-event",
        createdByMembershipId: ids.alice,
        createdAt: now,
        deletedAt: null,
      });
    });

    await asUser(t, "alice").mutation(api.calendarAccounts.disconnect, {
      companyId: COMPANY,
      accountId: "account-google",
    });

    const state = await t.run(async (ctx) => ({
      account: (await ctx.db.query("calendarAccount").collect())[0],
      calendar: (await ctx.db.query("calendar").collect())[0],
      event: (await ctx.db.query("calendarEvent").collect())[0],
      grants: await ctx.db.query("calendarGrant").collect(),
      links: await ctx.db.query("calendarEventLink").collect(),
      changes: await ctx.db.query("syncChanges").collect(),
    }));
    expect(state.account?.disconnectedAt).toEqual(expect.any(Number));
    expect(state.calendar?.deletedAt).toEqual(expect.any(Number));
    expect(state.event?.deletedAt).toEqual(expect.any(Number));
    expect(state.grants).toEqual([]);
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({ googleEventId: "stable-google-event", deletedAt: null });
    expect(state.changes.map((change) => change.entityKind)).toEqual([
      "calendarAccount",
      "calendar",
    ]);
  });
});

async function companyDoc(ctx: QueryCtx) {
  return await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", COMPANY))
    .unique();
}
