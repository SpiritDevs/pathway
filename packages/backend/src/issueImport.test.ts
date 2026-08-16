// @effect-diagnostics globalDate:off -- Fixtures use explicit Convex epoch milliseconds.
/** End-to-end coverage for the full-fidelity empty-company issue import surface. */
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_ISSUE_STATUSES } from "@spiritdevs/contracts";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.import.test";
const CLERK_ISSUER = "https://clerk.import.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_CLOUD_SYNC = "enabled";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/issueImport.ts": () => import("../convex/issueImport.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const COMPANY_ID = "019a0000-0000-7000-8000-000000000001";
const MANAGER_MEMBERSHIP_ID = "019a0000-0000-7000-8000-000000000101";
const READER_MEMBERSHIP_ID = "019a0000-0000-7000-8000-000000000102";
const ENV_ONE = "import-environment-one";
const ENV_TWO = "import-environment-two";
const THUMB_ONE = "import-thumb-one";
const THUMB_TWO = "import-thumb-two";
const RUN_ID = "019a0000-0000-7000-8000-000000000201";
const STATUS_ID = "019a0000-0000-7000-8000-000000000301";
const PROJECT_ID = "019a0000-0000-7000-8000-000000000302";
const BINDING_ID = "019a0000-0000-7000-8000-000000000303";
const ISSUE_ID = "019a0000-0000-7000-8000-000000000304";
const ATTACHMENT_ID = "019a0000-0000-7000-8000-000000000305";
const COMMENT_ID = "019a0000-0000-7000-8000-000000000306";
const AUDIT_ID = "019a0000-0000-7000-8000-000000000307";
const LINK_ID = "019a0000-0000-7000-8000-000000000308";

function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;

function asMember(t: Harness, subject: "manager" | "reader") {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email: `${subject}@example.test`,
  });
}

function asEnvironment(t: Harness, environmentId = ENV_ONE) {
  const thumbprint = environmentId === ENV_ONE ? THUMB_ONE : THUMB_TWO;
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: environmentId,
    tokenIdentifier: `${RELAY_ISSUER}|${environmentId}`,
    cnf: { jkt: thumbprint },
  });
}

async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Import Co",
      issueKeyPrefix: "OLD",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const addMember = async (
      subject: "manager" | "reader",
      membershipId: string,
      permissions: string[],
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
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const roleDocId = await ctx.db.insert("roles", {
        id: `${membershipId}-role`,
        companyId: companyDocId,
        name: `${subject} role`,
        description: "",
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${membershipId}-assignment`,
        companyId: companyDocId,
        membershipId: membershipDocId,
        roleId: roleDocId,
        scope: "company",
        teamId: null,
        createdAt: now,
      });
      return membershipDocId;
    };

    const managerDocId = await addMember("manager", MANAGER_MEMBERSHIP_ID, [
      "company.manage",
      "company.read",
      "projects.read",
      "issues.read",
      "audit.read",
      "environments.read",
    ]);
    await addMember("reader", READER_MEMBERSHIP_ID, ["issues.read"]);

    const addRegistration = async (id: string, environmentId: string, thumbprint: string) =>
      await ctx.db.insert("environmentRegistrations", {
        id,
        companyId: companyDocId,
        environmentId,
        publicKeyThumbprint: thumbprint,
        descriptor: { environmentId, label: environmentId },
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: now,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: managerDocId,
        createdAt: now,
        updatedAt: now,
      });
    const registrationOne = await addRegistration(
      "019a0000-0000-7000-8000-000000000401",
      ENV_ONE,
      THUMB_ONE,
    );
    await addRegistration("019a0000-0000-7000-8000-000000000402", ENV_TWO, THUMB_TWO);
    return { companyDocId, managerDocId, registrationOne };
  });
}

async function start(t: Harness, id = RUN_ID) {
  return await asMember(t, "manager").mutation(api.issueImport.start, {
    companyId: COMPANY_ID,
    id,
    sourceEnvironmentId: ENV_ONE,
    selectedIssueKeyPrefix: "PAT",
  });
}

const status = (id = STATUS_ID) => ({
  entityKind: "issueStatus" as const,
  id,
  scope: "company" as const,
  teamId: null,
  baseStatusId: null,
  name: "Todo",
  color: "#123456",
  category: "unstarted" as const,
  position: 0,
  hidden: false,
  createdAt: 1_600_000_000_001,
  updatedAt: 1_600_000_000_002,
});

const project = () => ({
  entityKind: "cloudProject" as const,
  id: PROJECT_ID,
  name: "Imported project",
  createdAt: 1_600_000_000_003,
  updatedAt: 1_600_000_000_004,
  binding: {
    id: BINDING_ID,
    localProjectId: "local-project",
    localWorkspaceRoot: "/workspace/project",
    createdAt: 1_600_000_000_005,
    updatedAt: 1_600_000_000_006,
  },
});

const issue = () => ({
  entityKind: "issue" as const,
  id: ISSUE_ID,
  key: "PAT-41",
  keyNumber: 41,
  title: "Historical issue",
  description: "Preserved body",
  statusId: STATUS_ID,
  priority: "high" as const,
  assignee: { kind: "member" as const, membershipId: MANAGER_MEMBERSHIP_ID },
  projectId: PROJECT_ID,
  milestoneId: null,
  cycleId: null,
  parentId: null,
  sortOrder: "0001",
  labelIds: [],
  dueDate: null,
  triage: false,
  slackSource: null,
  teamIds: [],
  workflowOwner: { kind: "company" as const },
  workModelSelection: null,
  automationAssignment: null,
  pullRequest: null,
  createdAt: 1_500_000_000_001,
  updatedAt: 1_500_000_000_002,
});

const emptyExpected = (overrides: Partial<Record<string, number>> = {}) => ({
  issue: 0,
  issueStatus: 0,
  issueLabel: 0,
  issueMilestone: 0,
  issueCycle: 0,
  issueTodo: 0,
  issueRelation: 0,
  issueComment: 0,
  issueAttachment: 0,
  issueView: 0,
  issueAuditEvent: 0,
  issueThreadLink: 0,
  ...overrides,
});

type ImportEntity = FunctionArgs<typeof api.issueImport.applyEntities>["entities"][number];

async function apply(t: Harness, entities: ImportEntity[]) {
  return await asEnvironment(t).mutation(api.issueImport.applyEntities, {
    companyId: COMPANY_ID,
    runId: RUN_ID,
    entities,
  });
}

async function bootstrapAll(t: Harness) {
  const entities: Array<{ entityKind: string; entityId: string; payload: unknown }> = [];
  let cursor: string | null = null;
  do {
    const page: {
      entities: Array<{ entityKind: string; entityId: string; payload: unknown }>;
      cursor: string | null;
      isDone: boolean;
    } = await asMember(t, "manager").query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor,
      pageSize: 20,
    });
    entities.push(...page.entities);
    cursor = page.cursor;
    if (page.isDone) break;
  } while (cursor !== null);
  return entities;
}

describe("issue import", () => {
  it("authorizes member start, enforces empty-company mode, and makes start idempotent", async () => {
    const t = harness();
    const seeded = await seed(t);
    await expect(
      asMember(t, "reader").mutation(api.issueImport.start, {
        companyId: COMPANY_ID,
        id: RUN_ID,
        sourceEnvironmentId: ENV_ONE,
        selectedIssueKeyPrefix: "PAT",
      }),
    ).rejects.toThrow("company.manage");

    const first = await start(t);
    const second = await start(t);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "created", importingMembershipId: MANAGER_MEMBERSHIP_ID });

    const other = harness();
    const otherSeed = await seed(other);
    await other.run(async (ctx) => {
      const { entityKind: _, ...row } = status();
      await ctx.db.insert("issueStatuses", {
        ...row,
        companyId: otherSeed.companyDocId,
        deletedAt: null,
        version: 0,
      });
    });
    await expect(start(other)).rejects.toThrow("no issue data or workflow edits");
    expect(seeded.registrationOne).toBeTruthy();
  });

  it("replaces only the untouched provisioned workflow before importing source statuses", async () => {
    const t = harness();
    const seeded = await seed(t);
    await t.run(async (ctx) => {
      for (const row of DEFAULT_ISSUE_STATUSES) {
        await ctx.db.insert("issueStatuses", {
          ...row,
          companyId: seeded.companyDocId,
          scope: "company",
          teamId: null,
          baseStatusId: null,
          hidden: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          deletedAt: null,
          version: 0,
        });
      }
    });

    await expect(start(t)).resolves.toMatchObject({ state: "created" });
    await expect(apply(t, [status("todo")])).resolves.toMatchObject({
      outcomes: [{ status: "applied" }],
    });
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("issueStatuses")
        .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", seeded.companyDocId))
        .collect(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "todo", color: "#123456" });
  });

  it("scopes execution to the run's active source environment", async () => {
    const t = harness();
    await seed(t);
    await start(t);
    await expect(
      asEnvironment(t, ENV_TWO).mutation(api.issueImport.applyEntities, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        entities: [status()],
      }),
    ).rejects.toThrow("another environment");
    await expect(apply(t, [status()])).resolves.toMatchObject({
      outcomes: [{ status: "applied" }],
    });
  });

  it("preserves historical fields through shared encoders into bootstrap and the feed", async () => {
    const t = harness();
    await seed(t);
    await start(t);
    await asEnvironment(t).mutation(api.issueImport.applyTrackerConfig, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      issueKeyPrefix: "PAT",
      nextIssueNumber: 42,
    });
    await apply(t, [project(), status(), issue()]);
    const comment = {
      entityKind: "issueComment" as const,
      id: COMMENT_ID,
      issueId: ISSUE_ID,
      body: "Original comment",
      author: { kind: "member" as const, membershipId: MANAGER_MEMBERSHIP_ID },
      attachmentIds: [],
      mentions: [{ membershipId: MANAGER_MEMBERSHIP_ID, start: 0, end: 8 }],
      createdAt: 1_400_000_000_001,
      updatedAt: 1_400_000_000_002,
    };
    const audit = {
      entityKind: "issueAuditEvent" as const,
      id: AUDIT_ID,
      issueId: ISSUE_ID,
      kind: "field_changed",
      actor: { kind: "member" as const, membershipId: MANAGER_MEMBERSHIP_ID },
      payload: { field: "title", before: "Before", after: "Historical issue" },
      operationId: "source-operation",
      createdAt: 1_300_000_000_001,
    };
    const link = {
      entityKind: "issueThreadLink" as const,
      id: LINK_ID,
      issueId: ISSUE_ID,
      environmentId: ENV_ONE,
      threadId: "source-thread",
      origin: "manual" as const,
      createdByMembershipId: MANAGER_MEMBERSHIP_ID,
      createdAt: 1_200_000_000_001,
    };
    await apply(t, [comment, audit, link]);

    const seeded = await bootstrapAll(t);
    const payload = (kind: string, id: string) =>
      seeded.find((row) => row.entityKind === kind && row.entityId === id)?.payload as
        | Record<string, unknown>
        | undefined;
    expect(payload("issue", ISSUE_ID)).toMatchObject({
      id: ISSUE_ID,
      key: "PAT-41",
      keyNumber: 41,
      createdAt: 1_500_000_000_001,
      updatedAt: 1_500_000_000_002,
    });
    expect(payload("issueComment", COMMENT_ID)).toMatchObject({
      author: { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID },
      createdAt: 1_400_000_000_001,
      updatedAt: 1_400_000_000_002,
    });
    expect(payload("issueAuditEvent", AUDIT_ID)).toMatchObject({
      operationId: "source-operation",
      payload: { before: "Before", after: "Historical issue" },
      createdAt: 1_300_000_000_001,
    });
    expect(payload("issueThreadLink", LINK_ID)).toMatchObject({
      environmentId: ENV_ONE,
      threadId: "source-thread",
      createdByMembershipId: MANAGER_MEMBERSHIP_ID,
      createdAt: 1_200_000_000_001,
    });

    const changes = await asMember(t, "manager").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
      limit: 100,
    });
    expect(changes._tag).toBe("Changes");
    if (changes._tag === "Changes") {
      expect(
        changes.changes.some((row) => row.entityKind === "issue" && row.entityId === ISSUE_ID),
      ).toBe(true);
      expect(
        changes.changes.some(
          (row) => row.entityKind === "issueAuditEvent" && row.entityId === AUDIT_ID,
        ),
      ).toBe(true);
    }
  });

  it("deduplicates a replayed batch and rejects a foreign id without overwriting it", async () => {
    const t = harness();
    const seeded = await seed(t);
    await start(t);
    const first = await apply(t, [status()]);
    const second = await apply(t, [status()]);
    expect(first.outcomes).toMatchObject([{ status: "applied" }]);
    expect(second.outcomes).toMatchObject([{ status: "alreadyApplied" }]);

    const foreignId = "019a0000-0000-7000-8000-000000000399";
    await t.run(async (ctx) => {
      const { entityKind: _, ...row } = status(foreignId);
      await ctx.db.insert("issueStatuses", {
        ...row,
        companyId: seeded.companyDocId,
        name: "Foreign",
        deletedAt: null,
        version: 0,
      });
    });
    const conflict = await apply(t, [status(foreignId)]);
    expect(conflict.outcomes).toMatchObject([{ status: "rejected", code: "foreign-id-conflict" }]);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("issueStatuses")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", foreignId),
        )
        .unique(),
    );
    expect(stored?.name).toBe("Foreign");
  });

  it("preserves a historical deletion timestamp while still accepting its audit history", async () => {
    const t = harness();
    const seeded = await seed(t);
    await start(t);
    await apply(t, [project(), status(), { ...issue(), deletedAt: 1_550_000_000_000 }]);
    await apply(t, [
      {
        entityKind: "issueAuditEvent",
        id: AUDIT_ID,
        issueId: ISSUE_ID,
        kind: "deleted",
        actor: { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID },
        payload: { deletedAt: 1_550_000_000_000 },
        operationId: null,
        createdAt: 1_550_000_000_000,
      },
    ]);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("issues")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ISSUE_ID),
        )
        .unique(),
    );
    expect(stored?.deletedAt).toBe(1_550_000_000_000);
    const feed = await t.run(async (ctx) =>
      ctx.db
        .query("syncChanges")
        .withIndex("by_company_and_entity", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("entityKind", "issue").eq("entityId", ISSUE_ID),
        )
        .collect(),
    );
    expect(feed).toMatchObject([{ changeKind: "tombstone", payload: null }]);
  });

  it("never regresses tracker config and idempotently reapplies the accepted config", async () => {
    const t = harness();
    await seed(t);
    await start(t);
    const accepted = await asEnvironment(t).mutation(api.issueImport.applyTrackerConfig, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      issueKeyPrefix: "PAT",
      nextIssueNumber: 50,
    });
    expect(accepted.status).toBe("applied");
    await expect(
      asEnvironment(t).mutation(api.issueImport.applyTrackerConfig, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        issueKeyPrefix: "PAT",
        nextIssueNumber: 10,
      }),
    ).rejects.toThrow("different values");
    const replay = await asEnvironment(t).mutation(api.issueImport.applyTrackerConfig, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      issueKeyPrefix: "PAT",
      nextIssueNumber: 50,
    });
    expect(replay).toMatchObject({ status: "alreadyApplied", nextIssueNumber: 50 });
  });

  it("blocks completion on pending attachments and atomically activates imported bindings", async () => {
    const t = harness();
    const seeded = await seed(t);
    await start(t);
    await asEnvironment(t).mutation(api.issueImport.applyTrackerConfig, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      issueKeyPrefix: "PAT",
      nextIssueNumber: 42,
    });
    await apply(t, [project(), status(), issue()]);
    await apply(t, [
      {
        entityKind: "issueAttachment",
        id: ATTACHMENT_ID,
        issueId: ISSUE_ID,
        commentId: null,
        fileName: "proof.txt",
        mimeType: "text/plain",
        byteSize: 5,
        checksum: "deferred-to-upload",
        uploadedByMembershipId: MANAGER_MEMBERSHIP_ID,
        state: "pending",
        createdAt: 1_100_000_000_001,
        updatedAt: 1_100_000_000_002,
      },
    ]);
    const expected = emptyExpected({
      cloudProject: 1,
      issueStatus: 1,
      issue: 1,
      issueAttachment: 1,
    });
    await expect(
      asEnvironment(t).mutation(api.issueImport.complete, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        expectedCounts: expected,
      }),
    ).rejects.toThrow("not finalized");

    const before = await t.run(async (ctx) =>
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", BINDING_ID),
        )
        .unique(),
    );
    expect(before?.status).toBe("pending");
    const uploadUrl = await asEnvironment(t).action(api.issueImport.generateAttachmentUploadUrl, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      attachmentId: ATTACHMENT_ID,
    });
    expect(uploadUrl).toContain("http");
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["proof"])));
    await expect(
      asEnvironment(t).mutation(api.issueImport.finalizeAttachment, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        attachmentId: ATTACHMENT_ID,
        storageId,
        checksum: "sha256-proof",
        byteSize: 5,
      }),
    ).resolves.toEqual({ status: "finalized" });
    const finalizedAttachment = await t.run(async (ctx) =>
      ctx.db
        .query("issueAttachments")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ATTACHMENT_ID),
        )
        .unique(),
    );
    expect(finalizedAttachment?.updatedAt).toBe(1_100_000_000_002);

    const completed = await asEnvironment(t).mutation(api.issueImport.complete, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      expectedCounts: expected,
    });
    expect(completed.state).toBe("completed");
    const after = await t.run(async (ctx) =>
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", BINDING_ID),
        )
        .unique(),
    );
    expect(after?.status).toBe("active");
    const feed = await t.run(async (ctx) =>
      ctx.db
        .query("syncChanges")
        .withIndex("by_company_and_entity", (q) =>
          q
            .eq("companyId", seeded.companyDocId)
            .eq("entityKind", "environmentBinding")
            .eq("entityId", BINDING_ID),
        )
        .collect(),
    );
    expect(feed).toHaveLength(1);
    expect((feed[0]?.payload as { status?: string }).status).toBe("active");
  });

  it("checks expected counts and leaves abandoned partial rows in place", async () => {
    const t = harness();
    const seeded = await seed(t);
    await start(t);
    await apply(t, [status()]);
    await expect(
      asEnvironment(t).mutation(api.issueImport.complete, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        expectedCounts: emptyExpected(),
      }),
    ).rejects.toThrow("Expected 0 issueStatus rows, applied 1");
    await expect(
      asMember(t, "reader").mutation(api.issueImport.abandon, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
      }),
    ).rejects.toThrow("Missing permission company.manage");
    const abandoned = await asMember(t, "manager").mutation(api.issueImport.abandon, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
    });
    expect(abandoned.state).toBe("abandoned");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("issueStatuses")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", STATUS_ID),
        )
        .unique(),
    );
    expect(row?.name).toBe("Todo");
  });
});
