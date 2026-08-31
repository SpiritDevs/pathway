// @effect-diagnostics globalDate:off -- Claim-expiry assertions intentionally control wall-clock time.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.automation-jobs.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/issueAutomation.ts": () => import("../convex/issueAutomation.ts"),
  "../convex/slackIntegrations.ts": () => import("../convex/slackIntegrations.ts"),
};

const COMPANY_ID = "01990000-0000-7000-8000-000000000021";
const JOB_ID = "01990000-0000-7000-8000-000000000022";
const ENVIRONMENT_ID = "automation-environment";
const NOW = 1_800_000_000_000;

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asEnvironment(t: Harness) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: ENVIRONMENT_ID,
    tokenIdentifier: `${RELAY_ISSUER}|${ENVIRONMENT_ID}`,
    cnf: { jkt: `${ENVIRONMENT_ID}-thumbprint` },
  });
}

async function seed(t: Harness, state: "pending" | "blocked" = "pending") {
  await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Automation Co",
      issueKeyPrefix: "AUT",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("environmentRegistrations", {
      id: "automation-registration",
      companyId,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: `${ENVIRONMENT_ID}-thumbprint`,
      descriptor: { environmentId: ENVIRONMENT_ID, label: "Automation environment" },
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
    await ctx.db.insert("issueAutomationJobs", {
      id: JOB_ID,
      companyId,
      issueId: "01990000-0000-7000-8000-000000000023",
      kind: "audit-outcome-reduction",
      triggerKey: "issue-transition:audit-reduction",
      settingsRevision: 1,
      modelSelection: null,
      ruleId: null,
      ruleSnapshot: null,
      targetKind: "thread",
      cloudProjectId: null,
      threadId: "thread-1",
      targetEnvironmentId: ENVIRONMENT_ID,
      requiredProviderInstanceId: null,
      requiredModel: null,
      state,
      blockCode: state === "blocked" ? "environment-offline" : null,
      diagnostic: state === "blocked" ? "Capabilities are stale." : null,
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
}

describe("durable issue automation jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("lets a registered environment read runtime settings without a service-role grant", async () => {
    const t = harness();
    await seed(t);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      await ctx.db.insert("issueAutomationSettings", {
        companyId: company!._id,
        enabled: true,
        activatedAt: NOW,
        revision: 1,
        settings: { schemaVersion: 1 },
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const environment = asEnvironment(t);

    await expect(
      environment.query(api.issueAutomation.getSettings, { companyId: COMPANY_ID }),
    ).rejects.toThrow("Missing permission integrations.read");
    await expect(
      environment.query(api.issueAutomation.runtimeStatus, { companyId: COMPANY_ID }),
    ).resolves.toEqual({ enabled: true, activatedAt: NOW });
  });

  it("reclaims an expired job and fences the stale generation", async () => {
    const t = harness();
    await seed(t);
    const environment = asEnvironment(t);
    const [first] = await environment.mutation(api.issueAutomation.claim, {
      companyId: COMPANY_ID,
      limit: 1,
    });
    expect(first).toMatchObject({ claimGeneration: 1, attempts: 1, state: "claimed" });

    vi.setSystemTime(NOW + 91_000);
    const [second] = await environment.mutation(api.issueAutomation.claim, {
      companyId: COMPANY_ID,
      limit: 1,
    });
    expect(second).toMatchObject({ claimGeneration: 2, attempts: 2, state: "claimed" });
    await expect(
      environment.mutation(api.issueAutomation.report, {
        companyId: COMPANY_ID,
        jobId: JOB_ID,
        claimGeneration: 1,
        outcome: "succeeded",
        result: { kind: "reduction", outcome: "passed" },
        blockCode: null,
        diagnostic: null,
      }),
    ).rejects.toThrow("stale");
    const completed = await environment.mutation(api.issueAutomation.report, {
      companyId: COMPANY_ID,
      jobId: JOB_ID,
      claimGeneration: 2,
      outcome: "succeeded",
      result: { kind: "reduction", outcome: "passed" },
      blockCode: null,
      diagnostic: null,
    });
    expect(completed).toMatchObject({ state: "succeeded", completedAt: NOW + 91_000 });
  });

  it("re-evaluates a blocked job after fresh capabilities arrive", async () => {
    const t = harness();
    await seed(t, "blocked");
    await asEnvironment(t).mutation(api.slackIntegrations.publishCapabilities, {
      companyId: COMPANY_ID,
      revision: 1,
      supportsSlackCoordination: true,
      supportsAutomationJobs: true,
      providers: [],
    });
    expect(await t.mutation(internal.issueAutomation.recoverBlocked, {})).toBe(1);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("issueAutomationJobs")
        .filter((q) => q.eq(q.field("id"), JOB_ID))
        .unique();
      expect(row).toMatchObject({ state: "pending", blockCode: null, diagnostic: null });
    });
  });
});
