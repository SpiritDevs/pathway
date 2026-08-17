// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives `lib/companyApply` — the company domain's feed writer — against the same Convex harness
 * `syncApply.test.ts` uses, because the load-bearing property is that the two writers share a head:
 * an administration append and a batch of issue operations have to produce one gapless run of
 * versions, not two that collide.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import {
  appendCompanyChanges,
  bumpAuthorizationEpoch,
  companyRowVersion,
  companySettingsDomainId,
  encodeCompany,
  encodeCompanySettings,
  encodeMembership,
  encodeRole,
  encodeRoleAssignment,
  encodeTeam,
  encodeTeamMembership,
  teamMembershipDomainId,
} from "../convex/lib/companyApply.ts";
import schema from "../convex/schema.ts";
import { SYNC_MAX_ID_CHARS } from "./sync/operations.ts";
import { SYNC_FEED_RETENTION_MS } from "./sync/protocol.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const OWNER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const MEMBER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";
const ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000201";
const ASSIGNMENT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000301";
const STATUS_ID = "0198c0de-bbbb-7bbb-8bbb-000000000001";
const ISSUE_ID = "0198c0de-cccc-7ccc-8ccc-000000000001";

const OWNER_ACTOR = { kind: "member", membershipId: OWNER_MEMBERSHIP_ID } as const;

function harness() {
  return convexTest(schema, modules);
}

/**
 * A company with an owner who can write issues, one ordinary member, one team, and a role assigned
 * company-wide — one live row of every kind this module encodes.
 */
async function seed(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Company Apply Co",
      workspaceKind: "organization",
      issueKeyPrefix: "PAT",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("companySettings", {
      companyId: companyDocId,
      offlineAccessDays: 30,
      updatedByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });

    const ownerUserId = await ctx.db.insert("users", {
      clerkSubject: "user_owner",
      email: "owner@example.test",
      displayName: "Owner",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    const ownerMembershipId = await ctx.db.insert("memberships", {
      id: OWNER_MEMBERSHIP_ID,
      companyId: companyDocId,
      userId: ownerUserId,
      state: "active",
      displayNameSnapshot: "Owner",
      emailSnapshot: "owner@example.test",
      invitedByMembershipId: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("companyOwners", {
      companyId: companyDocId,
      membershipId: ownerMembershipId,
      grantedByMembershipId: null,
      createdAt: now,
    });

    const memberUserId = await ctx.db.insert("users", {
      clerkSubject: "user_member",
      email: "member@example.test",
      displayName: "Member",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    const memberMembershipId = await ctx.db.insert("memberships", {
      id: MEMBER_MEMBERSHIP_ID,
      companyId: companyDocId,
      userId: memberUserId,
      state: "active",
      displayNameSnapshot: "Member",
      emailSnapshot: "member@example.test",
      invitedByMembershipId: OWNER_MEMBERSHIP_ID,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const teamDocId = await ctx.db.insert("teams", {
      id: TEAM_ID,
      companyId: companyDocId,
      name: "Alpha",
      description: "The alpha team",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const teamMembershipDocId = await ctx.db.insert("teamMemberships", {
      companyId: companyDocId,
      teamId: teamDocId,
      membershipId: memberMembershipId,
      createdAt: now,
    });
    const roleDocId = await ctx.db.insert("roles", {
      id: ROLE_ID,
      companyId: companyDocId,
      name: "Reader",
      description: "Reads issues",
      permissions: ["issues.read"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const assignmentDocId = await ctx.db.insert("roleAssignments", {
      id: ASSIGNMENT_ID,
      companyId: companyDocId,
      membershipId: memberMembershipId,
      roleId: roleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });

    return {
      now,
      companyDocId,
      ownerMembershipId,
      memberMembershipId,
      memberUserId,
      teamDocId,
      teamMembershipDocId,
      roleDocId,
      assignmentDocId,
    };
  });
}

function asOwner(t: ReturnType<typeof harness>) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "user_owner",
    tokenIdentifier: `${CLERK_ISSUER}|user_owner`,
  });
}

/** Envelope factory matching `syncApply.test.ts`: unique operation ids per call. */
function makeOps() {
  let counter = 0;
  return (kind: string, entityId: string, args: unknown) => {
    counter += 1;
    return {
      protocolVersion: 1,
      operationId: `0198c0de-eeee-7eee-8eee-0${String(counter).padStart(11, "0")}`,
      companyId: COMPANY_ID,
      clientId: "client-test",
      environmentId: null,
      actor: OWNER_ACTOR,
      localSequence: counter,
      baseVersion: 0,
      kind,
      entityId,
      args,
      dependsOn: [],
    };
  };
}

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
        createdAt: row.createdAt,
        retainUntil: row.retainUntil,
      }));
  });
}

describe("appendCompanyChanges", () => {
  it("interleaves with applyOperations on one head without gaps or duplicate versions", async () => {
    const t = harness();
    const seeded = await seed(t);
    const op = makeOps();

    // Issue batch one: a single status upsert takes version 1.
    const first = await asOwner(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
        }),
      ],
    });
    expect(first).toMatchObject({ versionFrom: 0, versionTo: 1 });

    // An administration append lands between the two batches, off the same head.
    const appended = await t.run(async (ctx: MutationCtx) => {
      const team = await ctx.db.get(seeded.teamDocId);
      const role = await ctx.db.get(seeded.roleDocId);
      if (team === null || role === null) throw new Error("seed the rows first");
      return await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [
          {
            entityKind: "team",
            entityId: TEAM_ID,
            changeKind: "upsert",
            versionDocId: seeded.teamDocId,
            payload: encodeTeam(team),
          },
          {
            entityKind: "role",
            entityId: ROLE_ID,
            changeKind: "upsert",
            versionDocId: seeded.roleDocId,
            payload: encodeRole(role),
          },
        ],
        bumpEpoch: true,
      });
    });
    expect(appended).toMatchObject({
      versionFrom: 1,
      versionTo: 3,
      versions: [2, 3],
      authorizationEpoch: 2,
    });

    // Issue batch two resumes at the head the append left, not at the one it found.
    const second = await asOwner(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.create", ISSUE_ID, { title: "Fix the crash", statusId: STATUS_ID })],
    });
    expect(second).toMatchObject({ versionFrom: 3, versionTo: 5 });

    const rows = await feedRows(t);
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.entityKind)).toEqual([
      "issueStatus",
      "team",
      "role",
      "issue",
      "issueAuditEvent",
    ]);

    await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      expect(company?.syncVersion).toBe(5);
      // The appended rows carry the versions their feed entries were assigned.
      expect((await ctx.db.get(seeded.teamDocId))?.version).toBe(2);
      expect((await ctx.db.get(seeded.roleDocId))?.version).toBe(3);
    });
  });

  it("stamps company-wide scope, a null operation id, the actor, and the 90-day retention line", async () => {
    const t = harness();
    const seeded = await seed(t);

    await t.run(async (ctx: MutationCtx) => {
      const membership = await ctx.db.get(seeded.memberMembershipId);
      if (membership === null) throw new Error("seed first");
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [
          {
            entityKind: "membership",
            entityId: MEMBER_MEMBERSHIP_ID,
            changeKind: "upsert",
            versionDocId: seeded.memberMembershipId,
            payload: encodeMembership(membership),
          },
        ],
      });
    });

    const [row] = await feedRows(t);
    expect(row).toBeDefined();
    if (row === undefined) return;
    // Company records are company-wide: an empty team list is what forces a company-scoped grant.
    expect(row.teamIds).toEqual([]);
    expect(row.operationId).toBeNull();
    expect(row.actor).toEqual(OWNER_ACTOR);
    expect(row.retainUntil).toBe(row.createdAt + SYNC_FEED_RETENTION_MS);
  });

  it("updates the company timestamp only for a company upsert", async () => {
    const t = harness();
    const seeded = await seed(t);

    await t.run(async (ctx: MutationCtx) => {
      const membership = await ctx.db.get(seeded.memberMembershipId);
      if (membership === null) throw new Error("membership vanished");
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [
          {
            entityKind: "membership",
            entityId: membership.id,
            changeKind: "upsert",
            versionDocId: membership._id,
            payload: encodeMembership(membership),
          },
        ],
        bumpEpoch: true,
      });
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(seeded.companyDocId))?.updatedAt).toBe(seeded.now);
    });

    await t.run(async (ctx: MutationCtx) => {
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [],
        companyUpsert: true,
      });
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(seeded.companyDocId))?.updatedAt).toBeGreaterThan(seeded.now);
    });
  });

  it("bumps the epoch and encodes the company payload from the patched row, in one transaction", async () => {
    const t = harness();
    const seeded = await seed(t);

    const result = await t.run(async (ctx: MutationCtx) => {
      // A rename patched first in the same transaction: the append must encode what it wrote.
      await ctx.db.patch(seeded.companyDocId, { name: "Renamed Co" });
      return await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [],
        companyUpsert: true,
        bumpEpoch: true,
      });
    });
    expect(result).toMatchObject({ versionFrom: 0, versionTo: 1, authorizationEpoch: 2 });

    const [row] = await feedRows(t);
    expect(row?.entityKind).toBe("company");
    expect(row?.entityId).toBe(COMPANY_ID);
    expect(row?.payload).toMatchObject({ name: "Renamed Co", updatedAt: row?.createdAt });
    // The epoch and the head are the two values the payload deliberately does not carry: both are
    // stale the moment the next change lands, and both ride every feed response already.
    expect(row?.payload).not.toHaveProperty("authorizationEpoch");
    expect(row?.payload).not.toHaveProperty("syncVersion");

    await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      expect(company?.authorizationEpoch).toBe(2);
      expect(company?.syncVersion).toBe(1);
      // The company row is stamped with its own change's version, not just the head.
      expect(company?.version).toBe(1);
    });
  });

  it("appends nothing and moves no head for an empty change list, but still bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);

    const result = await t.run(async (ctx: MutationCtx) =>
      appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [],
        bumpEpoch: true,
      }),
    );
    expect(result).toMatchObject({
      versionFrom: 0,
      versionTo: 0,
      versions: [],
      authorizationEpoch: 2,
    });
    expect(await feedRows(t)).toHaveLength(0);

    await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      expect(company?.syncVersion).toBe(0);
      expect(company?.authorizationEpoch).toBe(2);
    });
  });

  it("drops the payload of a tombstone whose row is already gone", async () => {
    const t = harness();
    const seeded = await seed(t);

    await t.run(async (ctx: MutationCtx) => {
      const id = teamMembershipDomainId(TEAM_ID, MEMBER_MEMBERSHIP_ID);
      await ctx.db.delete(seeded.teamMembershipDocId);
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [
          {
            entityKind: "teamMembership",
            entityId: id,
            changeKind: "tombstone",
            versionDocId: null,
            // Even a payload handed in is dropped: a tombstone is the absence of the entity.
            payload: { id },
          },
        ],
        bumpEpoch: true,
      });
    });

    const [row] = await feedRows(t);
    expect(row).toMatchObject({ changeKind: "tombstone", payload: null, version: 1 });
  });

  it("two appends in one transaction take consecutive runs off the head the first left", async () => {
    const t = harness();
    const seeded = await seed(t);

    const [first, second] = await t.run(async (ctx: MutationCtx) => {
      const one = await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [],
        companyUpsert: true,
      });
      const two = await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: [],
        companyUpsert: true,
      });
      return [one, two] as const;
    });
    expect(first).toMatchObject({ versionFrom: 0, versionTo: 1 });
    expect(second).toMatchObject({ versionFrom: 1, versionTo: 2 });
    expect((await feedRows(t)).map((row) => row.version)).toEqual([1, 2]);
  });

  it("refuses to encode a reference that has gone dangling", async () => {
    const t = harness();
    const seeded = await seed(t);

    await expect(
      t.run(async (ctx: MutationCtx) => {
        const assignment = await ctx.db.get(seeded.assignmentDocId);
        if (assignment === null) throw new Error("seed first");
        await ctx.db.delete(seeded.roleDocId);
        return await encodeRoleAssignment(ctx, assignment);
      }),
    ).rejects.toThrow(/Referenced role is missing/);
  });
});

describe("bumpAuthorizationEpoch", () => {
  it("moves the epoch alone, leaving the feed and its head untouched", async () => {
    const t = harness();
    const seeded = await seed(t);

    const epoch = await t.run(async (ctx: MutationCtx) =>
      bumpAuthorizationEpoch(ctx, seeded.companyDocId),
    );
    expect(epoch).toBe(2);
    expect(await feedRows(t)).toHaveLength(0);

    await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      expect(company?.authorizationEpoch).toBe(2);
      expect(company?.syncVersion).toBe(0);
      expect(company?.updatedAt).toBe(seeded.now);
    });
  });
});

describe("company payload encoders", () => {
  it("encode every field of their table and nothing the wire has no business carrying", async () => {
    const t = harness();
    const seeded = await seed(t);

    const encoded = await t.run(async (ctx: MutationCtx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      if (company === null) throw new Error("seed first");
      const settings = await ctx.db
        .query("companySettings")
        .withIndex("by_company", (q) => q.eq("companyId", seeded.companyDocId))
        .unique();
      const membership = await ctx.db.get(seeded.memberMembershipId);
      const team = await ctx.db.get(seeded.teamDocId);
      const teamMembership = await ctx.db.get(seeded.teamMembershipDocId);
      const role = await ctx.db.get(seeded.roleDocId);
      const assignment = await ctx.db.get(seeded.assignmentDocId);
      if (
        settings === null ||
        membership === null ||
        team === null ||
        teamMembership === null ||
        role === null ||
        assignment === null
      ) {
        throw new Error("seed every row first");
      }
      return {
        company: await encodeCompany(ctx, company),
        companySettings: encodeCompanySettings(company, settings),
        membership: encodeMembership(membership),
        team: encodeTeam(team),
        teamMembership: await encodeTeamMembership(ctx, teamMembership),
        role: encodeRole(role),
        roleAssignment: await encodeRoleAssignment(ctx, assignment),
      };
    });

    // Exact object equality throughout: these payloads are the server half of the `Sync*Payload`
    // structs in `contracts/cloudSync`, and an extra field is as much a divergence as a missing
    // one. `companyId` is on none of them — a replica is one company by construction.
    expect(encoded.company).toEqual({
      id: COMPANY_ID,
      name: "Company Apply Co",
      workspaceKind: "organization",
      issueKeyPrefix: "PAT",
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      // Ownership is a relation with no wire kind of its own; it rides the company.
      owners: [
        {
          membershipId: OWNER_MEMBERSHIP_ID,
          grantedByMembershipId: null,
          createdAt: seeded.now,
        },
      ],
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });

    // A settings row written before the id column existed still encodes one, by the convention.
    expect(encoded.companySettings).toEqual({
      id: COMPANY_ID,
      offlineAccessDays: 30,
      updatedByMembershipId: null,
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });

    expect(encoded.membership).toEqual({
      id: MEMBER_MEMBERSHIP_ID,
      userId: seeded.memberUserId,
      state: "active",
      displayNameSnapshot: "Member",
      emailSnapshot: "member@example.test",
      invitedByMembershipId: OWNER_MEMBERSHIP_ID,
      joinedAt: seeded.now,
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });

    expect(encoded.team).toEqual({
      id: TEAM_ID,
      name: "Alpha",
      description: "The alpha team",
      archivedAt: null,
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });

    // Convex `_id` references are resolved to the domain ids a replica indexes by.
    expect(encoded.teamMembership).toEqual({
      id: `${TEAM_ID}:${MEMBER_MEMBERSHIP_ID}`,
      teamId: TEAM_ID,
      membershipId: MEMBER_MEMBERSHIP_ID,
      createdAt: seeded.now,
    });

    expect(encoded.role).toEqual({
      id: ROLE_ID,
      name: "Reader",
      description: "Reads issues",
      permissions: ["issues.read"],
      seeded: false,
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });

    expect(encoded.roleAssignment).toEqual({
      id: ASSIGNMENT_ID,
      membershipId: MEMBER_MEMBERSHIP_ID,
      roleId: ROLE_ID,
      scope: { kind: "company" },
      createdAt: seeded.now,
    });
  });

  it("re-joins a team-scoped assignment, and reads a scoped row with no team as company-wide", async () => {
    const t = harness();
    const seeded = await seed(t);

    const scoped = await t.run(async (ctx: MutationCtx) => {
      await ctx.db.patch(seeded.assignmentDocId, { scope: "team", teamId: TEAM_ID });
      const withTeam = await ctx.db.get(seeded.assignmentDocId);
      if (withTeam === null) throw new Error("missing assignment");
      const team = await encodeRoleAssignment(ctx, withTeam);
      await ctx.db.patch(seeded.assignmentDocId, { scope: "team", teamId: null });
      const orphan = await ctx.db.get(seeded.assignmentDocId);
      if (orphan === null) throw new Error("missing assignment");
      return { team, orphan: await encodeRoleAssignment(ctx, orphan) };
    });

    expect(scoped.team).toMatchObject({ scope: { kind: "team", teamId: TEAM_ID } });
    // Matches `lib/identity`'s resolution rule, so a client cannot resolve a grant differently.
    expect(scoped.orphan).toMatchObject({ scope: { kind: "company" } });
  });

  it("derives one stable team-membership id from the pair it joins", () => {
    const id = teamMembershipDomainId(TEAM_ID, MEMBER_MEMBERSHIP_ID);
    // Byte-identical to `teamMembershipSyncEntityId` in `contracts/cloudSync`: a tombstone written
    // here has to match the id the client folded the upsert under.
    expect(id).toBe(`${TEAM_ID}:${MEMBER_MEMBERSHIP_ID}`);
    expect(teamMembershipDomainId(MEMBER_MEMBERSHIP_ID, TEAM_ID)).not.toBe(id);
    // Comfortably inside the protocol's id ceiling, and no separator can appear in either half.
    expect(id.length).toBeLessThanOrEqual(SYNC_MAX_ID_CHARS);
    expect(id.split(":")).toHaveLength(2);
  });

  it("reads a row untouched since the feed began as version zero", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      const team = await ctx.db.get(seeded.teamDocId);
      const company = await ctx.db.get(seeded.companyDocId);
      if (team === null || company === null) throw new Error("seed first");
      expect(team.version).toBeUndefined();
      expect(companyRowVersion(team)).toBe(0);
      // Settings borrow the company's identity rather than minting a second singleton id.
      expect(companySettingsDomainId(company)).toBe(COMPANY_ID);
    });
  });
});
