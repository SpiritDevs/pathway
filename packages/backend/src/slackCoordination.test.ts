// @effect-diagnostics globalDate:off -- Lease assertions intentionally control wall-clock time.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.slack-coordination.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/slackIntegrations.ts": () => import("../convex/slackIntegrations.ts"),
  "../convex/slackOperations.ts": () => import("../convex/slackOperations.ts"),
};

const COMPANY_ID = "01990000-0000-7000-8000-000000000011";
const INTEGRATION_ID = "01990000-0000-7000-8000-000000000012";
const PRIMARY = "slack-primary";
const BACKUP = "slack-backup";
const NOW = 1_800_000_000_000;

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asEnvironment(t: Harness, environmentId: string) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: environmentId,
    tokenIdentifier: `${RELAY_ISSUER}|${environmentId}`,
    cnf: { jkt: `${environmentId}-thumbprint` },
  });
}

async function seed(t: Harness) {
  await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Slack Coordination Co",
      issueKeyPrefix: "SLC",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const environmentId of [PRIMARY, BACKUP]) {
      await ctx.db.insert("environmentRegistrations", {
        id: `registration-${environmentId}`,
        companyId,
        environmentId,
        publicKeyThumbprint: `${environmentId}-thumbprint`,
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
    }
    await ctx.db.insert("slackIntegrations", {
      id: INTEGRATION_ID,
      companyId,
      workspaceId: "T123",
      workspaceName: "Acme",
      workspaceDomain: "acme",
      botUserId: "U1",
      botId: "B1",
      state: "active",
      activatedAt: NOW,
      credentialPresent: true,
      preferredEnvironmentId: PRIMARY,
      backupEnvironmentIds: [BACKUP],
      configurationRevision: 1,
      lastPollAt: null,
      currentError: null,
      blockedReason: null,
      watchCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

describe("Slack controller coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("selects the preferred controller, fails over in order, and safely fails back", async () => {
    const t = harness();
    await seed(t);
    const heartbeat = (environmentId: string) =>
      asEnvironment(t, environmentId).mutation(api.slackIntegrations.heartbeat, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        healthy: true,
        capabilityRevision: 1,
      });

    const primary = await heartbeat(PRIMARY);
    expect(primary).toMatchObject({ holderEnvironmentId: PRIMARY, generation: 1 });
    expect(await heartbeat(BACKUP)).toMatchObject({ holderEnvironmentId: PRIMARY, generation: 1 });

    vi.setSystemTime(NOW + 91_000);
    const backup = await heartbeat(BACKUP);
    expect(backup).toMatchObject({ holderEnvironmentId: BACKUP, generation: 2 });

    expect(await heartbeat(PRIMARY)).toMatchObject({ holderEnvironmentId: BACKUP, generation: 2 });
    expect(await heartbeat(PRIMARY)).toMatchObject({ holderEnvironmentId: BACKUP, generation: 2 });

    vi.setSystemTime(NOW + 182_000);
    const failedBack = await heartbeat(PRIMARY);
    expect(failedBack).toMatchObject({ holderEnvironmentId: PRIMARY, generation: 3 });

    await expect(
      asEnvironment(t, BACKUP).mutation(api.slackIntegrations.updateHealth, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 2,
        lastPollAt: NOW,
        error: null,
      }),
    ).rejects.toThrow("stale");
  });

  it("creates one canonical issue for a Slack origin submitted twice", async () => {
    const t = harness();
    await seed(t);
    await asEnvironment(t, PRIMARY).mutation(api.slackIntegrations.heartbeat, {
      companyId: COMPANY_ID,
      integrationId: INTEGRATION_ID,
      healthy: true,
      capabilityRevision: 1,
    });
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", COMPANY_ID))
        .unique();
      const integration = await ctx.db
        .query("slackIntegrations")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company!._id).eq("id", INTEGRATION_ID),
        )
        .unique();
      await ctx.db.insert("slackChannelWatches", {
        id: "01990000-0000-7000-8000-000000000013",
        companyId: company!._id,
        integrationId: integration!._id,
        channelId: "C123",
        channelName: "triage",
        cloudProjectId: null,
        cycleId: null,
        trigger: { everyMessage: true, botMention: false, reactionRoutes: [] },
        autoInvestigate: false,
        autoAssign: false,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const create = () =>
      asEnvironment(t, PRIMARY).mutation(api.slackOperations.createIssue, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 1,
        channelId: "C123",
        messageTs: "1800000000.000100",
        routeEmoji: null,
        title: "One Slack message",
        description: "The same origin must be idempotent.",
        permalink: "https://acme.slack.com/archives/C123/p1800000000000100",
        authorName: "Sam",
      });
    const [first, second] = await Promise.all([create(), create()]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.issueId).toBe(second.issueId);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("issues").collect()).toHaveLength(1);
      expect(await ctx.db.query("slackProcessedMessages").collect()).toHaveLength(1);
    });
  });
});
