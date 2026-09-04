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
    return { companyId, membershipId, projectId, bindingId, threadId, milestoneId };
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

async function seedMergeDuplicate(t: Harness, ids: Awaited<ReturnType<typeof seed>>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("cloudProjects", {
      id: PENDING_PROJECT_ID,
      companyId: ids.companyId,
      name: "Pathway duplicate",
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
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
      rootPath: "/Users/corey/GitHub/pathway",
      displayName: "spiritdevs/pathway",
    };
    const bindingId = await ctx.db.insert("environmentBindings", {
      id: "0198c0de-aaaa-7aaa-8aaa-000000000007",
      companyId: ids.companyId,
      cloudProjectId: projectId,
      environmentId: "environment-laptop",
      localProjectId: "local-pathway-laptop",
      localWorkspaceRoot: "/Users/corey/GitHub/pathway",
      repositoryIdentity,
      repositoryKey: repositoryIdentity.canonicalKey,
      status: "active",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      version: 0,
    });
    const threadId = await ctx.db.insert("agentThreads", {
      id: "environment-laptop:thread-2",
      companyId: ids.companyId,
      environmentId: "environment-laptop",
      cloudProjectId: projectId,
      localProjectId: "local-pathway-laptop",
      threadId: "thread-2",
      shell: { id: "thread-2", projectId: "local-pathway-laptop" },
      updatedAt: NOW,
      version: 0,
    });
    return { projectId, bindingId, threadId, repositoryIdentity };
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

  it("keeps the stored repository identity when a republish has not resolved one yet", async () => {
    const t = harness();
    const ids = await seed(t);
    await registerEnvironment(t, ids.companyId);
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:spiritdevs/pathway.git",
      },
      rootPath: "/work/pathway",
    };
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bindingId, {
        repositoryIdentity,
        repositoryKey: repositoryIdentity.canonicalKey,
      });
    });

    // The publisher re-reports each project every minute, and its enrichment cache expires on the
    // same cadence — a null identity here means "not resolved yet" and must not clear or republish.
    const result = await asOwner(t).mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: LOCAL_PROJECT_ID,
      localWorkspaceRoot: "/work/pathway",
      repositoryIdentity: null,
      name: "Pathway",
    });

    expect(result).toBe(PROJECT_ID);
    const state = await t.run(async (ctx) => ({
      binding: await ctx.db.get(ids.bindingId),
      bindingChanges: (await ctx.db.query("syncChanges").collect()).filter(
        (change) => change.entityKind === "environmentBinding",
      ),
    }));
    expect(state.binding?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(state.binding?.repositoryKey).toBe(repositoryIdentity.canonicalKey);
    expect(state.bindingChanges).toHaveLength(0);
  });

  it("creates a distinct company project when repository matching is disabled", async () => {
    const t = harness();
    const ids = await seed(t);
    await registerEnvironment(t, ids.companyId);
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:spiritdevs/pathway.git",
      },
      rootPath: "/work/pathway",
    };
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bindingId, {
        repositoryIdentity,
        repositoryKey: repositoryIdentity.canonicalKey,
      });
    });

    const result = await asOwner(t).mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "local-independent",
      localWorkspaceRoot: "/work/pathway-v2",
      repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/pathway-v2" },
      matchRepository: false,
      name: "Pathway v2",
    });

    expect(result).toBe("local-independent");
    const state = await t.run(async (ctx) => ({
      project: (await ctx.db.query("cloudProjects").collect()).find(
        (project) => project.id === "local-independent",
      ),
      binding: (await ctx.db.query("environmentBindings").collect()).find(
        (binding) => binding.localProjectId === "local-independent",
      ),
    }));
    expect(state.project?.name).toBe("Pathway v2");
    expect(state.binding?.cloudProjectId).toBe(state.project?._id);
    expect(state.binding?.cloudProjectId).not.toBe(ids.projectId);
  });

  it("creates a distinct project after a legacy repository link is released", async () => {
    const t = harness();
    const ids = await seed(t);
    await registerEnvironment(t, ids.companyId);
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:spiritdevs/pathway.git",
      },
      rootPath: "/work/pathway-v2",
    };
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bindingId, {
        localProjectId: "local-independent",
        localWorkspaceRoot: "/work/pathway-v2",
        repositoryIdentity,
        repositoryKey: repositoryIdentity.canonicalKey,
      });
    });
    const owner = asOwner(t);

    await owner.mutation(api.cloudProjects.releaseEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "local-independent",
    });
    const result = await owner.mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "local-independent",
      localWorkspaceRoot: "/work/pathway-v2",
      repositoryIdentity,
      matchRepository: false,
      name: "Pathway v2",
    });

    expect(result).toBe("local-independent");
    const state = await t.run(async (ctx) => ({
      projects: await ctx.db.query("cloudProjects").collect(),
      bindings: (await ctx.db.query("environmentBindings").collect()).filter(
        (binding) => binding.localProjectId === "local-independent",
      ),
    }));
    const distinctProject = state.projects.find((project) => project.id === "local-independent");
    expect(state.bindings).toHaveLength(2);
    expect(state.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cloudProjectId: ids.projectId, status: "revoked" }),
        expect.objectContaining({ cloudProjectId: distinctProject?._id, status: "active" }),
      ]),
    );
  });
});

describe("company project merge", () => {
  it("moves duplicate connections and threads while preserving the selected repository", async () => {
    const t = harness();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.projectId, { teamIds: ["team-target"] });
    });
    const duplicate = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("cloudProjects", {
        id: PENDING_PROJECT_ID,
        companyId: ids.companyId,
        name: "Pathway duplicate",
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
      const bindingId = await ctx.db.insert("environmentBindings", {
        id: "0198c0de-aaaa-7aaa-8aaa-000000000007",
        companyId: ids.companyId,
        cloudProjectId: projectId,
        environmentId: "environment-laptop",
        localProjectId: "local-pathway-laptop",
        localWorkspaceRoot: "/Users/corey/GitHub/pathway",
        repositoryIdentity: {
          canonicalKey: "github.com/spiritdevs/pathway",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/SpiritDevs/pathway.git",
          },
          rootPath: "/Users/corey/GitHub/pathway",
          displayName: "spiritdevs/pathway",
        },
        repositoryKey: "github.com/spiritdevs/pathway",
        status: "active",
        lastSeenAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        version: 0,
      });
      const threadId = await ctx.db.insert("agentThreads", {
        id: "environment-laptop:thread-2",
        companyId: ids.companyId,
        environmentId: "environment-laptop",
        cloudProjectId: projectId,
        localProjectId: "local-pathway-laptop",
        threadId: "thread-2",
        shell: { id: "thread-2", projectId: "local-pathway-laptop" },
        updatedAt: NOW,
        version: 0,
      });
      const issueViewId = await ctx.db.insert("issueViews", {
        id: "0198c0de-aaaa-7aaa-8aaa-000000000008",
        companyId: ids.companyId,
        ownerMembershipId: ids.membershipId,
        visibility: "company",
        teamIds: [],
        name: "Duplicate project work",
        config: {
          tab: "active",
          projectIds: [PENDING_PROJECT_ID, PROJECT_ID],
          grouping: "status",
          sortMode: "manual",
          viewMode: "list",
        },
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });
      const commandId = await ctx.db.insert("environmentCommands", {
        id: "0198c0de-aaaa-7aaa-8aaa-000000000009",
        companyId: ids.companyId,
        targetEnvironmentId: "environment-laptop",
        cloudProjectId: projectId,
        bindingId: "0198c0de-aaaa-7aaa-8aaa-000000000007",
        kind: "startThread",
        args: { projectId: "local-pathway-laptop" },
        issuedByMembershipId: ids.membershipId,
        onBehalfOfActor: { kind: "member", membershipId: MEMBERSHIP_ID },
        state: "claimed",
        claimedByEnvironmentId: "environment-laptop",
        claimGeneration: 2,
        claimExpiresAt: NOW + 60_000,
        expiresAt: NOW + 120_000,
        result: null,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 0,
      });
      return { projectId, bindingId, threadId, issueViewId, commandId };
    });
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
      rootPath: "/Users/corey/GitHub/pathway",
      displayName: "spiritdevs/pathway",
    };

    const result = await asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
      companyId: COMPANY_ID,
      sourceCloudProjectId: PENDING_PROJECT_ID,
      targetCloudProjectId: PROJECT_ID,
      repositoryIdentity,
    });
    await t.mutation(internal.cloudProjects.retargetMergedProjectIssueViews, {
      companyId: ids.companyId,
      sourceProjectId: PENDING_PROJECT_ID,
      targetProjectId: PROJECT_ID,
      cursor: null,
    });

    const state = await t.run(async (ctx) => ({
      target: await ctx.db.get(ids.projectId),
      source: await ctx.db.get(duplicate.projectId),
      binding: await ctx.db.get(duplicate.bindingId),
      thread: await ctx.db.get(duplicate.threadId),
      issueView: await ctx.db.get(duplicate.issueViewId),
      command: await ctx.db.get(duplicate.commandId),
      changes: await ctx.db.query("syncChanges").collect(),
    }));
    expect(result).toEqual({ movedBindings: 1, movedThreads: 1, movedIssues: 0 });
    expect(state.target?.repositoryIdentity).toEqual({
      canonicalKey: repositoryIdentity.canonicalKey,
      locator: repositoryIdentity.locator,
      displayName: repositoryIdentity.displayName,
    });
    expect(state.target?.repositoryIdentityAuthority).toBe("merge");
    expect(state.target?.teamIds).toEqual([]);
    expect(state.source?.deletedAt).toEqual(expect.any(Number));
    expect(state.binding).toMatchObject({
      cloudProjectId: ids.projectId,
      repositoryKey: repositoryIdentity.canonicalKey,
      repositoryIdentity: {
        ...repositoryIdentity,
        rootPath: "/Users/corey/GitHub/pathway",
      },
    });
    expect(state.thread?.cloudProjectId).toBe(ids.projectId);
    expect(state.issueView?.config).toMatchObject({ projectIds: [PROJECT_ID] });
    expect(state.command).toMatchObject({
      cloudProjectId: ids.projectId,
      bindingId: null,
      state: "pending",
      claimedByEnvironmentId: null,
      claimGeneration: 3,
      claimExpiresAt: null,
    });
    expect(state.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "agentThread",
          entityId: `${ENVIRONMENT_ID}:thread-1`,
        }),
        expect.objectContaining({ entityKind: "issueMilestone", entityId: MILESTONE_ID }),
        expect.objectContaining({
          entityKind: "issueView",
          entityId: "0198c0de-aaaa-7aaa-8aaa-000000000008",
        }),
      ]),
    );
  });

  it("rejects a locator that was not detected with the selected canonical key", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: {
          ...duplicate.repositoryIdentity,
          locator: {
            ...duplicate.repositoryIdentity.locator,
            remoteUrl: "https://example.test/untrusted.git",
          },
        },
      }),
    ).rejects.toThrow("already detected");
  });

  it("rejects two active project bindings in the same environment", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bindingId, { environmentId: "environment-laptop" });
    });

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: duplicate.repositoryIdentity,
      }),
    ).rejects.toThrow("both have active connections in one environment");
  });

  it("rejects oversized serialized payloads before moving project records", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);
    await t.run(async (ctx) => {
      for (let index = 0; index < 4; index += 1) {
        await ctx.db.insert("capturedEmails", {
          id: `environment-laptop:large-message-${index}`,
          companyId: ids.companyId,
          environmentId: "environment-laptop",
          cloudProjectId: duplicate.projectId,
          localProjectId: "local-pathway-laptop",
          messageId: `large-message-${index}`,
          message: { subject: "x".repeat(600_000) },
          updatedAt: NOW,
          version: 0,
        });
      }
    });

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: duplicate.repositoryIdentity,
      }),
    ).rejects.toThrow("too much serialized project data");
    const source = await t.run(async (ctx) => ctx.db.get(duplicate.projectId));
    expect(source?.deletedAt).toBeNull();
  });

  it("ignores terminal command history when bounding merge work", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);
    await t.run(async (ctx) => {
      for (let index = 0; index < 2_001; index += 1) {
        await ctx.db.insert("environmentCommands", {
          id: `0198c0de-eeee-7eee-8eee-${String(index).padStart(12, "0")}`,
          companyId: ids.companyId,
          targetEnvironmentId: ENVIRONMENT_ID,
          cloudProjectId: duplicate.projectId,
          bindingId: null,
          kind: "statusQuery",
          args: {},
          issuedByMembershipId: ids.membershipId,
          onBehalfOfActor: { kind: "member", membershipId: MEMBERSHIP_ID },
          state: "succeeded",
          claimedByEnvironmentId: null,
          claimGeneration: 0,
          claimExpiresAt: null,
          expiresAt: NOW + 120_000,
          result: null,
          error: null,
          createdAt: NOW,
          updatedAt: NOW,
          version: 0,
        });
      }
    });

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: duplicate.repositoryIdentity,
      }),
    ).resolves.toMatchObject({ movedBindings: 1, movedThreads: 1 });
  });

  it("does not reject a merge because the company has extensive saved-view history", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);
    await t.run(async (ctx) => {
      for (let index = 0; index < 2_001; index += 1) {
        await ctx.db.insert("issueViews", {
          id: `0198c0de-dddd-7ddd-8ddd-${String(index).padStart(12, "0")}`,
          companyId: ids.companyId,
          ownerMembershipId: ids.membershipId,
          visibility: "private",
          teamIds: [],
          name: `Deleted view ${index}`,
          config: { tab: "active", projectIds: [] },
          position: index,
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: NOW,
          version: 0,
        });
      }
    });

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: duplicate.repositoryIdentity,
      }),
    ).resolves.toMatchObject({ movedBindings: 1, movedThreads: 1 });
  });

  it("rejects an oversized merge before moving any records", async () => {
    const t = harness();
    const ids = await seed(t);
    const duplicate = await seedMergeDuplicate(t, ids);
    await t.run(async (ctx) => {
      for (let index = 0; index < 300; index += 1) {
        await ctx.db.insert("agentThreads", {
          id: `environment-laptop:overflow-${index}`,
          companyId: ids.companyId,
          environmentId: "environment-laptop",
          cloudProjectId: duplicate.projectId,
          localProjectId: "local-pathway-laptop",
          threadId: `overflow-${index}`,
          shell: { id: `overflow-${index}`, projectId: "local-pathway-laptop" },
          updatedAt: NOW,
          version: 0,
        });
      }
    });

    await expect(
      asOwner(t).mutation(api.cloudProjects.mergeCompanyProjects, {
        companyId: COMPANY_ID,
        sourceCloudProjectId: PENDING_PROJECT_ID,
        targetCloudProjectId: PROJECT_ID,
        repositoryIdentity: duplicate.repositoryIdentity,
      }),
    ).rejects.toThrow("too many source threads");
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.get(duplicate.projectId),
      binding: await ctx.db.get(duplicate.bindingId),
    }));
    expect(state.source?.deletedAt).toBeNull();
    expect(state.binding?.cloudProjectId).toBe(duplicate.projectId);
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

  it("removes every user's Focus assignments for each bound checkout", async () => {
    const t = harness();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      const owner = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "project_owner"))
        .unique();
      if (owner === null) throw new Error("Expected the project owner.");
      const otherUserId = await ctx.db.insert("users", {
        clerkSubject: "other_user",
        email: "other_user@example.test",
        displayName: "Other User",
        imageUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const ownerFocusId = await ctx.db.insert("focuses", {
        id: "0198c0de-eeee-7eee-8eee-000000000001",
        userId: owner._id,
        name: "Owner Focus",
        iconName: "Briefcase",
        accentColor: "#3366ff",
        orderKey: "a",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const otherFocusId = await ctx.db.insert("focuses", {
        id: "0198c0de-eeee-7eee-8eee-000000000002",
        userId: otherUserId,
        name: "Other Focus",
        iconName: "House",
        accentColor: "#ff6633",
        orderKey: "a",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("environmentBindings", {
        id: "0198c0de-eeee-7eee-8eee-000000000003",
        companyId: ids.companyId,
        cloudProjectId: ids.projectId,
        environmentId: "environment-studio",
        localProjectId: "local-pathway-studio",
        localWorkspaceRoot: "/work/pathway-studio",
        status: "active",
        lastSeenAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        version: 0,
      });
      for (const [userId, focusId, projectKey] of [
        [owner._id, ownerFocusId, `${ENVIRONMENT_ID}:${LOCAL_PROJECT_ID}`],
        [otherUserId, otherFocusId, `${ENVIRONMENT_ID}:${LOCAL_PROJECT_ID}`],
        [otherUserId, otherFocusId, "environment-studio:local-pathway-studio"],
        [owner._id, ownerFocusId, `${ENVIRONMENT_ID}:other-project`],
        [otherUserId, otherFocusId, "environment-other:other-project"],
      ] as const) {
        await ctx.db.insert("focusAssignments", {
          userId,
          focusId,
          projectKey,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });

    await asOwner(t).mutation(api.cloudProjects.deleteCompanyProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
    });

    const assignments = await t.run(async (ctx) =>
      (await ctx.db.query("focusAssignments").collect())
        .map((assignment) => assignment.projectKey)
        .sort(),
    );
    expect(assignments).toEqual([
      `${ENVIRONMENT_ID}:other-project`,
      "environment-other:other-project",
    ]);
  });

  it("removes project-owned issues, email, automation, commands, and Slack routes", async () => {
    const t = harness();
    const ids = await seed(t);
    const issueId = "0198c0de-dddd-7ddd-8ddd-000000000001";
    const childIssueId = "0198c0de-dddd-7ddd-8ddd-000000000002";
    const commentId = "0198c0de-dddd-7ddd-8ddd-000000000003";
    const integrationId = "0198c0de-dddd-7ddd-8ddd-000000000004";
    const v1WatchId = "0198c0de-dddd-7ddd-8ddd-000000000005";
    const v2WatchId = "0198c0de-dddd-7ddd-8ddd-000000000006";
    const deletedWatchId = "0198c0de-dddd-7ddd-8ddd-000000000017";
    const matchingRuleId = "0198c0de-dddd-7ddd-8ddd-000000000007";
    const remainingRuleId = "0198c0de-dddd-7ddd-8ddd-000000000008";
    const commandId = "0198c0de-dddd-7ddd-8ddd-000000000009";
    const emailId = `${ENVIRONMENT_ID}:message-1`;

    await t.run(async (ctx) => {
      const issue = async (id: string, projectId: string | null, parentId: string | null) =>
        await ctx.db.insert("issues", {
          id,
          companyId: ids.companyId,
          key: id === issueId ? "PTC-1" : "PTC-2",
          keyNumber: id === issueId ? 1 : 2,
          title: id === issueId ? "Delete me" : "Keep me",
          description: "",
          statusId: "status-todo",
          priority: "none",
          assignee: null,
          projectId,
          milestoneId: projectId === null ? null : MILESTONE_ID,
          cycleId: null,
          parentId,
          sortOrder: id,
          labelIds: [],
          dueDate: null,
          triage: false,
          slackSource: null,
          teamIds: [],
          workflowOwner: { kind: "company" },
          workModelSelection: null,
          automationAssignment: null,
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
          version: 0,
        });
      await issue(issueId, PROJECT_ID, null);
      await issue(childIssueId, null, issueId);
      await ctx.db.insert("issueTodos", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000010",
        companyId: ids.companyId,
        issueId,
        text: "Delete this",
        done: false,
        sortOrder: "a",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });
      await ctx.db.insert("issueComments", {
        id: commentId,
        companyId: ids.companyId,
        issueId,
        body: "Delete this",
        author: { kind: "member", membershipId: MEMBERSHIP_ID },
        attachmentIds: ["0198c0de-dddd-7ddd-8ddd-000000000011"],
        mentions: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });
      await ctx.db.insert("issueAttachments", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000011",
        companyId: ids.companyId,
        issueId,
        commentId,
        storageId: null,
        fileName: "evidence.txt",
        mimeType: "text/plain",
        byteSize: 8,
        checksum: "checksum",
        uploadedByMembershipId: ids.membershipId,
        state: "ready",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        version: 0,
      });
      await ctx.db.insert("issueAuditEvents", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000012",
        companyId: ids.companyId,
        issueId,
        kind: "created",
        actor: { kind: "member", membershipId: MEMBERSHIP_ID },
        payload: {},
        operationId: null,
        createdAt: NOW,
        version: 0,
      });
      await ctx.db.insert("issueAuditEvents", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000099",
        companyId: ids.companyId,
        issueId,
        kind: "deleted_snapshot",
        actor: { kind: "member", membershipId: MEMBERSHIP_ID },
        payload: { deletedIssue: { id: issueId } },
        operationId: null,
        createdAt: NOW,
        version: 0,
      });
      await ctx.db.insert("issueThreadLinks", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000013",
        companyId: ids.companyId,
        issueId,
        environmentId: ENVIRONMENT_ID,
        threadId: "thread-1",
        origin: "start-work",
        createdByMembershipId: ids.membershipId,
        createdAt: NOW,
        deletedAt: null,
        version: 0,
      });
      await ctx.db.insert("issueRelations", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000014",
        companyId: ids.companyId,
        issueId,
        relatedIssueId: childIssueId,
        kind: "relates",
        createdAt: NOW,
        deletedAt: null,
        version: 0,
      });
      await ctx.db.insert("capturedEmails", {
        id: emailId,
        companyId: ids.companyId,
        environmentId: ENVIRONMENT_ID,
        cloudProjectId: ids.projectId,
        localProjectId: LOCAL_PROJECT_ID,
        messageId: "message-1",
        message: { subject: "Delete this" },
        updatedAt: NOW,
        version: 0,
      });
      await ctx.db.insert("environmentCommands", {
        id: commandId,
        companyId: ids.companyId,
        targetEnvironmentId: ENVIRONMENT_ID,
        cloudProjectId: ids.projectId,
        bindingId: BINDING_ID,
        kind: "startThread",
        args: { projectId: LOCAL_PROJECT_ID },
        issuedByMembershipId: ids.membershipId,
        onBehalfOfActor: { kind: "member", membershipId: MEMBERSHIP_ID },
        state: "claimed",
        claimedByEnvironmentId: ENVIRONMENT_ID,
        claimGeneration: 1,
        claimExpiresAt: NOW + 60_000,
        expiresAt: NOW + 120_000,
        result: null,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 0,
      });
      const integrationDocId = await ctx.db.insert("slackIntegrations", {
        id: integrationId,
        companyId: ids.companyId,
        workspaceId: "workspace-1",
        workspaceName: "Test Slack",
        workspaceDomain: null,
        botUserId: null,
        botId: null,
        state: "active",
        activatedAt: NOW,
        credentialPresent: true,
        preferredEnvironmentId: ENVIRONMENT_ID,
        backupEnvironmentIds: [],
        configurationRevision: 1,
        lastPollAt: NOW,
        currentError: null,
        blockedReason: null,
        watchCount: 3,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackChannelWatches", {
        id: v1WatchId,
        companyId: ids.companyId,
        integrationId: integrationDocId,
        channelId: "channel-v1",
        channelName: "v1",
        cloudProjectId: ids.projectId,
        cycleId: "cycle-1",
        autoInvestigate: true,
        autoAssign: true,
        trigger: {
          everyMessage: true,
          botMention: false,
          reactionRoutes: [
            { emoji: "ticket", cloudProjectId: PROJECT_ID, autoInvestigate: null },
            { emoji: "triage", cloudProjectId: null, autoInvestigate: null },
          ],
        },
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackChannelWatches", {
        id: v2WatchId,
        companyId: ids.companyId,
        integrationId: integrationDocId,
        channelId: "channel-v2",
        channelName: "v2",
        cloudProjectId: null,
        cycleId: null,
        autoInvestigate: false,
        autoAssign: false,
        trigger: { everyMessage: false, botMention: false, reactionRoutes: [] },
        configurationVersion: 2,
        rules: [
          { id: matchingRuleId, cloudProjectId: PROJECT_ID },
          { id: remainingRuleId, cloudProjectId: null },
        ],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackChannelWatches", {
        id: deletedWatchId,
        companyId: ids.companyId,
        integrationId: integrationDocId,
        channelId: "channel-project-only",
        channelName: "project-only",
        cloudProjectId: ids.projectId,
        cycleId: null,
        autoInvestigate: false,
        autoAssign: false,
        trigger: { everyMessage: true, botMention: false, reactionRoutes: [] },
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackChannelCursors", {
        companyId: ids.companyId,
        integrationId: integrationDocId,
        channelId: "channel-project-only",
        messageCursor: null,
        reactionCursor: null,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackPendingIntake", {
        companyId: ids.companyId,
        integrationId: integrationDocId,
        channelId: "channel-v2",
        messageTs: "1.000001",
        watchRevision: 1,
        candidateRuleId: matchingRuleId,
        eligibleAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackIssueAutomationIntents", {
        companyId: ids.companyId,
        issueId,
        integrationId: integrationDocId,
        watchId: v2WatchId,
        watchRevision: 1,
        ruleId: matchingRuleId,
        ruleSnapshot: "{}",
        cloudProjectId: ids.projectId,
        investigationTiming: "off",
        investigationTriggerStatusId: null,
        investigationSuccessStatusId: null,
        investigationState: "off",
        assignmentTiming: "off",
        assignmentState: "off",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackProcessedMessages", {
        companyId: ids.companyId,
        integrationId: integrationDocId,
        workspaceId: "workspace-1",
        channelId: "channel-v2",
        messageTs: "1.000001",
        rootMessageTs: "1.000001",
        disposition: "created",
        issueId,
        commentId,
        reason: null,
        processedAt: NOW,
      });
      await ctx.db.insert("slackOutboundDeliveries", {
        companyId: ids.companyId,
        integrationId: integrationDocId,
        deliveryId: "0198c0de-dddd-7ddd-8ddd-000000000015",
        channelId: "channel-v2",
        threadTs: "1.000001",
        kind: "status",
        issueId,
        state: "pending",
        claimedByEnvironmentId: null,
        claimGeneration: 0,
        claimExpiresAt: null,
        slackMessageTs: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("issueAutomationJobs", {
        id: "0198c0de-dddd-7ddd-8ddd-000000000016",
        companyId: ids.companyId,
        issueId,
        kind: "automatic-assignment",
        triggerKey: "delete-test",
        settingsRevision: 1,
        modelSelection: null,
        ruleId: matchingRuleId,
        ruleSnapshot: "{}",
        targetKind: "project",
        cloudProjectId: ids.projectId,
        threadId: null,
        targetEnvironmentId: ENVIRONMENT_ID,
        requiredProviderInstanceId: null,
        requiredModel: null,
        state: "pending",
        blockCode: null,
        diagnostic: null,
        claimHolderEnvironmentId: null,
        claimGeneration: 0,
        claimExpiresAt: null,
        attempts: 0,
        nextRetryAt: null,
        result: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      });
    });

    await asOwner(t).mutation(api.cloudProjects.deleteCompanyProject, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
    });

    const state = await t.run(async (ctx) => ({
      issues: await ctx.db.query("issues").collect(),
      todos: await ctx.db.query("issueTodos").collect(),
      comments: await ctx.db.query("issueComments").collect(),
      attachments: await ctx.db.query("issueAttachments").collect(),
      audits: await ctx.db.query("issueAuditEvents").collect(),
      links: await ctx.db.query("issueThreadLinks").collect(),
      relations: await ctx.db.query("issueRelations").collect(),
      emails: await ctx.db.query("capturedEmails").collect(),
      emailDeletions: await ctx.db.query("capturedEmailDeletions").collect(),
      commands: await ctx.db.query("environmentCommands").collect(),
      watches: await ctx.db.query("slackChannelWatches").collect(),
      cursors: await ctx.db.query("slackChannelCursors").collect(),
      pendingIntake: await ctx.db.query("slackPendingIntake").collect(),
      intents: await ctx.db.query("slackIssueAutomationIntents").collect(),
      processed: await ctx.db.query("slackProcessedMessages").collect(),
      deliveries: await ctx.db.query("slackOutboundDeliveries").collect(),
      automationJobs: await ctx.db.query("issueAutomationJobs").collect(),
      integration: await ctx.db.query("slackIntegrations").first(),
      changes: await ctx.db.query("syncChanges").collect(),
    }));

    expect(state.issues).toEqual([
      expect.objectContaining({ id: childIssueId, parentId: null, deletedAt: null }),
    ]);
    expect([
      state.todos,
      state.comments,
      state.attachments,
      state.audits,
      state.links,
      state.relations,
      state.emails,
      state.commands,
      state.pendingIntake,
      state.intents,
      state.deliveries,
      state.automationJobs,
    ]).toEqual([[], [], [], [], [], [], [], [], [], [], [], []]);
    expect(state.emailDeletions).toEqual([
      expect.objectContaining({
        id: emailId,
        environmentId: ENVIRONMENT_ID,
        messageId: "message-1",
      }),
    ]);
    expect(state.processed).toEqual([
      expect.objectContaining({
        disposition: "ignored",
        issueId: null,
        commentId: null,
        reason: "Project deleted.",
      }),
    ]);
    expect(state.integration).toMatchObject({ configurationRevision: 2, watchCount: 2 });
    expect(state.watches).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: deletedWatchId })]),
    );
    expect(state.cursors).toEqual([]);
    expect(state.watches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: v1WatchId,
          cloudProjectId: null,
          cycleId: null,
          revision: 2,
          trigger: expect.objectContaining({
            everyMessage: false,
            botMention: false,
            reactionRoutes: [expect.objectContaining({ emoji: "triage", cloudProjectId: null })],
          }),
        }),
        expect.objectContaining({
          id: v2WatchId,
          revision: 2,
          rules: [expect.objectContaining({ id: remainingRuleId, cloudProjectId: null })],
        }),
      ]),
    );
    expect(state.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "issue",
          entityId: issueId,
          changeKind: "tombstone",
        }),
        expect.objectContaining({
          entityKind: "issue",
          entityId: childIssueId,
          changeKind: "upsert",
        }),
        expect.objectContaining({
          entityKind: "capturedEmail",
          entityId: emailId,
          changeKind: "tombstone",
        }),
        expect.objectContaining({
          entityKind: "environmentCommand",
          entityId: commandId,
          changeKind: "tombstone",
        }),
        expect.objectContaining({
          entityKind: "issueAuditEvent",
          entityId: "0198c0de-dddd-7ddd-8ddd-000000000099",
          changeKind: "tombstone",
          payload: null,
          deletedIssueSnapshot: true,
        }),
      ]),
    );
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
