// @effect-diagnostics globalDate:off -- Test fixtures mirror Convex documents and use epoch milliseconds.
/** End-to-end company environment registry, authorization, feed, and bootstrap coverage. */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { appendCompanyChanges, encodeEnvironmentBinding } from "../convex/lib/companyApply.ts";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/agentThreads.ts": () => import("../convex/agentThreads.ts"),
  "../convex/capturedEmails.ts": () => import("../convex/capturedEmails.ts"),
  "../convex/emailTags.ts": () => import("../convex/emailTags.ts"),
  "../convex/trustedEmailSenders.ts": () => import("../convex/trustedEmailSenders.ts"),
  "../convex/cloudProjects.ts": () => import("../convex/cloudProjects.ts"),
  "../convex/environments.ts": () => import("../convex/environments.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const COMPANY_ID = "0198f900-0000-7000-8000-000000000001";
const COMPANY_TWO_ID = "0198f900-0000-7000-8000-000000000002";
const COMPANY_THREE_ID = "0198f900-0000-7000-8000-000000000003";
const MANAGER_MEMBERSHIP_ID = "0198f900-0000-7000-8000-000000000101";
const READER_MEMBERSHIP_ID = "0198f900-0000-7000-8000-000000000102";
const BLIND_MEMBERSHIP_ID = "0198f900-0000-7000-8000-000000000103";
const MANAGER_ROLE_ID = "0198f900-0000-7000-8000-000000000201";
const READER_ROLE_ID = "0198f900-0000-7000-8000-000000000202";
const BLIND_ROLE_ID = "0198f900-0000-7000-8000-000000000203";
const ENVIRONMENT_ID = "environment-registry-one";
const ENVIRONMENT_TWO = "environment-registry-two";
const REGISTRATION_ID = "0198f900-0000-7000-8000-000000000301";
const REVOKED_REGISTRATION_ID = "0198f900-0000-7000-8000-000000000302";
const PROJECT_ID = "0198f900-0000-7000-8000-000000000401";
const BINDING_ID = "0198f900-0000-7000-8000-000000000501";
const TRUSTED_SENDER_ID = "0198f900-0000-7000-8000-000000000701";
const THUMBPRINT = "thumbprint-registry-one";

const descriptor = (environmentId = ENVIRONMENT_ID, label = "Registry machine") => ({
  environmentId,
  label,
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "1.2.3",
  capabilities: {
    repositoryIdentity: true,
    connectionProbe: true,
    pushAutoSettlement: true,
  },
});

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asUser(t: Harness, subject: string) {
  return t.withIdentity({
    issuer: "https://clerk.example.test",
    subject,
    tokenIdentifier: `https://clerk.example.test|${subject}`,
    email: `${subject}@example.test`,
    name: subject,
  });
}

function asEnvironment(t: Harness, thumbprint = THUMBPRINT) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: ENVIRONMENT_ID,
    tokenIdentifier: `${RELAY_ISSUER}|${ENVIRONMENT_ID}`,
    cnf: { jkt: thumbprint },
  });
}

async function seed(t: Harness, workspaceKind?: "personal" | "organization") {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Registry Test Co",
      ...(workspaceKind === undefined ? {} : { workspaceKind }),
      issueKeyPrefix: "REG",
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
      subject: string,
      id: string,
      roleDomainId: string,
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
      const membershipId = await ctx.db.insert("memberships", {
        id,
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
      const roleId = await ctx.db.insert("roles", {
        id: roleDomainId,
        companyId: companyDocId,
        name: `${subject} role`,
        description: "",
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${id}-assignment`,
        companyId: companyDocId,
        membershipId,
        roleId,
        scope: "company",
        teamId: null,
        createdAt: now,
      });
      return membershipId;
    };

    await addMember("manager", MANAGER_MEMBERSHIP_ID, MANAGER_ROLE_ID, [
      "environments.read",
      "environments.manage",
      "projects.manage",
    ]);
    await addMember("reader", READER_MEMBERSHIP_ID, READER_ROLE_ID, ["environments.read"]);
    await addMember("blind", BLIND_MEMBERSHIP_ID, BLIND_ROLE_ID, ["issues.read"]);
    return { companyDocId, now };
  });
}

async function seedRegistration(t: Harness, state: "active" | "revoked" = "active") {
  const seeded = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("environmentRegistrations", {
      id: REGISTRATION_ID,
      companyId: seeded.companyDocId,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMBPRINT,
      descriptor: descriptor(ENVIRONMENT_ID, "Before publish"),
      relayLinkState: "linked",
      managedEndpointAvailable: true,
      lastSeenAt: null,
      serviceRoleIds: [],
      teamIds: [],
      state,
      registeredByMembershipId: null,
      createdAt: seeded.now,
      updatedAt: seeded.now,
    });
  });
  return seeded;
}

async function publish(t: Harness, label = "Registry machine") {
  await asEnvironment(t).mutation(api.environments.register, {
    companyId: COMPANY_ID,
    environmentId: ENVIRONMENT_ID,
    descriptor: descriptor(ENVIRONMENT_ID, label),
    relayLinkState: "linked",
    managedEndpointAvailable: true,
  });
}

async function feedRows(t: Harness) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("syncChanges").collect()).slice().sort((a, b) => a.version - b.version),
  );
}

interface BootstrapPage {
  readonly entities: { entityKind: string; entityId: string; payload: unknown }[];
  readonly cursor: string | null;
  readonly isDone: boolean;
}

describe("environment registry", () => {
  it("makes a local environment project available to cloud issues exactly once", async () => {
    const t = harness();
    await seedRegistration(t);

    const args = {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: "/workspace/pathway",
      name: "Pathway",
    };
    expect(
      await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, args),
    ).toBe(PROJECT_ID);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("cloudProjects").collect()).toHaveLength(1);
      const bindings = await ctx.db.query("environmentBindings").collect();
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        localProjectId: PROJECT_ID,
        localWorkspaceRoot: "/workspace/pathway",
        status: "active",
      });
    });
    expect((await feedRows(t)).map((row) => row.entityKind)).toEqual([
      "cloudProject",
      "environmentBinding",
    ]);

    await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, args);
    expect(await feedRows(t)).toHaveLength(2);

    await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, {
      ...args,
      localWorkspaceRoot: "/workspace/pathway-next",
      name: "Pathway Next",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("cloudProjects").first()).toMatchObject({ name: "Pathway Next" });
      expect(await ctx.db.query("environmentBindings").first()).toMatchObject({
        localWorkspaceRoot: "/workspace/pathway-next",
        status: "active",
      });
    });
    expect((await feedRows(t)).slice(2).map((row) => row.entityKind)).toEqual([
      "cloudProject",
      "environmentBinding",
    ]);

    await asUser(t, "manager").mutation(api.cloudProjects.releaseEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("environmentBindings").first()).toMatchObject({
        status: "revoked",
      });
      expect(await ctx.db.query("cloudProjects").first()).toMatchObject({
        preferredBindingId: null,
      });
    });

    const versionAfterRelease = (await feedRows(t)).length;
    await asUser(t, "manager").mutation(api.cloudProjects.releaseEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
    });
    expect(await feedRows(t)).toHaveLength(versionAfterRelease);
  });

  it("persists the preferred environment binding for future project work", async () => {
    const t = harness();
    await seedRegistration(t);
    await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: "/workspace/pathway",
      name: "Pathway",
    });
    await t.run(async (ctx) => {
      const project = await ctx.db.query("cloudProjects").first();
      if (project === null) throw new Error("Missing project fixture.");
      await ctx.db.insert("environmentBindings", {
        id: BINDING_ID,
        companyId: project.companyId,
        cloudProjectId: project._id,
        environmentId: ENVIRONMENT_TWO,
        localProjectId: "project-on-second-environment",
        localWorkspaceRoot: "/workspace/pathway",
        status: "active",
        lastSeenAt: 1_700_000_000_000,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      });
    });

    await asUser(t, "manager").mutation(api.cloudProjects.setPreferredEnvironmentBinding, {
      companyId: COMPANY_ID,
      cloudProjectId: PROJECT_ID,
      bindingId: BINDING_ID,
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("cloudProjects").first()).toMatchObject({
        preferredBindingId: BINDING_ID,
      });
    });
    expect((await feedRows(t)).at(-1)).toMatchObject({ entityKind: "cloudProject" });
  });

  it("publishes a registration to members with environments.read and withholds it without that grant", async () => {
    const t = harness();
    await seedRegistration(t);
    await publish(t);

    const visible = await asUser(t, "reader").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(visible).toMatchObject({ _tag: "Changes", cursor: 1 });
    if (visible._tag !== "Changes") return;
    expect(visible.changes).toHaveLength(1);
    expect(visible.changes[0]).toMatchObject({
      version: 1,
      entityKind: "environmentRegistration",
      entityId: REGISTRATION_ID,
      changeKind: "upsert",
      payload: {
        id: REGISTRATION_ID,
        environmentId: ENVIRONMENT_ID,
        descriptor: { label: "Registry machine" },
        lastSeenAt: expect.any(Number),
      },
    });

    const hidden = await asUser(t, "blind").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(hidden).toMatchObject({ _tag: "Changes", changes: [], cursor: 1 });
  });

  it("lets environments.read list and inspect active registrations and refuses callers without it", async () => {
    const t = harness();
    await seedRegistration(t);
    await publish(t);

    await expect(
      asUser(t, "reader").query(api.environments.list, { companyId: COMPANY_ID }),
    ).resolves.toMatchObject([
      {
        id: REGISTRATION_ID,
        environmentId: ENVIRONMENT_ID,
        descriptor: { label: "Registry machine" },
      },
    ]);
    await expect(
      asUser(t, "reader").query(api.environments.get, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
      }),
    ).resolves.toMatchObject({ id: REGISTRATION_ID, lastSeenAt: expect.any(Number) });
    await expect(
      asUser(t, "blind").query(api.environments.list, { companyId: COMPANY_ID }),
    ).rejects.toThrow("Missing permission environments.read");
  });

  it("lets an environment discover every active proof-key-bound company registration", async () => {
    const t = harness();
    await seedRegistration(t);
    await t.run(async (ctx) => {
      const insertCompany = async (
        id: string,
        name: string,
        lifecycleState: "active" | "deletionScheduled",
      ) =>
        await ctx.db.insert("companies", {
          id,
          name,
          issueKeyPrefix: name.slice(0, 3).toUpperCase(),
          nextIssueNumber: 1,
          lifecycleState,
          deletionScheduledAt: lifecycleState === "active" ? null : 1_700_000_000_000,
          purgeAfter: lifecycleState === "active" ? null : 1_700_086_400_000,
          authorizationEpoch: 1,
          syncVersion: 0,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        });
      const insertRegistration = async (input: {
        companyId: Awaited<ReturnType<typeof insertCompany>>;
        id: string;
        publicKeyThumbprint: string;
        state?: "active" | "revoked";
      }) => {
        const state = input.state ?? "active";
        await ctx.db.insert("environmentRegistrations", {
          id: input.id,
          companyId: input.companyId,
          environmentId: ENVIRONMENT_ID,
          publicKeyThumbprint: input.publicKeyThumbprint,
          descriptor: descriptor(ENVIRONMENT_ID, input.id),
          relayLinkState: state === "active" ? "linked" : "revoked",
          managedEndpointAvailable: state === "active",
          lastSeenAt: null,
          serviceRoleIds: [],
          teamIds: [],
          state,
          registeredByMembershipId: null,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        });
      };

      const companyTwo = await insertCompany(COMPANY_TWO_ID, "Second Company", "active");
      await insertRegistration({
        companyId: companyTwo,
        id: "0198f900-0000-7000-8000-000000000303",
        publicKeyThumbprint: THUMBPRINT,
      });
      const companyThree = await insertCompany(
        COMPANY_THREE_ID,
        "Deleting Company",
        "deletionScheduled",
      );
      await insertRegistration({
        companyId: companyThree,
        id: "0198f900-0000-7000-8000-000000000304",
        publicKeyThumbprint: THUMBPRINT,
      });
      const wrongKeyCompany = await insertCompany(
        "0198f900-0000-7000-8000-000000000004",
        "Wrong Key Company",
        "active",
      );
      await insertRegistration({
        companyId: wrongKeyCompany,
        id: "0198f900-0000-7000-8000-000000000305",
        publicKeyThumbprint: "somebody-elses-thumbprint",
      });
      const revokedCompany = await insertCompany(
        "0198f900-0000-7000-8000-000000000005",
        "Revoked Company",
        "active",
      );
      await insertRegistration({
        companyId: revokedCompany,
        id: "0198f900-0000-7000-8000-000000000306",
        publicKeyThumbprint: THUMBPRINT,
        state: "revoked",
      });
    });

    await expect(
      asEnvironment(t).query(api.environments.listRegisteredCompanies, {}),
    ).resolves.toEqual([COMPANY_ID, COMPANY_TWO_ID]);
  });

  it("refuses company-registration discovery to humans and unauthenticated callers", async () => {
    const t = harness();
    await seedRegistration(t);

    await expect(
      asUser(t, "reader").query(api.environments.listRegisteredCompanies, {}),
    ).rejects.toThrow("Only an environment can discover its company registrations");
    await expect(t.query(api.environments.listRegisteredCompanies, {})).rejects.toThrow(
      "authenticated identity",
    );
  });

  it("refuses discovery rather than silently truncating an oversized environment registry", async () => {
    const t = harness();
    const seeded = await seedRegistration(t);
    await t.run(async (ctx) => {
      for (let index = 1; index <= 2_000; index += 1) {
        await ctx.db.insert("environmentRegistrations", {
          id: `0198f901-0000-7000-8000-${String(index).padStart(12, "0")}`,
          companyId: seeded.companyDocId,
          environmentId: ENVIRONMENT_ID,
          publicKeyThumbprint: THUMBPRINT,
          descriptor: descriptor(ENVIRONMENT_ID, `Registry machine ${index}`),
          relayLinkState: "linked",
          managedEndpointAvailable: true,
          lastSeenAt: null,
          serviceRoleIds: [],
          teamIds: [],
          state: "active",
          registeredByMembershipId: null,
          createdAt: seeded.now,
          updatedAt: seeded.now,
        });
      }
    });

    await expect(
      asEnvironment(t).query(api.environments.listRegisteredCompanies, {}),
    ).rejects.toThrow("more than 2000 company registrations");
  });

  it("delivers environment bindings through the environments.read feed gate", async () => {
    const t = harness();
    const seeded = await seedRegistration(t);
    await t.run(async (ctx: MutationCtx) => {
      const projectDocId = await ctx.db.insert("cloudProjects", {
        id: PROJECT_ID,
        companyId: seeded.companyDocId,
        name: "Registry project",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        archivedAt: null,
        createdAt: seeded.now,
        updatedAt: seeded.now,
        deletedAt: null,
      });
      const bindingDocId = await ctx.db.insert("environmentBindings", {
        id: BINDING_ID,
        companyId: seeded.companyDocId,
        cloudProjectId: projectDocId,
        environmentId: ENVIRONMENT_ID,
        localProjectId: "local-project",
        localWorkspaceRoot: "/workspace/project",
        status: "active",
        lastSeenAt: seeded.now,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      const binding = await ctx.db.get(bindingDocId);
      if (binding === null) throw new Error("seed the binding first");
      await appendCompanyChanges(ctx, {
        companyId: seeded.companyDocId,
        actor: { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID },
        changes: [
          {
            entityKind: "environmentBinding",
            entityId: binding.id,
            changeKind: "upsert",
            versionDocId: bindingDocId,
            payload: await encodeEnvironmentBinding(ctx, binding),
          },
        ],
      });
    });

    const visible = await asUser(t, "reader").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 0,
    });
    expect(visible).toMatchObject({
      _tag: "Changes",
      cursor: 1,
      changes: [
        {
          entityKind: "environmentBinding",
          entityId: BINDING_ID,
          payload: { cloudProjectId: PROJECT_ID, localWorkspaceRoot: "/workspace/project" },
        },
      ],
    });
    await expect(
      asUser(t, "blind").query(api.sync.listChanges, { companyId: COMPANY_ID, cursor: 0 }),
    ).resolves.toMatchObject({ _tag: "Changes", changes: [], cursor: 1 });
  });

  it("lets a manager create the company binding with a minted registration id", async () => {
    const t = harness();
    await seed(t);
    await asUser(t, "manager").mutation(api.environments.register, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMBPRINT,
      descriptor: descriptor(),
      relayLinkState: "linked",
      managedEndpointAvailable: true,
    });

    const rows = await feedRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await expect(
      asEnvironment(t).query(api.sync.latestVersion, { companyId: COMPANY_ID }),
    ).resolves.toMatchObject({ version: 1, authorizationEpoch: 2 });
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      expect(company).toMatchObject({ updatedAt: 1_700_000_000_000, syncVersion: 1 });
    });
  });

  it("keeps environment registration available to a personal workspace", async () => {
    const t = harness();
    await seed(t, "personal");

    await asUser(t, "manager").mutation(api.environments.register, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMBPRINT,
      descriptor: descriptor(),
      relayLinkState: "linked",
      managedEndpointAvailable: true,
    });

    await expect(
      asUser(t, "manager").query(api.environments.list, { companyId: COMPANY_ID }),
    ).resolves.toMatchObject([
      {
        environmentId: ENVIRONMENT_ID,
        descriptor: { label: "Registry machine" },
      },
    ]);
  });

  it("does not append a change for last-seen-only heartbeats but does for descriptor updates", async () => {
    const t = harness();
    await seedRegistration(t);
    await publish(t);
    expect(await feedRows(t)).toHaveLength(1);

    await asEnvironment(t).mutation(api.environments.heartbeat, {
      companyId: COMPANY_ID,
      relayLinkState: "linked",
      managedEndpointAvailable: true,
    });
    expect(await feedRows(t)).toHaveLength(1);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      if (company === null) throw new Error("seed the company first");
      const registration = await ctx.db
        .query("environmentRegistrations")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", company._id).eq("environmentId", ENVIRONMENT_ID),
        )
        .unique();
      expect(registration).toMatchObject({ lastSeenAt: expect.any(Number), version: 1 });
    });

    await publish(t, "Registry machine renamed");
    const rows = await feedRows(t);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      entityKind: "environmentRegistration",
      changeKind: "upsert",
      payload: { descriptor: { label: "Registry machine renamed" } },
    });
  });

  it("delivers a delete-shaped change when a manager deactivates a registration", async () => {
    const t = harness();
    await seedRegistration(t);
    await publish(t);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      const integrationId = await ctx.db.insert("slackIntegrations", {
        id: "0198f900-0000-7000-8000-000000000801",
        companyId: company!._id,
        workspaceId: "T-REVOKE",
        workspaceName: "Revocation test",
        workspaceDomain: null,
        botUserId: null,
        botId: null,
        state: "active",
        credentialPresent: true,
        preferredEnvironmentId: ENVIRONMENT_ID,
        backupEnvironmentIds: [],
        configurationRevision: 1,
        lastPollAt: null,
        currentError: null,
        blockedReason: null,
        healthHistory: [],
        watchCount: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      });
      await ctx.db.insert("slackCoordinatorLeases", {
        companyId: company!._id,
        integrationId,
        holderEnvironmentId: ENVIRONMENT_ID,
        generation: 4,
        expiresAt: 1_900_000_000_000,
        preferredHealthyHeartbeats: 2,
        updatedAt: 1_700_000_000_000,
      });
    });
    await asUser(t, "manager").mutation(api.environments.deactivate, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
    });

    const page = await asUser(t, "reader").query(api.sync.listChanges, {
      companyId: COMPANY_ID,
      cursor: 1,
    });
    expect(page).toMatchObject({ _tag: "Changes", cursor: 2 });
    if (page._tag !== "Changes") return;
    expect(page.changes).toEqual([
      {
        version: 2,
        entityKind: "environmentRegistration",
        entityId: REGISTRATION_ID,
        changeKind: "tombstone",
        payload: null,
      },
    ]);
    await expect(
      asUser(t, "reader").query(api.environments.get, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
      }),
    ).resolves.toBeNull();
    await t.run(async (ctx) => {
      const lease = await ctx.db.query("slackCoordinatorLeases").first();
      expect(lease).toMatchObject({
        holderEnvironmentId: null,
        generation: 5,
        expiresAt: null,
      });
    });
  });

  it("bootstraps active registrations before environment bindings and skips revoked registrations", async () => {
    const t = harness();
    const seeded = await seedRegistration(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("environmentRegistrations", {
        id: REVOKED_REGISTRATION_ID,
        companyId: seeded.companyDocId,
        environmentId: ENVIRONMENT_TWO,
        publicKeyThumbprint: "thumbprint-two",
        descriptor: descriptor(ENVIRONMENT_TWO, "Revoked machine"),
        relayLinkState: "revoked",
        managedEndpointAvailable: false,
        lastSeenAt: null,
        serviceRoleIds: [],
        teamIds: [],
        state: "revoked",
        registeredByMembershipId: null,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      const projectDocId = await ctx.db.insert("cloudProjects", {
        id: PROJECT_ID,
        companyId: seeded.companyDocId,
        name: "Registry project",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        archivedAt: null,
        createdAt: seeded.now,
        updatedAt: seeded.now,
        deletedAt: null,
      });
      await ctx.db.insert("environmentBindings", {
        id: BINDING_ID,
        companyId: seeded.companyDocId,
        cloudProjectId: projectDocId,
        environmentId: ENVIRONMENT_ID,
        localProjectId: "local-project",
        localWorkspaceRoot: "/workspace/project",
        status: "active",
        lastSeenAt: seeded.now,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
    });

    const entities: { entityKind: string; entityId: string; payload: unknown }[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
      const page: BootstrapPage = await asUser(t, "reader").query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor,
        pageSize: 2,
      });
      entities.push(...page.entities);
      cursor = page.cursor;
      if (page.isDone) break;
    }
    const registry = entities.filter((entity) => entity.entityKind.startsWith("environment"));
    expect(registry.map((entity) => [entity.entityKind, entity.entityId])).toEqual([
      ["environmentRegistration", REGISTRATION_ID],
      ["environmentBinding", BINDING_ID],
    ]);
    expect(registry[1]?.payload).toMatchObject({ cloudProjectId: PROJECT_ID });
  });

  it("refuses registration publishing when the relay token proof key does not match", async () => {
    const t = harness();
    await seedRegistration(t);
    await expect(
      asEnvironment(t, "somebody-elses-thumbprint").mutation(api.environments.register, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        descriptor: descriptor(),
        relayLinkState: "linked",
        managedEndpointAvailable: true,
      }),
    ).rejects.toThrow("not bound to the key");
    expect(await feedRows(t)).toHaveLength(0);
  });

  it("publishes redacted Agent Thread metadata once for an active project binding", async () => {
    const t = harness();
    await seedRegistration(t);
    await t.run(async (ctx) => {
      const registration = await ctx.db.query("environmentRegistrations").unique();
      if (registration === null) throw new Error("missing environment fixture");
      await ctx.db.patch(registration._id, { serviceRoleIds: [MANAGER_ROLE_ID] });
    });
    await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: "/workspace/pathway",
      name: "Pathway",
    });
    const shell = {
      id: "thread-one",
      projectId: PROJECT_ID,
      title: "Cloud-visible thread",
      latestVisibleMessage: {
        id: "message-one",
        role: "assistant",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    };

    await asEnvironment(t).mutation(api.agentThreads.upsert, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-one",
      localProjectId: PROJECT_ID,
      shell,
    });
    const feedCount = (await feedRows(t)).length;
    await asEnvironment(t).mutation(api.agentThreads.upsert, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-one",
      localProjectId: PROJECT_ID,
      shell,
    });

    expect(await feedRows(t)).toHaveLength(feedCount);
    const thread = await t.run(async (ctx) => await ctx.db.query("agentThreads").unique());
    expect(thread).toMatchObject({
      id: `${ENVIRONMENT_ID}:thread-one`,
      environmentId: ENVIRONMENT_ID,
      cloudProjectId: expect.anything(),
      localProjectId: PROJECT_ID,
      threadId: "thread-one",
      shell,
    });
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "agentThread",
      entityId: `${ENVIRONMENT_ID}:thread-one`,
      changeKind: "upsert",
      payload: { shell },
    });

    await expect(
      asEnvironment(t).mutation(api.agentThreads.upsert, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        threadId: "thread-one",
        localProjectId: PROJECT_ID,
        shell: {
          ...shell,
          latestVisibleMessage: { ...shell.latestVisibleMessage, text: "secret transcript" },
        },
      }),
    ).rejects.toThrow("may not contain message text");
  });

  it("publishes parsed captured mail with source provenance and reconciles retention", async () => {
    const t = harness();
    await seedRegistration(t);
    await t.run(async (ctx) => {
      const registration = await ctx.db.query("environmentRegistrations").unique();
      if (registration === null) throw new Error("missing environment fixture");
      await ctx.db.patch(registration._id, { serviceRoleIds: [MANAGER_ROLE_ID] });
    });
    await asUser(t, "manager").mutation(api.cloudProjects.ensureEnvironmentProject, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: "/workspace/pathway",
      name: "Pathway",
    });
    const message = {
      id: "email-one",
      attribution: {
        projectId: PROJECT_ID,
        mailSlug: "pathway",
        matchedBy: "auth-username",
        matchedValue: "pathway",
      },
      envelope: {
        mailFrom: "sender@example.test",
        rcptTo: ["pathway@example.test"],
        authUsername: "pathway",
        helo: "localhost",
        remoteAddress: "127.0.0.1",
      },
      parsedHeaders: {
        subject: "Build finished",
        messageId: "<email-one@example.test>",
        date: "2026-08-17T00:00:00.000Z",
        from: [{ address: "sender@example.test", name: "Sender" }],
        to: [{ address: "pathway@example.test", name: null }],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: [{ name: "Subject", value: "Build finished" }],
      },
      textBody: "The build finished.",
      htmlBody: "<p>The build finished.</p>",
      attachments: [],
      smtpTransactionLog: [],
      timings: {
        connectedAt: "2026-08-17T00:00:00.000Z",
        messageReceivedAt: "2026-08-17T00:00:00.100Z",
        parsedAt: "2026-08-17T00:00:00.200Z",
        storedAt: "2026-08-17T00:00:00.300Z",
        parseDurationMs: 100,
        totalDurationMs: 300,
      },
      sizeBytes: 128,
      isRead: false,
      detectedCode: null,
      deliverability: {
        version: 1,
        checks: [],
        metrics: {
          subjectLength: 14,
          imageCount: 0,
          visibleTextCharacters: 19,
          imageToTextRatio: 0,
          trackingPixelCount: 0,
        },
        htmlCompatibilityWarnings: [],
      },
    };

    await asEnvironment(t).mutation(api.capturedEmails.upsert, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      messageId: message.id,
      localProjectId: PROJECT_ID,
      message,
    });

    expect(await t.run(async (ctx) => await ctx.db.query("capturedEmails").unique())).toMatchObject(
      {
        id: `${ENVIRONMENT_ID}:${message.id}`,
        environmentId: ENVIRONMENT_ID,
        localProjectId: PROJECT_ID,
        messageId: message.id,
        message,
      },
    );
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "capturedEmail",
      entityId: `${ENVIRONMENT_ID}:${message.id}`,
      changeKind: "upsert",
      payload: { environmentId: ENVIRONMENT_ID, message },
    });

    const tagId = "0198f900-0000-7000-8000-000000000601";
    await asUser(t, "manager").mutation(api.emailTags.create, {
      companyId: COMPANY_ID,
      id: tagId,
      name: "Authentication",
      color: "#3b82f6",
    });
    await asUser(t, "manager").mutation(api.capturedEmails.setTag, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      messageId: message.id,
      tagId,
      present: true,
    });
    expect(await t.run(async (ctx) => await ctx.db.query("capturedEmails").unique())).toMatchObject(
      {
        tagIds: [tagId],
      },
    );
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "capturedEmail",
      payload: { tagIds: [tagId] },
    });

    await asUser(t, "manager").mutation(api.capturedEmails.remove, {
      companyId: COMPANY_ID,
      messages: [{ environmentId: ENVIRONMENT_ID, messageId: message.id }],
    });
    expect(await t.run(async (ctx) => await ctx.db.query("capturedEmails").unique())).toBeNull();
    expect(
      await t.run(async (ctx) => await ctx.db.query("capturedEmailDeletions").unique()),
    ).toMatchObject({ id: `${ENVIRONMENT_ID}:${message.id}` });
    expect(
      await asEnvironment(t).mutation(api.capturedEmails.upsert, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        messageId: message.id,
        localProjectId: PROJECT_ID,
        message,
      }),
    ).toBe(false);

    await asEnvironment(t).mutation(api.capturedEmails.reconcile, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      currentMessageIds: [],
    });
    expect(await t.run(async (ctx) => await ctx.db.query("capturedEmails").unique())).toBeNull();
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "capturedEmail",
      entityId: `${ENVIRONMENT_ID}:${message.id}`,
      changeKind: "tombstone",
      payload: null,
    });
  });

  it("replicates exact trusted email senders and removes them everywhere", async () => {
    const t = harness();
    await seed(t);

    await asUser(t, "manager").mutation(api.trustedEmailSenders.trust, {
      companyId: COMPANY_ID,
      id: TRUSTED_SENDER_ID,
      address: "  Alerts@Example.TEST ",
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("trustedEmailSenders").unique()),
    ).toMatchObject({ id: TRUSTED_SENDER_ID, address: "alerts@example.test" });
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "trustedEmailSender",
      entityId: TRUSTED_SENDER_ID,
      changeKind: "upsert",
      payload: { id: TRUSTED_SENDER_ID, address: "alerts@example.test" },
    });

    // Trusting the same normalized address from another environment is idempotent.
    await asUser(t, "manager").mutation(api.trustedEmailSenders.trust, {
      companyId: COMPANY_ID,
      id: "0198f900-0000-7000-8000-000000000702",
      address: "alerts@example.test",
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("trustedEmailSenders").collect()),
    ).toHaveLength(1);

    await asUser(t, "manager").mutation(api.trustedEmailSenders.remove, {
      companyId: COMPANY_ID,
      trustedSenderId: TRUSTED_SENDER_ID,
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("trustedEmailSenders").unique()),
    ).toBeNull();
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "trustedEmailSender",
      entityId: TRUSTED_SENDER_ID,
      changeKind: "tombstone",
      payload: null,
    });
  });
});
