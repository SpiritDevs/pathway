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

const STATUS_ID = "0198c0de-bbbb-7bbb-8bbb-000000000001";
const ISSUE_A = "0198c0de-cccc-7ccc-8ccc-000000000001";
const ISSUE_B = "0198c0de-cccc-7ccc-8ccc-000000000002";
const ISSUE_C = "0198c0de-cccc-7ccc-8ccc-000000000003";

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

function asMember(t: ReturnType<typeof harness>, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });
}

const asWriter = (t: ReturnType<typeof harness>) => asMember(t, "user_writer");
const asReader = (t: ReturnType<typeof harness>) => asMember(t, "user_reader");

/** Envelope factory: unique-per-test operation ids and sequences, everything else overridable. */
function makeOps(membershipId: string) {
  let counter = 0;
  return (kind: string, entityId: string, args: unknown) => {
    counter += 1;
    return {
      protocolVersion: 1,
      operationId: `0198c0de-eeee-7eee-8eee-${String(counter).padStart(12, "0")}`,
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
