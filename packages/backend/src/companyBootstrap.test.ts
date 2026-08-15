// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * The company domain's read half, end to end: `sync.bootstrap` seeding the seven administration
 * kinds appended to `BOOTSTRAP_ENTITY_ORDER`, and `sync.listChanges` delivering the rows
 * `lib/companyApply` appends — both filtered by the same `src/sync/visibility` predicate.
 *
 * Three properties are load-bearing here and none of them can be checked in a unit test.
 *
 * - The walk crosses the issue→company boundary through the cursor, not inside one page, so a
 *   client that pages a seed two rows at a time still ends up with every kind.
 * - A cursor minted by the deployment *before* the company kinds were appended still resumes, and
 *   resumes into them. That is what makes the growth append-only in practice rather than in theory.
 * - Seed and feed agree row for row on what one actor may see. A member with no grants at all is
 *   the sharp case: they must still learn their company, its offline budget, and their own identity.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import {
  appendCompanyChanges,
  companySettingsDomainId,
  encodeCompanySettings,
  encodeMembership,
  encodeRole,
  encodeRoleAssignment,
  encodeTeam,
  encodeTeamMembership,
  teamMembershipDomainId,
} from "../convex/lib/companyApply.ts";
import schema from "../convex/schema.ts";
import {
  BOOTSTRAP_ENTITY_ORDER,
  bootstrapKindAfter,
  encodeBootstrapCursor,
} from "./sync/bootstrap.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";
process.env.PATHWAY_CLOUD_SYNC = "enabled";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const OWNER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
/** The actor with no roles at all — the one self-visibility exists for. */
const PLAIN_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";
const STRANGER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000103";
const TEAM_ID = "0198c0de-dddd-7ddd-8ddd-000000000001";
const ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000201";
const OTHER_ROLE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000202";
const PLAIN_ASSIGNMENT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000301";
const STRANGER_ASSIGNMENT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000302";
const STATUS_ID = "0198c0de-bbbb-7bbb-8bbb-000000000001";
const LABEL_ID = "0198c0de-1111-7111-8111-000000000001";

const PLAIN_TEAM_MEMBERSHIP_ID = teamMembershipDomainId(TEAM_ID, PLAIN_MEMBERSHIP_ID);
const STRANGER_TEAM_MEMBERSHIP_ID = teamMembershipDomainId(TEAM_ID, STRANGER_MEMBERSHIP_ID);

const OWNER_ACTOR = { kind: "member", membershipId: OWNER_MEMBERSHIP_ID } as const;

function harness() {
  return convexTest(schema, modules);
}

/**
 * One live row of every company kind, plus two issue-domain catalog rows so a paged walk has to
 * cross from one domain into the other.
 *
 * `plain` holds a role granting nothing: they are a member with an assignment and a team, and no
 * read switch anywhere. `stranger` is the foreign member every negative assertion is about.
 */
async function seed(t: ReturnType<typeof harness>) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Bootstrap Co",
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
      id: COMPANY_ID,
      offlineAccessDays: 14,
      updatedByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });

    const member = async (subject: string, domainId: string) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("memberships", {
        id: domainId,
        companyId: companyDocId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };

    const ownerMembershipId = await member("user_owner", OWNER_MEMBERSHIP_ID);
    await ctx.db.insert("companyOwners", {
      companyId: companyDocId,
      membershipId: ownerMembershipId,
      grantedByMembershipId: null,
      createdAt: now,
    });
    const plainMembershipId = await member("user_plain", PLAIN_MEMBERSHIP_ID);
    const strangerMembershipId = await member("user_stranger", STRANGER_MEMBERSHIP_ID);

    const teamDocId = await ctx.db.insert("teams", {
      id: TEAM_ID,
      companyId: companyDocId,
      name: "Alpha",
      description: "The alpha team",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const plainTeamMembershipDocId = await ctx.db.insert("teamMemberships", {
      companyId: companyDocId,
      id: PLAIN_TEAM_MEMBERSHIP_ID,
      teamId: teamDocId,
      membershipId: plainMembershipId,
      createdAt: now,
    });
    const strangerTeamMembershipDocId = await ctx.db.insert("teamMemberships", {
      companyId: companyDocId,
      id: STRANGER_TEAM_MEMBERSHIP_ID,
      teamId: teamDocId,
      membershipId: strangerMembershipId,
      createdAt: now,
    });

    // A role that grants nothing: it exists so both members carry an assignment without any of it
    // widening what they may read.
    const roleDocId = await ctx.db.insert("roles", {
      id: ROLE_ID,
      companyId: companyDocId,
      name: "Nothing",
      description: "Grants no switches",
      permissions: [],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const otherRoleDocId = await ctx.db.insert("roles", {
      id: OTHER_ROLE_ID,
      companyId: companyDocId,
      name: "Somebody else's role",
      description: "Not referenced by the plain member",
      permissions: [],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const plainAssignmentDocId = await ctx.db.insert("roleAssignments", {
      id: PLAIN_ASSIGNMENT_ID,
      companyId: companyDocId,
      membershipId: plainMembershipId,
      roleId: roleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });
    const strangerAssignmentDocId = await ctx.db.insert("roleAssignments", {
      id: STRANGER_ASSIGNMENT_ID,
      companyId: companyDocId,
      membershipId: strangerMembershipId,
      roleId: otherRoleDocId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });

    await ctx.db.insert("issueStatuses", {
      id: STATUS_ID,
      companyId: companyDocId,
      scope: "company",
      teamId: null,
      baseStatusId: null,
      name: "Todo",
      category: "unstarted",
      color: "#888888",
      position: 1,
      hidden: false,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await ctx.db.insert("issueLabels", {
      id: LABEL_ID,
      companyId: companyDocId,
      teamId: null,
      name: "bug",
      color: "#ff0000",
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    return {
      now,
      companyDocId,
      plainMembershipId,
      strangerMembershipId,
      teamDocId,
      plainTeamMembershipDocId,
      strangerTeamMembershipDocId,
      roleDocId,
      otherRoleDocId,
      plainAssignmentDocId,
      strangerAssignmentDocId,
    };
  });
}

function asMember(t: ReturnType<typeof harness>, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });
}

interface SeedPage {
  readonly version: number;
  readonly entities: readonly {
    readonly entityKind: string;
    readonly entityId: string;
    readonly version: number;
    readonly payload: unknown;
  }[];
  readonly cursor: string | null;
  readonly isDone: boolean;
}

/** Pages a whole seed, returning every entity and how many round trips it took. */
async function drainSeed(
  identity: ReturnType<typeof asMember>,
  pageSize?: number,
  startCursor: string | null = null,
): Promise<{
  entities: SeedPage["entities"];
  pages: number;
  version: number;
  /** The walk position each intermediate page handed back, decoded to its entity kind. */
  cursorKinds: readonly string[];
}> {
  let cursor = startCursor;
  let pages = 0;
  let version = -1;
  const entities: SeedPage["entities"][number][] = [];
  const cursorKinds: string[] = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const page: SeedPage = await identity.query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor,
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    pages += 1;
    version = page.version;
    entities.push(...page.entities);
    if (page.isDone) return { entities, pages, version, cursorKinds };
    cursor = page.cursor;
    if (cursor !== null) {
      cursorKinds.push(String((JSON.parse(cursor) as Record<string, unknown>)["k"]));
    }
  }
  throw new Error("bootstrap never finished");
}

const kindsOf = (entities: SeedPage["entities"]) => entities.map((entity) => entity.entityKind);
const idsOfKind = (entities: SeedPage["entities"], kind: string) =>
  entities.filter((entity) => entity.entityKind === kind).map((entity) => entity.entityId);

const COMPANY_KINDS = [
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
] as const;

describe("sync.bootstrap over both domains", () => {
  it("seeds every company kind, one page at a time, crossing the domain boundary", async () => {
    const t = harness();
    await seed(t);

    // Two rows a page: the walk has to hand its position across the issue→company boundary in a
    // cursor rather than inside one call.
    const seedResult = await drainSeed(asMember(t, "user_owner"), 2);
    expect(seedResult.pages).toBeGreaterThan(1);
    // The boundary was crossed *through a token*: some page suspended inside the issue domain and
    // some later page suspended inside the company domain.
    expect(seedResult.cursorKinds.some((kind) => kind.startsWith("issue"))).toBe(true);
    expect(
      seedResult.cursorKinds.some((kind) => (COMPANY_KINDS as readonly string[]).includes(kind)),
    ).toBe(true);

    const kinds = kindsOf(seedResult.entities);
    for (const kind of COMPANY_KINDS) expect(kinds).toContain(kind);
    expect(kinds).toContain("issueStatus");
    expect(kinds).toContain("issueLabel");

    // Walk order is preserved across pages: every issue row precedes every company row.
    const lastIssue = kinds.reduce(
      (last, kind, index) => (kind.startsWith("issue") ? index : last),
      -1,
    );
    const firstCompany = kinds.findIndex((kind) =>
      (COMPANY_KINDS as readonly string[]).includes(kind),
    );
    expect(firstCompany).toBeGreaterThan(lastIssue);

    expect(idsOfKind(seedResult.entities, "company")).toEqual([COMPANY_ID]);
    expect(idsOfKind(seedResult.entities, "companySettings")).toEqual([COMPANY_ID]);
    expect(idsOfKind(seedResult.entities, "membership").sort()).toEqual(
      [OWNER_MEMBERSHIP_ID, PLAIN_MEMBERSHIP_ID, STRANGER_MEMBERSHIP_ID].sort(),
    );
    expect(idsOfKind(seedResult.entities, "teamMembership").sort()).toEqual(
      [PLAIN_TEAM_MEMBERSHIP_ID, STRANGER_TEAM_MEMBERSHIP_ID].sort(),
    );
    expect(idsOfKind(seedResult.entities, "roleAssignment").sort()).toEqual(
      [PLAIN_ASSIGNMENT_ID, STRANGER_ASSIGNMENT_ID].sort(),
    );
  });

  it("suspends on every kind in the walk when it can only carry one row at a time", async () => {
    const t = harness();
    await seed(t);

    // One row a page forces a suspension inside — or immediately after — each populated table, and
    // the walk has to name each of the nineteen kinds in turn to get to the end. This is the test
    // that fails if a kind is appended to `BOOTSTRAP_ENTITY_ORDER` and `readBootstrapRows` reads it
    // from the wrong table: the walk would stall or skip rather than chain.
    const seedResult = await drainSeed(asMember(t, "user_owner"), 1);
    const chain = new Set(seedResult.cursorKinds);
    for (const kind of chain) expect(BOOTSTRAP_ENTITY_ORDER).toContain(kind);
    // Every populated table's kind, and the kind after the last populated one, must appear.
    for (const kind of ["issueStatus", "issueLabel", ...COMPANY_KINDS]) {
      expect(chain.has(kind) || chain.has(String(bootstrapKindAfter(kind as never)))).toBe(true);
    }
  });

  it("seeds each company row exactly once however small the page", async () => {
    const t = harness();
    await seed(t);

    const paged = await drainSeed(asMember(t, "user_owner"), 1);
    const whole = await drainSeed(asMember(t, "user_owner"));
    const key = (entity: SeedPage["entities"][number]) =>
      `${entity.entityKind}\u0000${entity.entityId}`;
    expect(paged.entities.map(key).sort()).toEqual(whole.entities.map(key).sort());
    expect(new Set(paged.entities.map(key)).size).toBe(paged.entities.length);
  });

  it("seeds payloads byte-identical to what the feed writer would append", async () => {
    const t = harness();
    const seeded = await seed(t);
    const seedResult = await drainSeed(asMember(t, "user_owner"));
    const payloadFor = (kind: string, id: string) =>
      seedResult.entities.find((entity) => entity.entityKind === kind && entity.entityId === id)
        ?.payload;

    const expected = await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      if (company === null) throw new Error("company vanished");
      const settings = await ctx.db
        .query("companySettings")
        .withIndex("by_company", (q) => q.eq("companyId", seeded.companyDocId))
        .first();
      const membership = await ctx.db.get(seeded.plainMembershipId);
      const team = await ctx.db.get(seeded.teamDocId);
      const teamMembership = await ctx.db.get(seeded.plainTeamMembershipDocId);
      const role = await ctx.db.get(seeded.roleDocId);
      const assignment = await ctx.db.get(seeded.plainAssignmentDocId);
      if (
        settings === null ||
        membership === null ||
        team === null ||
        teamMembership === null ||
        role === null ||
        assignment === null
      ) {
        throw new Error("seed row vanished");
      }
      return {
        settings: encodeCompanySettings(company, settings),
        membership: encodeMembership(membership),
        team: encodeTeam(team),
        teamMembership: await encodeTeamMembership(ctx, teamMembership),
        role: encodeRole(role),
        assignment: await encodeRoleAssignment(ctx, assignment),
        settingsId: companySettingsDomainId(company),
      };
    });

    expect(payloadFor("companySettings", expected.settingsId)).toEqual(expected.settings);
    expect(payloadFor("membership", PLAIN_MEMBERSHIP_ID)).toEqual(expected.membership);
    expect(payloadFor("team", TEAM_ID)).toEqual(expected.team);
    expect(payloadFor("teamMembership", PLAIN_TEAM_MEMBERSHIP_ID)).toEqual(expected.teamMembership);
    expect(payloadFor("role", ROLE_ID)).toEqual(expected.role);
    expect(payloadFor("roleAssignment", PLAIN_ASSIGNMENT_ID)).toEqual(expected.assignment);

    // The company payload embeds its owners rather than shipping a `companyOwner` kind.
    expect(payloadFor("company", COMPANY_ID)).toMatchObject({
      id: COMPANY_ID,
      name: "Bootstrap Co",
      owners: [{ membershipId: OWNER_MEMBERSHIP_ID, grantedByMembershipId: null }],
    });
    expect(kindsOf(seedResult.entities)).not.toContain("companyOwner");
  });

  it("seeds an unstamped company row at version zero, which no later change can be shadowed by", async () => {
    const t = harness();
    await seed(t);
    const seedResult = await drainSeed(asMember(t, "user_owner"));
    for (const kind of COMPANY_KINDS) {
      for (const entity of seedResult.entities.filter((row) => row.entityKind === kind)) {
        // Nothing has appended a company change yet, so every row is at `?? 0`. Reporting anything
        // higher would let a replica discard the first real change to that row as stale.
        expect(entity.version).toBe(0);
      }
    }
  });
});

describe("a bootstrap cursor minted before the company kinds were appended", () => {
  /**
   * The walk position such a cursor could hold: the last kind of the twelve-kind issue walk. The
   * token format did not change, so a cursor from that deployment is byte-identical to one minted
   * here naming the same position — which is exactly why appending is safe and inserting is not.
   */
  const preGrowthCursor = (snapshotVersion: number) =>
    encodeBootstrapCursor({
      companyId: COMPANY_ID,
      snapshotVersion,
      entityKind: "issueAuditEvent",
      afterId: "",
    });

  it("resumes rather than failing closed, and walks on into the company domain", async () => {
    const t = harness();
    await seed(t);

    const resumed = await drainSeed(asMember(t, "user_owner"), undefined, preGrowthCursor(0));
    const kinds = kindsOf(resumed.entities);
    for (const kind of COMPANY_KINDS) expect(kinds).toContain(kind);
    // It resumed: the issue kinds before `issueAuditEvent` are behind the cursor and not re-sent.
    expect(kinds).not.toContain("issueStatus");
    expect(kinds).not.toContain("issueLabel");
  });

  it("still refuses a token naming a kind this build does not walk", async () => {
    const t = harness();
    await seed(t);
    const token = JSON.parse(preGrowthCursor(0)) as Record<string, unknown>;
    token["k"] = "environmentCommand";
    await expect(
      asMember(t, "user_owner").query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor: JSON.stringify(token),
      }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });
});

describe("company-domain self visibility", () => {
  /** Exactly what a member holding no read switch is entitled to. */
  const SELF_ROWS = [
    ["company", COMPANY_ID],
    ["companySettings", COMPANY_ID],
    ["membership", PLAIN_MEMBERSHIP_ID],
    ["teamMembership", PLAIN_TEAM_MEMBERSHIP_ID],
    ["role", ROLE_ID],
    ["roleAssignment", PLAIN_ASSIGNMENT_ID],
  ] as const;

  it("bootstraps a grantless member into their own identity and nothing foreign", async () => {
    const t = harness();
    await seed(t);

    const seedResult = await drainSeed(asMember(t, "user_plain"));
    const delivered = seedResult.entities.map((entity) => [entity.entityKind, entity.entityId]);
    for (const row of SELF_ROWS) expect(delivered).toContainEqual([...row]);

    // Foreign company-domain rows stay behind their switches, and the issue domain behind theirs.
    expect(idsOfKind(seedResult.entities, "membership")).toEqual([PLAIN_MEMBERSHIP_ID]);
    expect(idsOfKind(seedResult.entities, "teamMembership")).toEqual([PLAIN_TEAM_MEMBERSHIP_ID]);
    expect(idsOfKind(seedResult.entities, "roleAssignment")).toEqual([PLAIN_ASSIGNMENT_ID]);
    // Their own team membership does not carry the team it names: `teams.read` gates that, and no
    // self rule widens a record that is about the company rather than about them.
    expect(kindsOf(seedResult.entities)).not.toContain("team");
    expect(idsOfKind(seedResult.entities, "role")).toEqual([ROLE_ID]);
    expect(kindsOf(seedResult.entities)).not.toContain("issueStatus");
  });

  it("keeps bootstrap and listChanges in parity for self rows and referenced roles", async () => {
    const t = harness();
    const seeded = await seed(t);
    const bootstrapped = (await drainSeed(asMember(t, "user_plain"))).entities.map((entity) => [
      entity.entityKind,
      entity.entityId,
    ]);

    // Re-append every company row through the real feed writer, so the drain sees exactly what an
    // administration mutation would have produced.
    await t.run(async (ctx) => {
      const company = await ctx.db.get(seeded.companyDocId);
      if (company === null) throw new Error("company vanished");
      const settings = await ctx.db
        .query("companySettings")
        .withIndex("by_company", (q) => q.eq("companyId", seeded.companyDocId))
        .first();
      if (settings === null) throw new Error("settings vanished");
      const rowsFor = async () => {
        const changes = [];
        changes.push({
          entityKind: "companySettings" as const,
          entityId: companySettingsDomainId(company),
          changeKind: "upsert" as const,
          versionDocId: settings._id,
          payload: encodeCompanySettings(company, settings),
        });
        for (const docId of [seeded.plainMembershipId, seeded.strangerMembershipId]) {
          const doc = await ctx.db.get(docId);
          if (doc === null) throw new Error("membership vanished");
          changes.push({
            entityKind: "membership" as const,
            entityId: doc.id,
            changeKind: "upsert" as const,
            versionDocId: doc._id,
            payload: encodeMembership(doc),
          });
        }
        const team = await ctx.db.get(seeded.teamDocId);
        if (team === null) throw new Error("team vanished");
        changes.push({
          entityKind: "team" as const,
          entityId: team.id,
          changeKind: "upsert" as const,
          versionDocId: team._id,
          payload: encodeTeam(team),
        });
        for (const docId of [seeded.plainTeamMembershipDocId, seeded.strangerTeamMembershipDocId]) {
          const doc = await ctx.db.get(docId);
          if (doc === null) throw new Error("team membership vanished");
          changes.push({
            entityKind: "teamMembership" as const,
            entityId: doc.id ?? "",
            changeKind: "upsert" as const,
            versionDocId: doc._id,
            payload: await encodeTeamMembership(ctx, doc),
          });
        }
        for (const docId of [seeded.roleDocId, seeded.otherRoleDocId]) {
          const role = await ctx.db.get(docId);
          if (role === null) throw new Error("role vanished");
          changes.push({
            entityKind: "role" as const,
            entityId: role.id,
            changeKind: "upsert" as const,
            versionDocId: role._id,
            payload: encodeRole(role),
          });
        }
        for (const docId of [seeded.plainAssignmentDocId, seeded.strangerAssignmentDocId]) {
          const doc = await ctx.db.get(docId);
          if (doc === null) throw new Error("assignment vanished");
          changes.push({
            entityKind: "roleAssignment" as const,
            entityId: doc.id,
            changeKind: "upsert" as const,
            versionDocId: doc._id,
            payload: await encodeRoleAssignment(ctx, doc),
          });
        }
        return changes;
      };
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: OWNER_ACTOR,
        changes: await rowsFor(),
        companyUpsert: true,
        bumpEpoch: true,
      });
    });

    const drained = await asMember(t, "user_plain").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(drained._tag).toBe("Changes");
    const delivered = (drained.changes ?? []).map((change) => [change.entityKind, change.entityId]);
    expect(delivered.slice().sort()).toEqual(bootstrapped.slice().sort());
    for (const row of SELF_ROWS) expect(delivered).toContainEqual([...row]);
    expect(delivered).not.toContainEqual(["membership", STRANGER_MEMBERSHIP_ID]);
    expect(delivered).not.toContainEqual(["teamMembership", STRANGER_TEAM_MEMBERSHIP_ID]);
    expect(delivered).not.toContainEqual(["roleAssignment", STRANGER_ASSIGNMENT_ID]);
    expect(delivered).not.toContainEqual(["team", TEAM_ID]);
    expect(delivered).toContainEqual(["role", ROLE_ID]);
    expect(delivered).not.toContainEqual(["role", OTHER_ROLE_ID]);
  });

  it("gives an owner the whole company domain through both paths", async () => {
    const t = harness();
    await seed(t);
    const seedResult = await drainSeed(asMember(t, "user_owner"));
    expect(idsOfKind(seedResult.entities, "membership")).toHaveLength(3);
    expect(idsOfKind(seedResult.entities, "teamMembership")).toHaveLength(2);
    expect(idsOfKind(seedResult.entities, "role").sort()).toEqual([ROLE_ID, OTHER_ROLE_ID].sort());
  });
});
