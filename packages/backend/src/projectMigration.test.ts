// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Moving a project between companies, driven through the production mutation.
 *
 * The properties that matter are the ones a half-finished move would break: every issue lands in
 * the destination under a new key, every reference that cannot cross a company boundary is cleared
 * rather than dangling, and both companies' feeds are told — tombstones on the way out, upserts on
 * the way in — because a replica that hears only one side keeps serving work that has left.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/projectMigration.ts": () => import("../convex/projectMigration.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const FROM_COMPANY = "0198c0de-bbbb-7bbb-8bbb-000000000001";
const TO_COMPANY = "0198c0de-bbbb-7bbb-8bbb-000000000002";
const PROJECT_ID = "0198c0de-cccc-7ccc-8ccc-000000000001";
const FROM_TODO = "0198c0de-dddd-7ddd-8ddd-000000000001";
const FROM_DONE = "0198c0de-dddd-7ddd-8ddd-000000000002";
const TO_TODO = "0198c0de-eeee-7eee-8eee-000000000001";
const TO_DONE = "0198c0de-eeee-7eee-8eee-000000000002";
const FROM_LABEL = "0198c0de-ffff-7fff-8fff-000000000001";
const TO_LABEL = "0198c0de-ffff-7fff-8fff-000000000002";
const MILESTONE_ID = "0198c0de-1111-7111-8111-000000000001";
const CYCLE_ID = "0198c0de-2222-7222-8222-000000000001";
const SLACK_INTEGRATION_ID = "0198c0de-9999-7999-8999-000000000001";
const SLACK_WATCH_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const AUTOMATION_JOB_ID = "0198c0de-abcd-7abc-8abc-000000000001";

type Harness = ReturnType<typeof convexTest>;

function asUser(t: Harness, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email: `${subject}@example.test`,
    name: subject,
  });
}

const NOW = 1_700_000_000_000;

/** Two companies the same person owns, with a project and two issues in the first. */
async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const userDocId = await ctx.db.insert("users", {
      clerkSubject: "user_owner",
      email: "user_owner@example.test",
      displayName: "Owner",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const company = async (id: string, name: string, prefix: string) => {
      const companyDocId = await ctx.db.insert("companies", {
        id,
        name,
        workspaceKind: "organization" as const,
        issueKeyPrefix: prefix,
        nextIssueNumber: 10,
        lifecycleState: "active" as const,
        deletionScheduledAt: null,
        purgeAfter: null,
        authorizationEpoch: 1,
        syncVersion: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const membershipDocId = await ctx.db.insert("memberships", {
        id: `${id}-m`,
        companyId: companyDocId,
        userId: userDocId,
        state: "active" as const,
        displayNameSnapshot: "Owner",
        emailSnapshot: "user_owner@example.test",
        invitedByMembershipId: null,
        joinedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // Ownership passes every permission check, which is what `projects.manage` needs here.
      await ctx.db.insert("companyOwners", {
        companyId: companyDocId,
        membershipId: membershipDocId,
        grantedByMembershipId: null,
        createdAt: NOW,
      });
      await ctx.db.insert("companySettings", {
        companyId: companyDocId,
        id,
        offlineAccessDays: 30,
        updatedByMembershipId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      return companyDocId;
    };

    const fromDocId = await company(FROM_COMPANY, "Source Co", "SRC");
    const toDocId = await company(TO_COMPANY, "Target Co", "TGT");

    const status = async (
      companyDocId: typeof fromDocId,
      id: string,
      name: string,
      category: string,
    ) =>
      await ctx.db.insert("issueStatuses", {
        id,
        companyId: companyDocId,
        scope: "company" as const,
        teamId: null,
        baseStatusId: null,
        name,
        color: "gray",
        category: category as never,
        position: 1,
        hidden: false,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });

    await status(fromDocId, FROM_TODO, "Todo", "unstarted");
    await status(fromDocId, FROM_DONE, "Done", "completed");
    await status(toDocId, TO_TODO, "Todo", "unstarted");
    await status(toDocId, TO_DONE, "Done", "completed");

    for (const [companyDocId, id] of [
      [fromDocId, FROM_LABEL],
      [toDocId, TO_LABEL],
    ] as const) {
      await ctx.db.insert("issueLabels", {
        id,
        companyId: companyDocId,
        teamId: null,
        name: "bug",
        color: "red",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });
    }

    const projectDocId = await ctx.db.insert("cloudProjects", {
      id: PROJECT_ID,
      companyId: fromDocId,
      name: "Moving Project",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });

    await ctx.db.insert("environmentBindings", {
      id: "0198c0de-4444-7444-8444-000000000001",
      companyId: fromDocId,
      cloudProjectId: projectDocId,
      environmentId: "environment-1",
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: "/work/moving-project",
      status: "active",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      version: 0,
    });
    await ctx.db.insert("agentThreads", {
      id: "environment-1:thread-1",
      companyId: fromDocId,
      environmentId: "environment-1",
      cloudProjectId: projectDocId,
      localProjectId: PROJECT_ID,
      threadId: "thread-1",
      shell: { id: "thread-1", projectId: PROJECT_ID },
      updatedAt: NOW,
      version: 0,
    });
    await ctx.db.insert("capturedEmails", {
      id: "environment-1:message-1",
      companyId: fromDocId,
      environmentId: "environment-1",
      cloudProjectId: projectDocId,
      localProjectId: PROJECT_ID,
      messageId: "message-1",
      message: { subject: "Move me" },
      tagIds: [FROM_LABEL],
      updatedAt: NOW,
      version: 0,
    });
    const slackIntegrationDocId = await ctx.db.insert("slackIntegrations", {
      id: SLACK_INTEGRATION_ID,
      companyId: fromDocId,
      workspaceId: "workspace-1",
      workspaceName: "Source Slack",
      workspaceDomain: "source",
      botUserId: "bot-user-1",
      botId: "bot-1",
      state: "active",
      activatedAt: NOW,
      credentialPresent: true,
      preferredEnvironmentId: "environment-1",
      backupEnvironmentIds: [],
      configurationRevision: 1,
      lastPollAt: NOW,
      currentError: null,
      blockedReason: null,
      watchCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("slackChannelWatches", {
      id: SLACK_WATCH_ID,
      companyId: fromDocId,
      integrationId: slackIntegrationDocId,
      channelId: "channel-1",
      channelName: "issues",
      cloudProjectId: projectDocId,
      cycleId: CYCLE_ID,
      autoInvestigate: true,
      autoAssign: true,
      trigger: { kind: "mention" },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await ctx.db.insert("issueMilestones", {
      id: MILESTONE_ID,
      companyId: fromDocId,
      cloudProjectId: PROJECT_ID,
      name: "Beta",
      description: null,
      startDate: null,
      targetDate: "2026-09-01",
      position: 1,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });

    const issue = async (id: string, keyNumber: number, statusId: string, extra: object = {}) =>
      await ctx.db.insert("issues", {
        id,
        companyId: fromDocId,
        key: `SRC-${keyNumber}`,
        keyNumber,
        title: `Issue ${keyNumber}`,
        description: "",
        statusId,
        priority: "none" as const,
        assignee: null,
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_ID,
        cycleId: CYCLE_ID,
        parentId: null,
        sortOrder: `a${keyNumber}`,
        labelIds: [FROM_LABEL],
        dueDate: null,
        triage: false,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" as const },
        workModelSelection: null,
        automationAssignment: null,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
        ...extra,
      });

    const first = await issue("0198c0de-3333-7333-8333-000000000001", 1, FROM_TODO);
    const second = await issue("0198c0de-3333-7333-8333-000000000002", 2, FROM_DONE, {
      parentId: "0198c0de-3333-7333-8333-000000000001",
    });
    await ctx.db.insert("issueAutomationJobs", {
      id: AUTOMATION_JOB_ID,
      companyId: fromDocId,
      issueId: "0198c0de-3333-7333-8333-000000000001",
      kind: "automatic-assignment",
      triggerKey: "project-move-test",
      settingsRevision: 1,
      modelSelection: null,
      ruleId: null,
      ruleSnapshot: null,
      targetKind: "project",
      cloudProjectId: projectDocId,
      threadId: null,
      targetEnvironmentId: "environment-1",
      requiredProviderInstanceId: null,
      requiredModel: null,
      state: "running",
      blockCode: null,
      diagnostic: null,
      claimHolderEnvironmentId: "environment-1",
      claimGeneration: 1,
      claimExpiresAt: NOW + 60_000,
      attempts: 1,
      nextRetryAt: null,
      result: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    });
    await ctx.db.insert("issueTodos", {
      id: "0198c0de-5555-7555-8555-000000000001",
      companyId: fromDocId,
      issueId: "0198c0de-3333-7333-8333-000000000001",
      text: "Move the checklist",
      done: false,
      sortOrder: "a",
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });
    await ctx.db.insert("issueComments", {
      id: "0198c0de-6666-7666-8666-000000000001",
      companyId: fromDocId,
      issueId: "0198c0de-3333-7333-8333-000000000001",
      body: "Move the discussion",
      author: { kind: "member", membershipId: `${FROM_COMPANY}-m` },
      attachmentIds: [],
      mentions: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });
    await ctx.db.insert("issueThreadLinks", {
      id: "0198c0de-7777-7777-8777-000000000001",
      companyId: fromDocId,
      issueId: "0198c0de-3333-7333-8333-000000000001",
      environmentId: "environment-1",
      threadId: "thread-1",
      origin: "start-work",
      createdByMembershipId: null,
      createdAt: NOW,
      deletedAt: null,
      version: 0,
    });
    await ctx.db.insert("issueRelations", {
      id: "0198c0de-8888-7888-8888-000000000001",
      companyId: fromDocId,
      issueId: "0198c0de-3333-7333-8333-000000000001",
      relatedIssueId: "0198c0de-3333-7333-8333-000000000002",
      kind: "relates",
      createdAt: NOW,
      deletedAt: null,
      version: 0,
    });
    return { fromDocId, toDocId, first, second };
  });
}

const FULL_MAPPING = {
  statusMapping: [
    { from: FROM_TODO, to: TO_TODO },
    { from: FROM_DONE, to: TO_DONE },
  ],
  labelMapping: [{ from: FROM_LABEL, to: TO_LABEL }],
};

describe("projectMigration.moveProjectToCompany", () => {
  it("moves the project, its issues, and its milestones, re-keyed under the new prefix", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const result = await asUser(t, "user_owner").mutation(
      api.projectMigration.moveProjectToCompany,
      {
        fromCompanyId: FROM_COMPANY,
        toCompanyId: TO_COMPANY,
        projectId: PROJECT_ID,
        ...FULL_MAPPING,
      },
    );
    expect(result).toMatchObject({
      movedIssues: 2,
      movedMilestones: 1,
      movedBindings: 1,
      movedThreads: 1,
      movedEmails: 1,
      movedIssueAssets: 4,
      canceledAutomationJobs: 1,
      detachedSlackWatches: 1,
      droppedLabels: 0,
    });

    await t.run(async (ctx) => {
      const to = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", TO_COMPANY))
        .unique();
      const issues = (await ctx.db.query("issues").collect()).toSorted(
        (a, b) => a.keyNumber - b.keyNumber,
      );
      expect(issues.every((issue) => issue.companyId === to?._id)).toBe(true);
      // Keys are re-issued from the destination's counter, in the original order.
      expect(issues.map((issue) => issue.key)).toEqual(["TGT-10", "TGT-11"]);
      expect(issues.map((issue) => issue.statusId)).toEqual([TO_TODO, TO_DONE]);
      expect(issues.every((issue) => issue.labelIds.includes(TO_LABEL))).toBe(true);

      const milestone = await ctx.db.query("issueMilestones").first();
      expect(milestone?.companyId).toBe(to?._id);
      const project = await ctx.db.query("cloudProjects").first();
      expect(project?.companyId).toBe(to?._id);
      expect((await ctx.db.query("environmentBindings").first())?.companyId).toBe(to?._id);
      expect((await ctx.db.query("agentThreads").first())?.companyId).toBe(to?._id);
      expect(await ctx.db.query("capturedEmails").first()).toMatchObject({
        companyId: to?._id,
        tagIds: [],
      });
      expect((await ctx.db.query("issueTodos").first())?.companyId).toBe(to?._id);
      expect((await ctx.db.query("issueComments").first())?.companyId).toBe(to?._id);
      expect((await ctx.db.query("issueThreadLinks").first())?.companyId).toBe(to?._id);
      expect((await ctx.db.query("issueRelations").first())?.companyId).toBe(to?._id);
      expect(await ctx.db.query("issueAutomationJobs").first()).toMatchObject({
        companyId: to?._id,
        state: "canceled",
        completedAt: expect.any(Number),
      });
      const slackWatch = await ctx.db.query("slackChannelWatches").first();
      expect(slackWatch?.companyId).not.toBe(to?._id);
      expect(slackWatch).toMatchObject({
        cloudProjectId: null,
        cycleId: null,
        revision: 2,
      });
    });
  });

  it("clears references that cannot cross a company boundary", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await asUser(t, "user_owner").mutation(api.projectMigration.moveProjectToCompany, {
      fromCompanyId: FROM_COMPANY,
      toCompanyId: TO_COMPANY,
      projectId: PROJECT_ID,
      ...FULL_MAPPING,
    });

    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      // A cycle belongs to the whole source company and does not travel with one project.
      expect(issues.every((issue) => issue.cycleId === null)).toBe(true);
      // The parent moved too, so that link survives.
      const child = issues.find((issue) => issue.title === "Issue 2");
      expect(child?.parentId).toBe("0198c0de-3333-7333-8333-000000000001");
    });
  });

  it("tells both companies' feeds, so neither replica is left with a stale view", async () => {
    const t = convexTest(schema, modules);
    const { fromDocId, toDocId } = await seed(t);
    await asUser(t, "user_owner").mutation(api.projectMigration.moveProjectToCompany, {
      fromCompanyId: FROM_COMPANY,
      toCompanyId: TO_COMPANY,
      projectId: PROJECT_ID,
      ...FULL_MAPPING,
    });

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("syncChanges").collect();
      const source = rows.filter((row) => row.companyId === fromDocId);
      const destination = rows.filter((row) => row.companyId === toDocId);

      expect(source.every((row) => row.changeKind === "tombstone")).toBe(true);
      expect(source.filter((row) => row.entityKind === "issue")).toHaveLength(2);
      expect(source.filter((row) => row.entityKind === "cloudProject")).toHaveLength(1);

      const upserts = destination.filter((row) => row.changeKind === "upsert");
      expect(upserts.filter((row) => row.entityKind === "issue")).toHaveLength(2);
      // The payload has to be the row as it now reads, not the pre-move snapshot.
      const issuePayload = upserts.find((row) => row.entityKind === "issue")?.payload as {
        key?: string;
      } | null;
      expect(issuePayload?.key?.startsWith("TGT-")).toBe(true);
    });
  });

  it("refuses a move that has not said where every status goes", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.projectMigration.moveProjectToCompany, {
        fromCompanyId: FROM_COMPANY,
        toCompanyId: TO_COMPANY,
        projectId: PROJECT_ID,
        statusMapping: [{ from: FROM_TODO, to: TO_TODO }],
        labelMapping: [],
      }),
    ).rejects.toThrow("No destination chosen");

    // Nothing may have been written on the way to that refusal.
    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      expect(issues.every((issue) => issue.key.startsWith("SRC-"))).toBe(true);
      expect(await ctx.db.query("syncChanges").collect()).toHaveLength(0);
    });
  });

  it("drops an unmapped label rather than carrying a foreign id across", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const result = await asUser(t, "user_owner").mutation(
      api.projectMigration.moveProjectToCompany,
      {
        fromCompanyId: FROM_COMPANY,
        toCompanyId: TO_COMPANY,
        projectId: PROJECT_ID,
        statusMapping: FULL_MAPPING.statusMapping,
        labelMapping: [],
      },
    );
    expect(result.droppedLabels).toBe(2);
    await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      expect(issues.every((issue) => issue.labelIds.length === 0)).toBe(true);
    });
  });

  it("refuses a move into the company the project is already in", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(
      asUser(t, "user_owner").mutation(api.projectMigration.moveProjectToCompany, {
        fromCompanyId: FROM_COMPANY,
        toCompanyId: FROM_COMPANY,
        projectId: PROJECT_ID,
        ...FULL_MAPPING,
      }),
    ).rejects.toThrow("already in that company");
  });

  it("refuses a caller who is not a member of the destination", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(
      asUser(t, "user_stranger").mutation(api.projectMigration.moveProjectToCompany, {
        fromCompanyId: FROM_COMPANY,
        toCompanyId: TO_COMPANY,
        projectId: PROJECT_ID,
        ...FULL_MAPPING,
      }),
    ).rejects.toThrow();
  });
});
