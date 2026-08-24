// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/cloudProjects.ts": () => import("../convex/cloudProjects.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const MEMBERSHIP_ID = "0198c0de-aaaa-7aaa-8aaa-000000000002";
const PROJECT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000003";
const BINDING_ID = "0198c0de-aaaa-7aaa-8aaa-000000000004";
const MILESTONE_ID = "0198c0de-aaaa-7aaa-8aaa-000000000005";
const ENVIRONMENT_ID = "environment-macbook";
const LOCAL_PROJECT_ID = "local-pathway";
const PENDING_PROJECT_ID = "0198c0de-aaaa-7aaa-8aaa-000000000006";
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
    return { companyId, projectId, bindingId, threadId, milestoneId };
  });
}

async function registerEnvironment(
  t: Harness,
  companyId: Awaited<ReturnType<typeof seed>>["companyId"],
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("environmentRegistrations", {
      id: "0198c0de-cccc-7ccc-8ccc-000000000001",
      companyId,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: "thumbprint",
      descriptor: { platform: { os: "darwin" } },
      relayLinkState: "linked",
      managedEndpointAvailable: false,
      lastSeenAt: NOW,
      serviceRoleIds: [],
      teamIds: [],
      state: "active",
      registeredByMembershipId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

describe("checkoutless project setup", () => {
  it("binds a new local checkout to the explicitly selected company project", async () => {
    const t = harness();
    const ids = await seed(t);
    await registerEnvironment(t, ids.companyId);
    const pendingProjectDocId = await t.run(async (ctx) =>
      ctx.db.insert("cloudProjects", {
        id: PENDING_PROJECT_ID,
        companyId: ids.companyId,
        name: "Pending setup",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      }),
    );

    const result = await asOwner(t).mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PENDING_PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "local-pending",
      localWorkspaceRoot: "/work/pending",
      name: "Pending setup",
    });

    expect(result).toBe(PENDING_PROJECT_ID);
    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(pendingProjectDocId),
      binding: (await ctx.db.query("environmentBindings").collect()).find(
        (binding) => binding.localProjectId === "local-pending",
      ),
      duplicate: (await ctx.db.query("cloudProjects").collect()).find(
        (project) => project.id === "local-pending",
      ),
    }));
    expect(state.binding?.cloudProjectId).toBe(pendingProjectDocId);
    expect(state.project?.preferredBindingId).toBe(state.binding?.id);
    expect(state.duplicate).toBeUndefined();
  });
});

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

  it("reports whether the call actually removed a project", async () => {
    const t = harness();
    await seed(t);
    const owner = asOwner(t);

    expect(
      await owner.mutation(api.cloudProjects.deleteCompanyProject, {
        companyId: COMPANY_ID,
        cloudProjectId: PROJECT_ID,
      }),
    ).toEqual({ deleted: true });

    // A caller holding the same project id in several workspaces asks each of them in turn, so
    // "this company owns nothing by that id" has to read differently from "removed".
    expect(
      await owner.mutation(api.cloudProjects.deleteCompanyProject, {
        companyId: COMPANY_ID,
        cloudProjectId: PROJECT_ID,
      }),
    ).toEqual({ deleted: false });
    expect(
      await owner.mutation(api.cloudProjects.deleteCompanyProject, {
        companyId: COMPANY_ID,
        cloudProjectId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toEqual({ deleted: false });
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

  it("does not resurrect a deleted project during a reconnect bootstrap", async () => {
    const t = harness();
    await seed(t);
    const owner = asOwner(t);

    const before = await owner.query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: null,
    });
    expect(before.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "cloudProject", entityId: PROJECT_ID }),
      ]),
    );

    await owner.mutation(api.cloudProjects.deleteCompanyProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
    });

    const after = await owner.query(api.sync.bootstrap, {
      companyId: COMPANY_ID,
      cursor: null,
    });
    expect(after.entities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "cloudProject", entityId: PROJECT_ID }),
      ]),
    );
    expect(after.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "environmentBinding",
          entityId: BINDING_ID,
          payload: expect.objectContaining({ status: "revoked" }),
        }),
      ]),
    );
  });
});

/** A second company the same environment (and user) is registered with. */
async function seedSecondCompany(t: Harness) {
  return await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", {
      id: "0198c0de-bbbb-7bbb-8bbb-000000000001",
      name: "Second Test Co",
      workspaceKind: "organization",
      issueKeyPrefix: "STC",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "project_owner"))
      .unique();
    if (user === null) throw new Error("seed missing user");
    const membershipId = await ctx.db.insert("memberships", {
      id: "0198c0de-bbbb-7bbb-8bbb-000000000002",
      companyId,
      userId: user._id,
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
    return { companyId };
  });
}

describe("single-company project ownership", () => {
  it("reconciliation refreshes an owned project but never mints one", async () => {
    const t = harness();
    await seed(t);

    const result = await asOwner(t).mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "local-unowned",
      localWorkspaceRoot: "/work/unowned",
      name: "Unowned",
      allowCreate: false,
    });
    expect(result).toBeNull();

    const created = await t.run(async (ctx) =>
      (await ctx.db.query("cloudProjects").collect()).filter((row) => row.id === "local-unowned"),
    );
    expect(created).toEqual([]);
  });

  it("does not mirror a checkout into a second company that did not own it", async () => {
    const t = harness();
    await seed(t);
    const second = await seedSecondCompany(t);

    const result = await asOwner(t).mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: "0198c0de-bbbb-7bbb-8bbb-000000000001",
      environmentId: ENVIRONMENT_ID,
      localProjectId: LOCAL_PROJECT_ID,
      localWorkspaceRoot: "/work/pathway",
      name: "Pathway",
    });
    expect(result).toBe(PROJECT_ID);

    const foreignRows = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("cloudProjects").collect()).filter(
        (row) => row.companyId === second.companyId,
      ),
      bindings: (await ctx.db.query("environmentBindings").collect()).filter(
        (row) => row.companyId === second.companyId,
      ),
    }));
    expect(foreignRows.projects).toEqual([]);
    expect(foreignRows.bindings).toEqual([]);
  });
});

describe("stale environment binding reclamation", () => {
  it("marks bindings stale when the environment has no active registration", async () => {
    const t = harness();
    const ids = await seed(t);

    await t.mutation(internal.cloudProjects.revokeStaleEnvironmentBindings, {});

    const state = await t.run(async (ctx) => ({
      binding: await ctx.db.get(ids.bindingId),
      project: await ctx.db.get(ids.projectId),
      changes: (await ctx.db.query("syncChanges").collect())
        .slice()
        .sort((left, right) => left.version - right.version),
    }));
    expect(state.binding).toMatchObject({ status: "stale" });
    // The stale binding was the preferred one, and nothing replaced it.
    expect(state.project).toMatchObject({ preferredBindingId: null });
    expect(state.changes.map((change) => [change.entityKind, change.entityId])).toEqual([
      ["environmentBinding", BINDING_ID],
      ["cloudProject", PROJECT_ID],
    ]);
  });

  it("leaves bindings of actively registered environments alone", async () => {
    const t = harness();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("environmentRegistrations", {
        id: "0198c0de-cccc-7ccc-8ccc-000000000001",
        companyId: ids.companyId,
        environmentId: ENVIRONMENT_ID,
        publicKeyThumbprint: "thumbprint",
        descriptor: { platform: { os: "darwin" } },
        relayLinkState: "linked",
        managedEndpointAvailable: false,
        lastSeenAt: NOW,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    await t.mutation(internal.cloudProjects.revokeStaleEnvironmentBindings, {});

    const binding = await t.run(async (ctx) => await ctx.db.get(ids.bindingId));
    expect(binding).toMatchObject({ status: "active" });
  });
});
