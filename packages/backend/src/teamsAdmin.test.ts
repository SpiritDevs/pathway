// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives `convex/teams` end to end through the Convex harness.
 *
 * Three properties are checked for every mutation, because each one fails silently in a different
 * way. The *write* is the obvious half. The *feed row* is what every replica actually sees, so its
 * entity id, change kind, and payload field list are pinned against the wire contract rather than
 * merely inspected — a payload with one extra key quarantines the row on the client and shows up
 * only as a counter. And the *epoch* is checked in both directions: a missing bump leaves revoked
 * readers serving records offline, and a gratuitous one costs every client its whole replica.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";
process.env.PATHWAY_CLOUD_SYNC = "enabled";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
  "../convex/teams.ts": () => import("../convex/teams.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const MANAGER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const READER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const OUTSIDER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000103";
const LOCKED_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000104";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";
const OTHER_TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000002";

const MANAGER_ACTOR = { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID } as const;

function harness() {
  return convexTest(schema, modules);
}

/**
 * One company, one owner-less cast of graded readers: a manager who may administer teams, a reader
 * who may only see them, an outsider with neither, and a locked membership that no team may take.
 * Nobody is an owner — ownership passes every check, which would hide the permission plumbing.
 */
async function seed(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Teams Co",
      issueKeyPrefix: "TC",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const member = async (
      subject: string,
      membershipId: string,
      state: "active" | "locked",
      permissions: readonly string[],
    ) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipDocId = await ctx.db.insert("memberships", {
        id: membershipId,
        companyId: companyDocId,
        userId,
        state,
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (permissions.length > 0) {
        const roleDocId = await ctx.db.insert("roles", {
          id: `0198c0de-bbbb-7bbb-8bbb-${membershipId.slice(-12)}`,
          companyId: companyDocId,
          name: `${subject} role`,
          description: "",
          permissions: [...permissions],
          seeded: false,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("roleAssignments", {
          id: `0198c0de-cccc-7ccc-8ccc-${membershipId.slice(-12)}`,
          companyId: companyDocId,
          membershipId: membershipDocId,
          roleId: roleDocId,
          scope: "company",
          teamId: null,
          createdAt: now,
        });
      }
      return membershipDocId;
    };

    const managerDocId = await member("manager", MANAGER_MEMBERSHIP_ID, "active", [
      "teams.read",
      "teams.manage",
      "members.read",
    ]);
    const readerDocId = await member("reader", READER_MEMBERSHIP_ID, "active", ["teams.read"]);
    const outsiderDocId = await member("outsider", OUTSIDER_MEMBERSHIP_ID, "active", [
      "issues.read",
    ]);
    const lockedDocId = await member("locked", LOCKED_MEMBERSHIP_ID, "locked", []);

    return { now, companyDocId, managerDocId, readerDocId, outsiderDocId, lockedDocId };
  });
}

function asMember(t: ReturnType<typeof harness>, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });
}

const asManager = (t: ReturnType<typeof harness>) => asMember(t, "manager");
const asReader = (t: ReturnType<typeof harness>) => asMember(t, "reader");

async function feedRows(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("syncChanges").collect();
    return rows
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((row) => ({
        version: row.version,
        entityKind: row.entityKind,
        entityId: row.entityId,
        changeKind: row.changeKind,
        teamIds: row.teamIds,
        payload: row.payload as Record<string, unknown> | null,
        operationId: row.operationId,
        actor: row.actor,
      }));
  });
}

async function epochOf(t: ReturnType<typeof harness>, companyDocId: string) {
  return await t.run(async (ctx) => {
    const company = await ctx.db.get(companyDocId as never);
    return (company as { authorizationEpoch: number } | null)?.authorizationEpoch ?? null;
  });
}

async function createTeam(t: ReturnType<typeof harness>, id = TEAM_ID, name = "Alpha") {
  await asManager(t).mutation(api.teams.create, {
    companyId: COMPANY_ID,
    id,
    name,
    description: "The alpha team",
  });
}

describe("teams.create", () => {
  it("refuses a caller holding only teams.read", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asReader(t).mutation(api.teams.create, { companyId: COMPANY_ID, id: TEAM_ID, name: "Alpha" }),
    ).rejects.toThrow("teams.manage");
    expect(await feedRows(t)).toHaveLength(0);
  });

  it("refuses a blank name, a blank id, and a second team under one id", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asManager(t).mutation(api.teams.create, { companyId: COMPANY_ID, id: TEAM_ID, name: "  " }),
    ).rejects.toThrow("A team needs a name");
    await expect(
      asManager(t).mutation(api.teams.create, { companyId: COMPANY_ID, id: "", name: "Alpha" }),
    ).rejects.toThrow("A team id must be");

    await createTeam(t);
    await expect(
      asManager(t).mutation(api.teams.create, {
        companyId: COMPANY_ID,
        id: TEAM_ID,
        name: "Again",
      }),
    ).rejects.toThrow("already exists");
    expect(await feedRows(t)).toHaveLength(1);
  });

  it("writes the team, appends one company-wide upsert, and leaves the epoch alone", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    const rows = await feedRows(t);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error("expected a change row");
    expect(row).toMatchObject({
      version: 1,
      entityKind: "team",
      entityId: TEAM_ID,
      changeKind: "upsert",
      // Company administration is online-only: no client operation stands behind the row.
      operationId: null,
      actor: MANAGER_ACTOR,
    });
    // Company-wide, which is what forces a company-scoped grant rather than a team-scoped one.
    expect(row.teamIds).toEqual([]);
    // Field-for-field with `SyncTeamPayload` in `contracts/cloudSync`: an extra key quarantines
    // the row on every client, and a missing one blanks the team out of the picker.
    expect(Object.keys(row.payload ?? {}).sort()).toEqual([
      "archivedAt",
      "createdAt",
      "description",
      "id",
      "name",
      "updatedAt",
    ]);
    expect(row.payload).toMatchObject({
      id: TEAM_ID,
      name: "Alpha",
      description: "The alpha team",
      archivedAt: null,
    });

    await t.run(async (ctx) => {
      const team = await ctx.db
        .query("teams")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", TEAM_ID),
        )
        .unique();
      expect(team).toMatchObject({ name: "Alpha", archivedAt: null });
      // Stamped with the version its feed entry carries, which closes the bootstrap seed handoff.
      expect(team?.version).toBe(1);
      const company = await ctx.db.get(seeded.companyDocId);
      expect(company?.syncVersion).toBe(1);
    });
    // A team nobody belongs to and nobody is assigned into grants nothing.
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });
});

describe("teams.update", () => {
  it("renames without touching the epoch and re-emits the whole row", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    await asManager(t).mutation(api.teams.update, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      name: "  Renamed  ",
    });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ version: 2, entityKind: "team", changeKind: "upsert" });
    // The name is trimmed on the way in, and the description survives a name-only update.
    expect(rows[1]?.payload).toMatchObject({ name: "Renamed", description: "The alpha team" });
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });

  it("refuses an empty update, a blank name, and a team from another company", async () => {
    const t = harness();
    await seed(t);
    await createTeam(t);

    await expect(
      asManager(t).mutation(api.teams.update, { companyId: COMPANY_ID, teamId: TEAM_ID }),
    ).rejects.toThrow("needs a name or a description");
    await expect(
      asManager(t).mutation(api.teams.update, { companyId: COMPANY_ID, teamId: TEAM_ID, name: "" }),
    ).rejects.toThrow("A team needs a name");
    await expect(
      asManager(t).mutation(api.teams.update, {
        companyId: COMPANY_ID,
        teamId: OTHER_TEAM_ID,
        name: "Ghost",
      }),
    ).rejects.toThrow(`No team ${OTHER_TEAM_ID}`);
    expect(await feedRows(t)).toHaveLength(1);
  });
});

describe("teams.archive", () => {
  it("stamps archivedAt as an upsert rather than a tombstone, and does not bump the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    await asManager(t).mutation(api.teams.archive, { companyId: COMPANY_ID, teamId: TEAM_ID });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(2);
    // A tombstone would drop the row from every replica while issues still name the team, leaving
    // work attached to a scope the client can no longer render.
    expect(rows[1]).toMatchObject({ entityKind: "team", changeKind: "upsert" });
    expect(rows[1]?.payload?.archivedAt).toEqual(expect.any(Number));
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });

  it("is idempotent: a second archive keeps the first stamp and appends nothing", async () => {
    const t = harness();
    await seed(t);
    await createTeam(t);
    await asManager(t).mutation(api.teams.archive, { companyId: COMPANY_ID, teamId: TEAM_ID });
    const first = await feedRows(t);

    await asManager(t).mutation(api.teams.archive, { companyId: COMPANY_ID, teamId: TEAM_ID });
    expect(await feedRows(t)).toEqual(first);
  });
});

describe("teams.addMember", () => {
  it("joins the pair under the composite id, emits the upsert, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    await asManager(t).mutation(api.teams.addMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect(row).toMatchObject({
      entityKind: "teamMembership",
      // The composite `teamMembershipSyncEntityId` mints, byte for byte — the tombstone has to
      // name this same id, and the client parses the membership half out of it.
      entityId: `${TEAM_ID}:${READER_MEMBERSHIP_ID}`,
      changeKind: "upsert",
      actor: MANAGER_ACTOR,
    });
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "membershipId",
      "teamId",
    ]);
    expect(row?.payload).toMatchObject({
      id: `${TEAM_ID}:${READER_MEMBERSHIP_ID}`,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });

    // Team membership is what a team-scoped grant resolves through, so replicas must reseed.
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);
    await t.run(async (ctx) => {
      const joins = await ctx.db.query("teamMemberships").collect();
      expect(joins).toHaveLength(1);
      expect(joins[0]?.version).toBe(2);
    });
  });

  it("adding the same member twice appends nothing and does not bump the epoch again", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);
    const add = () =>
      asManager(t).mutation(api.teams.addMember, {
        companyId: COMPANY_ID,
        teamId: TEAM_ID,
        membershipId: READER_MEMBERSHIP_ID,
      });
    await add();
    await add();

    expect(await feedRows(t)).toHaveLength(2);
    // The point of the idempotence check: a double click must not cost every client two reseeds.
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("teamMemberships").collect()).toHaveLength(1);
    });
  });

  it("refuses an archived team, a locked membership, an unknown membership, and a reader", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    await expect(
      asReader(t).mutation(api.teams.addMember, {
        companyId: COMPANY_ID,
        teamId: TEAM_ID,
        membershipId: READER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("teams.manage");
    await expect(
      asManager(t).mutation(api.teams.addMember, {
        companyId: COMPANY_ID,
        teamId: TEAM_ID,
        membershipId: LOCKED_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("not active");
    await expect(
      asManager(t).mutation(api.teams.addMember, {
        companyId: COMPANY_ID,
        teamId: TEAM_ID,
        membershipId: "0198c0de-ffff-7fff-8fff-000000000009",
      }),
    ).rejects.toThrow("No membership");

    await asManager(t).mutation(api.teams.archive, { companyId: COMPANY_ID, teamId: TEAM_ID });
    await expect(
      asManager(t).mutation(api.teams.addMember, {
        companyId: COMPANY_ID,
        teamId: TEAM_ID,
        membershipId: READER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("archived team");

    // Only the create and the archive ever reached the feed.
    expect((await feedRows(t)).map((row) => row.changeKind)).toEqual(["upsert", "upsert"]);
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });
});

describe("teams.removeMember", () => {
  it("deletes the join row, tombstones the same entity id, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);
    await asManager(t).mutation(api.teams.addMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });

    await asManager(t).mutation(api.teams.removeMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      entityKind: "teamMembership",
      entityId: `${TEAM_ID}:${READER_MEMBERSHIP_ID}`,
      changeKind: "tombstone",
      // A tombstone carries no payload; the entity id is the whole message.
      payload: null,
    });
    // Losing a team changes what that member may see, so every replica reseeds and purges.
    expect(await epochOf(t, seeded.companyDocId)).toBe(3);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("teamMemberships").collect()).toHaveLength(0);
    });
  });

  it("removing someone who was never on the team appends nothing and bumps nothing", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);

    await asManager(t).mutation(api.teams.removeMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });
    expect(await feedRows(t)).toHaveLength(1);
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });

  it("leaves team-scoped role assignments alone: a seat is not a grant", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createTeam(t);
    await asManager(t).mutation(api.teams.addMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });
    const before = await t.run(
      async (ctx) => (await ctx.db.query("roleAssignments").collect()).length,
    );

    await asManager(t).mutation(api.teams.removeMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });
    const after = await t.run(
      async (ctx) => (await ctx.db.query("roleAssignments").collect()).length,
    );
    expect(after).toBe(before);
    expect(await epochOf(t, seeded.companyDocId)).toBe(3);
  });
});

describe("teams.list", () => {
  it("counts members and keeps archived teams in the list, flagged", async () => {
    const t = harness();
    await seed(t);
    await createTeam(t);
    await createTeam(t, OTHER_TEAM_ID, "Beta");
    await asManager(t).mutation(api.teams.addMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });
    await asManager(t).mutation(api.teams.archive, {
      companyId: COMPANY_ID,
      teamId: OTHER_TEAM_ID,
    });

    const listed = await asReader(t).query(api.teams.list, { companyId: COMPANY_ID });
    expect(listed).toEqual([
      {
        id: TEAM_ID,
        name: "Alpha",
        description: "The alpha team",
        memberCount: 1,
        archivedAt: null,
      },
      {
        id: OTHER_TEAM_ID,
        name: "Beta",
        description: "The alpha team",
        memberCount: 0,
        archivedAt: expect.any(Number),
      },
    ]);
  });

  it("refuses a caller with no teams.read", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asMember(t, "outsider").query(api.teams.list, { companyId: COMPANY_ID }),
    ).rejects.toThrow("teams.read");
  });
});

describe("draining team administration off the change feed", () => {
  it("a teams.read member sees the team and a foreign team membership; an outsider sees neither", async () => {
    const t = harness();
    await seed(t);
    await createTeam(t);
    // The manager is the subject, so nothing the reader drains can be explained by the
    // own-rows carve-out in `sync/visibility` — only the `teams.read` grant delivers these.
    await asManager(t).mutation(api.teams.addMember, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: MANAGER_MEMBERSHIP_ID,
    });
    await asManager(t).mutation(api.teams.update, {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      description: "Now with a roster",
    });

    const page = await asReader(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (page._tag !== "Changes") throw new Error("expected Changes");
    expect(page.changes.map((change) => [change.entityKind, change.changeKind])).toEqual([
      ["team", "upsert"],
      ["teamMembership", "upsert"],
      ["team", "upsert"],
    ]);
    // The drain ends at the head even though the reader is not the subject of any of it.
    expect(page.cursor).toBe(page.latestVersion);
    expect(page.hasMore).toBe(false);

    const outsider = await asMember(t, "outsider").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (outsider._tag !== "Changes") throw new Error("expected Changes");
    expect(outsider.changes).toEqual([]);
    // Filtering empties the page but the cursor still advances, so sync cannot wedge.
    expect(outsider.cursor).toBe(outsider.latestVersion);
  });
});
