// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives `convex/roles` end to end through the Convex harness.
 *
 * This is the file that decides who may read what, so the epoch assertions are the sharp end: every
 * test states whether `authorizationEpoch` moved and why. A missing bump leaves a revoked member's
 * replica serving records offline that it may no longer read; a gratuitous one throws away every
 * client's entire replica to no purpose. Feed payloads are pinned key-for-key against
 * `contracts/cloudSync`, because a mismatch surfaces on the client only as a quarantine counter.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/roles.ts": () => import("../convex/roles.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const MANAGER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const READER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const OUTSIDER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000103";
const LOCKED_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000104";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";
const ARCHIVED_TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000002";
const ROLE_ID = "0198c0de-eeee-7eee-8eee-000000000001";
const ASSIGNMENT_ID = "0198c0de-ffff-7fff-8fff-000000000001";
const OTHER_ASSIGNMENT_ID = "0198c0de-ffff-7fff-8fff-000000000002";

const MANAGER_ACTOR = { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID } as const;

/**
 * The ceiling `roles.remove` cascades under, mirrored from `convex/roles`. Kept as a literal rather
 * than imported: a Convex module's public surface is its functions, and pulling a tuning constant
 * out of one to satisfy a test would make the ceiling part of the deployment's API.
 */
const ROLE_REMOVE_MAX_ASSIGNMENTS = 500;

function harness() {
  return convexTest(schema, modules);
}

/** A manager who may administer roles, a reader who may only see them, and an outsider. */
async function seed(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Roles Co",
      issueKeyPrefix: "RC",
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
      "roles.read",
      "roles.manage",
    ]);
    const readerDocId = await member("reader", READER_MEMBERSHIP_ID, "active", ["roles.read"]);
    await member("outsider", OUTSIDER_MEMBERSHIP_ID, "active", ["issues.read"]);
    await member("locked", LOCKED_MEMBERSHIP_ID, "locked", []);

    await ctx.db.insert("teams", {
      id: TEAM_ID,
      companyId: companyDocId,
      name: "Alpha",
      description: "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teams", {
      id: ARCHIVED_TEAM_ID,
      companyId: companyDocId,
      name: "Retired",
      description: "",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return { now, companyDocId, managerDocId, readerDocId };
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

describe("personal workspace collaboration guard", () => {
  it("keeps seeded-role reads available but blocks role administration", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.companyDocId, { workspaceKind: "personal" });
    });

    expect(await asManager(t).query(api.roles.list, { companyId: COMPANY_ID })).not.toEqual([]);
    await expect(
      asManager(t).mutation(api.roles.create, {
        companyId: COMPANY_ID,
        id: ROLE_ID,
        name: "Blocked",
        permissions: [],
      }),
    ).rejects.toThrow("Upgrade this personal workspace to an organization");
  });
});

/**
 * Only the rows this file's mutations wrote. The seed inserts its cast directly, so the feed starts
 * empty and every row below is one a mutation under test chose to append.
 */
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

async function createRole(
  t: ReturnType<typeof harness>,
  permissions: readonly string[] = ["issues.read"],
) {
  await asManager(t).mutation(api.roles.create, {
    companyId: COMPANY_ID,
    id: ROLE_ID,
    name: "Reader",
    description: "Reads issues",
    permissions: [...permissions],
  });
}

async function assignRole(t: ReturnType<typeof harness>, id = ASSIGNMENT_ID) {
  await asManager(t).mutation(api.roles.assign, {
    companyId: COMPANY_ID,
    id,
    membershipId: READER_MEMBERSHIP_ID,
    assignment: { roleId: ROLE_ID, scope: { kind: "company" } },
  });
}

describe("roles.create", () => {
  it("refuses a caller holding only roles.read, an unknown switch, a blank name, and a reused id", async () => {
    const t = harness();
    await seed(t);

    await expect(
      asReader(t).mutation(api.roles.create, {
        companyId: COMPANY_ID,
        id: ROLE_ID,
        name: "Reader",
        permissions: [],
      }),
    ).rejects.toThrow("roles.manage");
    await expect(
      asManager(t).mutation(api.roles.create, {
        companyId: COMPANY_ID,
        id: ROLE_ID,
        name: "Reader",
        permissions: ["issues.telepathy"],
      }),
    ).rejects.toThrow("Unknown permission issues.telepathy");
    await expect(
      asManager(t).mutation(api.roles.create, {
        companyId: COMPANY_ID,
        id: ROLE_ID,
        name: " ",
        permissions: [],
      }),
    ).rejects.toThrow("A role needs a name");

    await createRole(t);
    await expect(createRole(t)).rejects.toThrow("already exists");
    expect(await feedRows(t)).toHaveLength(1);
  });

  it("writes the role, appends one upsert, de-duplicates switches, and leaves the epoch alone", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t, ["issues.read", "issues.read", "comments.create"]);

    const rows = await feedRows(t);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error("expected a change row");
    expect(row).toMatchObject({
      version: 1,
      entityKind: "role",
      entityId: ROLE_ID,
      changeKind: "upsert",
      operationId: null,
      actor: MANAGER_ACTOR,
    });
    expect(row.teamIds).toEqual([]);
    // Field-for-field with `SyncRolePayload` in `contracts/cloudSync`.
    expect(Object.keys(row.payload ?? {}).sort()).toEqual([
      "createdAt",
      "description",
      "id",
      "name",
      "permissions",
      "seeded",
      "updatedAt",
    ]);
    expect(row.payload).toMatchObject({
      id: ROLE_ID,
      name: "Reader",
      permissions: ["issues.read", "comments.create"],
      // Provenance, not similarity: only the bundles a company is created with are seeded.
      seeded: false,
    });

    // An unassigned role is a definition nobody resolves through.
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
    await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ROLE_ID),
        )
        .unique();
      expect(role?.version).toBe(1);
    });
  });
});

describe("roles.update", () => {
  it("bumps the epoch when the switches change", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t, ["issues.read"]);

    await asManager(t).mutation(api.roles.update, {
      companyId: COMPANY_ID,
      roleId: ROLE_ID,
      permissions: ["issues.read", "issues.delete"],
    });

    const rows = await feedRows(t);
    expect(rows[1]).toMatchObject({ entityKind: "role", changeKind: "upsert" });
    expect(rows[1]?.payload).toMatchObject({ permissions: ["issues.read", "issues.delete"] });
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);
  });

  it("does not bump for a rename, nor for the same set re-sent in another order", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t, ["issues.read", "comments.create"]);

    await asManager(t).mutation(api.roles.update, {
      companyId: COMPANY_ID,
      roleId: ROLE_ID,
      name: "  Renamed  ",
      description: "Still reads issues",
    });
    // Re-sending the same switches, reordered and duplicated, resolves to the same grant.
    await asManager(t).mutation(api.roles.update, {
      companyId: COMPANY_ID,
      roleId: ROLE_ID,
      permissions: ["comments.create", "issues.read", "issues.read"],
    });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.payload).toMatchObject({ name: "Renamed", description: "Still reads issues" });
    // Three feed rows, no reseed: the rows carry the edits, the epoch carries authorization.
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });

  it("refuses an empty update, a blank name, an unknown switch, and an unknown role", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);

    await expect(
      asManager(t).mutation(api.roles.update, { companyId: COMPANY_ID, roleId: ROLE_ID }),
    ).rejects.toThrow("needs a name, description, or permissions");
    await expect(
      asManager(t).mutation(api.roles.update, { companyId: COMPANY_ID, roleId: ROLE_ID, name: "" }),
    ).rejects.toThrow("A role needs a name");
    await expect(
      asManager(t).mutation(api.roles.update, {
        companyId: COMPANY_ID,
        roleId: ROLE_ID,
        permissions: ["issues.telepathy"],
      }),
    ).rejects.toThrow("Unknown permission");
    await expect(
      asManager(t).mutation(api.roles.update, {
        companyId: COMPANY_ID,
        roleId: OTHER_ASSIGNMENT_ID,
        name: "Ghost",
      }),
    ).rejects.toThrow("No role");
    expect(await feedRows(t)).toHaveLength(1);
  });
});

describe("roles.remove", () => {
  it("cascades: every assignment is tombstoned, then the role, and the epoch bumps once", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    await assignRole(t, ASSIGNMENT_ID);
    await asManager(t).mutation(api.roles.assign, {
      companyId: COMPANY_ID,
      id: OTHER_ASSIGNMENT_ID,
      membershipId: MANAGER_MEMBERSHIP_ID,
      assignment: { roleId: ROLE_ID, scope: { kind: "team", teamId: TEAM_ID } },
    });
    const epochBefore = await epochOf(t, seeded.companyDocId);

    await asManager(t).mutation(api.roles.remove, { companyId: COMPANY_ID, roleId: ROLE_ID });

    const rows = await feedRows(t);
    const cascade = rows.slice(3);
    // Assignments first, the role last: a replica folding the page in order never holds an
    // assignment naming a role it has already dropped.
    expect(cascade.map((row) => [row.entityKind, row.entityId, row.changeKind])).toEqual([
      ["roleAssignment", ASSIGNMENT_ID, "tombstone"],
      ["roleAssignment", OTHER_ASSIGNMENT_ID, "tombstone"],
      ["role", ROLE_ID, "tombstone"],
    ]);
    expect(cascade.every((row) => row.payload === null)).toBe(true);
    // One bump for the whole cascade — it is one transaction, and one reseed answers all of it.
    expect(await epochOf(t, seeded.companyDocId)).toBe((epochBefore ?? 0) + 1);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("roles").withIndex("by_company").collect()).toHaveLength(
        // The three seeded cast roles survive; only the one under test is gone.
        3,
      );
      const orphans = await ctx.db.query("roleAssignments").collect();
      expect(orphans.map((row) => row.id)).not.toContain(ASSIGNMENT_ID);
      expect(orphans.map((row) => row.id)).not.toContain(OTHER_ASSIGNMENT_ID);
    });
  });

  it("still bumps the epoch for an unassigned role, so a re-created id cannot inherit its grants", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);

    await asManager(t).mutation(api.roles.remove, { companyId: COMPANY_ID, roleId: ROLE_ID });
    const rows = await feedRows(t);
    expect(rows[1]).toMatchObject({ entityKind: "role", changeKind: "tombstone", payload: null });
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);
  });

  it("refuses a cascade past the ceiling instead of half-applying one", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);

    await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ROLE_ID),
        )
        .unique();
      if (role === null) throw new Error("seed the role first");
      for (let index = 0; index <= ROLE_REMOVE_MAX_ASSIGNMENTS; index += 1) {
        await ctx.db.insert("roleAssignments", {
          id: `0198c0de-9999-7999-8999-${String(index).padStart(12, "0")}`,
          companyId: seeded.companyDocId,
          membershipId: seeded.readerDocId,
          roleId: role._id,
          scope: "company",
          teamId: null,
          createdAt: seeded.now,
        });
      }
    });

    await expect(
      asManager(t).mutation(api.roles.remove, { companyId: COMPANY_ID, roleId: ROLE_ID }),
    ).rejects.toThrow(`more than ${ROLE_REMOVE_MAX_ASSIGNMENTS} assignments`);
    // Nothing partial: the role, its assignments, the feed, and the epoch are all untouched.
    expect(await feedRows(t)).toHaveLength(1);
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
    await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ROLE_ID),
        )
        .unique();
      expect(role).not.toBeNull();
    });
  });

  it("refuses a caller holding only roles.read", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);
    await expect(
      asReader(t).mutation(api.roles.remove, { companyId: COMPANY_ID, roleId: ROLE_ID }),
    ).rejects.toThrow("roles.manage");
  });
});

describe("roles.assign", () => {
  it("writes the grant, encodes company scope as the tagged union, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    await assignRole(t);

    const rows = await feedRows(t);
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect(row).toMatchObject({
      entityKind: "roleAssignment",
      entityId: ASSIGNMENT_ID,
      changeKind: "upsert",
      actor: MANAGER_ACTOR,
    });
    // Field-for-field with `SyncRoleAssignmentPayload` in `contracts/cloudSync`.
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "membershipId",
      "roleId",
      "scope",
    ]);
    expect(row?.payload).toMatchObject({
      id: ASSIGNMENT_ID,
      membershipId: READER_MEMBERSHIP_ID,
      roleId: ROLE_ID,
      // Storage splits scope into a literal plus a nullable team; the wire re-joins them.
      scope: { kind: "company" },
    });
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);
    await t.run(async (ctx) => {
      const assignment = await ctx.db
        .query("roleAssignments")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ASSIGNMENT_ID),
        )
        .unique();
      expect(assignment).toMatchObject({ scope: "company", teamId: null, version: 2 });
    });
  });

  it("carries the team through a team-scoped grant", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);
    await asManager(t).mutation(api.roles.assign, {
      companyId: COMPANY_ID,
      id: ASSIGNMENT_ID,
      membershipId: READER_MEMBERSHIP_ID,
      assignment: { roleId: ROLE_ID, scope: { kind: "team", teamId: TEAM_ID } },
    });

    const rows = await feedRows(t);
    expect(rows[1]?.payload).toMatchObject({ scope: { kind: "team", teamId: TEAM_ID } });
  });

  it("treats a retry under the same id as done and a second id for the same grant as an error", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    await assignRole(t, ASSIGNMENT_ID);

    // Same id, same triple: the caller's own write arriving twice.
    await assignRole(t, ASSIGNMENT_ID);
    expect(await feedRows(t)).toHaveLength(2);
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);

    // A different id for a grant that already resolves would leave `unassign` unable to revoke it.
    await expect(assignRole(t, OTHER_ASSIGNMENT_ID)).rejects.toThrow("already assigned");
    expect(await feedRows(t)).toHaveLength(2);
  });

  it("refuses a reader, a blank id, a locked or unknown membership, and an unknown or archived team", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    const grant = (
      identity: ReturnType<typeof asManager>,
      overrides: {
        id?: string;
        membershipId?: string;
        scope?: { kind: "company" } | { kind: "team"; teamId: string };
      },
    ) =>
      identity.mutation(api.roles.assign, {
        companyId: COMPANY_ID,
        id: overrides.id ?? ASSIGNMENT_ID,
        membershipId: overrides.membershipId ?? READER_MEMBERSHIP_ID,
        assignment: { roleId: ROLE_ID, scope: overrides.scope ?? { kind: "company" } },
      });

    await expect(grant(asReader(t), {})).rejects.toThrow("roles.manage");
    await expect(grant(asManager(t), { id: "" })).rejects.toThrow("A role assignment id must be");
    await expect(grant(asManager(t), { membershipId: LOCKED_MEMBERSHIP_ID })).rejects.toThrow(
      "not active",
    );
    await expect(
      grant(asManager(t), { membershipId: "0198c0de-0000-7000-8000-000000000009" }),
    ).rejects.toThrow("No membership");
    await expect(
      grant(asManager(t), {
        scope: { kind: "team", teamId: "0198c0de-0000-7000-8000-00000000000a" },
      }),
    ).rejects.toThrow("No team");
    await expect(
      grant(asManager(t), { scope: { kind: "team", teamId: ARCHIVED_TEAM_ID } }),
    ).rejects.toThrow("archived team");
    await expect(
      asManager(t).mutation(api.roles.assign, {
        companyId: COMPANY_ID,
        id: ASSIGNMENT_ID,
        membershipId: READER_MEMBERSHIP_ID,
        assignment: {
          roleId: "0198c0de-0000-7000-8000-00000000000b",
          scope: { kind: "company" },
        },
      }),
    ).rejects.toThrow("No role");

    expect(await feedRows(t)).toHaveLength(1);
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });
});

describe("roles.unassign", () => {
  it("deletes the grant, tombstones it, and bumps the epoch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    await assignRole(t);

    await asManager(t).mutation(api.roles.unassign, {
      companyId: COMPANY_ID,
      assignmentId: ASSIGNMENT_ID,
    });

    const rows = await feedRows(t);
    expect(rows[2]).toMatchObject({
      entityKind: "roleAssignment",
      entityId: ASSIGNMENT_ID,
      changeKind: "tombstone",
      payload: null,
    });
    // The revocation itself: without the bump nothing tells the client to purge what it holds.
    expect(await epochOf(t, seeded.companyDocId)).toBe(3);
    await t.run(async (ctx) => {
      const gone = await ctx.db
        .query("roleAssignments")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ASSIGNMENT_ID),
        )
        .unique();
      expect(gone).toBeNull();
    });
  });

  it("unassigning something already gone appends nothing and bumps nothing", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);

    await asManager(t).mutation(api.roles.unassign, {
      companyId: COMPANY_ID,
      assignmentId: ASSIGNMENT_ID,
    });
    expect(await feedRows(t)).toHaveLength(1);
    expect(await epochOf(t, seeded.companyDocId)).toBe(1);
  });

  it("refuses a caller holding only roles.read", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);
    await assignRole(t);
    await expect(
      asReader(t).mutation(api.roles.unassign, {
        companyId: COMPANY_ID,
        assignmentId: ASSIGNMENT_ID,
      }),
    ).rejects.toThrow("roles.manage");
  });
});

describe("draining role administration off the change feed", () => {
  it("a roles.read member sees the role and a foreign assignment; an outsider sees neither", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);
    // Assigned to the manager, not the reader, so the reader's grant is what delivers the row
    // rather than the own-rows carve-out in `sync/visibility`.
    await asManager(t).mutation(api.roles.assign, {
      companyId: COMPANY_ID,
      id: ASSIGNMENT_ID,
      membershipId: MANAGER_MEMBERSHIP_ID,
      assignment: { roleId: ROLE_ID, scope: { kind: "company" } },
    });

    const page = await asReader(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (page._tag !== "Changes") throw new Error("expected Changes");
    expect(page.changes.map((change) => [change.entityKind, change.changeKind])).toEqual([
      ["role", "upsert"],
      ["roleAssignment", "upsert"],
    ]);
    expect(page.cursor).toBe(page.latestVersion);

    const outsider = await asMember(t, "outsider").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (outsider._tag !== "Changes") throw new Error("expected Changes");
    expect(outsider.changes).toEqual([]);
    expect(outsider.cursor).toBe(outsider.latestVersion);
  });
});

describe("atomic company role assignment deltas", () => {
  it("adds and removes company assignments with one epoch bump per effective batch", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);

    await asManager(t).mutation(api.roles.updateCompanyAssignments, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      additions: [{ id: ASSIGNMENT_ID, roleId: ROLE_ID }],
      removeAssignmentIds: [],
    });
    expect((await feedRows(t))[1]).toMatchObject({
      entityKind: "roleAssignment",
      entityId: ASSIGNMENT_ID,
      changeKind: "upsert",
    });
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);

    await asManager(t).mutation(api.roles.updateCompanyAssignments, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      additions: [],
      removeAssignmentIds: [ASSIGNMENT_ID],
    });
    expect((await feedRows(t))[2]).toMatchObject({
      entityId: ASSIGNMENT_ID,
      changeKind: "tombstone",
    });
    expect(await epochOf(t, seeded.companyDocId)).toBe(3);
  });

  it("is idempotent and validates duplicates, wrong membership, and inactive additions before writes", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    await asManager(t).mutation(api.roles.updateCompanyAssignments, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      additions: [{ id: ASSIGNMENT_ID, roleId: ROLE_ID }],
      removeAssignmentIds: [],
    });
    await asManager(t).mutation(api.roles.updateCompanyAssignments, {
      companyId: COMPANY_ID,
      membershipId: READER_MEMBERSHIP_ID,
      additions: [{ id: ASSIGNMENT_ID, roleId: ROLE_ID }],
      removeAssignmentIds: [],
    });
    expect(await epochOf(t, seeded.companyDocId)).toBe(2);

    await expect(
      asManager(t).mutation(api.roles.updateCompanyAssignments, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        additions: [
          { id: OTHER_ASSIGNMENT_ID, roleId: ROLE_ID },
          { id: OTHER_ASSIGNMENT_ID, roleId: ROLE_ID },
        ],
        removeAssignmentIds: [],
      }),
    ).rejects.toThrow("duplicates");
    await expect(
      asManager(t).mutation(api.roles.updateCompanyAssignments, {
        companyId: COMPANY_ID,
        membershipId: LOCKED_MEMBERSHIP_ID,
        additions: [{ id: OTHER_ASSIGNMENT_ID, roleId: ROLE_ID }],
        removeAssignmentIds: [],
      }),
    ).rejects.toThrow("not active");
    await expect(
      asManager(t).mutation(api.roles.updateCompanyAssignments, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        additions: [],
        removeAssignmentIds: ["0198c0de-cccc-7ccc-8ccc-000000000101"],
      }),
    ).rejects.toThrow("this membership's company-scoped assignments");
    expect(await feedRows(t)).toHaveLength(2);
  });

  it("refuses to remove a team-scoped assignment through the company endpoint", async () => {
    const t = harness();
    await seed(t);
    await createRole(t);
    await asManager(t).mutation(api.roles.assign, {
      companyId: COMPANY_ID,
      id: ASSIGNMENT_ID,
      membershipId: READER_MEMBERSHIP_ID,
      assignment: { roleId: ROLE_ID, scope: { kind: "team", teamId: TEAM_ID } },
    });

    await expect(
      asManager(t).mutation(api.roles.updateCompanyAssignments, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        additions: [],
        removeAssignmentIds: [ASSIGNMENT_ID],
      }),
    ).rejects.toThrow("company-scoped assignments");
  });

  it("rejects more than 500 effective removals without a partial write", async () => {
    const t = harness();
    const seeded = await seed(t);
    await createRole(t);
    const assignmentIds = await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ROLE_ID),
        )
        .unique();
      if (role === null) throw new Error("expected role");
      const ids: string[] = [];
      for (let index = 0; index <= 500; index += 1) {
        const id = `0198c0de-7777-7777-8777-${String(index).padStart(12, "0")}`;
        await ctx.db.insert("roleAssignments", {
          id,
          companyId: seeded.companyDocId,
          membershipId: seeded.readerDocId,
          roleId: role._id,
          scope: "company",
          teamId: null,
          createdAt: seeded.now,
        });
        ids.push(id);
      }
      return ids;
    });

    await expect(
      asManager(t).mutation(api.roles.updateCompanyAssignments, {
        companyId: COMPANY_ID,
        membershipId: READER_MEMBERSHIP_ID,
        additions: [],
        removeAssignmentIds: assignmentIds,
      }),
    ).rejects.toThrow("at most 500");
    expect(
      await t.run(async (ctx) => (await ctx.db.query("roleAssignments").collect()).length),
    ).toBeGreaterThanOrEqual(501);
  });
});
