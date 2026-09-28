// @effect-diagnostics globalDate:off -- Lease tests use a controlled transaction clock.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";
import { appleTestCredential } from "./fixtures/appleTestKey.ts";
const RELAY = "https://relay.apple.test";
const COMPANY = "01990000-0000-7000-8000-000000000011";
const PROJECT = "01990000-0000-7000-8000-000000000012";
const TEAM = "APPLETEAM1";
const NOW = 1_800_000_000_000;
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/appleSessions.ts": () => import("../convex/appleSessions.ts"),
  "../convex/appleIntegrations.ts": () => import("../convex/appleIntegrations.ts"),
};
const apps = {
  data: [
    {
      id: "app-1",
      attributes: { name: "Test App", bundleId: "com.example.app", privateKey: "SHOULD_NOT_LEAK" },
    },
  ],
};
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;
function human(t: Harness, subject = "owner") {
  return t.withIdentity({
    issuer: "https://clerk.apple.test",
    subject,
    tokenIdentifier: `clerk|${subject}`,
  });
}
function environment(t: Harness, subject: string) {
  return t.withIdentity({
    issuer: RELAY,
    subject,
    tokenIdentifier: `${RELAY}|${subject}`,
    cnf: { jkt: `${subject}-proof` },
  });
}
async function seed(t: Harness) {
  await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY,
      name: "Apple tests",
      issueKeyPrefix: "APL",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const subject of ["owner", "teammate", "outsider"]) {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      if (subject === "outsider") continue;
      const membershipId = await ctx.db.insert("memberships", {
        id:
          subject === "owner"
            ? "01990000-0000-7000-8000-000000000013"
            : "01990000-0000-7000-8000-000000000014",
        companyId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
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
    }
    for (const environmentId of ["env-a", "env-b", "not-owners-env"]) {
      await ctx.db.insert("environmentRegistrations", {
        id: `reg-${environmentId}`,
        companyId,
        environmentId,
        publicKeyThumbprint: `${environmentId}-proof`,
        descriptor: { environmentId, label: environmentId },
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: NOW,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      if (environmentId === "not-owners-env") continue;
      await ctx.db.insert("relayEnvironmentLinks", {
        userId: "owner",
        environmentId,
        environmentLabel: environmentId,
        environmentPublicKey: "test",
        endpointHttpBaseUrl: "https://env.test",
        endpointWsBaseUrl: "wss://env.test",
        endpointProviderKind: "managed",
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: false,
        createdByDeviceId: null,
        revokedAt: null,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      });
    }
    await ctx.db.insert("cloudProjects", {
      id: PROJECT,
      companyId,
      name: "App project",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    });
  });
}
async function setup(company = false) {
  const t = harness();
  await seed(t);
  const owner = human(t);
  const account = await owner.mutation(api.appleIntegrations.createAccount, {
    email: "first@apple.test",
    displayName: "First",
    ...(company ? { scope: { kind: "company" as const, companyId: COMPANY } } : {}),
  });
  const target = { accountId: account.id, teamId: TEAM };
  await owner.mutation(api.appleIntegrations.upsertTeam, {
    ...target,
    name: "Team one",
    type: "organization",
  });
  const connected = await owner.action(api.appleIntegrations.connect, {
    ...target,
    ...appleTestCredential,
    expectedRevision: 0,
  });
  return { t, owner, account, target, connected, runtimeTarget: { ...target, companyId: COMPANY } };
}
async function appleRecords(t: Harness) {
  return await t.run(async (ctx) => ({
    accounts: await ctx.db.query("appleAccounts").collect(),
    teams: await ctx.db.query("appleTeams").collect(),
    credentials: await ctx.db.query("appleIntegrationCredentials").collect(),
    leases: await ctx.db.query("appleEnvironmentLeases").collect(),
    sessions: await ctx.db.query("appleAccountSessions").collect(),
    links: await ctx.db.query("appleProjectLinks").collect(),
  }));
}

describe("Apple account cloud custody", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("PATHWAY_RELAY_JWT_ISSUER", RELAY);
    vi.stubEnv("PATHWAY_RELAY_JWKS_URL", `${RELAY}/.well-known/jwks.json`);
    vi.stubEnv("PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID", "test-seal");
    vi.stubEnv(
      "PATHWAY_INTEGRATION_CREDENTIAL_KEYS",
      JSON.stringify({ "test-seal": btoa("a".repeat(32)) }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(apps), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("supports multiple personal Apple IDs and several teams with independent keys", async () => {
    const { t, owner, target } = await setup();
    await owner.mutation(api.appleIntegrations.createAccount, {
      email: "second@apple.test",
      displayName: "Second",
    });
    await owner.mutation(api.appleIntegrations.upsertTeam, {
      accountId: target.accountId,
      teamId: "APPLETEAM2",
      name: "Team two",
      type: "individual",
    });
    const accounts = await owner.query(api.appleIntegrations.listAccounts, {});
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ scope: { kind: "user" }, verifiedAt: null });
    expect(
      await owner.query(api.appleIntegrations.listTeams, { accountId: target.accountId }),
    ).toHaveLength(2);
    expect(
      (
        await owner.query(api.appleIntegrations.status, {
          accountId: target.accountId,
          teamId: "APPLETEAM2",
        })
      ).integration.connected,
    ).toBe(false);
    expect(
      await human(t, "teammate").query(api.appleIntegrations.listAccounts, { companyId: COMPANY }),
    ).toEqual([]);
    await expect(human(t, "teammate").query(api.appleIntegrations.status, target)).rejects.toThrow(
      "private to its owner",
    );
    await expect(
      environment(t, "not-owners-env").mutation(api.appleIntegrations.heartbeat, {
        ...target,
        companyId: COMPANY,
      }),
    ).rejects.toThrow("not linked");
  });
  it("seals keys, issues simultaneous leases, and fences both environments on rotation and revoke", async () => {
    const { t, owner, account, target, runtimeTarget, connected } = await setup();
    const a = environment(t, "env-a"),
      b = environment(t, "env-b");
    await Promise.all([
      a.mutation(api.appleIntegrations.heartbeat, runtimeTarget),
      b.mutation(api.appleIntegrations.heartbeat, runtimeTarget),
    ]);
    const lease = {
      ...runtimeTarget,
      revision: connected.revision,
      accountRevision: account.revision,
    };
    expect(await a.action(api.appleIntegrations.runtimeCredential, lease)).toEqual(
      appleTestCredential,
    );
    expect(await b.action(api.appleIntegrations.runtimeCredential, lease)).toEqual(
      appleTestCredential,
    );
    const stored = await t.run((ctx) => ctx.db.query("appleIntegrationCredentials").collect());
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");
    expect(stored[0]?.keyId).toBe("test-seal");
    const replacement = { ...appleTestCredential, keyId: "TESTKEY002" };
    await owner.action(api.appleIntegrations.connect, {
      ...target,
      ...replacement,
      expectedRevision: 1,
    });
    for (const env of [a, b]) {
      await expect(env.action(api.appleIntegrations.runtimeCredential, lease)).rejects.toThrow(
        "no longer current",
      );
      await env.mutation(api.appleIntegrations.heartbeat, runtimeTarget);
      expect(
        await env.action(api.appleIntegrations.runtimeCredential, { ...lease, revision: 2 }),
      ).toEqual(replacement);
    }
    await owner.mutation(api.appleIntegrations.revoke, { ...target, expectedRevision: 2 });
    for (const env of [a, b])
      await expect(
        env.action(api.appleIntegrations.runtimeCredential, { ...lease, revision: 2 }),
      ).rejects.toThrow("no longer current");
    expect(await t.run((ctx) => ctx.db.query("appleIntegrationCredentials").collect())).toEqual([]);
    const publicData = [
      await owner.query(api.appleIntegrations.status, target),
      await owner.query(api.appleIntegrations.listTeams, { accountId: target.accountId }),
    ];
    for (const secret of [
      "PRIVATE KEY",
      "TESTKEY001",
      "TESTKEY002",
      "ciphertext",
      "authenticationTag",
    ])
      expect(JSON.stringify(publicData)).not.toContain(secret);
  });
  it("denies clients the credential endpoint and checks environment proof, expiry and owner unlink", async () => {
    const { t, owner, account, runtimeTarget } = await setup();
    const env = environment(t, "env-a");
    const lease = { ...runtimeTarget, revision: 1, accountRevision: account.revision };
    await expect(owner.action(api.appleIntegrations.runtimeCredential, lease)).rejects.toThrow(
      "Only environments",
    );
    await expect(
      t
        .withIdentity({ issuer: RELAY, subject: "env-a", cnf: { jkt: "wrong" } })
        .mutation(api.appleIntegrations.heartbeat, runtimeTarget),
    ).rejects.toThrow();
    await env.mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    vi.setSystemTime(NOW + 30_001);
    await expect(env.action(api.appleIntegrations.runtimeCredential, lease)).rejects.toThrow(
      "no longer current",
    );
    await env.mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user_and_environment", (q) =>
          q.eq("userId", "owner").eq("environmentId", "env-a"),
        )
        .unique();
      await ctx.db.patch(link!._id, { revokedAt: new Date().toISOString() });
    });
    await expect(env.action(api.appleIntegrations.runtimeCredential, lease)).rejects.toThrow(
      "not linked",
    );
  });
  it("authorizes the RPC caller separately from the host for personal accounts", async () => {
    const { t, owner, account, runtimeTarget } = await setup();
    const env = environment(t, "env-a");
    // A readable project link exposes these IDs without granting access to the private account.
    await owner.action(api.appleIntegrations.linkProject, {
      ...runtimeTarget,
      projectId: PROJECT,
      appId: "app-1",
    });
    const link = await human(t, "teammate").query(api.appleIntegrations.projectLink, {
      companyId: COMPANY,
      projectId: PROJECT,
    });
    expect(link?.accountId).toBe(account.id);
    const input = { companyId: COMPANY, accountId: link!.accountId, manage: false };
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, {
        ...input,
        caller: { clerkSubject: "teammate" },
      }),
    ).rejects.toThrow("private to its owner");
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, {
        ...input,
        caller: { clerkSubject: "owner" },
      }),
    ).resolves.toBeNull();
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    for (const user of users.filter((u) => u.clerkSubject !== "outsider")) {
      const result = env.query(api.appleIntegrations.authorizeRuntimeCaller, {
        ...input,
        caller: { userId: user._id },
      });
      if (user.clerkSubject === "owner") await expect(result).resolves.toBeNull();
      else await expect(result).rejects.toThrow("private to its owner");
    }
    for (const caller of [{ clerkSubject: "missing" }, { userId: "invalid-id" }])
      await expect(
        env.query(api.appleIntegrations.authorizeRuntimeCaller, { ...input, caller }),
      ).rejects.toThrow("caller is unknown");
    await expect(
      owner.query(api.appleIntegrations.authorizeRuntimeCaller, {
        ...input,
        caller: { clerkSubject: "owner" },
      }),
    ).rejects.toThrow("environment identity");
  });
  it("denies another company registered on the same host", async () => {
    const { t, runtimeTarget } = await setup(true);
    const otherCompany = "01990000-0000-7000-8000-000000000099";
    await t.run(async (ctx) => {
      const original = (await ctx.db.query("companies").collect())[0]!;
      const { _id: _companyId, _creationTime: _companyCreated, ...companyFields } = original;
      const companyId = await ctx.db.insert("companies", { ...companyFields, id: otherCompany });
      const registration = (await ctx.db.query("environmentRegistrations").collect()).find(
        (r) => r.environmentId === "env-a",
      )!;
      const { _id: _regId, _creationTime: _regCreated, ...registrationFields } = registration;
      await ctx.db.insert("environmentRegistrations", {
        ...registrationFields,
        id: "other-registration",
        companyId,
      });
      const outsider = (await ctx.db.query("users").collect()).find(
        (u) => u.clerkSubject === "outsider",
      )!;
      const membership = (await ctx.db.query("memberships").collect())[0]!;
      const { _id: _memberId, _creationTime: _memberCreated, ...membershipFields } = membership;
      const membershipId = await ctx.db.insert("memberships", {
        ...membershipFields,
        id: "other-member",
        companyId,
        userId: outsider._id,
      });
      await ctx.db.insert("companyOwners", {
        companyId,
        membershipId,
        grantedByMembershipId: null,
        createdAt: NOW,
      });
    });
    const otherAccount = await human(t, "outsider").mutation(api.appleIntegrations.createAccount, {
      email: "other@apple.test",
      displayName: "Other",
      scope: { kind: "company", companyId: otherCompany },
    });
    const env = environment(t, "env-a");
    // Both host registrations are valid, but the caller belongs only to the first company.
    await expect(
      env.query(api.appleIntegrations.accountStatus, {
        accountId: otherAccount.id,
        companyId: otherCompany,
      }),
    ).resolves.toMatchObject({ id: otherAccount.id });
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, {
        accountId: otherAccount.id,
        companyId: otherCompany,
        caller: { clerkSubject: "owner" },
        manage: false,
      }),
    ).rejects.toThrow("not an active member");
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, {
        accountId: runtimeTarget.accountId,
        companyId: otherCompany,
        caller: { clerkSubject: "owner" },
        manage: false,
      }),
    ).rejects.toThrow("another company");
  });
  it("lists personal accounts when the selected company does not grant integrations.read", async () => {
    const { t, owner, account } = await setup();
    const companyAccount = await owner.mutation(api.appleIntegrations.createAccount, {
      email: "shared@apple.test",
      displayName: "Company",
      scope: { kind: "company", companyId: COMPANY },
    });
    expect(await owner.query(api.appleIntegrations.listAccounts, { companyId: COMPANY })).toEqual([
      account,
      companyAccount,
    ]);
    await t.run(async (ctx) => {
      const member = (await ctx.db.query("memberships").collect()).find(
        (m) => m.displayNameSnapshot === "owner",
      )!;
      const ownership = await ctx.db
        .query("companyOwners")
        .withIndex("by_company_and_membership", (q) =>
          q.eq("companyId", member.companyId).eq("membershipId", member._id),
        )
        .unique();
      await ctx.db.delete(ownership!._id);
    });
    expect(await owner.query(api.appleIntegrations.listAccounts, { companyId: COMPANY })).toEqual([
      account,
    ]);
    expect(await owner.query(api.appleIntegrations.listAccounts, {})).toEqual([account]);
  });
  it("requires the caller's current company integration permission for reads and writes", async () => {
    const { t, runtimeTarget } = await setup(true);
    const role = await t.run(async (ctx) => {
      const member = (await ctx.db.query("memberships").collect()).find(
        (m) => m.displayNameSnapshot === "teammate",
      )!;
      const owner = await ctx.db
        .query("companyOwners")
        .withIndex("by_company_and_membership", (q) =>
          q.eq("companyId", member.companyId).eq("membershipId", member._id),
        )
        .unique();
      await ctx.db.delete(owner!._id);
      const roleId = await ctx.db.insert("roles", {
        id: "integration-reader",
        companyId: member.companyId,
        name: "Reader",
        description: "",
        permissions: ["integrations.read"],
        seeded: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("roleAssignments", {
        id: "integration-reader-assignment",
        companyId: member.companyId,
        membershipId: member._id,
        roleId,
        scope: "company",
        teamId: null,
        createdAt: NOW,
      });
      return roleId;
    });
    const env = environment(t, "env-a");
    const input = {
      accountId: runtimeTarget.accountId,
      companyId: COMPANY,
      caller: { clerkSubject: "teammate" },
    };
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, { ...input, manage: false }),
    ).resolves.toBeNull();
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, { ...input, manage: true }),
    ).rejects.toThrow("integrations.manage");
    await t.run((ctx) =>
      ctx.db.patch(role, { permissions: ["integrations.read", "integrations.manage"] }),
    );
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, { ...input, manage: true }),
    ).resolves.toBeNull();
    await t.run((ctx) => ctx.db.patch(role, { permissions: [] }));
    await expect(
      env.query(api.appleIntegrations.authorizeRuntimeCaller, { ...input, manage: false }),
    ).rejects.toThrow("integrations.read");
  });
  it("disconnects personal environment health immediately when the owner unlinks", async () => {
    const { t, owner, target, runtimeTarget } = await setup();
    await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    expect(
      (await owner.query(api.appleIntegrations.status, target)).environments[0]?.connected,
    ).toBe(true);
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user_and_environment", (q) =>
          q.eq("userId", "owner").eq("environmentId", "env-a"),
        )
        .unique();
      await ctx.db.patch(link!._id, { revokedAt: new Date(NOW).toISOString() });
    });
    const status = await owner.query(api.appleIntegrations.status, target);
    expect(status.integration.connected).toBe(true);
    expect(status.environments[0]).toMatchObject({ connected: false });
  });
  it.each(["tether", "untether"] as const)(
    "rejects duplicate accounts when changing scope to %s",
    async (direction) => {
      const { owner, account } = await setup();
      const companyAccount = await owner.mutation(api.appleIntegrations.createAccount, {
        email: account.email,
        displayName: "Company copy",
        scope: { kind: "company", companyId: COMPANY },
      });
      const moving = direction === "tether" ? account : companyAccount;
      await expect(
        owner.mutation(api.appleIntegrations.updateAccount, {
          accountId: moving.id,
          displayName: "Changed",
          scope:
            direction === "tether" ? { kind: "company", companyId: COMPANY } : { kind: "user" },
          expectedRevision: moving.revision,
        }),
      ).rejects.toThrow("already exists in this scope");
      expect(
        await owner.query(api.appleIntegrations.accountStatus, { accountId: moving.id }),
      ).toEqual(moving);
      // Renaming in the current scope excludes the account itself.
      await expect(
        owner.mutation(api.appleIntegrations.updateAccount, {
          accountId: moving.id,
          displayName: "Renamed",
          scope: moving.scope,
          expectedRevision: moving.revision,
        }),
      ).resolves.toMatchObject({ displayName: "Renamed", revision: moving.revision + 1 });
    },
  );
  it("shares tethered accounts with company members and environments, but not outsiders", async () => {
    const { t, account, runtimeTarget } = await setup(true);
    expect(
      await human(t, "teammate").query(api.appleIntegrations.listAccounts, { companyId: COMPANY }),
    ).toHaveLength(1);
    await expect(
      environment(t, "not-owners-env").mutation(api.appleIntegrations.heartbeat, runtimeTarget),
    ).resolves.toMatchObject({ integration: { connected: true } });
    await expect(
      human(t, "outsider").query(api.appleIntegrations.accountStatus, { accountId: account.id }),
    ).rejects.toThrow("not an active member");
  });
  it("preserves the active key on failed validation and rejects stale replacement or revoke", async () => {
    const { t, owner, target } = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(appleTestCredential.privateKey, { status: 403 })),
    );
    await expect(
      owner.action(api.appleIntegrations.connect, {
        ...target,
        ...appleTestCredential,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("does not have access");
    expect((await owner.query(api.appleIntegrations.status, target)).integration.revision).toBe(1);
    await expect(
      owner.mutation(api.appleIntegrations.revoke, { ...target, expectedRevision: 0 }),
    ).rejects.toThrow("changed");
    await expect(
      owner.action(api.appleIntegrations.connect, {
        ...target,
        ...appleTestCredential,
        expectedRevision: 0,
      }),
    ).rejects.toThrow("changed");
    expect(
      await t.run((ctx) => ctx.db.query("appleIntegrationCredentials").collect()),
    ).toHaveLength(1);
  });
  it("validates project apps against the selected team and shares a secret-free link", async () => {
    const { t, owner, target, account } = await setup();
    const project = { companyId: COMPANY, projectId: PROJECT };
    await expect(
      owner.action(api.appleIntegrations.linkProject, {
        ...project,
        ...target,
        appId: "not-in-team",
      }),
    ).rejects.toThrow("not accessible");
    const result = await owner.action(api.appleIntegrations.linkProject, {
      ...project,
      ...target,
      appId: "app-1",
    });
    expect(result.app).toEqual({ id: "app-1", name: "Test App", bundleId: "com.example.app" });
    expect(await human(t, "teammate").query(api.appleIntegrations.projectLink, project)).toEqual(
      result,
    );
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
    await expect(
      owner.mutation(api.appleIntegrations.updateAccount, {
        accountId: account.id,
        displayName: "First",
        scope: { kind: "company", companyId: COMPANY },
        expectedRevision: account.revision,
      }),
    ).rejects.toMatchObject({
      data: {
        code: "apple-account-linked-projects",
        message: "Unlink projects before changing this Apple account's scope.",
      },
    });
    await human(t, "teammate").mutation(api.appleIntegrations.unlinkProject, project);
    expect(await owner.query(api.appleIntegrations.projectLink, project)).toBeNull();
    await owner.mutation(api.appleIntegrations.updateAccount, {
      accountId: account.id,
      displayName: "Shared",
      scope: { kind: "company", companyId: COMPANY },
      expectedRevision: account.revision,
    });
    expect(
      await human(t, "teammate").query(api.appleIntegrations.accountStatus, {
        accountId: account.id,
      }),
    ).toMatchObject({ scope: { kind: "company", companyId: COMPANY }, revision: 2 });
  });
  it.each(["connected", "revoked"] as const)(
    "team removal deletes the owner's %s team and its custody rows only",
    async (state) => {
      const { t, owner, account, target, runtimeTarget, connected } = await setup();
      for (const id of ["env-a", "env-b"])
        await environment(t, id).mutation(api.appleIntegrations.heartbeat, runtimeTarget);
      const sibling = { ...target, teamId: "APPLETEAM2" };
      await owner.mutation(api.appleIntegrations.upsertTeam, {
        ...sibling,
        name: "Team two",
        type: "organization",
      });
      await owner.action(api.appleIntegrations.connect, {
        ...sibling,
        ...appleTestCredential,
        expectedRevision: 0,
      });
      await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, {
        ...sibling,
        companyId: COMPANY,
      });
      await owner.action(api.appleIntegrations.linkProject, {
        ...sibling,
        companyId: COMPANY,
        projectId: PROJECT,
        appId: "app-1",
      });
      await t.run(async (ctx) => {
        const storedAccount = (await ctx.db.query("appleAccounts").collect())[0]!;
        await ctx.db.insert("appleAccountSessions", {
          accountId: storedAccount._id,
          accountRevision: storedAccount.revision,
          revision: 1,
          expiresAt: NOW + 30_000,
          keyId: "test-seal",
          iv: "session-iv",
          ciphertext: "sealed-session",
          authenticationTag: "session-tag",
        });
      });
      const expectedRevision =
        state === "revoked"
          ? (
              await owner.mutation(api.appleIntegrations.revoke, {
                ...target,
                expectedRevision: connected.revision,
              })
            ).revision
          : connected.revision;
      const before = await appleRecords(t);
      const team = before.teams.find((row) => row.teamId === target.teamId)!;
      expect(before.leases.filter((row) => row.teamId === team._id)).toHaveLength(2);
      await expect(
        owner.mutation(api.appleIntegrations.removeTeam, { ...target, expectedRevision }),
      ).resolves.toBeNull();
      expect(await appleRecords(t)).toEqual({
        ...before,
        teams: before.teams.filter((row) => row._id !== team._id),
        credentials: before.credentials.filter((row) => row.teamId !== team._id),
        leases: before.leases.filter((row) => row.teamId !== team._id),
      });
      await expect(
        environment(t, "env-a").action(api.appleIntegrations.runtimeCredential, {
          ...runtimeTarget,
          revision: connected.revision,
          accountRevision: account.revision,
        }),
      ).rejects.toThrow("team is unavailable");
    },
  );
  it("team removal refuses linked projects without changing any records", async () => {
    const { t, owner, target, runtimeTarget, connected } = await setup();
    await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    await owner.action(api.appleIntegrations.linkProject, {
      ...runtimeTarget,
      projectId: PROJECT,
      appId: "app-1",
    });
    const before = await appleRecords(t);
    await expect(
      owner.mutation(api.appleIntegrations.removeTeam, {
        ...target,
        expectedRevision: connected.revision,
      }),
    ).rejects.toMatchObject({ data: { code: "apple-account-linked-projects" } });
    expect(await appleRecords(t)).toEqual(before);
    await owner.mutation(api.appleIntegrations.unlinkProject, {
      companyId: COMPANY,
      projectId: PROJECT,
    });
    await expect(
      owner.mutation(api.appleIntegrations.removeTeam, {
        ...target,
        expectedRevision: connected.revision,
      }),
    ).resolves.toBeNull();
  });
  it("team removal rejects a stale revision without changing any records", async () => {
    const { t, owner, target, runtimeTarget, connected } = await setup();
    await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    const before = await appleRecords(t);
    await expect(
      owner.mutation(api.appleIntegrations.removeTeam, {
        ...target,
        expectedRevision: connected.revision - 1,
      }),
    ).rejects.toMatchObject({ data: { code: "entity-conflict" } });
    expect(await appleRecords(t)).toEqual(before);
  });
  it.each(["non-owner", "company outsider", "environment"] as const)(
    "team removal denies the %s without changing any records",
    async (caller) => {
      const { t, target, runtimeTarget, connected } = await setup(caller === "company outsider");
      await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, runtimeTarget);
      const actor =
        caller === "environment"
          ? environment(t, "env-a")
          : human(t, caller === "non-owner" ? "teammate" : "outsider");
      const before = await appleRecords(t);
      await expect(
        actor.mutation(api.appleIntegrations.removeTeam, {
          ...target,
          expectedRevision: connected.revision,
        }),
      ).rejects.toMatchObject({
        data: { code: caller === "company outsider" ? "not-a-member" : "permission-denied" },
      });
      expect(await appleRecords(t)).toEqual(before);
    },
  );
  it("account deletion removes team keys, leases, sessions and links", async () => {
    const { t, owner, target, account, runtimeTarget } = await setup();
    await environment(t, "env-a").mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    await owner.action(api.appleIntegrations.linkProject, {
      ...target,
      companyId: COMPANY,
      projectId: PROJECT,
      appId: "app-1",
    });
    await owner.mutation(api.appleIntegrations.removeAccount, {
      accountId: account.id,
      expectedRevision: 1,
    });
    const counts = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("appleAccounts").collect(),
        ctx.db.query("appleTeams").collect(),
        ctx.db.query("appleIntegrationCredentials").collect(),
        ctx.db.query("appleEnvironmentLeases").collect(),
        ctx.db.query("appleProjectLinks").collect(),
      ]),
    );
    expect(counts.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
  });
  it("sanitizes environment diagnostics and fences stale health writes", async () => {
    const { t, owner, target, runtimeTarget, account } = await setup();
    const env = environment(t, "env-a");
    await env.mutation(api.appleIntegrations.heartbeat, runtimeTarget);
    const lease = { ...runtimeTarget, revision: 1, accountRevision: account.revision };
    await env.mutation(api.appleIntegrations.updateHealth, {
      ...lease,
      lastVerifiedAt: null,
      error: {
        code: "unauthorized",
        message: appleTestCredential.privateKey,
        retryAfterSeconds: null,
      },
    });
    expect(JSON.stringify(await owner.query(api.appleIntegrations.status, target))).not.toContain(
      "PRIVATE KEY",
    );
    await owner.mutation(api.appleIntegrations.revoke, { ...target, expectedRevision: 1 });
    await expect(
      env.mutation(api.appleIntegrations.updateHealth, {
        ...lease,
        lastVerifiedAt: NOW,
        error: null,
      }),
    ).rejects.toThrow("no longer current");
    await expect(
      env.query(internal.appleIntegrations.runtimeCredentialRecord, lease),
    ).rejects.toThrow("no longer current");
  });
  it("seals Apple ID cookies, verifies the account, discovers teams and leases only to authorized environments", async () => {
    const { t, owner, account, runtimeTarget } = await setup();
    const env = environment(t, "env-a");
    const target = { accountId: account.id, companyId: COMPANY };
    const credential = {
      cookies: [
        {
          key: "myacinfo",
          value: "PRIVATE-SESSION-COOKIE",
          domain: ".apple.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: null,
        },
      ],
    };
    const current = await env.query(api.appleSessions.status, target);
    const saved = await env.action(api.appleSessions.save, {
      ...target,
      credential,
      accountRevision: current.accountRevision,
      revision: current.revision,
      expiresAt: NOW + 60_000,
      teams: [{ teamId: "DISCOVERED", name: "Discovered team", type: "organization" }],
    });
    expect(saved.revision).toBe(1);
    expect(
      (await owner.query(api.appleIntegrations.accountStatus, { accountId: account.id }))
        .verifiedAt,
    ).toBe(NOW);
    expect(
      await owner.query(api.appleIntegrations.listTeams, { accountId: account.id }),
    ).toContainEqual({
      accountId: account.id,
      teamId: "DISCOVERED",
      name: "Discovered team",
      type: "organization",
    });
    const stored = await t.run((ctx) => ctx.db.query("appleAccountSessions").collect());
    expect(JSON.stringify(stored)).not.toContain("PRIVATE-SESSION-COOKIE");
    const leased = await environment(t, "env-b").action(api.appleSessions.read, target);
    expect(leased.credential).toEqual(credential);
    expect(leased.leaseExpiresAt).toBe(NOW + 30_000);
    await expect(
      environment(t, "not-owners-env").action(api.appleSessions.read, target),
    ).rejects.toThrow();
    await expect(owner.action(api.appleSessions.read, target)).rejects.toThrow();
    await env.mutation(api.appleSessions.revoke, { ...target, revision: saved.revision });
    await expect(env.action(api.appleSessions.read, target)).rejects.toThrow();
    await expect(
      env.action(api.appleSessions.save, {
        ...target,
        credential,
        accountRevision: current.accountRevision,
        revision: current.revision,
        expiresAt: NOW + 60_000,
        teams: [],
      }),
    ).rejects.toThrow();
    expect(
      (await env.query(api.appleIntegrations.status, runtimeTarget)).integration.connected,
    ).toBe(true);
  });
  it("expires Apple sessions and fences them when account scope or registration changes", async () => {
    const { t, owner, account } = await setup();
    const env = environment(t, "env-a");
    const target = { accountId: account.id, companyId: COMPANY };
    const credential = {
      cookies: [
        {
          key: "myacinfo",
          value: "cookie",
          domain: ".apple.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: null,
        },
      ],
    };
    await env.action(api.appleSessions.save, {
      ...target,
      credential,
      accountRevision: account.revision,
      revision: 0,
      expiresAt: NOW + 1000,
      teams: [],
    });
    vi.setSystemTime(NOW + 1001);
    await expect(env.action(api.appleSessions.read, target)).rejects.toThrow();
    vi.setSystemTime(NOW);
    await owner.mutation(api.appleIntegrations.updateAccount, {
      accountId: account.id,
      expectedRevision: account.revision,
      displayName: "Shared",
      scope: { kind: "company", companyId: COMPANY },
    });
    await expect(env.action(api.appleSessions.read, target)).rejects.toThrow();
    const meta = await env.query(api.appleSessions.status, target);
    await env.action(api.appleSessions.save, {
      ...target,
      credential,
      accountRevision: meta.accountRevision,
      revision: meta.revision,
      expiresAt: NOW + 60_000,
      teams: [],
    });
    await t.run(async (ctx) => {
      const reg = await ctx.db
        .query("environmentRegistrations")
        .filter((q) => q.eq(q.field("environmentId"), "env-a"))
        .unique();
      await ctx.db.patch(reg!._id, { state: "revoked" });
    });
    await expect(env.action(api.appleSessions.read, target)).rejects.toThrow();
  });
});
