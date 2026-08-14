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
import { encodeBootstrapCursor } from "./sync/bootstrap.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";
process.env.PATHWAY_CLOUD_SYNC = "enabled";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
/** A company id this harness never seeds; only ever used to mint a cursor bound elsewhere. */
const OTHER_COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-00000000000f";
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
const LABEL_COMPANY_ID = "0198c0de-1111-7111-8111-000000000002";
const CYCLE_COMPANY_ID = "0198c0de-9999-7999-8999-000000000001";
const PRIVATE_VIEW_ID = "0198c0de-4444-7444-8444-000000000002";
const MILESTONE_ID = "0198c0de-2222-7222-8222-000000000001";
const RELATION_ID = "0198c0de-3333-7333-8333-000000000001";
const VIEW_ID = "0198c0de-4444-7444-8444-000000000001";
const STATUS_THIRD_ID = "0198c0de-bbbb-7bbb-8bbb-000000000003";
const STATUS_OVERRIDE_ID = "0198c0de-bbbb-7bbb-8bbb-000000000004";
const STATUS_OTHER_OVERRIDE_ID = "0198c0de-bbbb-7bbb-8bbb-000000000005";
const STATUS_FOURTH_ID = "0198c0de-bbbb-7bbb-8bbb-000000000006";
const TODO_ID = "0198c0de-8888-7888-8888-000000000001";
const COMMENT_ID = "0198c0de-5555-7555-8555-000000000001";
const ATTACHMENT_ID = "0198c0de-6666-7666-8666-000000000001";
const ATTACHMENT_OTHER_ID = "0198c0de-6666-7666-8666-000000000002";
const THREAD_LINK_ID = "0198c0de-7777-7777-8777-000000000001";
/** A membership id no company here has ever issued. */
const GHOST_MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000909";

const ENVIRONMENT_ONE = "environment-one";
const ENVIRONMENT_TWO = "environment-two";
const ENVIRONMENT_REVOKED = "environment-revoked";
const ENVIRONMENT_THUMBPRINT = "thumbprint-environment";

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
      extra: ("workflow.manage" | "projects.read" | "projects.manage" | "views.shared")[],
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
      // No `environments.read`: alpha runs its own team's work, and reaching an environment is a
      // separate grant the seeded roles carry separately.
      ["workflow.manage", "projects.read", "projects.manage", "views.shared"],
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
          color: "#3b82f6",
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
          color: "#3b82f6",
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

interface SeedEnvelope {
  version: number;
  entityKind: string;
  entityId: string;
  changeKind: "upsert" | "tombstone";
  payload: unknown;
}
interface SeedPage {
  version: number;
  entities: SeedEnvelope[];
  cursor: string | null;
  isDone: boolean;
}

/** Everything a full bootstrap hands one actor, paged to the end. */
async function seedFor(identity: ReturnType<typeof asMember>): Promise<SeedEnvelope[]> {
  const entities: SeedEnvelope[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 64; page += 1) {
    const response: SeedPage = await identity.query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor,
    });
    entities.push(...response.entities);
    cursor = response.cursor;
    if (response.isDone) return entities;
  }
  throw new Error("bootstrap never finished");
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
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "team",
          color: "#3b82f6",
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

describe("private saved views", () => {
  /** Alpha owns the private view; alpha reads only team alpha, the reader reads the whole company. */
  async function withPrivateView(t: ReturnType<typeof harness>) {
    await seed(t);
    await seedTeams(t);
    const op = makeOps(ALPHA_MEMBERSHIP_ID, "a");
    const created = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", PRIVATE_VIEW_ID, {
          name: "Alpha's own board",
          config: VIEW_CONFIG,
          visibility: "private",
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });
    return op;
  }

  const views = (rows: readonly { entityKind: string; entityId: string }[]) =>
    rows.filter((row) => row.entityKind === "issueView").map((row) => row.entityId);

  it("delivers a private view to its owner alone, on the feed and in the seed", async () => {
    const t = harness();
    await withPrivateView(t);

    // The reader holds company-wide `issues.read` — the broadest issue grant there is — and still
    // never sees the name or configuration of somebody else's private view.
    expect(views((await drain(asReader(t), 0)).changes)).toEqual([]);
    expect(views(await seedFor(asReader(t)))).toEqual([]);
    // Nor does another team-scoped member.
    expect(views((await drain(asBeta(t), 0)).changes)).toEqual([]);
    expect(views(await seedFor(asBeta(t)))).toEqual([]);

    // The owner receives it although their only `issues.read` is scoped to one team, which the
    // view is not attached to at all.
    expect(views((await drain(asAlpha(t), 0)).changes)).toEqual([PRIVATE_VIEW_ID]);
    expect(views(await seedFor(asAlpha(t)))).toEqual([PRIVATE_VIEW_ID]);
  });

  it("withholds the tombstone of a private view from everyone but its owner", async () => {
    const t = harness();
    const op = await withPrivateView(t);

    const before = await drain(asReader(t), 0);
    const deleted = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.delete", PRIVATE_VIEW_ID, {})],
    });
    expect(deleted.receipts[0]).toMatchObject({ status: "accepted" });

    // A tombstone carries no payload, but it still says a private view exists and who owns it.
    expect(views((await drain(asReader(t), before.cursor)).changes)).toEqual([]);
    const ownerPage = await drain(asAlpha(t), 0);
    expect(ownerPage.changes.filter((row) => row.entityKind === "issueView").at(-1)).toMatchObject({
      entityId: PRIVATE_VIEW_ID,
      changeKind: "tombstone",
    });
  });

  it("stops delivering the history of a view that has since become private", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    // Company-wide when it was written, so the reader's cursor sits behind an upsert carrying the
    // whole configuration. Making it private has to take that historical row away too — a client
    // whose cursor predates the change would otherwise drain the leak on its next page.
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", VIEW_ID, {
          name: "Once shared",
          config: VIEW_CONFIG,
          visibility: "company",
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });
    expect(views((await drain(asReader(t), 0)).changes)).toEqual([VIEW_ID]);

    const madePrivate = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.update", VIEW_ID, { visibility: "private" })],
    });
    expect(madePrivate.receipts[0]).toMatchObject({ status: "accepted" });

    // Everything the reader's history still yields is one payloadless tombstone: the company-wide
    // upsert carrying the name and configuration is gone from the feed and from the seed.
    expect(
      (await drain(asReader(t), 0)).changes.filter((row) => row.entityKind === "issueView"),
    ).toMatchObject([{ entityId: VIEW_ID, changeKind: "tombstone", payload: null }]);
    expect(views(await seedFor(asReader(t)))).toEqual([]);
    // The owner keeps it: the tombstone addressed to the departing audience reaches them too, and
    // the owner-gated upsert that follows it restores the row.
    expect(
      (await drain(asWriter(t), 0)).changes
        .filter((row) => row.entityKind === "issueView")
        .map((row) => row.changeKind),
    ).toEqual(["upsert", "tombstone", "upsert"]);
    expect(views(await seedFor(asWriter(t)))).toEqual([VIEW_ID]);
  });

  it("tells a replica that already holds a shared view that it has gone private", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", VIEW_ID, {
          name: "Once shared",
          config: VIEW_CONFIG,
          visibility: "company",
        }),
      ],
    });
    // The reader drains the create, so its replica now holds the view and will keep holding it
    // until something on the feed says otherwise. Withholding the descope is not "taking it away".
    const first = await drain(asReader(t), 0);
    expect(views(first.changes)).toEqual([VIEW_ID]);

    const madePrivate = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.update", VIEW_ID, { visibility: "private" })],
    });
    expect(madePrivate.receipts[0]).toMatchObject({ status: "accepted" });

    // Draining onward from its own cursor, the reader hears that the view left — and hears it as a
    // tombstone, so the descope discloses nothing the replica did not already hold.
    expect(
      (await drain(asReader(t), first.cursor)).changes.filter(
        (row) => row.entityKind === "issueView",
      ),
    ).toMatchObject([{ entityId: VIEW_ID, changeKind: "tombstone", payload: null }]);

    // A team-scoped member who never had the company-wide view is told nothing at all: the
    // departure is scoped to the audience that is losing it, not broadcast.
    expect(views((await drain(asBeta(t), 0)).changes)).toEqual([]);
  });

  it("scopes the departure of a team-shared view to the teams it was shared with", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueView.create", VIEW_ID, {
          name: "Alpha's board",
          config: VIEW_CONFIG,
          visibility: "teams",
          teamIds: [TEAM_ALPHA],
        }),
      ],
    });
    const alphaFirst = await drain(asAlpha(t), 0);
    expect(views(alphaFirst.changes)).toEqual([VIEW_ID]);
    expect(views((await drain(asBeta(t), 0)).changes)).toEqual([]);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueView.update", VIEW_ID, { visibility: "private" })],
    });

    expect(
      (await drain(asAlpha(t), alphaFirst.cursor)).changes.filter(
        (row) => row.entityKind === "issueView",
      ),
    ).toMatchObject([{ entityId: VIEW_ID, changeKind: "tombstone", payload: null }]);
    expect(views(await seedFor(asAlpha(t)))).toEqual([]);
    // Team beta was never in the audience, so it is not in the departure either.
    expect(views((await drain(asBeta(t), 0)).changes)).toEqual([]);
  });
});

describe("company catalog visibility", () => {
  /** Company base status, company label, company cycle — the vocabulary every team board inherits. */
  async function seedCatalog(t: ReturnType<typeof harness>) {
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
        }),
        op("issueLabel.create", LABEL_COMPANY_ID, { name: "Urgent", color: "#ef4444" }),
        op("issueCycle.create", CYCLE_COMPANY_ID, {
          name: "Sprint 1",
          startDate: "2026-01-01",
          endDate: "2026-01-14",
        }),
        // A company-wide issue: the control. It is attached to no team either, and must stay
        // invisible to a team-scoped reader.
        op("issue.create", ISSUE_A, { title: "Company-wide", statusId: STATUS_ID }),
      ],
    });
    for (const receipt of result.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return op;
  }

  const kinds = (rows: readonly { entityKind: string }[]) =>
    [...new Set(rows.map((row) => row.entityKind))].sort();

  it("reaches a reader scoped to one team, on the feed and in the seed", async () => {
    const t = harness();
    await seedCatalog(t);

    // Beta reads exactly one team and owns nothing company-wide. Without the catalog it receives a
    // board whose statusId, labels, and cycles are ids it can never resolve.
    expect(kinds((await drain(asBeta(t), 0)).changes)).toEqual([
      "issueCycle",
      "issueLabel",
      "issueStatus",
    ]);
    expect(kinds(await seedFor(asBeta(t)))).toEqual(["issueCycle", "issueLabel", "issueStatus"]);
  });

  it("does not widen company-wide records generally", async () => {
    const t = harness();
    await seedCatalog(t);

    // The company-wide issue and its audit event stay behind a company-scoped grant.
    expect(kinds((await drain(asBeta(t), 0)).changes)).not.toContain("issue");
    expect(kinds(await seedFor(asBeta(t)))).not.toContain("issue");
    expect(kinds(await seedFor(asReader(t)))).toContain("issue");
  });

  it("is withheld from a member holding no issue read at all", async () => {
    const t = harness();
    await seedCatalog(t);

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_domain_id", (q) => q.eq("id", BETA_MEMBERSHIP_ID))
        .unique();
      if (membership === null) throw new Error("seed beta first");
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", membership.companyId).eq("id", `${BETA_MEMBERSHIP_ID}-role`),
        )
        .unique();
      if (role === null) throw new Error("seed beta's role first");
      await ctx.db.patch(role._id, { permissions: ["audit.read"] });
    });

    // The catalog widens *scope*, not the switch: with `issues.read` gone the statuses, labels, and
    // cycles go with it, and the audit events beta can now name are company-wide rather than team's.
    expect(kinds((await drain(asBeta(t), 0)).changes)).toEqual([]);
    expect(kinds(await seedFor(asBeta(t)))).toEqual([]);
  });
});

describe("operation decision ledger", () => {
  /** What the 90-day prune will do to receipts, done now so a resend has to survive it. */
  async function expireReceipts(t: ReturnType<typeof harness>) {
    await t.run(async (ctx) => {
      const receipts = await ctx.db.query("syncOperationReceipts").collect();
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) await ctx.db.delete(receipt._id);
    });
  }

  it("still answers an accepted operation as a duplicate once its receipt has expired", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const create = op("issueStatus.create", STATUS_ID, {
      scope: "company",
      color: "#3b82f6",
      name: "Todo",
      category: "unstarted",
    });
    const update = op("issue.create", ISSUE_A, { title: "Original", statusId: STATUS_ID });
    const first = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [create, update],
    });
    for (const receipt of first.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    const head = first.versionTo;

    // Newer state lands, exactly as it would in the 90 days a durable outbox can outlive its
    // receipt while holding an unacknowledged send.
    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.update", ISSUE_A, { title: "Newer" })],
    });
    await expireReceipts(t);

    const resent = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [create, update],
    });
    expect(resent.receipts.map((receipt) => receipt.status)).toEqual(["accepted", "accepted"]);
    expect(resent.receipts).toEqual(
      expect.arrayContaining([expect.objectContaining({ duplicate: true })]),
    );
    // Nothing was applied a second time: no new versions, no second audit event, and the newer
    // title survives instead of being overwritten by the replayed create.
    expect(resent.versionTo).toBe(resent.versionFrom);
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.title).toBe("Newer");
      const created = (await ctx.db.query("issueAuditEvents").collect()).filter(
        (row) => row.kind === "created",
      );
      expect(created).toHaveLength(1);
      expect((await ctx.db.query("companies").collect())[0]?.syncVersion).toBeGreaterThan(head);
    });
  });

  it("still refuses a rejected operation once its receipt has expired", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const doomed = op("issue.create", ISSUE_B, { title: "" });
    const first = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [doomed],
    });
    expect(first.receipts[0]).toMatchObject({ status: "rejected", code: "invalid-arguments" });
    await expireReceipts(t);

    const resent = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [doomed],
    });
    expect(resent.receipts[0]).toMatchObject({
      status: "rejected",
      duplicate: true,
      code: "invalid-arguments",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
    });
  });

  it("keeps one compact decision row per operation, whatever the outcome", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
        }),
        op("issue.create", ISSUE_B, { title: "" }),
      ],
    });

    await t.run(async (ctx) => {
      const decisions = await ctx.db.query("syncOperationDecisions").collect();
      expect(decisions.map((row) => row.status).sort()).toEqual(["accepted", "rejected"]);
      const accepted = decisions.find((row) => row.status === "accepted");
      expect(accepted?.firstVersion).toBe(1);
      expect(accepted?.lastVersion).toBe(1);
      const rejectedRow = decisions.find((row) => row.status === "rejected");
      expect(rejectedRow).toMatchObject({
        firstVersion: null,
        lastVersion: null,
        rejectionCode: "invalid-arguments",
      });
      // No retention column: the prune that clears receipts has nothing here to key on.
      expect(rejectedRow).not.toHaveProperty("retainUntil");
    });
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

    // Minted by this deployment, for this company, with an intact checksum — and still refused,
    // because that version comes back as the seed's resume cursor and a client persisting it would
    // skip every change up to it without ever knowing.
    await expect(
      asWriter(t).query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor: encodeBootstrapCursor({
          companyId: COMPANY_ID,
          snapshotVersion: 9_999,
          entityKind: "issue",
          afterId: "",
        }),
      }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });

  it("refuses a cursor bound to another company", async () => {
    const t = harness();
    await seed(t);

    await expect(
      asWriter(t).query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor: encodeBootstrapCursor({
          companyId: OTHER_COMPANY_ID,
          snapshotVersion: 0,
          entityKind: "issue",
          afterId: "",
        }),
      }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });

  it("fails closed on a corrupted walk position instead of seeding nothing", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    await asWriter(t).mutation(api.sync.applyOperations, {
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

    // A persisted cursor half-overwritten to name the last table past every id: the quiet failure
    // is `isDone` on an empty page, which the client stores as a finished — and empty — replica.
    const minted = JSON.parse(
      encodeBootstrapCursor({
        companyId: COMPANY_ID,
        snapshotVersion: 0,
        entityKind: "issueStatus",
        afterId: "",
      }),
    ) as Record<string, unknown>;
    minted["k"] = "issueAuditEvent";
    minted["a"] = "zzzzzzzz";

    await expect(
      asWriter(t).query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor: JSON.stringify(minted),
      }),
    ).rejects.toThrow("Unrecognized bootstrap cursor");
  });

  it("round-trips its own cursor across a paged seed", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
        }),
        op("issue.create", ISSUE_A, { title: "First", statusId: STATUS_ID }),
      ],
    });

    const first: SeedPage = await asWriter(t).query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: null,
      pageSize: 1,
    });
    expect(first.cursor).not.toBeNull();
    expect(JSON.parse(first.cursor ?? "{}")).toMatchObject({ c: COMPANY_ID });
    const second: SeedPage = await asWriter(t).query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: first.cursor,
      pageSize: 1,
    });
    expect(second.version).toBe(first.version);
  });
});

// ---------------------------------------------------------------------------
// Reference authorization and referential integrity
// ---------------------------------------------------------------------------

/** Uploads arrive through file storage rather than an operation, so the row is written directly. */
async function insertAttachment(
  t: ReturnType<typeof harness>,
  input: {
    readonly id: string;
    readonly issueId: string;
    readonly state: "pending" | "finalized";
  },
) {
  await t.run(async (ctx) => {
    const company = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("id"), COMPANY_ID))
      .unique();
    if (company === null) throw new Error("seed the company first");
    const now = Date.now();
    await ctx.db.insert("issueAttachments", {
      id: input.id,
      companyId: company._id,
      issueId: input.issueId,
      commentId: null,
      storageId: null,
      fileName: "screenshot.png",
      mimeType: "image/png",
      byteSize: 1024,
      checksum: "sha256-test",
      uploadedByMembershipId: null,
      state: input.state,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 0,
    });
  });
}

/** Registrations are minted by the relay's control plane, not by sync, so they are seeded here. */
async function insertRegistration(
  t: ReturnType<typeof harness>,
  input: {
    readonly environmentId: string;
    readonly state: "active" | "revoked";
    readonly permissions?: readonly ("issues.read" | "issues.update")[];
  },
) {
  await t.run(async (ctx) => {
    const company = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("id"), COMPANY_ID))
      .unique();
    if (company === null) throw new Error("seed the company first");
    const now = Date.now();
    const serviceRoleIds: string[] = [];
    if (input.permissions !== undefined) {
      const roleDomainId = `${input.environmentId}-service-role`;
      await ctx.db.insert("roles", {
        id: roleDomainId,
        companyId: company._id,
        name: `${input.environmentId} service`,
        description: "",
        permissions: [...input.permissions],
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      serviceRoleIds.push(roleDomainId);
    }
    await ctx.db.insert("environmentRegistrations", {
      id: `${input.environmentId}-registration`,
      companyId: company._id,
      environmentId: input.environmentId,
      publicKeyThumbprint: ENVIRONMENT_THUMBPRINT,
      descriptor: {},
      relayLinkState: "linked",
      managedEndpointAvailable: false,
      lastSeenAt: null,
      serviceRoleIds,
      teamIds: [],
      state: input.state,
      registeredByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** The identity shape the relay mints: environment subject bound to the registered key. */
function asEnvironment(t: ReturnType<typeof harness>, environmentId: string) {
  return t.withIdentity({
    issuer: "https://relay.example.test",
    subject: environmentId,
    tokenIdentifier: `https://relay.example.test|${environmentId}`,
    cnf: { jkt: ENVIRONMENT_THUMBPRINT },
  });
}

/** {@link makeOps} for an environment actor: the envelope is attributed to a registration. */
function makeEnvironmentOps(environmentId: string, series: string) {
  let counter = 0;
  return (kind: string, entityId: string, args: unknown) => {
    counter += 1;
    return {
      protocolVersion: 1,
      operationId: `0198c0de-eeee-7eee-8eee-${series}${String(counter).padStart(11, "0")}`,
      companyId: COMPANY_ID,
      clientId: "client-environment",
      environmentId,
      actor: { kind: "environment" as const, environmentId },
      localSequence: counter,
      baseVersion: 0,
      kind,
      entityId,
      args,
      dependsOn: [],
    };
  };
}

describe("issue project and milestone references", () => {
  it("refuses a project the actor cannot read, exactly as it refuses a missing one", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(ALPHA_MEMBERSHIP_ID, "a");

    // Alpha reaches only its own team, so beta's project is not one it may file work against.
    // Existence was the only thing checked before, and existence is not authorization.
    const hidden = op("issue.create", ISSUE_A, {
      title: "Filed against another team's project",
      triage: true,
      teamIds: [TEAM_ALPHA],
      projectId: PROJECT_BETA,
    });
    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [hidden],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      // Word for word the answer a project that never existed gets, so the refusal cannot double
      // as an existence oracle for another team's ids.
      message: `No project ${PROJECT_BETA}.`,
    });

    // Its own team's project still works, so the check refuses the reach, not the reference.
    const allowed = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_B, {
          title: "Alpha project work",
          triage: true,
          teamIds: [TEAM_ALPHA],
          projectId: PROJECT_ALPHA,
        }),
      ],
    });
    expect(allowed.receipts[0]).toMatchObject({ status: "accepted" });
  });

  it("refuses a project whose team scope the issue's teams cannot justify", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    // The owner reads every project, so only the scope rule can refuse this one: an alpha issue
    // carrying a beta-only project is a reference no alpha replica could ever resolve.
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, {
          title: "Cross-scope project",
          triage: true,
          teamIds: [TEAM_ALPHA],
          projectId: PROJECT_BETA,
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("another team"),
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(0);
    });
  });

  it("refuses an update pointing an issue at a project the actor cannot read", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const alpha = makeOps(ALPHA_MEMBERSHIP_ID, "a");

    const created = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        alpha("issue.create", ISSUE_A, {
          title: "Alpha work",
          triage: true,
          teamIds: [TEAM_ALPHA],
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [alpha("issue.update", ISSUE_A, { projectId: PROJECT_BETA })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: `No project ${PROJECT_BETA}.`,
    });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.projectId).toBeNull();
    });
  });

  it("clears a milestone the moved project leaves behind, even when the patch omits it", async () => {
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
          title: "Scheduled work",
          triage: true,
          teamIds: [TEAM_ALPHA, TEAM_BETA],
          projectId: PROJECT_ALPHA,
          milestoneId: MILESTONE_ID,
        }),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // Only the project moves. The milestone belongs to the project being left, so keeping it would
    // write exactly the cross-project pair an explicit `milestoneId` is refused for.
    const moved = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.update", ISSUE_A, { projectId: PROJECT_BETA })],
    });
    expect(moved.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.projectId).toBe(PROJECT_BETA);
      expect(issue?.milestoneId).toBeNull();
    });
  });
});

describe("issue assignee references", () => {
  it("refuses a member assignee this company cannot resolve, on create and on update", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const ghost = op("issue.create", ISSUE_A, {
      title: "Assigned to nobody",
      triage: true,
      assignee: { kind: "member", membershipId: GHOST_MEMBERSHIP_ID },
    });
    const real = op("issue.create", ISSUE_B, {
      title: "Assigned to the writer",
      triage: true,
      assignee: { kind: "member", membershipId: WRITER_MEMBERSHIP_ID },
    });
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [ghost, real],
    });
    const receipts = byOperationId(created.receipts);
    expect(receipts.get(ghost.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining(GHOST_MEMBERSHIP_ID),
    });
    expect(receipts.get(real.operationId)).toMatchObject({ status: "accepted" });

    const updated = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.update", ISSUE_B, {
          assignee: { kind: "member", membershipId: GHOST_MEMBERSHIP_ID },
        }),
      ],
    });
    expect(updated.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
    });

    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.assignee).toEqual({
        kind: "member",
        membershipId: WRITER_MEMBERSHIP_ID,
      });
    });
  });

  it("refuses new work handed to a departed membership", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    await t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").collect()).find(
        (row) => row.id === READER_MEMBERSHIP_ID,
      );
      if (membership === undefined) throw new Error("seed the reader first");
      await ctx.db.patch(membership._id, { state: "left" });
    });

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, {
          title: "Handed to somebody who left",
          triage: true,
          assignee: { kind: "member", membershipId: READER_MEMBERSHIP_ID },
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({ status: "rejected", code: "invalid-arguments" });
  });
});

describe("issues.pullRequest storage", () => {
  it("still stores and serializes an issue row written before the column existed", async () => {
    const t = harness();
    await seed(t);

    // Exactly the row phase 1 wrote — no `pullRequest` key at all. A required column fails the
    // table validator on this insert, which is the failure a rollout onto existing data would hit.
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .filter((q) => q.eq(q.field("id"), COMPANY_ID))
        .unique();
      if (company === null) throw new Error("seed the company first");
      const now = Date.now();
      await ctx.db.insert("issues", {
        id: ISSUE_A,
        companyId: company._id,
        key: "PAT-1",
        keyNumber: 1,
        title: "Phase one issue",
        description: "",
        statusId: "",
        priority: "none",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "a0",
        labelIds: [],
        dueDate: null,
        triage: true,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 0,
      });
    });

    interface BootstrapPage {
      entities: { entityId: string; payload: unknown }[];
    }
    const response: BootstrapPage = await asWriter(t).query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: null,
    });
    const issue = response.entities.find((entity) => entity.entityId === ISSUE_A);
    // The wire shape has always carried an explicit null, whatever storage holds.
    expect(issue?.payload).toMatchObject({ id: ISSUE_A, pullRequest: null });
  });
});

describe("issue.restore", () => {
  it("lands a revived issue back in a live status when its own was deleted meanwhile", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const setup = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Doing",
          category: "started",
          position: 1,
        }),
        op("issue.create", ISSUE_A, { title: "Doomed", statusId: STATUS_BETA_ID }),
        op("issue.delete", ISSUE_A, {}),
        // Status deletion deliberately skips deleted issues, so this leaves ISSUE_A pointing at a
        // tombstone nothing else will ever repair.
        op("issueStatus.delete", STATUS_BETA_ID, { reassignToStatusId: STATUS_ID }),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    const restored = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.restore", ISSUE_A, {})],
    });
    expect(restored.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.deletedAt).toBeNull();
      // The workflow's remaining status, not the tombstone it went into the bin holding.
      expect(issue?.statusId).toBe(STATUS_ID);
    });

    // Replicas are told, so a restored card is not repainted into a column they cannot resolve.
    const page = await drain(asWriter(t), 0);
    const upserts = page.changes.filter(
      (change) => change.entityKind === "issue" && change.changeKind === "upsert",
    );
    expect(upserts.at(-1)?.payload).toMatchObject({ id: ISSUE_A, statusId: STATUS_ID });
  });

  it("drops a parent and a project reference that died while the issue was deleted", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const setup = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_B, { title: "Parent", triage: true, teamIds: [TEAM_ALPHA] }),
        op("issue.create", ISSUE_A, {
          title: "Child",
          triage: true,
          teamIds: [TEAM_ALPHA],
          parentId: ISSUE_B,
          projectId: PROJECT_ALPHA,
        }),
        op("issue.delete", ISSUE_A, {}),
        op("issue.delete", ISSUE_B, {}),
      ],
    });
    for (const receipt of setup.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const project = (await ctx.db.query("cloudProjects").collect()).find(
        (row) => row.id === PROJECT_ALPHA,
      );
      if (project === undefined) throw new Error("seed the projects first");
      await ctx.db.patch(project._id, { archivedAt: Date.now() });
    });

    const restored = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.restore", ISSUE_A, {})],
    });
    expect(restored.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.parentId).toBeNull();
      expect(issue?.projectId).toBeNull();
    });
  });
});

describe("issueStatus.reorder", () => {
  /** Three company statuses in a known order. */
  async function threeStatuses(t: ReturnType<typeof harness>) {
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Todo",
          category: "unstarted",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Doing",
          category: "started",
          position: 1,
        }),
        op("issueStatus.create", STATUS_THIRD_ID, {
          scope: "company",
          color: "#3b82f6",
          name: "Done",
          category: "completed",
          position: 2,
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return op;
  }

  it("refuses a partial order, which would leave the omitted statuses tied", async () => {
    const t = harness();
    await seed(t);
    const op = await threeStatuses(t);

    // Positions are rewritten from the list, so this would put "Done" and "Todo" on 0 and 1 while
    // "Doing" kept 1 — a tie, not an order.
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.reorder", STATUS_ID, { statusIds: [STATUS_THIRD_ID, STATUS_ID] }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("every live status"),
    });

    await t.run(async (ctx) => {
      const positions = new Map(
        (await ctx.db.query("issueStatuses").collect()).map((row) => [row.id, row.position]),
      );
      expect(positions.get(STATUS_ID)).toBe(0);
      expect(positions.get(STATUS_BETA_ID)).toBe(1);
      expect(positions.get(STATUS_THIRD_ID)).toBe(2);
    });
  });

  it("refuses a list naming one status twice", async () => {
    const t = harness();
    await seed(t);
    const op = await threeStatuses(t);

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.reorder", STATUS_ID, {
          statusIds: [STATUS_ID, STATUS_ID, STATUS_BETA_ID, STATUS_THIRD_ID],
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("twice"),
    });
  });

  it("accepts the complete order and rewrites every position from it", async () => {
    const t = harness();
    await seed(t);
    const op = await threeStatuses(t);

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.reorder", STATUS_ID, {
          statusIds: [STATUS_THIRD_ID, STATUS_ID, STATUS_BETA_ID],
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const positions = new Map(
        (await ctx.db.query("issueStatuses").collect()).map((row) => [row.id, row.position]),
      );
      expect(positions.get(STATUS_THIRD_ID)).toBe(0);
      expect(positions.get(STATUS_ID)).toBe(1);
      expect(positions.get(STATUS_BETA_ID)).toBe(2);
    });
  });
});

describe("issueComment attachments", () => {
  /** One issue to hang comments off, plus a second to borrow an attachment from. */
  async function twoIssues(t: ReturnType<typeof harness>) {
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, { title: "Commented", triage: true }),
        op("issue.create", ISSUE_B, { title: "Elsewhere", triage: true }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return op;
  }

  it("refuses an attachment that is unfinished, on another issue, or named twice", async () => {
    const t = harness();
    await seed(t);
    const op = await twoIssues(t);
    await insertAttachment(t, { id: ATTACHMENT_ID, issueId: ISSUE_A, state: "pending" });
    await insertAttachment(t, {
      id: ATTACHMENT_OTHER_ID,
      issueId: ISSUE_B,
      state: "finalized",
    });

    const unfinished = op("issueComment.create", COMMENT_ID, {
      issueId: ISSUE_A,
      body: "See the shot",
      attachmentIds: [ATTACHMENT_ID],
    });
    const foreign = op("issueComment.create", COMMENT_ID, {
      issueId: ISSUE_A,
      body: "Borrowed from another issue",
      attachmentIds: [ATTACHMENT_OTHER_ID],
    });
    const doubled = op("issueComment.create", COMMENT_ID, {
      issueId: ISSUE_A,
      body: "Twice",
      attachmentIds: [ATTACHMENT_OTHER_ID, ATTACHMENT_OTHER_ID],
    });
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [unfinished, foreign, doubled],
    });
    const receipts = byOperationId(result.receipts);
    for (const operation of [unfinished, foreign, doubled]) {
      expect(receipts.get(operation.operationId)).toMatchObject({
        status: "rejected",
        code: "invalid-arguments",
      });
    }

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issueComments").collect()).toHaveLength(0);
    });
  });

  it("binds the attachment to the comment and releases it when the edit drops it", async () => {
    const t = harness();
    await seed(t);
    const op = await twoIssues(t);
    await insertAttachment(t, { id: ATTACHMENT_ID, issueId: ISSUE_A, state: "finalized" });

    const before = await drain(asWriter(t), 0);
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueComment.create", COMMENT_ID, {
          issueId: ISSUE_A,
          body: "See the shot",
          attachmentIds: [ATTACHMENT_ID],
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const attachment = (await ctx.db.query("issueAttachments").collect())[0];
      // The back-reference is what tells the upload collector this file is spoken for.
      expect(attachment?.commentId).toBe(COMMENT_ID);
    });
    const attached = await drain(asWriter(t), before.cursor);
    expect(
      attached.changes.find((change) => change.entityKind === "issueAttachment")?.payload,
    ).toMatchObject({ id: ATTACHMENT_ID, commentId: COMMENT_ID });

    const edited = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueComment.update", COMMENT_ID, { attachmentIds: [] })],
    });
    expect(edited.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const attachment = (await ctx.db.query("issueAttachments").collect())[0];
      expect(attachment?.commentId).toBeNull();
    });
  });
});

describe("issueThreadLink.create", () => {
  /** One company-wide issue every actor in these tests can reach. */
  async function linkableIssue(t: ReturnType<typeof harness>) {
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.create", ISSUE_A, { title: "Worked remotely", triage: true })],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });
    return op;
  }

  it("refuses an environment link stamped with somebody else's environment", async () => {
    const t = harness();
    await seed(t);
    await linkableIssue(t);
    await insertRegistration(t, {
      environmentId: ENVIRONMENT_ONE,
      state: "active",
      permissions: ["issues.read", "issues.update"],
    });
    await insertRegistration(t, { environmentId: ENVIRONMENT_TWO, state: "active" });
    const op = makeEnvironmentOps(ENVIRONMENT_ONE, "e");

    // The token authenticates environment one, and nothing in the operation is evidence about a
    // thread another environment ran.
    const forged = op("issueThreadLink.create", THREAD_LINK_ID, {
      issueId: ISSUE_A,
      environmentId: ENVIRONMENT_TWO,
      threadId: "thread-1",
      origin: "start-work",
    });
    const result = await asEnvironment(t, ENVIRONMENT_ONE).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [forged],
    });
    expect(result.receipts[0]).toMatchObject({ status: "rejected", code: "permission-denied" });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("issueThreadLinks").collect()).toHaveLength(0);
    });

    // Its own environment is exactly the link it is evidence for.
    const own = await asEnvironment(t, ENVIRONMENT_ONE).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueThreadLink.create", THREAD_LINK_ID, {
          issueId: ISSUE_A,
          environmentId: ENVIRONMENT_ONE,
          threadId: "thread-1",
          origin: "start-work",
        }),
      ],
    });
    expect(own.receipts[0]).toMatchObject({ status: "accepted" });
  });

  it("refuses a link naming a revoked registration", async () => {
    const t = harness();
    await seed(t);
    const op = await linkableIssue(t);
    await insertRegistration(t, { environmentId: ENVIRONMENT_REVOKED, state: "revoked" });

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueThreadLink.create", THREAD_LINK_ID, {
          issueId: ISSUE_A,
          environmentId: ENVIRONMENT_REVOKED,
          threadId: "thread-1",
          origin: "manual",
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: `No environment ${ENVIRONMENT_REVOKED} here.`,
    });
  });

  it("refuses a member link onto an environment they hold no grant on", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    await insertRegistration(t, { environmentId: ENVIRONMENT_ONE, state: "active" });
    const alpha = makeOps(ALPHA_MEMBERSHIP_ID, "a");

    const created = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        alpha("issue.create", ISSUE_A, {
          title: "Alpha work",
          triage: true,
          teamIds: [TEAM_ALPHA],
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    // Alpha may update the issue, which is not the same as being able to see the environment the
    // link would stamp it with.
    const result = await asAlpha(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        alpha("issueThreadLink.create", THREAD_LINK_ID, {
          issueId: ISSUE_A,
          environmentId: ENVIRONMENT_ONE,
          threadId: "thread-1",
          origin: "manual",
        }),
      ],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "permission-denied",
      message: expect.stringContaining("environments.read"),
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow catalog: row variants, effective resolution, and bounded sweeps
// ---------------------------------------------------------------------------

const COLOR = "#3b82f6";

/**
 * Issues parked in one status, written straight to the table. A sweep ceiling is about the volume
 * of rows a mutation would have to move, and driving hundreds of `issue.create` operations through
 * the protocol would test the harness rather than the ceiling.
 */
async function seedIssuesInStatus(t: ReturnType<typeof harness>, statusId: string, count: number) {
  await t.run(async (ctx) => {
    const company = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("id"), COMPANY_ID))
      .unique();
    if (company === null) throw new Error("seed the company first");
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(12, "0");
      await ctx.db.insert("issues", {
        id: `0198c0de-9999-7999-8999-${suffix}`,
        companyId: company._id,
        key: `PAT-${1000 + index}`,
        keyNumber: 1000 + index,
        title: `Bulk ${index}`,
        description: "",
        statusId,
        priority: "none",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: `a${suffix}`,
        labelIds: [],
        dueDate: null,
        triage: false,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        pullRequest: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 0,
      });
    }
  });
}

describe("issueStatus row variants", () => {
  it("refuses rows that could never resolve into a workflow column", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const base = op("issueStatus.create", STATUS_ID, {
      scope: "company",
      name: "Todo",
      color: COLOR,
      category: "unstarted",
    });
    // A company status is a base of its own; inheriting from another has no meaning.
    const inheritingBase = op("issueStatus.create", STATUS_BETA_ID, {
      scope: "company",
      name: "Doing",
      color: COLOR,
      category: "started",
      baseStatusId: STATUS_ID,
    });
    // A base with no category cannot answer "the first target column of the same category".
    const uncategorizedBase = op("issueStatus.create", STATUS_THIRD_ID, {
      scope: "company",
      color: COLOR,
      name: "Anonymous",
    });
    // A team-only status stands in no inheritance chain, so it has to be whole too.
    const partialTeamStatus = op("issueStatus.create", STATUS_OTHER_OVERRIDE_ID, {
      scope: "team",
      teamId: TEAM_ALPHA,
      name: "Alpha only",
      category: "started",
    });

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [base, inheritingBase, uncategorizedBase, partialTeamStatus],
    });
    const receipts = byOperationId(result.receipts);
    expect(receipts.get(base.operationId)).toMatchObject({ status: "accepted" });
    for (const operation of [inheritingBase, uncategorizedBase, partialTeamStatus]) {
      expect(receipts.get(operation.operationId)).toMatchObject({
        status: "rejected",
        code: "invalid-arguments",
      });
    }

    await t.run(async (ctx) => {
      const stored = await ctx.db.query("issueStatuses").collect();
      expect(stored.map((row) => row.id)).toEqual([STATUS_ID]);
    });
  });

  it("refuses a second override of one base by the same team", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const first = op("issueStatus.create", STATUS_OVERRIDE_ID, {
      scope: "team",
      teamId: TEAM_ALPHA,
      baseStatusId: STATUS_ID,
      name: "Alpha todo",
    });
    const second = op("issueStatus.create", STATUS_OTHER_OVERRIDE_ID, {
      scope: "team",
      teamId: TEAM_ALPHA,
      baseStatusId: STATUS_ID,
      name: "Alpha todo again",
    });
    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          color: COLOR,
          category: "unstarted",
        }),
        first,
        second,
      ],
    });
    const receipts = byOperationId(result.receipts);
    expect(receipts.get(first.operationId)).toMatchObject({ status: "accepted" });
    // Two overrides of one base leave the column's name up to whichever row the merge read first.
    expect(receipts.get(second.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("already overrides"),
    });
  });

  it("refuses a patch that leaves a base status unrenderable", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          color: COLOR,
          category: "unstarted",
        }),
      ],
    });
    expect(created.receipts[0]).toMatchObject({ status: "accepted" });

    const result = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueStatus.update", STATUS_ID, { category: null })],
    });
    expect(result.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("category"),
    });

    await t.run(async (ctx) => {
      const stored = (await ctx.db.query("issueStatuses").collect())[0];
      expect(stored?.category).toBe("unstarted");
    });
  });
});

describe("issue.setWorkflowOwner carryover", () => {
  /** Two company columns, alpha renaming the first, beta hiding the second and shipping its own. */
  async function catalog(t: ReturnType<typeof harness>) {
    const op = makeOps(WRITER_MEMBERSHIP_ID);
    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Doing",
          color: COLOR,
          category: "started",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          name: "Done",
          color: COLOR,
          category: "completed",
          position: 1,
        }),
        op("issueStatus.create", STATUS_OTHER_OVERRIDE_ID, {
          scope: "team",
          teamId: TEAM_ALPHA,
          baseStatusId: STATUS_ID,
          name: "In progress",
        }),
        op("issueStatus.create", STATUS_OVERRIDE_ID, {
          scope: "team",
          teamId: TEAM_BETA,
          baseStatusId: STATUS_BETA_ID,
          hidden: true,
        }),
        op("issueStatus.create", STATUS_THIRD_ID, {
          scope: "team",
          teamId: TEAM_BETA,
          name: "Shipped",
          color: COLOR,
          category: "completed",
          position: 2,
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });
    return op;
  }

  it("carries the issue into the target team's own override of the same base", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await catalog(t);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, {
          title: "Ongoing",
          teamIds: [TEAM_ALPHA],
          statusId: STATUS_ID,
        }),
        op("issue.setWorkflowOwner", ISSUE_A, {
          workflowOwner: { kind: "team", teamId: TEAM_ALPHA },
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // Alpha's board draws this column from its own row, so the issue has to name that row.
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_OTHER_OVERRIDE_ID);
    });
  });

  it("never leaves an issue in a column the target team hides", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await catalog(t);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, {
          title: "Finished",
          teamIds: [TEAM_BETA],
          statusId: STATUS_BETA_ID,
        }),
        op("issue.setWorkflowOwner", ISSUE_A, {
          workflowOwner: { kind: "team", teamId: TEAM_BETA },
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // Beta hides the inherited "Done", so the carryover falls to the first visible target column of
    // the same semantic category rather than parking the issue where nobody would see it.
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_THIRD_ID);
    });
  });

  it("asks for a target when the workflow shows no column of that category", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = await catalog(t);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        // Beta hides the started column too, so it shows nothing in that category at all.
        op("issueStatus.create", STATUS_FOURTH_ID, {
          scope: "team",
          teamId: TEAM_BETA,
          baseStatusId: STATUS_ID,
          hidden: true,
        }),
        op("issue.create", ISSUE_A, {
          title: "Ongoing",
          teamIds: [TEAM_BETA],
          statusId: STATUS_ID,
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // Dropping the issue into beta's first column would silently move started work into a finished
    // one, so the contract's third step applies: ask.
    const moved = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.setWorkflowOwner", ISSUE_A, {
          workflowOwner: { kind: "team", teamId: TEAM_BETA },
        }),
      ],
    });
    expect(moved.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("name the one"),
    });

    // Naming one lands it there, provided the target actually shows that column.
    const hidden = op("issue.setWorkflowOwner", ISSUE_A, {
      workflowOwner: { kind: "team", teamId: TEAM_BETA },
      statusId: STATUS_BETA_ID,
    });
    const explicit = op("issue.setWorkflowOwner", ISSUE_A, {
      workflowOwner: { kind: "team", teamId: TEAM_BETA },
      statusId: STATUS_THIRD_ID,
    });
    const named = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [hidden, explicit],
    });
    const receipts = byOperationId(named.receipts);
    expect(receipts.get(hidden.operationId)).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
    });
    expect(receipts.get(explicit.operationId)).toMatchObject({ status: "accepted" });
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_THIRD_ID);
      expect(issue?.workflowOwner).toMatchObject({ kind: "team", teamId: TEAM_BETA });
    });
  });
});

describe("issueStatus.delete across a team's overrides", () => {
  it("moves the issues sitting on an override id, not only those on the base", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          color: COLOR,
          category: "unstarted",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          name: "Done",
          color: COLOR,
          category: "completed",
          position: 1,
        }),
        op("issueStatus.create", STATUS_OVERRIDE_ID, {
          scope: "team",
          teamId: TEAM_ALPHA,
          baseStatusId: STATUS_ID,
          name: "Alpha todo",
        }),
        op("issue.create", ISSUE_A, {
          title: "Alpha work",
          teamIds: [TEAM_ALPHA],
          workflowOwner: { kind: "team", teamId: TEAM_ALPHA },
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // The premise: a team that overrides a base holds its issues under the override's own id.
    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_OVERRIDE_ID);
    });

    const deleted = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueStatus.delete", STATUS_ID, { reassignToStatusId: STATUS_BETA_ID })],
    });
    expect(deleted.receipts[0]).toMatchObject({ status: "accepted" });

    await t.run(async (ctx) => {
      const byId = new Map(
        (await ctx.db.query("issueStatuses").collect()).map((row) => [row.id, row]),
      );
      expect(byId.get(STATUS_ID)?.deletedAt).not.toBeNull();
      expect(byId.get(STATUS_OVERRIDE_ID)?.deletedAt).not.toBeNull();
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      // Left on the override id, the issue would point at a tombstone forever.
      expect(issue?.statusId).toBe(STATUS_BETA_ID);
    });
  });

  it("refuses a replacement column the affected workflow hides", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          color: COLOR,
          category: "unstarted",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          name: "Done",
          color: COLOR,
          category: "completed",
          position: 1,
        }),
        op("issueStatus.create", STATUS_OVERRIDE_ID, {
          scope: "team",
          teamId: TEAM_ALPHA,
          baseStatusId: STATUS_BETA_ID,
          hidden: true,
        }),
        op("issue.create", ISSUE_A, {
          title: "Alpha work",
          teamIds: [TEAM_ALPHA],
          workflowOwner: { kind: "team", teamId: TEAM_ALPHA },
          statusId: STATUS_ID,
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    const deleted = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueStatus.delete", STATUS_ID, { reassignToStatusId: STATUS_BETA_ID })],
    });
    expect(deleted.receipts[0]).toMatchObject({
      status: "rejected",
      code: "invalid-arguments",
      message: expect.stringContaining("every affected workflow"),
    });

    await t.run(async (ctx) => {
      const issue = (await ctx.db.query("issues").collect()).find((row) => row.id === ISSUE_A);
      expect(issue?.statusId).toBe(STATUS_ID);
      const status = (await ctx.db.query("issueStatuses").collect()).find(
        (row) => row.id === STATUS_ID,
      );
      expect(status?.deletedAt).toBeNull();
    });
  });

  it("refuses a sweep larger than one mutation can migrate rather than truncating it", async () => {
    const t = harness();
    await seed(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issueStatus.create", STATUS_ID, {
          scope: "company",
          name: "Todo",
          color: COLOR,
          category: "unstarted",
          position: 0,
        }),
        op("issueStatus.create", STATUS_BETA_ID, {
          scope: "company",
          name: "Done",
          color: COLOR,
          category: "completed",
          position: 1,
        }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    // One issue past the documented ceiling. Moving them all would blow the transaction, and moving
    // some of them would tombstone the status over a half-migrated column.
    await seedIssuesInStatus(t, STATUS_ID, 501);

    const deleted = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issueStatus.delete", STATUS_ID, { reassignToStatusId: STATUS_BETA_ID })],
    });
    expect(deleted.receipts[0]).toMatchObject({
      status: "rejected",
      code: "dependency-blocked",
      message: expect.stringContaining("500"),
    });

    await t.run(async (ctx) => {
      const status = (await ctx.db.query("issueStatuses").collect()).find(
        (row) => row.id === STATUS_ID,
      );
      expect(status?.deletedAt).toBeNull();
    });
  });
});

describe("issue.setTeams dependent convergence", () => {
  it("republishes the issue's children to the audience the move spans", async () => {
    const t = harness();
    await seed(t);
    await seedTeams(t);
    const op = makeOps(WRITER_MEMBERSHIP_ID);

    const created = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [
        op("issue.create", ISSUE_A, {
          title: "Alpha work",
          triage: true,
          teamIds: [TEAM_ALPHA],
        }),
        op("issueComment.create", COMMENT_ID, { issueId: ISSUE_A, body: "Context" }),
        op("issueTodo.create", TODO_ID, { issueId: ISSUE_A, text: "Ship it" }),
      ],
    });
    for (const receipt of created.receipts) expect(receipt).toMatchObject({ status: "accepted" });

    const alphaBefore = await drain(asAlpha(t), 0);
    const betaBefore = await drain(asBeta(t), 0);
    const moved = await asWriter(t).mutation(api.sync.applyOperations, {
      companyId: COMPANY_ID,
      operations: [op("issue.setTeams", ISSUE_A, { teamIds: [TEAM_BETA] })],
    });
    expect(moved.receipts[0]).toMatchObject({ status: "accepted" });

    // Children carry no scope of their own: they inherit the parent's, in the feed and in bootstrap
    // alike. Beta gains the issue having never heard of its conversation, so the move has to hand
    // the conversation over with it.
    const betaPage = await drain(asBeta(t), betaBefore.cursor);
    const betaRows = betaPage.changes.map((change) => `${change.entityKind}:${change.entityId}`);
    expect(betaRows).toContain(`issue:${ISSUE_A}`);
    expect(betaRows).toContain(`issueComment:${COMMENT_ID}`);
    expect(betaRows).toContain(`issueTodo:${TODO_ID}`);

    // Alpha hears the same rows, which is what lets its replica drop them alongside the issue: a
    // later bootstrap would not seed them, so nothing else would ever correct the divergence.
    const alphaPage = await drain(asAlpha(t), alphaBefore.cursor);
    const alphaRows = alphaPage.changes.map((change) => `${change.entityKind}:${change.entityId}`);
    expect(alphaRows).toContain(`issueComment:${COMMENT_ID}`);
    expect(alphaRows).toContain(`issueTodo:${TODO_ID}`);
  });
});
