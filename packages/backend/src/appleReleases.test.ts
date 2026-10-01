// @effect-diagnostics globalDate:off -- Lease tests use a controlled transaction clock.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../convex/_generated/api.js";
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
  "../convex/appleReleases.ts": () => import("../convex/appleReleases.ts"),
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
const appleHttp = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/apps?")) return Response.json(apps);
  if (url.includes("/builds?"))
    return Response.json({
      data: [{ id: "build", attributes: { version: "10", processingState: "VALID" } }],
    });
  return Response.json({ data: [] });
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
const action = {
  kind: "upload" as const,
  archiveId: "archive-1",
  artifactSha256: "a".repeat(64),
  version: "1.0",
  buildNumber: "1",
  platform: "IOS" as const,
};
const caller = { clerkSubject: "owner" };
async function releases() {
  const h = await setup();
  const target = { ...h.runtimeTarget, appId: "app-1" };
  const env = environment(h.t, "env-a");
  const prepare = () => env.mutation(api.appleReleases.prepare, { ...target, caller, action });
  return { ...h, releaseTarget: target, env, prepare };
}
describe("Cloud release authority", () => {
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
    vi.stubGlobal("fetch", vi.fn(appleHttp));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("defaults off and permits preparation but no confirmation or upload", async () => {
    const h = await releases();
    expect(await h.owner.query(api.appleReleases.settings, h.releaseTarget)).toEqual({
      enabled: false,
      revision: 0,
    });
    const intent = await h.prepare();
    await expect(
      h.owner.mutation(api.appleReleases.confirm, { intentId: intent.id }),
    ).rejects.toThrow("Enable publishing");
    await expect(
      h.env.mutation(api.appleReleases.consume, {
        ...h.releaseTarget,
        caller,
        intentId: intent.id,
      }),
    ).rejects.toThrow("disabled");
  });
  it("environment identities cannot enable publishing or approve their own actions", async () => {
    const h = await releases();
    const intent = await h.prepare();
    await expect(
      h.env.mutation(api.appleReleases.setEnabled, {
        ...h.releaseTarget,
        enabled: true,
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    await expect(
      h.env.mutation(api.appleReleases.confirm, { intentId: intent.id }),
    ).rejects.toThrow();
    await expect(
      human(h.t, "teammate").mutation(api.appleReleases.confirm, { intentId: intent.id }),
    ).rejects.toThrow();
  });
  it("consumes an exact approval once and rejects other environments and app targets", async () => {
    const h = await releases();
    await h.owner.mutation(api.appleReleases.setEnabled, {
      ...h.releaseTarget,
      enabled: true,
      expectedRevision: 0,
    });
    const intent = await h.prepare();
    const args = { ...h.releaseTarget, caller, intentId: intent.id };
    await expect(h.env.mutation(api.appleReleases.consume, args)).rejects.toThrow("confirmation");
    await h.owner.mutation(api.appleReleases.confirm, { intentId: intent.id });
    await expect(
      environment(h.t, "env-b").mutation(api.appleReleases.consume, args),
    ).rejects.toThrow("confirmation");
    await expect(
      h.env.mutation(api.appleReleases.consume, { ...args, appId: "other" }),
    ).rejects.toThrow();
    const result = await h.env.mutation(api.appleReleases.consume, args);
    expect(result.action).toEqual(action);
    expect(result.state).toBe("consumed");
    await expect(h.env.mutation(api.appleReleases.consume, args)).rejects.toThrow("confirmation");
    expect(await h.env.query(api.appleReleases.checkExecution, args)).toBeNull();
  });
  it.each(["expired", "disabled", "rotated", "unlinked", "cancelled"])(
    "fences a %s approval",
    async (scenario) => {
      const h = await releases();
      await h.owner.mutation(api.appleReleases.setEnabled, {
        ...h.releaseTarget,
        enabled: true,
        expectedRevision: 0,
      });
      const intent = await h.prepare();
      await h.owner.mutation(api.appleReleases.confirm, { intentId: intent.id });
      if (scenario === "expired") vi.setSystemTime(NOW + 16 * 60_000);
      if (scenario === "disabled")
        await h.owner.mutation(api.appleReleases.setEnabled, {
          ...h.releaseTarget,
          enabled: false,
          expectedRevision: 1,
        });
      if (scenario === "rotated")
        await h.owner.mutation(api.appleIntegrations.revoke, {
          ...h.target,
          expectedRevision: h.connected.revision,
        });
      if (scenario === "unlinked")
        await h.t.run(async (ctx) => {
          const link = await ctx.db
            .query("relayEnvironmentLinks")
            .withIndex("by_user_and_environment", (q) =>
              q.eq("userId", "owner").eq("environmentId", "env-a"),
            )
            .unique();
          await ctx.db.patch(link!._id, { revokedAt: new Date(NOW).toISOString() });
        });
      if (scenario === "cancelled")
        await h.owner.mutation(api.appleReleases.cancel, { intentId: intent.id });
      await expect(
        h.env.mutation(api.appleReleases.consume, {
          ...h.releaseTarget,
          caller,
          intentId: intent.id,
        }),
      ).rejects.toThrow();
    },
  );
  it("disabling and re-enabling invalidates an already consumed grant", async () => {
    const h = await releases();
    await h.owner.mutation(api.appleReleases.setEnabled, {
      ...h.releaseTarget,
      enabled: true,
      expectedRevision: 0,
    });
    const intent = await h.prepare();
    const args = { ...h.releaseTarget, caller, intentId: intent.id };
    await h.owner.mutation(api.appleReleases.confirm, { intentId: intent.id });
    await h.env.mutation(api.appleReleases.consume, args);
    await h.owner.mutation(api.appleReleases.setEnabled, {
      ...h.releaseTarget,
      enabled: false,
      expectedRevision: 1,
    });
    await h.owner.mutation(api.appleReleases.setEnabled, {
      ...h.releaseTarget,
      enabled: true,
      expectedRevision: 2,
    });
    await expect(h.env.query(api.appleReleases.checkExecution, args)).rejects.toThrow(
      "confirmation",
    );
  });
  it("serializes concurrent environments and never reuses reserved build numbers", async () => {
    const h = await releases();
    const args = { ...h.releaseTarget, caller, version: "1.0" };
    const b = environment(h.t, "env-b");
    const lease = await h.env.action(api.appleReleases.acquireBuildLease, args);
    await expect(b.action(api.appleReleases.acquireBuildLease, args)).rejects.toThrow(
      "Another environment",
    );
    await expect(
      b.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: lease.token,
        observedMaximum: 10,
      }),
    ).rejects.toThrow("lease");
    expect(
      await h.env.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: lease.token,
        observedMaximum: 10,
      }),
    ).toBe("11");
    const leaseB = await b.action(api.appleReleases.acquireBuildLease, args);
    expect(
      await b.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: leaseB.token,
        observedMaximum: 10,
      }),
    ).toBe("12");
    await expect(
      h.env.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: lease.token,
        observedMaximum: 10,
      }),
    ).rejects.toThrow("lease");
  });
  it("allows only one simultaneous lease acquisition after Cloud app verification", async () => {
    const h = await releases();
    const args = { ...h.releaseTarget, caller, version: "1.0" };
    const attempts = await Promise.allSettled([
      h.env.action(api.appleReleases.acquireBuildLease, args),
      environment(h.t, "env-b").action(api.appleReleases.acquireBuildLease, args),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect())).toHaveLength(1);
  });
  it("denies an unrelated account before touching a shared counter and ignores client maxima", async () => {
    const h = await releases();
    const args = { ...h.releaseTarget, caller, version: "1.0" };
    const lease = await h.env.action(api.appleReleases.acquireBuildLease, args);
    const before = await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect());
    const other = human(h.t, "teammate");
    const account = await other.mutation(api.appleIntegrations.createAccount, {
      email: "other@apple.test",
      displayName: "Other private account",
    });
    const otherTeam = { accountId: account.id, teamId: "OTHERTEAM1" };
    await other.mutation(api.appleIntegrations.upsertTeam, {
      ...otherTeam,
      name: "Other",
      type: "organization",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "app-2",
              attributes: { name: "Other app", bundleId: "com.other.app" },
            },
          ],
        }),
      ),
    );
    await other.action(api.appleIntegrations.connect, {
      ...otherTeam,
      ...appleTestCredential,
      expectedRevision: 0,
    });
    await h.t.run(async (ctx) => {
      const link = await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user_and_environment", (q) =>
          q.eq("userId", "owner").eq("environmentId", "env-b"),
        )
        .unique();
      const { _id, _creationTime, ...copy } = link!;
      await ctx.db.insert("relayEnvironmentLinks", { ...copy, userId: "teammate" });
    });
    await expect(other.query(api.appleReleases.settings, h.releaseTarget)).rejects.toThrow(
      "private",
    );
    const otherArgs = { ...args, ...otherTeam, caller: { clerkSubject: "teammate" } };
    const otherEnv = environment(h.t, "env-b");
    await expect(otherEnv.action(api.appleReleases.acquireBuildLease, otherArgs)).rejects.toThrow(
      "cannot access this app",
    );
    await expect(
      otherEnv.action(api.appleReleases.allocateBuildNumber, {
        ...otherArgs,
        token: lease.token,
        observedMaximum: 9998,
      }),
    ).rejects.toThrow("cannot access this app");
    expect(await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect())).toEqual(before);
    vi.stubGlobal("fetch", vi.fn(appleHttp));
    expect(
      await h.env.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: lease.token,
        observedMaximum: 9998,
      }),
    ).toBe("11");
    // When Apple grants both keys access to the same app, they share the same counter.
    const next = await otherEnv.action(api.appleReleases.acquireBuildLease, otherArgs);
    expect(
      await otherEnv.action(api.appleReleases.allocateBuildNumber, {
        ...otherArgs,
        token: next.token,
        observedMaximum: 9998,
      }),
    ).toBe("12");
    expect(await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect())).toHaveLength(1);
  });
  it.each(["acquire", "allocate"] as const)(
    "rechecks credential revisions before %s writes",
    async (operation) => {
      const h = await releases();
      const args = { ...h.releaseTarget, caller, version: "1.0" };
      const lease =
        operation === "allocate"
          ? await h.env.action(api.appleReleases.acquireBuildLease, args)
          : undefined;
      const before = await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect());
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).includes("/apps?")) {
            entered.resolve();
            await gate.promise;
          }
          return appleHttp(input);
        }),
      );
      const attempt = lease
        ? h.env.action(api.appleReleases.allocateBuildNumber, { ...args, token: lease.token })
        : h.env.action(api.appleReleases.acquireBuildLease, args);
      const rejected = expect(attempt).rejects.toThrow();
      await entered.promise;
      await h.owner.mutation(api.appleIntegrations.revoke, {
        ...h.target,
        expectedRevision: h.connected.revision,
      });
      gate.resolve();
      await rejected;
      expect(await h.t.run((ctx) => ctx.db.query("appleBuildCounters").collect())).toEqual(before);
    },
  );
  it("rejects expired allocation tokens and recovers after lease expiry", async () => {
    const h = await releases();
    const args = { ...h.releaseTarget, caller, version: "1.0" };
    const lease = await h.env.action(api.appleReleases.acquireBuildLease, args);
    vi.setSystemTime(NOW + 30_001);
    await expect(
      h.env.action(api.appleReleases.allocateBuildNumber, {
        ...args,
        token: lease.token,
        observedMaximum: 0,
      }),
    ).rejects.toThrow("lease");
    const fresh = await environment(h.t, "env-b").action(api.appleReleases.acquireBuildLease, args);
    expect(fresh.token).not.toBe(lease.token);
  });
});
