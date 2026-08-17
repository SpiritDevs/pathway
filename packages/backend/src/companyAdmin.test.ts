// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives the company and membership administration surface end to end through the production
 * identity resolution, because every one of these mutations is three things at once: a write, a
 * feed append, and an authorization decision. A test that only checked the write would pass on a
 * mutation that silently never reaches a replica.
 *
 * Three properties recur and are asserted per mutation rather than once:
 *
 * - the refusal, made by the same `requireCompanyActor` / `requirePermission` path production uses;
 * - the feed row — kind, change kind, and a payload whose field list is exactly the wire contract
 *   in `contracts/cloudSync`, since a stray or missing field is not an error anywhere, it is a
 *   silently quarantined row on every client;
 * - the authorization epoch, which must move for anything that changes who authorizes and must
 *   *not* move for anything that does not, because a spurious bump costs every replica in the
 *   company a full reseed.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";
import { COMPANY_DELETION_RECOVERY_MS, OFFLINE_ACCESS_MAX_DAYS } from "./companies.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/companies.ts": () => import("../convex/companies.ts"),
  "../convex/memberships.ts": () => import("../convex/memberships.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const NEW_COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000002";
const OWNER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const ADMIN_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const READER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000103";
const ADMIN_ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000201";
const READER_ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000202";
const READER_ASSIGNMENT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000301";
const ADMIN_ASSIGNMENT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000302";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";

/** Exactly the field lists in `contracts/cloudSync`; an extra key is as much a break as a missing one. */
const COMPANY_PAYLOAD_KEYS = [
  "id",
  "name",
  "workspaceKind",
  "issueKeyPrefix",
  "lifecycleState",
  "deletionScheduledAt",
  "purgeAfter",
  "owners",
  "createdAt",
  "updatedAt",
];
const COMPANY_SETTINGS_PAYLOAD_KEYS = [
  "id",
  "offlineAccessDays",
  "updatedByMembershipId",
  "createdAt",
  "updatedAt",
];
const MEMBERSHIP_PAYLOAD_KEYS = [
  "id",
  "userId",
  "state",
  "displayNameSnapshot",
  "emailSnapshot",
  "invitedByMembershipId",
  "joinedAt",
  "createdAt",
  "updatedAt",
];

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asUser(t: Harness, subject: string, email = `${subject}@example.test`) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email,
    name: subject,
  });
}

/**
 * A company with three shapes of caller: an owner (passes everything), an admin whose role carries
 * the company and member administration switches without ownership, and a reader who may only see
 * the member list. The reader additionally sits on a team and holds the role assignment that grants
 * them `members.read`, so a departure has grant rows to tombstone.
 */
async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Admin Test Co",
      issueKeyPrefix: "ADM",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const settingsDocId = await ctx.db.insert("companySettings", {
      companyId: companyDocId,
      id: COMPANY_ID,
      offlineAccessDays: 30,
      updatedByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });

    const insertMember = async (subject: string, domainId: string, displayName: string) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: domainId,
        companyId: companyDocId,
        userId,
        state: "active",
        displayNameSnapshot: displayName,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, membershipId };
    };

    const owner = await insertMember("user_owner", OWNER_MEMBERSHIP_ID, "Owner");
    await ctx.db.insert("companyOwners", {
      companyId: companyDocId,
      membershipId: owner.membershipId,
      grantedByMembershipId: null,
      createdAt: now,
    });
    const admin = await insertMember("user_admin", ADMIN_MEMBERSHIP_ID, "Admin");
    const reader = await insertMember("user_reader", READER_MEMBERSHIP_ID, "Reader");

    const adminRoleDocId = await ctx.db.insert("roles", {
      id: ADMIN_ROLE_ID,
      companyId: companyDocId,
      name: "Administrator",
      description: "",
      permissions: ["company.manage", "members.manage", "members.read", "teams.read"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const readerRoleDocId = await ctx.db.insert("roles", {
      id: READER_ROLE_ID,
      companyId: companyDocId,
      name: "Reader",
      description: "",
      permissions: ["members.read"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      id: ADMIN_ASSIGNMENT_ID,
      companyId: companyDocId,
      membershipId: admin.membershipId,
      roleId: adminRoleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      id: READER_ASSIGNMENT_ID,
      companyId: companyDocId,
      membershipId: reader.membershipId,
      roleId: readerRoleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });

    const teamDocId = await ctx.db.insert("teams", {
      id: TEAM_ID,
      companyId: companyDocId,
      name: "Alpha",
      description: "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMemberships", {
      companyId: companyDocId,
      id: `${TEAM_ID}:${READER_MEMBERSHIP_ID}`,
      teamId: teamDocId,
      membershipId: reader.membershipId,
      createdAt: now,
    });

    return {
      now,
      companyDocId,
      settingsDocId,
      ownerMembershipDocId: owner.membershipId,
      adminMembershipDocId: admin.membershipId,
      readerMembershipDocId: reader.membershipId,
      teamDocId,
      readerRoleDocId,
      adminRoleDocId,
    };
  });
}

async function feedRows(t: Harness) {
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
        actor: row.actor,
        operationId: row.operationId,
        payload: row.payload as Record<string, unknown> | null,
      }));
  });
}

async function companyState(t: Harness) {
  return await t.run(async (ctx) => {
    const company = await ctx.db
      .query("companies")
      .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
      .unique();
    return company;
  });
}

// ---------------------------------------------------------------------------
// companies.provisionCurrentUser / companies.create
// ---------------------------------------------------------------------------

describe("companies.provisionCurrentUser", () => {
  it("lets background repair report a missing workspace without silently creating one", async () => {
    const t = harness();

    await expect(
      asUser(t, "user_legacy").mutation(api.companies.repairCurrentUserWorkspace, {}),
    ).resolves.toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.db.query("users").collect()).toEqual([]);
      expect(await ctx.db.query("companies").collect()).toEqual([]);
    });
  });

  it("bootstraps a whole company in one transaction and appends every row to its own feed", async () => {
    const t = harness();

    const summary = await asUser(t, "user_new", "ada@example.test").mutation(
      api.companies.provisionCurrentUser,
      {},
    );
    expect(summary).toMatchObject({
      name: "user_new's Workspace",
      workspaceKind: "personal",
      isOwner: true,
    });
    // Settings, the founder's membership, three roles, six workflow statuses, and the company
    // itself all land before provisioning returns. A fresh company must accept its first issue.
    expect(summary.syncVersion).toBe(12);
    expect(summary.authorizationEpoch).toBe(1);

    const rows = await feedRows(t);
    expect(rows.map((row) => row.entityKind)).toEqual([
      "companySettings",
      "membership",
      "role",
      "role",
      "role",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "company",
    ]);
    // Every company record is company-wide, which is what forces a company-scoped read grant.
    expect(rows.every((row) => row.teamIds.length === 0)).toBe(true);
    // Administration is online-only: no client operation stands behind any of these.
    expect(rows.every((row) => row.operationId === null)).toBe(true);
    expect(rows.every((row) => row.actor.kind === "member")).toBe(true);

    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "user_new"))
        .unique();
      expect(user?.email).toBe("ada@example.test");
      const roles = await ctx.db.query("roles").collect();
      expect(roles.map((role) => role.name).sort()).toEqual(["Admin", "Manager", "Member"]);
      // Seeded is provenance only; they stay ordinary editable roles.
      expect(roles.every((role) => role.seeded)).toBe(true);
      const statuses = await ctx.db.query("issueStatuses").collect();
      expect(
        statuses
          .slice()
          .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
          .map((status) => status.name),
      ).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
      expect(statuses.every((status) => status.scope === "company" && !status.hidden)).toBe(true);
      const settings = await ctx.db.query("companySettings").collect();
      expect(settings[0]?.offlineAccessDays).toBe(30);
      const owners = await ctx.db.query("companyOwners").collect();
      expect(owners).toHaveLength(1);
    });
  });

  /** Called on every sign-in, so a second call must converge rather than accumulate companies. */
  it("is idempotent: a second sign-in returns the same company and appends nothing", async () => {
    const t = harness();
    const first = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {});
    const before = await feedRows(t);

    const second = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {});
    expect(second).toEqual(first);
    expect(await feedRows(t)).toEqual(before);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("companies").collect()).toHaveLength(1);
    });
  });

  it("uses an explicit onboarding kind and name, then upgrades the same workspace in place", async () => {
    const t = harness();
    const personal = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {
      workspaceKind: "personal",
      workspaceName: "Ada's Space",
    });
    expect(personal).toMatchObject({
      name: "Ada's Space",
      workspaceKind: "personal",
      isOwner: true,
    });

    const organization = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {
      workspaceKind: "organization",
      workspaceName: "Analytical Engines",
    });
    expect(organization).toMatchObject({
      id: personal.id,
      membershipId: personal.membershipId,
      name: "Analytical Engines",
      workspaceKind: "organization",
    });
    expect(organization.syncVersion).toBe(personal.syncVersion + 1);

    const retry = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {
      workspaceKind: "organization",
      workspaceName: "A retry must not rename an established organization",
    });
    expect(retry).toEqual(organization);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("companies").collect()).toHaveLength(1);
    });
  });

  it("treats a legacy missing kind as organization and never downgrades it to personal", async () => {
    const t = harness();
    await seed(t);

    const personal = await asUser(t, "user_owner").mutation(api.companies.provisionCurrentUser, {
      workspaceKind: "personal",
      workspaceName: "Private Space",
    });
    expect(personal).toMatchObject({ workspaceKind: "personal", name: "Private Space" });
    expect(personal.id).not.toBe(COMPANY_ID);

    await t.run(async (ctx) => {
      const legacy = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      expect(legacy?.workspaceKind).toBeUndefined();
      expect(legacy?.name).toBe("Admin Test Co");
    });
  });

  it("repairs an existing company whose workflow predates default status seeding", async () => {
    const t = harness();
    await seed(t);

    const summary = await asUser(t, "user_owner").mutation(api.companies.provisionCurrentUser, {});
    expect(summary).toMatchObject({
      id: COMPANY_ID,
      workspaceKind: "organization",
      syncVersion: 7,
    });
    expect((await feedRows(t)).map((row) => row.entityKind)).toEqual([
      "company",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
      "issueStatus",
    ]);

    const second = await asUser(t, "user_owner").mutation(api.companies.provisionCurrentUser, {});
    expect(second).toEqual(summary);
    expect(await feedRows(t)).toHaveLength(7);
  });

  it("refuses a caller Convex could not authenticate", async () => {
    const t = harness();
    await expect(t.mutation(api.companies.provisionCurrentUser, {})).rejects.toThrow(
      "Provisioning requires a signed-in identity.",
    );
  });
});

describe("companies.create", () => {
  it("refuses a signed-in identity that has never been provisioned", async () => {
    const t = harness();
    await expect(
      asUser(t, "user_ghost").mutation(api.companies.create, {
        id: NEW_COMPANY_ID,
        name: "Second Co",
      }),
    ).rejects.toThrow("Provision the user before creating a company.");
  });

  it("creates a second company owned by the caller, on the caller's own domain id", async () => {
    const t = harness();
    await seed(t);

    const summary = await asUser(t, "user_owner").mutation(api.companies.create, {
      id: NEW_COMPANY_ID,
      name: "  Second Co  ",
      issueKeyPrefix: "sec",
    });
    expect(summary).toMatchObject({
      id: NEW_COMPANY_ID,
      name: "Second Co",
      workspaceKind: "organization",
      // Normalized on the way in: the prefix is the permanent human half of every issue key.
      issueKeyPrefix: "SEC",
      isOwner: true,
    });
    // The new company's feed is its own; the seeded company's head never moved.
    expect((await companyState(t))?.syncVersion).toBe(0);

    const rows = await feedRows(t);
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)).toMatchObject({ entityKind: "company", entityId: NEW_COMPANY_ID });
  });

  it("derives a prefix from the name when the caller supplies none", async () => {
    const t = harness();
    await seed(t);
    const summary = await asUser(t, "user_owner").mutation(api.companies.create, {
      id: NEW_COMPANY_ID,
      name: "Second Co",
    });
    expect(summary.issueKeyPrefix).toBe("SEC");
  });

  it("refuses a blank name and a prefix that normalizes away", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.companies.create, { id: NEW_COMPANY_ID, name: "   " }),
    ).rejects.toThrow("A company needs a name.");
    await expect(
      asUser(t, "user_owner").mutation(api.companies.create, {
        id: NEW_COMPANY_ID,
        name: "Second Co",
        issueKeyPrefix: "!!!",
      }),
    ).rejects.toThrow("An issue key prefix needs at least one character.");
  });

  /**
   * A client retrying a create it never saw the answer to sends the same id. Refusing is the only
   * safe resolution: handing back a company the caller may not even own would be worse than an error.
   */
  it("refuses a domain id that already names a company instead of adopting it", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.companies.create, { id: COMPANY_ID, name: "Clash Co" }),
    ).rejects.toThrow(`Company ${COMPANY_ID} already exists.`);
    expect(await feedRows(t)).toHaveLength(0);
  });
});

describe("companies.upgradeToOrganization", () => {
  it("upgrades a personal workspace once, keeps its identity, and applies the organization name", async () => {
    const t = harness();
    const personal = await asUser(t, "user_new").mutation(api.companies.provisionCurrentUser, {
      workspaceKind: "personal",
    });
    const before = await feedRows(t);

    const upgraded = await asUser(t, "user_new").mutation(api.companies.upgradeToOrganization, {
      companyId: personal.id,
      name: "  New Organization  ",
    });
    expect(upgraded).toMatchObject({
      id: personal.id,
      membershipId: personal.membershipId,
      workspaceKind: "organization",
      name: "New Organization",
    });
    expect(upgraded.syncVersion).toBe(personal.syncVersion + 1);
    expect((await feedRows(t)).slice(before.length)).toHaveLength(1);

    const retry = await asUser(t, "user_new").mutation(api.companies.upgradeToOrganization, {
      companyId: personal.id,
      name: "Ignored retry name",
    });
    expect(retry).toEqual(upgraded);
    expect((await feedRows(t)).slice(before.length)).toHaveLength(1);
  });

  it("requires company management permission and a non-blank name", async () => {
    const t = harness();
    await seed(t);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      if (company !== null) await ctx.db.patch(company._id, { workspaceKind: "personal" });
    });

    await expect(
      asUser(t, "user_reader").mutation(api.companies.upgradeToOrganization, {
        companyId: COMPANY_ID,
        name: "Readers Cannot Upgrade",
      }),
    ).rejects.toThrow("Missing permission company.manage.");
    await expect(
      asUser(t, "user_admin").mutation(api.companies.upgradeToOrganization, {
        companyId: COMPANY_ID,
        name: "   ",
      }),
    ).rejects.toThrow("A workspace needs a name.");
  });

  it("is the one-way door for ownership and membership administration", async () => {
    const t = harness();
    await seed(t);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      if (company !== null) await ctx.db.patch(company._id, { workspaceKind: "personal" });
    });

    await expect(
      asUser(t, "user_owner").mutation(api.companies.addOwner, {
        companyId: COMPANY_ID,
        membershipId: ADMIN_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("Upgrade this personal workspace to an organization");
    await expect(
      asUser(t, "user_admin").mutation(api.memberships.setState, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        state: "locked",
      }),
    ).rejects.toThrow("Upgrade this personal workspace to an organization");

    await asUser(t, "user_owner").mutation(api.companies.upgradeToOrganization, {
      companyId: COMPANY_ID,
      name: "Upgraded Co",
    });
    await asUser(t, "user_owner").mutation(api.companies.addOwner, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
    });
    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      state: "locked",
    });
  });
});

// ---------------------------------------------------------------------------
// companies.rename / setOfflineAccessDays
// ---------------------------------------------------------------------------

describe("companies.rename", () => {
  it("refuses a caller without company.manage", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_reader").mutation(api.companies.rename, {
        companyId: COMPANY_ID,
        name: "Renamed",
      }),
    ).rejects.toThrow("Missing permission company.manage.");
    expect(await feedRows(t)).toHaveLength(0);
  });

  /** The one company change that is not authorization-relevant, so replicas must not be reseeded. */
  it("emits a company upsert carrying the new name, and leaves the epoch alone", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "user_admin").mutation(api.companies.rename, {
      companyId: COMPANY_ID,
      name: "  Renamed Co  ",
    });

    const [row] = await feedRows(t);
    expect(row).toMatchObject({
      version: 1,
      entityKind: "company",
      entityId: COMPANY_ID,
      changeKind: "upsert",
      actor: { kind: "member", membershipId: ADMIN_MEMBERSHIP_ID },
    });
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual([...COMPANY_PAYLOAD_KEYS].sort());
    expect(row?.payload).toMatchObject({ name: "Renamed Co" });

    const company = await companyState(t);
    expect(company?.name).toBe("Renamed Co");
    expect(company?.authorizationEpoch).toBe(1);
    expect(company?.syncVersion).toBe(1);
  });

  it("appends nothing when the name is already what was asked for", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_admin").mutation(api.companies.rename, {
      companyId: COMPANY_ID,
      name: "Admin Test Co",
    });
    expect(await feedRows(t)).toHaveLength(0);
  });
});

describe("companies.setOfflineAccessDays", () => {
  it("refuses a caller without company.manage", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_reader").mutation(api.companies.setOfflineAccessDays, {
        companyId: COMPANY_ID,
        days: 7,
      }),
    ).rejects.toThrow("Missing permission company.manage.");
  });

  it("clamps to the policy range, emits a companySettings upsert, and leaves the epoch alone", async () => {
    const t = harness();
    const seeded = await seed(t);

    await asUser(t, "user_admin").mutation(api.companies.setOfflineAccessDays, {
      companyId: COMPANY_ID,
      days: 500,
    });

    const [row] = await feedRows(t);
    expect(row).toMatchObject({
      entityKind: "companySettings",
      // Settings are a singleton per company and borrow its identity rather than mint a second one.
      entityId: COMPANY_ID,
      changeKind: "upsert",
    });
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual(
      [...COMPANY_SETTINGS_PAYLOAD_KEYS].sort(),
    );
    expect(row?.payload).toMatchObject({
      offlineAccessDays: OFFLINE_ACCESS_MAX_DAYS,
      updatedByMembershipId: ADMIN_MEMBERSHIP_ID,
    });

    await t.run(async (ctx) => {
      const settings = await ctx.db.get(seeded.settingsDocId);
      expect(settings?.offlineAccessDays).toBe(OFFLINE_ACCESS_MAX_DAYS);
      // The row is stamped with the version its feed entry carries, closing the seed→drain handoff.
      expect(settings?.version).toBe(1);
    });
    // A retention dial is not an authorization change; every client refreshes its grant anyway.
    expect((await companyState(t))?.authorizationEpoch).toBe(1);
  });

  it("appends nothing when the setting is already at the requested value", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_admin").mutation(api.companies.setOfflineAccessDays, {
      companyId: COMPANY_ID,
      days: 30,
    });
    expect(await feedRows(t)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe("companies.addOwner", () => {
  it("refuses an admin who is not an owner: company.manage does not confer ownership", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_admin").mutation(api.companies.addOwner, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("Only an owner may grant ownership.");
  });

  it("refuses to make a locked membership an owner", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.readerMembershipDocId, { state: "locked" });
    });
    await expect(
      asUser(t, "user_owner").mutation(api.companies.addOwner, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("Only an active member may be made an owner");
  });

  it("delivers the grant by re-emitting the company, and bumps the epoch", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "user_owner").mutation(api.companies.addOwner, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
    });

    const [row] = await feedRows(t);
    // `companyOwner` has no wire kind of its own — ownership rides the company payload, so there is
    // no window in which a replica holds an owner whose company row disagrees.
    expect(row).toMatchObject({ entityKind: "company", changeKind: "upsert" });
    const owners = (row?.payload?.owners ?? []) as ReadonlyArray<Record<string, unknown>>;
    expect(owners.map((owner) => owner.membershipId).sort()).toEqual(
      [OWNER_MEMBERSHIP_ID, ADMIN_MEMBERSHIP_ID].sort(),
    );
    expect(owners.find((owner) => owner.membershipId === ADMIN_MEMBERSHIP_ID)).toMatchObject({
      grantedByMembershipId: OWNER_MEMBERSHIP_ID,
    });
    // Ownership passes every authorization check, so every replica must re-evaluate.
    expect((await companyState(t))?.authorizationEpoch).toBe(2);
  });

  it("is idempotent: a repeated grant produces neither a second owner row nor a second bump", async () => {
    const t = harness();
    await seed(t);
    const grant = () =>
      asUser(t, "user_owner").mutation(api.companies.addOwner, {
        companyId: COMPANY_ID,
        membershipId: ADMIN_MEMBERSHIP_ID,
      });
    await grant();
    await grant();

    expect(await feedRows(t)).toHaveLength(1);
    expect((await companyState(t))?.authorizationEpoch).toBe(2);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("companyOwners").collect()).toHaveLength(2);
    });
  });
});

describe("companies.removeOwner", () => {
  it("refuses to remove the last active owner", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.companies.removeOwner, {
        companyId: COMPANY_ID,
        membershipId: OWNER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("A company must always have at least one active owner.");
    expect(await feedRows(t)).toHaveLength(0);
    expect((await companyState(t))?.authorizationEpoch).toBe(1);
  });

  it("re-emits the company without the revoked owner, and bumps the epoch", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_owner").mutation(api.companies.addOwner, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
    });

    await asUser(t, "user_admin").mutation(api.companies.removeOwner, {
      companyId: COMPANY_ID,
      membershipId: OWNER_MEMBERSHIP_ID,
    });

    const rows = await feedRows(t);
    expect(rows.map((row) => row.entityKind)).toEqual(["company", "company"]);
    const owners = (rows.at(-1)?.payload?.owners ?? []) as ReadonlyArray<Record<string, unknown>>;
    expect(owners.map((owner) => owner.membershipId)).toEqual([ADMIN_MEMBERSHIP_ID]);
    expect((await companyState(t))?.authorizationEpoch).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("companies.scheduleDeletion and restore", () => {
  it("refuses a non-owner", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_admin").mutation(api.companies.scheduleDeletion, { companyId: COMPANY_ID }),
    ).rejects.toThrow("Only an owner may delete a company.");
  });

  it("marks the company, emits the change, bumps the epoch, and closes every company function", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "user_owner").mutation(api.companies.scheduleDeletion, {
      companyId: COMPANY_ID,
    });

    const [row] = await feedRows(t);
    expect(row).toMatchObject({ entityKind: "company", changeKind: "upsert" });
    expect(row?.payload).toMatchObject({ lifecycleState: "deletionScheduled" });
    const company = await companyState(t);
    expect(company?.authorizationEpoch).toBe(2);
    expect(company?.deletionScheduledAt).not.toBeNull();
    expect(company?.purgeAfter).toBe(
      (company?.deletionScheduledAt ?? 0) + COMPANY_DELETION_RECOVERY_MS,
    );

    // Access is disabled immediately: `requireCompanyActor` refuses a non-active company, which is
    // what makes a second schedule impossible and `restore` the only way back in.
    await expect(
      asUser(t, "user_owner").mutation(api.companies.scheduleDeletion, { companyId: COMPANY_ID }),
    ).rejects.toThrow("scheduled for deletion");
    await expect(
      asUser(t, "user_admin").mutation(api.companies.rename, {
        companyId: COMPANY_ID,
        name: "Nope",
      }),
    ).rejects.toThrow("scheduled for deletion");
  });

  it("restores inside the window for an owner and refuses everybody else", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_owner").mutation(api.companies.scheduleDeletion, {
      companyId: COMPANY_ID,
    });

    // Ownership is not substitutable by `company.manage`: scheduling was owner-only, so undoing is.
    await expect(
      asUser(t, "user_admin").mutation(api.companies.restore, { companyId: COMPANY_ID }),
    ).rejects.toThrow("Only an owner may restore a company.");
    await expect(t.mutation(api.companies.restore, { companyId: COMPANY_ID })).rejects.toThrow(
      "Restoring a company requires a signed-in user.",
    );

    await asUser(t, "user_owner").mutation(api.companies.restore, { companyId: COMPANY_ID });

    const rows = await feedRows(t);
    expect(rows.map((row) => row.entityKind)).toEqual(["company", "company"]);
    expect(rows.at(-1)?.payload).toMatchObject({
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
    });
    expect((await companyState(t))?.authorizationEpoch).toBe(3);
    // And the company is usable again.
    await asUser(t, "user_admin").mutation(api.companies.rename, {
      companyId: COMPANY_ID,
      name: "Back",
    });
  });

  it("refuses a restore once the recovery window has closed, purge job or no purge job", async () => {
    const t = harness();
    const seeded = await seed(t);
    await asUser(t, "user_owner").mutation(api.companies.scheduleDeletion, {
      companyId: COMPANY_ID,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.companyDocId, { purgeAfter: Date.now() - 1 });
    });

    await expect(
      asUser(t, "user_owner").mutation(api.companies.restore, { companyId: COMPANY_ID }),
    ).rejects.toThrow("The recovery window for this company has closed.");
  });
});

// ---------------------------------------------------------------------------
// memberships
// ---------------------------------------------------------------------------

describe("memberships.list", () => {
  it("refuses a caller without members.read and joins owners and teams for one who has it", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      // Strip the reader's only grant so the refusal is about `members.read` and nothing else.
      await ctx.db.patch(seeded.readerRoleDocId, { permissions: [] });
    });
    await expect(
      asUser(t, "user_reader").query(api.memberships.list, { companyId: COMPANY_ID }),
    ).rejects.toThrow("Missing permission members.read.");

    const listed = await asUser(t, "user_admin").query(api.memberships.list, {
      companyId: COMPANY_ID,
    });
    expect(
      listed.map((member) => [member.id, member.isOwner, member.teamIds] as const).sort(),
    ).toEqual(
      [
        [OWNER_MEMBERSHIP_ID, true, []],
        [ADMIN_MEMBERSHIP_ID, false, []],
        [READER_MEMBERSHIP_ID, false, [TEAM_ID]],
      ].sort(),
    );
  });
});

describe("memberships.setState", () => {
  it("refuses a caller without members.manage", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_reader").mutation(api.memberships.setState, {
        companyId: COMPANY_ID,
        membershipId: ADMIN_MEMBERSHIP_ID,
        state: "locked",
      }),
    ).rejects.toThrow("Missing permission members.manage.");
  });

  it("locks a member, emits the membership upsert, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);

    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      state: "locked",
    });

    const [row] = await feedRows(t);
    expect(row).toMatchObject({
      entityKind: "membership",
      entityId: READER_MEMBERSHIP_ID,
      changeKind: "upsert",
      teamIds: [],
    });
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual([...MEMBERSHIP_PAYLOAD_KEYS].sort());
    expect(row?.payload).toMatchObject({ state: "locked" });
    // No secret and no Convex-internal field ever reaches the wire.
    expect(row?.payload).not.toHaveProperty("companyId");
    expect(row?.payload).not.toHaveProperty("_id");

    expect((await companyState(t))?.authorizationEpoch).toBe(2);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(seeded.readerMembershipDocId))?.version).toBe(1);
    });
    // A locked member resolves to no actor at all, not to an actor with no permissions.
    await expect(
      asUser(t, "user_reader").query(api.memberships.list, { companyId: COMPANY_ID }),
    ).rejects.toThrow("You are not an active member of this company.");
  });

  /** Unlocking hands authorization back, which only a reseed makes true on a live replica. */
  it("bumps the epoch in the unlocking direction too", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.readerMembershipDocId, { state: "locked" });
    });

    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      state: "active",
    });
    expect((await companyState(t))?.authorizationEpoch).toBe(2);
    expect((await feedRows(t))[0]?.payload).toMatchObject({ state: "active" });
  });

  /** `members.manage` is enough to lock anybody; the last-owner rule is what stops this one. */
  it("refuses to lock the last active owner, and appends nothing when it does", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_admin").mutation(api.memberships.setState, {
        companyId: COMPANY_ID,
        membershipId: OWNER_MEMBERSHIP_ID,
        state: "locked",
      }),
    ).rejects.toThrow("A company must always have at least one active owner.");
    expect(await feedRows(t)).toHaveLength(0);
    expect((await companyState(t))?.authorizationEpoch).toBe(1);
  });

  it("refuses to reinstate a membership that has left", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_admin").mutation(api.memberships.remove, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });
    await expect(
      asUser(t, "user_admin").mutation(api.memberships.setState, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        state: "active",
      }),
    ).rejects.toThrow("restored by invitation");
  });

  it("appends nothing when the membership is already in the requested state", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      state: "active",
    });
    expect(await feedRows(t)).toHaveLength(0);
  });
});

describe("memberships.remove", () => {
  it("refuses a caller without members.manage", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_reader").mutation(api.memberships.remove, {
        companyId: COMPANY_ID,
        membershipId: ADMIN_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("Missing permission members.manage.");
  });

  /**
   * The membership itself is an upsert in `left` state, not a tombstone: the snapshots on the row
   * are the only thing that keeps "assigned to" and "commented by" naming a person after they go.
   * What is tombstoned is everything that existed solely to grant them something.
   */
  it("tombstones the grants, keeps the membership as a left upsert, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);

    await asUser(t, "user_admin").mutation(api.memberships.remove, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
    });

    const rows = await feedRows(t);
    expect(rows.map((row) => [row.entityKind, row.changeKind])).toEqual([
      ["teamMembership", "tombstone"],
      ["roleAssignment", "tombstone"],
      ["membership", "upsert"],
    ]);
    // The tombstone has to name the id the upsert used, or the replica keeps a phantom member.
    expect(rows[0]?.entityId).toBe(`${TEAM_ID}:${READER_MEMBERSHIP_ID}`);
    expect(rows[0]?.payload).toBeNull();
    expect(rows[1]?.entityId).toBe(READER_ASSIGNMENT_ID);
    expect(rows[2]?.payload).toMatchObject({
      id: READER_MEMBERSHIP_ID,
      state: "left",
      // Attribution survives the departure; that is the entire point of the snapshot columns.
      displayNameSnapshot: "Reader",
      emailSnapshot: "user_reader@example.test",
    });
    expect((await companyState(t))?.authorizationEpoch).toBe(2);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("teamMemberships").collect()).toHaveLength(0);
      // Only the departed member's assignment went; the admin's is untouched.
      const assignments = await ctx.db.query("roleAssignments").collect();
      expect(assignments.map((assignment) => assignment.id)).toEqual([ADMIN_ASSIGNMENT_ID]);
      expect((await ctx.db.get(seeded.readerMembershipDocId))?.state).toBe("left");
    });
    await expect(
      asUser(t, "user_reader").query(api.memberships.list, { companyId: COMPANY_ID }),
    ).rejects.toThrow("You are not an active member of this company.");
  });

  it("re-emits the company when the departing member was an owner", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "user_owner").mutation(api.companies.addOwner, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
    });

    await asUser(t, "user_admin").mutation(api.memberships.remove, {
      companyId: COMPANY_ID,
      membershipId: OWNER_MEMBERSHIP_ID,
    });

    const rows = await feedRows(t);
    expect(rows.map((row) => row.entityKind)).toEqual(["company", "membership", "company"]);
    const owners = (rows.at(-1)?.payload?.owners ?? []) as ReadonlyArray<Record<string, unknown>>;
    expect(owners.map((owner) => owner.membershipId)).toEqual([ADMIN_MEMBERSHIP_ID]);
  });

  it("refuses to remove the last active owner", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_admin").mutation(api.memberships.remove, {
        companyId: COMPANY_ID,
        membershipId: OWNER_MEMBERSHIP_ID,
      }),
    ).rejects.toThrow("A company must always have at least one active owner.");
    expect(await feedRows(t)).toHaveLength(0);
  });

  it("is idempotent: removing a membership that has already left appends nothing", async () => {
    const t = harness();
    await seed(t);
    const remove = () =>
      asUser(t, "user_admin").mutation(api.memberships.remove, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
      });
    await remove();
    await remove();
    expect(await feedRows(t)).toHaveLength(3);
    expect((await companyState(t))?.authorizationEpoch).toBe(2);
  });

  it("refuses a membership that belongs to no company of this name", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_admin").mutation(api.memberships.remove, {
        companyId: COMPANY_ID,
        membershipId: "0198c0de-aaaa-7aaa-8aaa-000000000909",
      }),
    ).rejects.toThrow("No such membership in this company.");
  });
});

describe("memberships.leave", () => {
  it("takes the same departure path for the caller's own membership", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "user_reader").mutation(api.memberships.leave, { companyId: COMPANY_ID });

    const rows = await feedRows(t);
    expect(rows.map((row) => [row.entityKind, row.changeKind])).toEqual([
      ["teamMembership", "tombstone"],
      ["roleAssignment", "tombstone"],
      ["membership", "upsert"],
    ]);
    // Attributed to the person who left, not to whoever happens to be administering.
    expect(rows.map((row) => row.actor)).toEqual(
      rows.map(() => ({ kind: "member", membershipId: READER_MEMBERSHIP_ID })),
    );
    expect((await companyState(t))?.authorizationEpoch).toBe(2);
  });

  it("hits the same last-owner protection as removal", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.memberships.leave, { companyId: COMPANY_ID }),
    ).rejects.toThrow("A company must always have at least one active owner.");
    expect(await feedRows(t)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The whole point: an administration write reaching a replica
// ---------------------------------------------------------------------------

describe("company administration through the change feed", () => {
  /**
   * The end-to-end claim phase 4 exists to make: an online-only administration mutation becomes a
   * feed row a permitted client drains and folds into its offline read cache. `members.read` is the
   * gate, and it is the same predicate `sync.bootstrap` uses, so a seed and a drain cannot disagree.
   */
  it("delivers a membership change to a reader holding members.read", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
      state: "locked",
    });

    const page = await asUser(t, "user_reader").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(page._tag).toBe("Changes");
    if (page._tag !== "Changes") return;
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      version: 1,
      entityKind: "membership",
      entityId: ADMIN_MEMBERSHIP_ID,
      changeKind: "upsert",
    });
    expect((page.changes[0]?.payload as Record<string, unknown> | undefined)?.state).toBe("locked");
    expect(page.cursor).toBe(1);
    // The epoch rides the page, so the reader learns it must reseed from the same response.
    expect(page.authorizationEpoch).toBe(2);
  });

  /**
   * The same row withheld from a caller who lacks the switch. Company records are company-wide
   * (`teamIds: []`), so only a company-scoped grant reaches them — the cursor still advances, which
   * is what stops an unreadable row from wedging a client's drain forever.
   */
  it("withholds it from a reader whose grant does not cover members.read", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.readerRoleDocId, { permissions: ["issues.read"] });
    });

    await asUser(t, "user_admin").mutation(api.memberships.setState, {
      companyId: COMPANY_ID,
      membershipId: ADMIN_MEMBERSHIP_ID,
      state: "locked",
    });

    const page = await asUser(t, "user_reader").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(page._tag).toBe("Changes");
    if (page._tag !== "Changes") return;
    expect(page.changes).toHaveLength(0);
    expect(page.cursor).toBe(1);
  });
});
