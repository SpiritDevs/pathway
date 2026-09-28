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
    ).rejects.toThrow("Unlink projects");
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
});
