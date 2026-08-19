// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/cloudProjects.ts": () => import("../convex/cloudProjects.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000002";
const PROJECT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000003";
const BINDING_ID = "0198c0de-aaaa-7aaa-8aaa-000000000004";
const MILESTONE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000005";
const ENVIRONMENT_ID = "environment-macbook";
const LOCAL_PROJECT_ID = "local-pathway";
const NOW = 1_700_000_000_000;

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asOwner(t: Harness) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "project_owner",
    tokenIdentifier: `${CLERK_ISSUER}|project_owner`,
    email: "project_owner@example.test",
    name: "Project Owner",
  });
}

async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "project_owner",
      email: "project_owner@example.test",
      displayName: "Project Owner",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Project Test Co",
      workspaceKind: "personal",
      issueKeyPrefix: "PTC",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const membershipId = await ctx.db.insert("memberships", {
      id: MEMBERSHIP_ID,
      companyId,
      userId,
      state: "active",
      displayNameSnapshot: "Project Owner",
      emailSnapshot: "project_owner@example.test",
      invitedByMembershipId: null,
      joinedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("companyOwners", {
      companyId,
      membershipId,
      grantedByMembershipId: null,
      createdAt: NOW,
    });
    const projectId = await ctx.db.insert("cloudProjects", {
      id: PROJECT_ID,
      companyId,
      name: "Pathway",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: BINDING_ID,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });
    const bindingId = await ctx.db.insert("environmentBindings", {
      id: BINDING_ID,
      companyId,
      cloudProjectId: projectId,
      environmentId: ENVIRONMENT_ID,
      localProjectId: LOCAL_PROJECT_ID,
      localWorkspaceRoot: "/work/pathway",
      status: "active",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      version: 0,
    });
    const threadId = await ctx.db.insert("agentThreads", {
      id: `${ENVIRONMENT_ID}:thread-1`,
      companyId,
      environmentId: ENVIRONMENT_ID,
      cloudProjectId: projectId,
      localProjectId: LOCAL_PROJECT_ID,
      threadId: "thread-1",
      shell: { id: "thread-1", projectId: LOCAL_PROJECT_ID },
      updatedAt: NOW,
      version: 0,
    });
    const milestoneId = await ctx.db.insert("issueMilestones", {
      id: MILESTONE_ID,
      companyId,
      cloudProjectId: PROJECT_ID,
      name: "Launch",
      description: null,
      startDate: null,
      targetDate: null,
      position: 1,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 0,
    });
    return { projectId, bindingId, threadId, milestoneId };
  });
}

describe("company project deletion", () => {
  it("tombstones the shared project and leaves durable revocations for offline checkouts", async () => {
    const t = harness();
    const ids = await seed(t);

    await asOwner(t).mutation(api.cloudProjects.deleteCompanyProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
    });

    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(ids.projectId),
      binding: await ctx.db.get(ids.bindingId),
      thread: await ctx.db.get(ids.threadId),
      milestone: await ctx.db.get(ids.milestoneId),
      changes: (await ctx.db.query("syncChanges").collect())
        .slice()
        .sort((left, right) => left.version - right.version),
    }));

    expect(state.project).toMatchObject({
      id: PROJECT_ID,
      preferredBindingId: null,
    });
    expect(state.project?.deletedAt).toEqual(expect.any(Number));
    expect(state.binding).toMatchObject({ status: "revoked" });
    expect(state.thread).toBeNull();
    expect(state.milestone?.deletedAt).toEqual(expect.any(Number));
    expect(
      state.changes.map((change) => [change.entityKind, change.changeKind, change.entityId]),
    ).toEqual([
      ["environmentBinding", "upsert", BINDING_ID],
      ["agentThread", "tombstone", `${ENVIRONMENT_ID}:thread-1`],
      ["issueMilestone", "tombstone", MILESTONE_ID],
      ["cloudProject", "tombstone", PROJECT_ID],
    ]);
  });

  it("does not let a reconnecting checkout resurrect a deleted project", async () => {
    const t = harness();
    const ids = await seed(t);
    const owner = asOwner(t);

    await owner.mutation(api.cloudProjects.deleteCompanyProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
    });
    await owner.mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: LOCAL_PROJECT_ID,
      localWorkspaceRoot: "/work/pathway",
      name: "Pathway from stale local state",
    });

    const project = await t.run(async (ctx) => await ctx.db.get(ids.projectId));
    expect(project).toMatchObject({ name: "Pathway", preferredBindingId: null });
    expect(project?.deletedAt).toEqual(expect.any(Number));
  });
});
