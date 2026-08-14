// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives `sync.applyOperations`, `sync.listChanges`, and `sync.bootstrap` end to end through the
 * production identity resolution: a Clerk member identity for the writer (an owner) and a second
 * member whose only role grants `issues.read` — enough to drain the feed, not enough to write.
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
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const WRITER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000101";
const READER_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000102";

const ALPHA_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000103";
const BETA_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000104";

const STATUS_ID = "0198c0de-bbbb-7bbb-8bbb-000000000001";
const STATUS_BETA_ID = "0198c0de-bbbb-7bbb-8bbb-000000000002";
const ISSUE_A = "0198c0de-cccc-7ccc-8ccc-000000000001";
const ISSUE_B = "0198c0de-cccc-7ccc-8ccc-000000000002";
const ISSUE_C = "0198c0de-cccc-7ccc-8ccc-000000000003";

const TEAM_ALPHA = "0198c0de-dddd-7ddd-8ddd-000000000001";
const TEAM_BETA = "0198c0de-dddd-7ddd-8ddd-000000000002";
const PROJECT_ALPHA = "0198c0de-ffff-7fff-8fff-000000000001";
const PROJECT_BETA = "0198c0de-ffff-7fff-8fff-000000000002";
const LABEL_BETA = "0198c0de-1111-7111-8111-000000000001";
const MILESTONE_ID = "0198c0de-2222-7222-8222-000000000001";
const RELATION_ID = "0198c0de-3333-7333-8333-000000000001";
const VIEW_ID = "0198c0de-4444-7444-8444-000000000001";

function harness() {
  return convexTest(schema, modules);
}

/** Company, an owner who can write everything, and a member whose one role grants `issues.read`. */
async function seed(t: ReturnType<typeof harness>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Sync Test Co",
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

    const writerUserId = await ctx.db.insert("users", {
      clerkSubject: "user_writer",
      email: "writer@example.test",
      displayName: "Writer",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    const writerMembershipId = await ctx.db.insert("memberships", {
      id: WRITER_MEMBERSHIP_ID,
      companyId: companyDocId,
      userId: writerUserId,
      state: "active",
      displayNameSnapshot: "Writer",
      emailSnapshot: "writer@example.test",
      invitedByMembershipId: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("companyOwners", {
      companyId: companyDocId,
      membershipId: writerMembershipId,
      grantedByMembershipId: null,
      createdAt: now,
    });

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
      invitedByMembershipId: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const readerRoleId = await ctx.db.insert("roles", {
      id: "0198c0de-aaaa-7aaa-8aaa-000000000201",
      companyId: companyDocId,
      name: "Reader",
      description: "",
      permissions: ["issues.read"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      id: "0198c0de-aaaa-7aaa-8aaa-000000000301",
      companyId: companyDocId,
      membershipId: readerMembershipId,
      roleId: readerRoleId,
      scope: "company",
      teamId: null,
      createdAt: now,
    });
  });
}

/**
 * Two teams, two team-scoped members, and a project per team. `alpha` runs its own team's work —
 * issues, workflow, projects, shared views — and holds nothing at all on `beta`, which is what makes
 * it the right actor for every cross-team refusal. `beta` only reads, so it stands in for the
 * replica a descoped change still has to reach.
 */
async function seedTeams(t: ReturnType<typeof harness>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const company = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("id"), COMPANY_ID))
      .unique();
    if (company === null) throw new Error("seed the company first");

    for (const [id, name] of [
      [TEAM_ALPHA, "Alpha"],
      [TEAM_BETA, "Beta"],
    ] as const) {
      await ctx.db.insert("teams", {
        id,
        companyId: company._id,
        name,
        description: "",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const [id, name, teamId] of [
      [PROJECT_ALPHA, "Alpha project", TEAM_ALPHA],
      [PROJECT_BETA, "Beta project", TEAM_BETA],
    ] as const) {
      await ctx.db.insert("cloudProjects", {
        id,
        companyId: company._id,
        name,
        description: "",
        teamIds: [teamId],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }

    const member = async (
      subject: string,
      membershipDomainId: string,
      teamId: string,
      permissions: ("issues.read" | "issues.create" | "issues.update" | "issues.delete")[],
      extra: ("workflow.manage" | "projects.manage" | "views.shared")[],
    ) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: membershipDomainId,
        companyId: company._id,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const roleId = await ctx.db.insert("roles", {
        id: `${membershipDomainId}-role`,
        companyId: company._id,
        name: `${subject} role`,
        description: "",
        permissions: [...permissions, ...extra],
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${membershipDomainId}-assignment`,
        companyId: company._id,
        membershipId,
        roleId,
        scope: "team",
        teamId,
        createdAt: now,
      });
    };

    await member(
      "user_alpha",
      ALPHA_MEMBERSHIP_ID,
      TEAM_ALPHA,
      ["issues.read", "issues.create", "issues.update", "issues.delete"],
      ["workflow.manage", "projects.manage", "views.shared"],
    );
    await member("user_beta", BETA_MEMBERSHIP_ID, TEAM_BETA, ["issues.read"], []);
  });
}

function asMember(t: ReturnType<typeof harness>, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });
}

const asWriter = (t: ReturnType<typeof harness>) => asMember(t, "user_writer");
const asReader = (t: ReturnType<typeof harness>) => asMember(t, "user_reader");
const asAlpha = (t: ReturnType<typeof harness>) => asMember(t, "user_alpha");
const asBeta = (t: ReturnType<typeof harness>) => asMember(t, "user_beta");

/**
 * Envelope factory: unique-per-test operation ids and sequences, everything else overridable.
 * `series` separates two actors' factories inside one test — an id reused across batches would be
 * answered from the first batch's receipt instead of being applied.
 */
function makeOps(membershipId: string, series = "0") {
  let counter = 0;
  return (kind: string, entityId: string, args: unknown) => {
    counter += 1;
    return {
      protocolVersion: 1,
      operationId: `0198c0de-eeee-7eee-8eee-${series}${String(counter).padStart(11, "0")}`,
      companyId: COMPANY_ID,
      clientId: "client-test",
      environmentId: null,
      actor: { kind: "member" as const, membershipId },
      localSequence: counter,
      baseVersion: 0,
      kind,
      entityId,
      args,
      dependsOn: [],
    };
  };
}

describe("sync.applyOperations", () => {
  it("accepted create, update, and delete write feed rows and stamp entity versions", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    // Create: a company status, then an issue placed in it. The status is one change; the issue is
    // two (its upsert plus its `created` audit event), so the batch spans versions 1..3.
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          category: "unstarted",
        }),
        op("issue.create", ISSUE_A, { title: "Fix the crash", statusId: STATUS_ID }),
      ],
    });
    expect(created.receipts).toHaveLength(2);
    expect(created.receipts[0]).toMatchObject({
      status: "accepted",
      firstVersion: 1,
      lastVersion: 1,
    });
    expect(created.receipts[1]).toMatchObject({
      status: "accepted",
      firstVersion: 2,
      lastVersion: 3,
    });
    expect(created).toMatchObject({ versionFrom: 0, versionTo: 3 });

    const afterCreate = await asWriter(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (afterCreate._tag !== "Changes") throw new Error("expected Changes");
    expect(afterCreate.changes.map((c) => [c.version, c.entityKind, c.changeKind])).toEqual([
      [1, "issueStatus", "upsert"],
      [2, "issue", "upsert"],
      [3, "issueAuditEvent", "upsert"],
    ]);
    expect(afterCreate.changes[1]?.payload).toMatchObject({
      id: ISSUE_A,
      key: "PAT-1",
      title: "Fix the crash",
      statusId: STATUS_ID,
      pullRequest: null,
    });

    // The written rows carry the versions their feed entries were assigned.
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.version).toBe(2);
    });

    // Update: the issue upsert re-ships whole, at a later version.
    const updated = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.update", ISSUE_A, { title: "Fix the crash for good" })],
    });
    expect(updated.receipts[0]).toMatchObject({ status: "accepted" });
    expect(updated.versionFrom).toBe(3);

    const afterUpdate = await asWriter(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 3,
    });
    if (afterUpdate._tag !== "Changes") throw new Error("expected Changes");
    const issueUpsert = afterUpdate.changes.find((c) => c.entityKind === "issue");
    expect(issueUpsert).toMatchObject({
      changeKind: "upsert",
      entityId: ISSUE_A,
      payload: { title: "Fix the crash for good" },
    });

    // Delete: a tombstone with no payload, and a soft-deleted row stamped at the tombstone version.
    const deleted = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.delete", ISSUE_A, {})],
    });
    expect(deleted.receipts[0]).toMatchObject({ status: "accepted" });

    const afterDelete = await asWriter(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: afterUpdate.cursor,
    });
    if (afterDelete._tag !== "Changes") throw new Error("expected Changes");
    const tombstone = afterDelete.changes.find((c) => c.changeKind === "tombstone");
    expect(tombstone).toMatchObject({ entityKind: "issue", entityId: ISSUE_A, payload: null });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.deletedAt).not.toBeNull();
      expect(issue?.version).toBe(tombstone?.version);
    });
  });

  it("a payload that fails validation receipts invalid-arguments and moves nothing", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.create", ISSUE_A, { title: "" })],
    });
    expect(result.receipts[0]).toMatchObject({ status: "rejected", code: "invalid-arguments" });
    expect(result).toMatchObject({ versionFrom: 0, versionTo: 0 });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("syncChanges").collect()).toHaveLength(0);
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
      // The refusal is receipted, so a resend replays it instead of applying.
      expect(await ctx.db.query("syncOperationReceipts").collect()).toHaveLength(1);
    });
  });

  it("an actor without the acting permission receipts permission-denied", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(READER_MEMBERSHIP_ID);

    const result = await asReader(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.create", ISSUE_A, { title: "Sneaky write" })],
    });
    expect(result.receipts[0]).toMatchObject({ status: "rejected", code: "permission-denied" });
    expect(result.receipts[0]).toMatchObject({ message: expect.stringContaining("issues.create") });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
      expect(await ctx.db.query("syncChanges").collect()).toHaveLength(0);
    });
  });

  it("an unknown operation kind receipts unknown-operation without failing the batch", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const hologram = op("hologram.create", ISSUE_A, {});
    const create = op("issue.create", ISSUE_B, { title: "Still lands", triage: true });
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [hologram, create],
    });
    // Receipts are matched by operation id, not position: the response lists accepted ones first.
    const byId = new Map(result.receipts.map((receipt) => [receipt.operationId, receipt]));
    expect(byId.get(hologram.operationId)).toMatchObject({
      status: "rejected",
      code: "unknown-operation",
    });
    expect(byId.get(create.operationId)).toMatchObject({ status: "accepted" });
  });
});

describe("tombstones in the change feed", () => {
  it("a reader drains the upsert and then the tombstone, but never the audit events", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, { title: "Doomed issue", triage: true }),
        op("issue.delete", ISSUE_A, {}),
      ],
    });

    const page = await asReader(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    if (page._tag !== "Changes") throw new Error("expected Changes");
    // The reader holds `issues.read` but not `audit.read`, so the two audit events are filtered
    // while the cursor still advances over them to the head.
    expect(page.changes.map((c) => [c.entityKind, c.changeKind])).toEqual([
      ["issue", "upsert"],
      ["issue", "tombstone"],
    ]);
    expect(page.cursor).toBe(page.latestVersion);
    expect(page.hasMore).toBe(false);
  });
});

describe("sync.bootstrap", () => {
  it("refuses a cursor token it did not mint", async () => {
    const t = harness();
    await seed(t);
    await expect(
      asWriter(t).query(api.sync.bootstrap, { companyId: COMPANY_ID, cursor: "garbage" }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });

  it("pages a filtered snapshot and hands off to listChanges without a gap", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          category: "unstarted",
        }),
        op("issue.create", ISSUE_A, { title: "First", statusId: STATUS_ID }),
        op("issue.create", ISSUE_B, { title: "Second", statusId: STATUS_ID }),
        op("issue.create", ISSUE_C, { title: "Third", statusId: STATUS_ID }),
        op("issue.delete", ISSUE_B, {}),
      ],
    });

    // Page with a tiny page size so the walk crosses tables over several calls. The annotation
    // breaks the loop-carried inference cycle between the cursor and the response type.
    interface BootstrapEnvelope {
      version: number;
      entityKind: string;
      entityId: string;
      changeKind: "upsert" | "tombstone";
      payload: unknown;
    }
    interface BootstrapPage {
      version: number;
      entities: BootstrapEnvelope[];
      cursor: string | null;
      isDone: boolean;
    }
    const entities: BootstrapEnvelope[] = [];
    let cursor: string | null = null;
    let version = -1;
    for (let page = 0; page < 32; page += 1) {
      const response: BootstrapPage = await asReader(t).query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor,
        pageSize: 2,
      });
      if (version === -1) version = response.version;
      // The snapshot version is captured on the first page and never drifts.
      expect(response.version).toBe(version);
      expect(response.entities.length).toBeLessThanOrEqual(2);
      entities.push(...response.entities);
      cursor = response.cursor;
      if (response.isDone) break;
    }
    expect(cursor).toBeNull();

    // The reader sees the status and the two live issues — not the deleted issue, and not the
    // audit events its missing `audit.read` gates.
    expect(entities.map((e) => [e.entityKind, e.entityId]).sort()).toEqual(
      [
        ["issueStatus", STATUS_ID],
        ["issue", ISSUE_A],
        ["issue", ISSUE_C],
      ].sort(),
    );
    for (const entity of entities) expect(entity.changeKind).toBe("upsert");
    // Each entity carries the feed version that last touched its row.
    const issueA = entities.find((e) => e.entityId === ISSUE_A);
    expect(issueA?.payload).toMatchObject({ title: "First", pullRequest: null });
    expect(issueA?.version).toBeGreaterThan(0);

    // The seed is consistent at `version`: a write landing after it drains incrementally from
    // there with contiguous versions — no gap between snapshot and feed.
    const later = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.update", ISSUE_C, { title: "Third, revised" })],
    });
    expect(later.versionFrom).toBe(version);

    const drained = await asReader(t).query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: version,
    });
    if (drained._tag !== "Changes") throw new Error("expected Changes");
    expect(drained.changes[0]?.version).toBe(version + 1);
    const revised = drained.changes.find((c) => c.entityKind === "issue");
    expect(revised?.payload).toMatchObject({ id: ISSUE_C, title: "Third, revised" });
  });

  it("an empty company bootstraps to done in one page, at version zero", async () => {
    const t = harness();
    await seed(t);
    const response = await asWriter(t).query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: null,
    });
    expect(response).toMatchObject({ version: 0, entities: [], cursor: null, isDone: true });
  });
});

// ---------------------------------------------------------------------------
// Cross-team and key-leasing invariants
// ---------------------------------------------------------------------------

/** The smallest configuration `issueView.create` accepts. */
const VIEW_CONFIG = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
} as const;

const byOperationId = <T extends { readonly operationId: string }>(receipts: readonly T[]) =>
  new Map(receipts.map((receipt) => [receipt.operationId, receipt]));

/** One page of what an actor can see from `cursor`. */
async function drain(identity: ReturnType<typeof asMember>, cursor: number) {
  const page = await identity.query(api.sync.listChanges, { companyId: COMPANY_ID, cursor });
  if (page._tag !== "Changes") throw new Error("expected Changes");
  return page;
}

describe("issue key assignment", () => {
  it("refuses a key far above the counter, so the counter can never mint a duplicate", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    // 2^53 + 1 survives the key pattern but not arithmetic: accepting it would park the counter on
    // a number `+ 1` cannot move, and every later create would mint that one key forever.
    const forged = op("issue.create", ISSUE_A, {
      title: "Forged key",
      triage: true,
      key: "PAT-9007199254740993",
    });
    const first = op("issue.create", ISSUE_B, { title: "First honest", triage: true });
    const second = op("issue.create", ISSUE_C, { title: "Second honest", triage: true });

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [forged, first, second],
    });
    const receipts = byOperationId(result.receipts);
    expect(receipts.get(forged.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
    });
    expect(receipts.get(first.operationId)).toMatchObject({ status: "accepted" });
    expect(receipts.get(second.operationId)).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const keys = (await ctx.db.query("issues").collect()).map((row) => row.key);
      expect([...keys].sort()).toEqual(["PAT-1", "PAT-2"]);
      const company = await ctx.db
        .query("companies")
        .filter((q) => q.eq(q.field("id"), COMPANY_ID))
        .unique();
      expect(company?.nextIssueNumber).toBe(3);
    });
  });

  it("accepts a leased key from the outstanding block and moves the counter past it", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, { title: "Leased", triage: true, key: "PAT-5" }),
        op("issue.create", ISSUE_B, { title: "Counter assigned", triage: true }),
      ],
    });
    for (const receipt of result.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const keys = (await ctx.db.query("issues").collect()).map((row) => row.key);
      expect([...keys].sort()).toEqual(["PAT-5", "PAT-6"]);
    });
  });
});

describe("issue.setTeams authorization", () => {
  /** An issue in alpha's team, created by the alpha member. */
  async function alphaIssue(t: ReturnType<typeof harness>) {
    const op = makeOps(ALPHA_MEMBERSHIP_ID, "a");
    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, { title: "Alpha work", triage: true, teamIds: [TEAM_ALPHA] }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({ status: "accepted" });
    return op;
  }

  it("refuses to attach a team the actor holds no grant on", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await alphaIssue(t);

    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.setTeams", ISSUE_A, { teamIds: [TEAM_BETA] })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "permission-denied",
      message: expect.stringContaining("issues.update"),
    });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.teamIds).toEqual([TEAM_ALPHA]);
    });
  });

  it("refuses to make an issue company-wide without a company-scoped grant", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await alphaIssue(t);

    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.setTeams", ISSUE_A, { teamIds: [] })],
    });
    expect(result.receipts[0]).toMatchObject({ status: "rejected", code: "permission-denied" });
  });

  it("still lets an actor detach a team it holds the grant on", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await alphaIssue(t);

    const widened = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        makeOps(WRITER_MEMBERSHIP_ID, "w")("issue.setTeams", ISSUE_A, {
          teamIds: [TEAM_ALPHA, TEAM_BETA],
        }),
      ],
    });
    expect(widened.receipts[0]).toMatchObject({ status: "accepted" });

    // Nothing is being attached, so alpha's own grant is enough to narrow the issue back.
    const narrowed = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.setTeams", ISSUE_A, { teamIds: [TEAM_ALPHA] })],
    });
    expect(narrowed.receipts[0]).toMatchObject({ status: "accepted" });
  });

  it("sends the move to the teams losing the issue as well as the teams gaining it", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    await alphaIssue(t);

    const before = await drain(asAlpha(t), 0);
    const moved = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        makeOps(WRITER_MEMBERSHIP_ID, "w")("issue.setTeams", ISSUE_A, { teamIds: [TEAM_BETA] }),
      ],
    });
    expect(moved.receipts[0]).toMatchObject({ status: "accepted" });

    // Alpha can no longer see the issue, which is precisely why it must receive this upsert: the
    // payload no longer names alpha, and that is what tells the replica to drop its copy. Scoped to
    // the new teams alone, alpha would keep a stale issue no later change could correct.
    const page = await drain(asAlpha(t), before.cursor);
    const upsert = page.changes.find((change) => change.entityKind === "issue");
    expect(upsert).toMatchObject({ entityId: ISSUE_A, changeKind: "upsert" });
    expect(upsert?.payload).toMatchObject({ teamIds: [TEAM_BETA] });
  });

  // The contract's own words for this operation: "removing a team atomically clears or reassigns
  // the team-scoped labels, cycles, workflow ownership, and project references it would
  // invalidate". A milestone is project-owned, so a cleared project cannot leave one behind.
  it("clears a project reference the new teams can no longer justify, and its milestone", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const setup = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueMilestone.create", MILESTONE_ID, {
          cloudProjectId: PROJECT_ALPHA,
          name: "Launch",
        }),
        op("issue.create", ISSUE_A, {
          title: "Alpha project work",
          triage: true,
          teamIds: [TEAM_ALPHA],
          projectId: PROJECT_ALPHA,
          milestoneId: MILESTONE_ID,
        }),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    const moved = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.setTeams", ISSUE_A, { teamIds: [TEAM_BETA] })],
    });
    expect(moved.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.teamIds).toEqual([TEAM_BETA]);
      expect(issue?.projectId).toBeNull();
      expect(issue?.milestoneId).toBeNull();
    });
  });
});

describe("cross-team references", () => {
  /** One issue in each team, created by the owner, who can reach both. */
  async function twoTeamIssues(t: ReturnType<typeof harness>) {
    const writer = makeOps(WRITER_MEMBERSHIP_ID, "w");
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        writer("issue.create", ISSUE_A, { title: "Alpha", triage: true, teamIds: [TEAM_ALPHA] }),
        writer("issue.create", ISSUE_B, { title: "Beta", triage: true, teamIds: [TEAM_BETA] }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return makeOps(ALPHA_MEMBERSHIP_ID, "a");
  }

  it("refuses a relation onto an unreadable issue without confirming it exists", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const alpha = await twoTeamIssues(t);

    const hidden = alpha("issueRelation.create", RELATION_ID, {
      issueId: ISSUE_A,
      relatedIssueId: ISSUE_B,
      kind: "relates",
    });
    const missing = alpha("issueRelation.create", RELATION_ID, {
      issueId: ISSUE_A,
      relatedIssueId: ISSUE_C,
      kind: "relates",
    });
    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [hidden, missing],
    });
    const receipts = byOperationId(result.receipts);
    expect(receipts.get(hidden.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: `No issue ${ISSUE_B}.`,
    });
    // Character for character the answer a genuinely absent issue gets, so the refusal is not an
    // existence oracle for another team's ids.
    expect(receipts.get(missing.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: `No issue ${ISSUE_C}.`,
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issueRelations").collect()).toHaveLength(0);
    });
  });

  it("refuses to parent an issue under one the actor cannot read", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const alpha = await twoTeamIssues(t);

    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [alpha("issue.update", ISSUE_A, { parentId: ISSUE_B })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: `No issue ${ISSUE_B}.`,
    });
  });

  it("refuses a label the issue's teams cannot justify", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const label = op("issueLabel.create", LABEL_BETA, {
      name: "Beta only",
      color: "#abc",
      teamId: TEAM_BETA,
    });
    const create = op("issue.create", ISSUE_A, {
      title: "Borrowing another team's label",
      triage: true,
      teamIds: [TEAM_ALPHA],
      labelIds: [LABEL_BETA],
    });
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [label, create],
    });
    const receipts = byOperationId(result.receipts);
    expect(receipts.get(label.operationId)).toMatchObject({ status: "accepted" });
    expect(receipts.get(create.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("another team"),
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
    });
  });

  it("refuses to close a parent chain into a cycle", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const built = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, { title: "Top", triage: true }),
        op("issue.create", ISSUE_B, { title: "Middle", triage: true }),
        op("issue.update", ISSUE_B, { parentId: ISSUE_A }),
      ],
    });
    for (const receipt of built.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    const closed = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.update", ISSUE_A, { parentId: ISSUE_B })],
    });
    expect(closed.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("already below"),
    });

    await t.run(async (ctx) => {
      const top = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(top?.parentId).toBeNull();
    });
  });
});

describe("issueStatus.delete", () => {
  it("refuses a replacement status from another workflow", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const setup = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          category: "unstarted",
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "team",
          teamId: TEAM_BETA,
          name: "Beta only",
          category: "started",
        }),
        op("issue.create", ISSUE_A, { title: "Company work", statusId: STATUS_ID }),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // Every stranded company-workflow issue would land in a status only one team's workflow has.
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueStatus.delete", STATUS_ID, { reassignToStatusId: STATUS_BETA_ID })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("different workflow"),
    });

    await t.run(async (ctx) => {
      const statuses = await ctx.db.query("issueStatuses").collect();
      expect(statuses.find((row) => row.id === STATUS_ID)?.deletedAt).toBeNull();
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_ID);
    });
  });
});

describe("issueMilestone.update", () => {
  /** A milestone on alpha's project, with one alpha issue pointing at it. */
  async function milestoneWithIssue(t: ReturnType<typeof harness>) {
    const op = makeOps(WRITER_MEMBERSHIP_ID, "w");
    const setup = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueMilestone.create", MILESTONE_ID, {
          cloudProjectId: PROJECT_ALPHA,
          name: "Launch",
        }),
        op("issue.create", ISSUE_A, {
          title: "Scheduled work",
          triage: true,
          teamIds: [TEAM_ALPHA],
          projectId: PROJECT_ALPHA,
          milestoneId: MILESTONE_ID,
        }),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return op;
  }

  it("refuses a move into a project the actor does not manage", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    await milestoneWithIssue(t);

    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        makeOps(ALPHA_MEMBERSHIP_ID, "a")("issueMilestone.update", MILESTONE_ID, {
          cloudProjectId: PROJECT_BETA,
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "permission-denied",
      message: expect.stringContaining("projects.manage"),
    });

    await t.run(async (ctx) => {
      const milestone = (await ctx.db.query("issueMilestones").collect())[0];
      expect(milestone?.cloudProjectId).toBe(PROJECT_ALPHA);
    });
  });

  it("clears the issues left behind and tells the old project's teams the milestone left", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await milestoneWithIssue(t);

    const before = await drain(asAlpha(t), 0);
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueMilestone.update", MILESTONE_ID, { cloudProjectId: PROJECT_BETA })],
    });
    expect(result.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      // A milestone is project-owned, so a cross-project reference is a state `issue.update`
      // itself refuses to write.
      expect(issue?.milestoneId).toBeNull();
      expect(issue?.projectId).toBe(PROJECT_ALPHA);
    });

    const page = await drain(asAlpha(t), before.cursor);
    const milestoneChange = page.changes.find((change) => change.entityKind === "issueMilestone");
    expect(milestoneChange).toMatchObject({ entityId: MILESTONE_ID, changeKind: "upsert" });
    const issueChange = page.changes.find((change) => change.entityKind === "issue");
    expect(issueChange?.payload).toMatchObject({ id: ISSUE_A, milestoneId: null });
  });
});

describe("issueView.update", () => {
  it("refuses to re-point a shared view at teams the actor cannot share with", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(ALPHA_MEMBERSHIP_ID, "a");

    const created = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", VIEW_ID, {
          name: "Alpha board",
          config: VIEW_CONFIG,
          visibility: "teams",
          teamIds: [TEAM_ALPHA],
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    // The visibility literal does not change, but the audience does — which is the whole act of
    // sharing.
    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.update", VIEW_ID, { teamIds: [TEAM_BETA] })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "permission-denied",
      message: expect.stringContaining("views.shared"),
    });

    await t.run(async (ctx) => {
      const view = (await ctx.db.query("issueViews").collect())[0];
      expect(view?.teamIds).toEqual([TEAM_ALPHA]);
    });
  });

  it("sends a narrowed view to the teams it was taken away from", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", VIEW_ID, {
          name: "Shared board",
          config: VIEW_CONFIG,
          visibility: "teams",
          teamIds: [TEAM_ALPHA, TEAM_BETA],
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    const before = await drain(asBeta(t), 0);
    const narrowed = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.update", VIEW_ID, { teamIds: [TEAM_ALPHA] })],
    });
    expect(narrowed.receipts[0]).toMatchObject({ status: "accepted" });

    const page = await drain(asBeta(t), before.cursor);
    const change = page.changes.find((row) => row.entityKind === "issueView");
    expect(change).toMatchObject({ entityId: VIEW_ID, changeKind: "upsert" });
    expect(change?.payload).toMatchObject({ teamIds: [TEAM_ALPHA] });
  });
});

describe("envelope identifiers", () => {
  it("refuses a batch carrying an entity id bootstrap could never deliver", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await expect(
      asWriter(t).mutation(api.sync.applyOperations, {
        companyId: COMPANY_ID,
        operations: [op("issue.create", "", { title: "Unreachable", triage: true })],
      }),
    ).rejects.toThrow("entity id");

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
    });
  });
});

describe("bootstrap cursor", () => {
  it("refuses a snapshot version this company never reached", async () => {
    const t = harness();
    await seed(t);

    // Well formed and decodes cleanly — but that version comes back as the seed's resume cursor,
    // and a client persisting it would skip every change up to it without ever knowing.
    await expect(
      asWriter(t).query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor: JSON.stringify({ v: 9_999, k: "issue", a: "" }),
      }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });
});
