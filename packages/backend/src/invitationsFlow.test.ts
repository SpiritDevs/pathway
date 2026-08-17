// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives the invitation lifecycle end to end through the production identity resolution:
 * `create` → `record` → the mailer → `accept` → `consume`.
 *
 * Two properties are load-bearing and neither is visible from the unit tests in `invitations.test.ts`.
 * The first is secrecy: the plaintext token exists only in what the mailer was handed, and the hash
 * behind it must never reach a query result or a change-feed payload. The second is atomicity:
 * acceptance creates a membership, its team memberships, and its role assignments, consumes the
 * token, and bumps the authorization epoch in one transaction — so a refused acceptance leaves the
 * company byte-for-byte as it was, and a successful one bumps the epoch exactly once.
 *
 * Delivery is injected. There is no Resend integration in the repository yet, and a test that
 * reached the network would be neither hermetic nor a test of this module; `setInvitationMailer`
 * installs a recorder, which is also how the test learns the token it is supposed to accept with.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import {
  INVITATION_RESEND_MIN_INTERVAL_MS,
  setInvitationMailer,
  type InvitationDelivery,
} from "../convex/invitations.ts";
import schema from "../convex/schema.ts";
import { hashInvitationToken, INVITATION_TTL_MS } from "./invitations.ts";
import type { PermissionKey } from "./permissions.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/invitations.ts": () => import("../convex/invitations.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const OWNER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const READER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";
const ARCHIVED_TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000002";
const ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000201";
const READER_ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000202";
const INVITATION_ID = "0198c0de-eeee-7eee-8eee-000000000001";
const SECOND_INVITATION_ID = "0198c0de-eeee-7eee-8eee-000000000002";

const INVITEE_EMAIL = "ada@example.test";

function harness() {
  return convexTest(schema, modules);
}

/** A company, an owner who may invite, an ordinary reader who may not, one team, and one role. */
async function seed(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Invite Co",
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

    const roleDocId = await ctx.db.insert("roles", {
      id: ROLE_ID,
      companyId: companyDocId,
      name: "Member",
      description: "Reads issues",
      permissions: ["issues.read", "members.read"],
      seeded: true,
      createdAt: now,
      updatedAt: now,
    });
    const readerRoleDocId = await ctx.db.insert("roles", {
      id: READER_ROLE_ID,
      companyId: companyDocId,
      name: "Reader",
      description: "Reads the member list and nothing else",
      permissions: ["members.read"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });

    // A member who can see invitations but cannot create or revoke one.
    const readerUserId = await ctx.db.insert("users", {
      clerkSubject: "user_reader",
      email: "reader@example.test",
      displayName: "Reader",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    const readerMembershipId = await ctx.db.insert("memberships", {
      id: READER_MEMBERSHIP_ID,
      companyId: companyDocId,
      userId: readerUserId,
      state: "active",
      displayNameSnapshot: "Reader",
      emailSnapshot: "reader@example.test",
      invitedByMembershipId: OWNER_MEMBERSHIP_ID,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      id: "0198c0de-aaaa-7aaa-8aaa-000000000301",
      companyId: companyDocId,
      membershipId: readerMembershipId,
      roleId: readerRoleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
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
    await ctx.db.insert("teams", {
      id: ARCHIVED_TEAM_ID,
      companyId: companyDocId,
      name: "Ghost",
      description: "Archived before anybody accepted",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return {
      now,
      companyDocId,
      ownerMembershipId,
      readerMembershipId,
      readerUserId,
      roleDocId,
      readerRoleDocId,
      teamDocId,
    };
  });
}

function asOwner(t: ReturnType<typeof harness>) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "user_owner",
    tokenIdentifier: `${CLERK_ISSUER}|user_owner`,
    email: "owner@example.test",
    emailVerified: true,
    name: "Owner",
  });
}

function asReader(t: ReturnType<typeof harness>) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "user_reader",
    tokenIdentifier: `${CLERK_ISSUER}|user_reader`,
    email: "reader@example.test",
    emailVerified: true,
    name: "Reader",
  });
}

async function setReaderPermissions(
  t: ReturnType<typeof harness>,
  roleId: Id<"roles">,
  permissions: PermissionKey[],
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch(roleId, { permissions });
  });
}

/** The invitee, who is nobody in this company until acceptance makes them somebody. */
function asInvitee(
  t: ReturnType<typeof harness>,
  overrides: { email?: string; emailVerified?: boolean } = {},
) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "user_invitee",
    tokenIdentifier: `${CLERK_ISSUER}|user_invitee`,
    email: overrides.email ?? "Ada@Example.TEST",
    emailVerified: overrides.emailVerified ?? true,
    name: "Ada Lovelace",
  });
}

let sent: InvitationDelivery[] = [];

beforeEach(() => {
  sent = [];
  setInvitationMailer(async (delivery) => {
    sent.push(delivery);
  });
});

afterEach(() => {
  setInvitationMailer(null);
});

function lastDelivery(): InvitationDelivery {
  const delivery = sent.at(-1);
  if (delivery === undefined) throw new Error("nothing was delivered");
  return delivery;
}

async function invite(
  t: ReturnType<typeof harness>,
  overrides: {
    id?: string;
    email?: string;
    teamIds?: string[];
    roleIds?: string[];
  } = {},
) {
  return await asOwner(t).action(api.invitations.create, {
    companyId: COMPANY_ID,
    id: overrides.id ?? INVITATION_ID,
    email: overrides.email ?? INVITEE_EMAIL,
    teamIds: overrides.teamIds ?? [TEAM_ID],
    roleIds: overrides.roleIds ?? [ROLE_ID],
  });
}

async function invitationRow(t: ReturnType<typeof harness>, id = INVITATION_ID) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("companyInvitations").collect();
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`no invitation ${id}`);
    return row;
  });
}

async function companyRow(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const company = await ctx.db
      .query("companies")
      .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
      .unique();
    if (company === null) throw new Error("no company");
    return company;
  });
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
      }));
  });
}

describe("personal workspace collaboration guard", () => {
  it("keeps invitation reads available but refuses to create an invitation", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.companyDocId, { workspaceKind: "personal" });
    });

    expect(await asOwner(t).query(api.invitations.list, { companyId: COMPANY_ID })).toEqual([]);
    await expect(invite(t)).rejects.toThrow("Upgrade this personal workspace to an organization");
    expect(sent).toEqual([]);
  });
});

describe("invitation lifecycle", () => {
  it("creates, delivers, accepts, and folds the whole join into one feed run", async () => {
    const t = harness();
    const seeded = await seed(t);

    const created = await invite(t);
    expect(created.id).toBe(INVITATION_ID);

    // The token exists in the delivery and nowhere else; the row holds its hash.
    const delivery = lastDelivery();
    expect(sent).toHaveLength(1);
    expect(delivery.token).toMatch(/^[0-9a-f]{64}$/);
    expect(delivery.email).toBe(INVITEE_EMAIL);
    expect(delivery.companyName).toBe("Invite Co");
    expect(delivery.expiresAt).toBe(created.expiresAt);
    // The first send is attempt one, and the Resend key names it.
    expect(delivery.idempotencyKey).toBe(`company-invite/${INVITATION_ID}/1`);

    const pending = await invitationRow(t);
    expect(pending.state).toBe("pending");
    expect(pending.tokenHash).toBe(await hashInvitationToken(delivery.token));
    expect(pending.tokenHash).not.toBe(delivery.token);
    expect(pending.deliveryAttempt).toBe(1);
    expect(pending.lastDeliveryAt).not.toBeNull();
    expect(pending.lastDeliveryError).toBeNull();
    // Seven days from the action's clock; the row is written a tick later, so the stored window is
    // that much shorter than the constant and never longer.
    expect(pending.expiresAt).toBe(created.expiresAt);
    expect(pending.expiresAt - pending.createdAt).toBeLessThanOrEqual(INVITATION_TTL_MS);
    expect(pending.expiresAt - pending.createdAt).toBeGreaterThan(INVITATION_TTL_MS - 5_000);
    expect(pending.invitedByMembershipId).toBe(seeded.ownerMembershipId);

    // Nothing has happened to the company yet: an invitation is not a change to any replica.
    expect((await companyRow(t)).authorizationEpoch).toBe(1);
    expect(await feedRows(t)).toHaveLength(0);

    const accepted = await asInvitee(t).action(api.invitations.accept, {
      token: delivery.token,
    });
    expect(accepted).toEqual({ companyId: COMPANY_ID });

    const joined = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "user_invitee"))
        .unique();
      if (user === null) throw new Error("the invitee was never provisioned");
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_user", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("userId", user._id),
        )
        .unique();
      if (membership === null) throw new Error("no membership");
      const teamMemberships = await ctx.db
        .query("teamMemberships")
        .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
        .collect();
      const assignments = await ctx.db
        .query("roleAssignments")
        .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
        .collect();
      return { user, membership, teamMemberships, assignments };
    });

    // The identity's address is normalized on both sides, so `Ada@Example.TEST` matched and stored
    // as the same string the invitation was addressed to.
    expect(joined.user.email).toBe(INVITEE_EMAIL);
    expect(joined.membership).toMatchObject({
      state: "active",
      displayNameSnapshot: "Ada Lovelace",
      emailSnapshot: INVITEE_EMAIL,
      invitedByMembershipId: OWNER_MEMBERSHIP_ID,
    });
    expect(joined.teamMemberships).toHaveLength(1);
    expect(joined.teamMemberships[0]?.id).toBe(`${TEAM_ID}:${joined.membership.id}`);
    expect(joined.assignments).toHaveLength(1);
    expect(joined.assignments[0]).toMatchObject({ roleId: seeded.roleDocId, scope: "company" });

    // The token is consumed, and its hash stays so a late click is told so.
    const consumed = await invitationRow(t);
    expect(consumed.state).toBe("accepted");
    expect(consumed.acceptedMembershipId).toBe(joined.membership._id);
    expect(consumed.acceptedAt).not.toBeNull();
    expect(consumed.tokenHash).toBe(pending.tokenHash);

    // One run: membership, then the grants it came with. One epoch bump for the whole join.
    const company = await companyRow(t);
    expect(company.authorizationEpoch).toBe(2);
    expect(company.syncVersion).toBe(3);

    const rows = await feedRows(t);
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.entityKind)).toEqual([
      "membership",
      "teamMembership",
      "roleAssignment",
    ]);
    for (const row of rows) {
      expect(row.changeKind).toBe("upsert");
      // Company records are company-wide, and administration has no client operation behind it.
      expect(row.teamIds).toEqual([]);
      expect(row.operationId).toBeNull();
      // Acceptance is the invitee's act; the inviter is recorded on the membership itself.
      expect(row.actor).toEqual({ kind: "member", membershipId: joined.membership.id });
    }
    expect(rows[0]?.payload).toMatchObject({
      id: joined.membership.id,
      state: "active",
      emailSnapshot: INVITEE_EMAIL,
      invitedByMembershipId: OWNER_MEMBERSHIP_ID,
    });
    expect(rows[1]?.payload).toEqual({
      id: `${TEAM_ID}:${joined.membership.id}`,
      teamId: TEAM_ID,
      membershipId: joined.membership.id,
      createdAt: expect.any(Number),
    });
    expect(rows[2]?.payload).toEqual({
      id: joined.assignments[0]?.id,
      membershipId: joined.membership.id,
      roleId: ROLE_ID,
      scope: { kind: "company" },
      createdAt: expect.any(Number),
    });
  });

  it("keeps the token and its hash out of every query result and every feed payload", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const delivery = lastDelivery();
    const tokenHash = (await invitationRow(t)).tokenHash;
    await asInvitee(t).action(api.invitations.accept, { token: delivery.token });

    const listed = await asOwner(t).query(api.invitations.list, { companyId: COMPANY_ID });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      "deliveryAttempt",
      "email",
      "expiresAt",
      "id",
      "lastDeliveryAt",
      "roleIds",
      "state",
      "teamIds",
    ]);

    const page = await asOwner(t).query(api.sync.listChanges, { companyId: COMPANY_ID, cursor: 0 });

    const serialized = JSON.stringify({ listed, page });
    expect(serialized).not.toContain(delivery.token);
    expect(serialized).not.toContain(tokenHash);
    expect(serialized).not.toContain("tokenHash");
  });
});

describe("acceptance refusals", () => {
  it("refuses an expired invitation and leaves the company untouched", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const delivery = lastDelivery();

    await t.run(async (ctx) => {
      const row = await ctx.db.query("companyInvitations").first();
      if (row === null) throw new Error("no invitation");
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });

    await expect(
      asInvitee(t).action(api.invitations.accept, { token: delivery.token }),
    ).rejects.toThrow(/expired/i);

    // The refusal is total: no membership, no feed row, no epoch bump.
    const company = await companyRow(t);
    expect(company.authorizationEpoch).toBe(1);
    expect(company.syncVersion).toBe(0);
    expect(await feedRows(t)).toHaveLength(0);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("memberships").collect()).toHaveLength(2);
    });
    // Still `pending`, because the transaction that noticed the expiry rolled back with the refusal.
    expect((await invitationRow(t)).state).toBe("pending");
  });

  it("refuses a second acceptance of the same token without changing anything", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const delivery = lastDelivery();

    await asInvitee(t).action(api.invitations.accept, { token: delivery.token });
    const afterFirst = await companyRow(t);

    await expect(
      asInvitee(t).action(api.invitations.accept, { token: delivery.token }),
    ).rejects.toThrow(/already been accepted/i);

    const afterSecond = await companyRow(t);
    // Exactly one epoch bump and one version run per join, however many times the link is clicked.
    expect(afterSecond.authorizationEpoch).toBe(afterFirst.authorizationEpoch);
    expect(afterSecond.syncVersion).toBe(afterFirst.syncVersion);
    expect(await feedRows(t)).toHaveLength(3);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("memberships").collect()).toHaveLength(3);
    });
  });

  it("refuses a revoked invitation, and revoking twice is not an error", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const delivery = lastDelivery();

    await asOwner(t).mutation(api.invitations.revoke, {
      companyId: COMPANY_ID,
      invitationId: INVITATION_ID,
    });
    await asOwner(t).mutation(api.invitations.revoke, {
      companyId: COMPANY_ID,
      invitationId: INVITATION_ID,
    });
    expect((await invitationRow(t)).state).toBe("revoked");

    await expect(
      asInvitee(t).action(api.invitations.accept, { token: delivery.token }),
    ).rejects.toThrow(/revoked/i);
  });

  it("refuses revoking an invitation somebody already accepted", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    await asInvitee(t).action(api.invitations.accept, { token: lastDelivery().token });

    await expect(
      asOwner(t).mutation(api.invitations.revoke, {
        companyId: COMPANY_ID,
        invitationId: INVITATION_ID,
      }),
    ).rejects.toThrow(/already been accepted/i);
  });

  it("binds acceptance to the verified address the invitation was sent to", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const delivery = lastDelivery();

    await expect(
      asInvitee(t, { email: "grace@example.test" }).action(api.invitations.accept, {
        token: delivery.token,
      }),
    ).rejects.toThrow(/different email address/i);
    await expect(
      asInvitee(t, { emailVerified: false }).action(api.invitations.accept, {
        token: delivery.token,
      }),
    ).rejects.toThrow(/verify your email/i);
    await expect(
      asInvitee(t).action(api.invitations.accept, { token: "not-a-token" }),
    ).rejects.toThrow(/not valid/i);

    expect((await invitationRow(t)).state).toBe("pending");
  });

  it("refuses an unauthenticated acceptance", async () => {
    const t = harness();
    await seed(t);
    await invite(t);

    await expect(t.action(api.invitations.accept, { token: lastDelivery().token })).rejects.toThrow(
      /requires signing in/i,
    );
  });
});

describe("reactivation", () => {
  it("brings a membership that left back to life instead of minting a second one", async () => {
    const t = harness();
    const seeded = await seed(t);

    const previous = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: "user_invitee",
        email: INVITEE_EMAIL,
        displayName: "Ada Lovelace",
        imageUrl: null,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: "0198c0de-aaaa-7aaa-8aaa-000000000109",
        companyId: seeded.companyDocId,
        userId,
        state: "left",
        displayNameSnapshot: "Ada Lovelace",
        emailSnapshot: INVITEE_EMAIL,
        invitedByMembershipId: OWNER_MEMBERSHIP_ID,
        joinedAt: seeded.now,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      return { userId, membershipId };
    });

    await invite(t);
    await asInvitee(t).action(api.invitations.accept, { token: lastDelivery().token });

    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_company", (q) => q.eq("companyId", seeded.companyDocId))
        .collect();
      // Owner, reader, and the one that came back — attribution survives a departure and a return.
      expect(memberships).toHaveLength(3);
      const revived = await ctx.db.get(previous.membershipId);
      expect(revived?.state).toBe("active");
      expect(revived?.joinedAt).toBeGreaterThan(seeded.now);
    });

    const rows = await feedRows(t);
    expect(rows.map((row) => row.entityKind)).toEqual([
      "membership",
      "teamMembership",
      "roleAssignment",
    ]);
    expect(rows[0]?.entityId).toBe("0198c0de-aaaa-7aaa-8aaa-000000000109");
    expect((await companyRow(t)).authorizationEpoch).toBe(2);
  });

  it("refuses to let a link unlock a locked membership", async () => {
    const t = harness();
    const seeded = await seed(t);

    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: "user_invitee",
        email: INVITEE_EMAIL,
        displayName: "Ada Lovelace",
        imageUrl: null,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      await ctx.db.insert("memberships", {
        id: "0198c0de-aaaa-7aaa-8aaa-000000000110",
        companyId: seeded.companyDocId,
        userId,
        state: "locked",
        displayNameSnapshot: "Ada Lovelace",
        emailSnapshot: INVITEE_EMAIL,
        invitedByMembershipId: OWNER_MEMBERSHIP_ID,
        joinedAt: seeded.now,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
    });

    await invite(t);
    await expect(
      asInvitee(t).action(api.invitations.accept, { token: lastDelivery().token }),
    ).rejects.toThrow(/locked/i);
    expect((await invitationRow(t)).state).toBe("pending");
  });
});

describe("creation guards", () => {
  it("refuses a caller without members.invite", async () => {
    const t = harness();
    await seed(t);

    await expect(
      asReader(t).action(api.invitations.create, {
        companyId: COMPANY_ID,
        id: INVITATION_ID,
        email: INVITEE_EMAIL,
        teamIds: [],
        roleIds: [],
      }),
    ).rejects.toThrow(/members\.invite/);
    await expect(
      asReader(t).mutation(api.invitations.revoke, {
        companyId: COMPANY_ID,
        invitationId: INVITATION_ID,
      }),
    ).rejects.toThrow(/members\.invite/);
    expect(sent).toHaveLength(0);
  });

  it("refuses role grants from an inviter without roles.manage", async () => {
    const t = harness();
    const seeded = await seed(t);
    await setReaderPermissions(t, seeded.readerRoleDocId, ["members.invite"]);

    await expect(
      asReader(t).action(api.invitations.create, {
        companyId: COMPANY_ID,
        id: INVITATION_ID,
        email: INVITEE_EMAIL,
        teamIds: [],
        roleIds: [ROLE_ID],
      }),
    ).rejects.toThrow(/roles\.manage/);
    expect(sent).toHaveLength(0);
  });

  it("refuses team grants from an inviter without teams.manage", async () => {
    const t = harness();
    const seeded = await seed(t);
    await setReaderPermissions(t, seeded.readerRoleDocId, ["members.invite"]);

    await expect(
      asReader(t).action(api.invitations.create, {
        companyId: COMPANY_ID,
        id: INVITATION_ID,
        email: INVITEE_EMAIL,
        teamIds: [TEAM_ID],
        roleIds: [],
      }),
    ).rejects.toThrow(/teams\.manage/);
    expect(sent).toHaveLength(0);
  });

  it("allows grant lists when the inviter holds both manage permissions", async () => {
    const t = harness();
    const seeded = await seed(t);
    await setReaderPermissions(t, seeded.readerRoleDocId, [
      "members.invite",
      "roles.manage",
      "teams.manage",
    ]);

    await asReader(t).action(api.invitations.create, {
      companyId: COMPANY_ID,
      id: INVITATION_ID,
      email: INVITEE_EMAIL,
      teamIds: [TEAM_ID],
      roleIds: [ROLE_ID],
    });

    expect(await invitationRow(t)).toMatchObject({ teamIds: [TEAM_ID], roleIds: [ROLE_ID] });
    expect(sent).toHaveLength(1);
  });

  it("allows a plain invitation with only members.invite", async () => {
    const t = harness();
    const seeded = await seed(t);
    await setReaderPermissions(t, seeded.readerRoleDocId, ["members.invite"]);

    await asReader(t).action(api.invitations.create, {
      companyId: COMPANY_ID,
      id: INVITATION_ID,
      email: INVITEE_EMAIL,
      teamIds: [],
      roleIds: [],
    });

    expect(await invitationRow(t)).toMatchObject({ teamIds: [], roleIds: [] });
    expect(sent).toHaveLength(1);
  });

  it("refuses an empty address, a duplicate id, a second live invitation, and an existing member", async () => {
    const t = harness();
    await seed(t);

    await expect(invite(t, { email: "   " })).rejects.toThrow(/needs an email/i);
    await invite(t);
    await expect(invite(t)).rejects.toThrow(/already exists/i);
    await expect(invite(t, { id: SECOND_INVITATION_ID })).rejects.toThrow(/pending invitation/i);
    await expect(
      invite(t, { id: SECOND_INVITATION_ID, email: "owner@example.test" }),
    ).rejects.toThrow(/already a member/i);
  });

  it("refuses to promise a team or role that does not exist", async () => {
    const t = harness();
    await seed(t);

    await expect(invite(t, { teamIds: ["0198c0de-dddd-7ddd-8ddd-00000000ffff"] })).rejects.toThrow(
      /No team/,
    );
    await expect(invite(t, { roleIds: ["0198c0de-aaaa-7aaa-8aaa-00000000ffff"] })).rejects.toThrow(
      /No role/,
    );
    await t.run(async (ctx) => {
      expect(await ctx.db.query("companyInvitations").collect()).toHaveLength(0);
    });
  });

  it("skips a team that was archived between the invitation and the acceptance", async () => {
    const t = harness();
    await seed(t);
    await invite(t, { teamIds: [TEAM_ID, ARCHIVED_TEAM_ID], roleIds: [] });
    await asInvitee(t).action(api.invitations.accept, { token: lastDelivery().token });

    const rows = await feedRows(t);
    // The live team lands; the archived one is dropped rather than stranding the invitee.
    expect(rows.map((row) => row.entityKind)).toEqual(["membership", "teamMembership"]);
    expect(rows[1]?.payload).toMatchObject({ teamId: TEAM_ID });
  });
});

describe("delivery", () => {
  it("records a failed send, keeps the invitation resendable, and surfaces the failure", async () => {
    const t = harness();
    await seed(t);
    setInvitationMailer(async () => {
      throw new Error("smtp is on fire");
    });

    await expect(invite(t)).rejects.toThrow(/could not be emailed/i);

    const row = await invitationRow(t);
    expect(row.state).toBe("pending");
    expect(row.lastDeliveryError).toBe("smtp is on fire");
    expect(row.lastDeliveryAt).not.toBeNull();
  });

  it("refuses to send at all when no mailer is installed", async () => {
    const t = harness();
    await seed(t);
    setInvitationMailer(null);

    await expect(invite(t)).rejects.toThrow(/no invitation mailer/i);
    expect((await invitationRow(t)).lastDeliveryError).toMatch(/no invitation mailer/i);
  });

  it("rotates the token on resend, under a fresh idempotency key and behind a rate limit", async () => {
    const t = harness();
    await seed(t);
    await invite(t);
    const first = lastDelivery();

    // A resend on the heels of the last attempt is refused: each one invalidates the last link.
    await expect(
      asOwner(t).action(api.invitations.resend, {
        companyId: COMPANY_ID,
        invitationId: INVITATION_ID,
      }),
    ).rejects.toThrow(/wait a minute/i);

    await t.run(async (ctx) => {
      const row = await ctx.db.query("companyInvitations").first();
      if (row === null) throw new Error("no invitation");
      await ctx.db.patch(row._id, {
        lastDeliveryAt: Date.now() - INVITATION_RESEND_MIN_INTERVAL_MS - 1,
      });
    });

    await asOwner(t).action(api.invitations.resend, {
      companyId: COMPANY_ID,
      invitationId: INVITATION_ID,
    });
    const second = lastDelivery();
    expect(second.token).not.toBe(first.token);
    expect(second.deliveryAttempt).toBe(2);
    expect(second.idempotencyKey).toBe(`company-invite/${INVITATION_ID}/2`);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);

    const row = await invitationRow(t);
    expect(row.deliveryAttempt).toBe(2);
    expect(row.tokenHash).toBe(await hashInvitationToken(second.token));

    // The first link is dead: its hash is no longer anybody's.
    await expect(
      asInvitee(t).action(api.invitations.accept, { token: first.token }),
    ).rejects.toThrow(/not valid/i);
    await expect(
      asInvitee(t).action(api.invitations.accept, { token: second.token }),
    ).resolves.toEqual({ companyId: COMPANY_ID });
  });

  it("brings a lapsed invitation back with the new link, but never a revoked or accepted one", async () => {
    const t = harness();
    await seed(t);
    await invite(t);

    await t.run(async (ctx) => {
      const row = await ctx.db.query("companyInvitations").first();
      if (row === null) throw new Error("no invitation");
      await ctx.db.patch(row._id, { state: "expired", lastDeliveryAt: null });
    });
    await asOwner(t).action(api.invitations.resend, {
      companyId: COMPANY_ID,
      invitationId: INVITATION_ID,
    });
    expect((await invitationRow(t)).state).toBe("pending");
    await expect(
      asInvitee(t).action(api.invitations.accept, { token: lastDelivery().token }),
    ).resolves.toEqual({ companyId: COMPANY_ID });

    await expect(
      asOwner(t).action(api.invitations.resend, {
        companyId: COMPANY_ID,
        invitationId: INVITATION_ID,
      }),
    ).rejects.toThrow(/already been accepted/i);

    await expect(
      asOwner(t).action(api.invitations.resend, {
        companyId: COMPANY_ID,
        invitationId: SECOND_INVITATION_ID,
      }),
    ).rejects.toThrow(/No such invitation/i);
  });
});
