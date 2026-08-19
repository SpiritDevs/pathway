// @effect-diagnostics globalDate:off -- Lease assertions intentionally control wall-clock time.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.slack-coordination.test";
const CLERK_ISSUER = "https://clerk.slack-coordination.test";
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
const AUTOMATION_SETTINGS = {
  schemaVersion: 1,
  routingModelSelection: { instanceId: "provider-1", model: "model-1" },
  routingRules: [],
  fallbackModelSelection: null,
  auditRules: [],
  reviewWorkers: [],
  statusTransitions: {
    workStartedStatusId: null,
    workFinishedStatusId: null,
    auditPassedStatusId: null,
    auditChangesRequestedStatusId: null,
  },
  maxRemediationCycles: 3,
};

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

function asOwner(t: Harness) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject: "slack-owner",
    tokenIdentifier: `${CLERK_ISSUER}|slack-owner`,
    email: "slack-owner@example.test",
    name: "Slack Owner",
  });
}

async function seed(t: Harness) {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "slack-owner",
      email: "slack-owner@example.test",
      displayName: "Slack Owner",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
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
    const membershipId = await ctx.db.insert("memberships", {
      id: "01990000-0000-7000-8000-000000000010",
      companyId,
      userId,
      state: "active",
      displayNameSnapshot: "Slack Owner",
      emailSnapshot: "slack-owner@example.test",
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

  it("clears stale protocol capabilities and fences a V2 lease before credential access", async () => {
    const t = harness();
    await seed(t);
    const environment = asEnvironment(t, PRIMARY);
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
        id: "01990000-0000-7000-8000-000000000030",
        companyId: company!._id,
        integrationId: integration!._id,
        channelId: "C-PROTOCOL",
        channelName: "protocol",
        cloudProjectId: null,
        cycleId: null,
        trigger: { everyMessage: false, botMention: false, reactionRoutes: [] },
        autoInvestigate: false,
        autoAssign: false,
        configurationVersion: 2,
        rules: [],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("slackIntegrationCredentials", {
        companyId: company!._id,
        integrationId: integration!._id,
        workspaceId: "T123",
        keyId: "test-key",
        iv: "iv",
        ciphertext: "ciphertext",
        authenticationTag: "tag",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const capabilityArgs = {
      companyId: COMPANY_ID,
      revision: 1,
      supportsSlackCoordination: true,
      supportsAutomationJobs: true,
      providers: [],
    };
    await environment.mutation(api.slackIntegrations.publishCapabilities, {
      ...capabilityArgs,
      slackProtocolVersion: 2,
    });
    expect(
      await environment.mutation(api.slackIntegrations.heartbeat, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        healthy: true,
        capabilityRevision: 1,
      }),
    ).toMatchObject({ holderEnvironmentId: PRIMARY, generation: 1 });

    await environment.mutation(api.slackIntegrations.publishCapabilities, capabilityArgs);
    await t.run(async (ctx) => {
      const [capabilities] = await ctx.db.query("environmentProviderCapabilities").collect();
      expect(capabilities?.slackProtocolVersion).toBe(1);
    });
    await expect(
      environment.query(internal.slackIntegrations.runtimeCredentialRecord, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 1,
      }),
    ).rejects.toThrow("protocol V2");
    expect(
      await environment.mutation(api.slackIntegrations.heartbeat, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        healthy: true,
        capabilityRevision: 1,
      }),
    ).toMatchObject({ holderEnvironmentId: null, generation: 2, expiresAt: null });
  });

  it("reserves a Slack workspace for only one company", async () => {
    const t = harness();
    await seed(t);
    const secondCompanyId = "01990000-0000-7000-8000-000000000040";
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "slack-owner"))
        .unique();
      const companyId = await ctx.db.insert("companies", {
        id: secondCompanyId,
        name: "Second Slack Company",
        issueKeyPrefix: "SSC",
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
        id: "01990000-0000-7000-8000-000000000041",
        companyId,
        userId: user!._id,
        state: "active",
        displayNameSnapshot: "Slack Owner",
        emailSnapshot: "slack-owner@example.test",
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
    });
    await expect(
      asOwner(t).mutation(internal.slackIntegrations.reserveConnection, {
        companyId: secondCompanyId,
        workspaceId: "T123",
        workspaceName: "Acme",
        workspaceDomain: "acme",
        botUserId: "U1",
        botId: "B1",
        expectedIntegrationId: null,
      }),
    ).rejects.toThrow("already connected to another company");
  });

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

  it("binds V2 issue creation to an exact rule revision and separates route and job snapshots", async () => {
    const t = harness();
    await seed(t);
    await asEnvironment(t, PRIMARY).mutation(api.slackIntegrations.heartbeat, {
      companyId: COMPANY_ID,
      integrationId: INTEGRATION_ID,
      healthy: true,
      capabilityRevision: 1,
    });
    const ruleId = "01990000-0000-7000-8000-000000000014";
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
        id: "01990000-0000-7000-8000-000000000015",
        companyId: company!._id,
        integrationId: integration!._id,
        channelId: "C456",
        channelName: "workflow",
        cloudProjectId: null,
        cycleId: null,
        trigger: { everyMessage: false, botMention: false, reactionRoutes: [] },
        autoInvestigate: false,
        autoAssign: false,
        configurationVersion: 2,
        rules: [
          {
            id: ruleId,
            name: "Everything",
            condition: { kind: "every-message" },
            teamId: null,
            cloudProjectId: null,
            cycleId: null,
            initialStatusId: null,
            investigation: { timing: "off", triggerStatusId: null, successStatusId: null },
            assignmentTiming: "immediate",
          },
        ],
        revision: 3,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("issueAutomationSettings", {
        companyId: company!._id,
        enabled: true,
        activatedAt: NOW,
        revision: 4,
        settings: AUTOMATION_SETTINGS,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const create = (watchRevision: number) =>
      asEnvironment(t, PRIMARY).mutation(api.slackOperations.createIssue, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 1,
        channelId: "C456",
        messageTs: "1800000000.000200",
        routeEmoji: null,
        ruleId,
        watchRevision,
        title: "V2 Slack message",
        description: "The workflow decision must be durable.",
        permalink: null,
        authorName: null,
      });
    await expect(create(2)).rejects.toThrow("changed");
    const created = await create(3);
    expect(created.created).toBe(true);
    await t.run(async (ctx) => {
      const issue = await ctx.db
        .query("issues")
        .filter((q) => q.eq(q.field("id"), created.issueId))
        .unique();
      expect(issue).toMatchObject({ triage: true, statusId: "" });
      const intent = await ctx.db
        .query("slackIssueAutomationIntents")
        .withIndex("by_company_and_issue", (q) =>
          q.eq("companyId", issue!.companyId).eq("issueId", created.issueId),
        )
        .unique();
      expect(intent).toMatchObject({
        ruleId,
        watchRevision: 3,
        investigationState: "off",
        assignmentState: "scheduled",
      });
      expect(JSON.parse(intent!.ruleSnapshot)).toMatchObject({ id: ruleId });
      const job = await ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_trigger", (q) =>
          q
            .eq("companyId", issue!.companyId)
            .eq(
              "triggerKey",
              `slack/${INTEGRATION_ID}/C456/1800000000.000200:automatic-assignment`,
            ),
        )
        .unique();
      expect(job?.ruleId).toBeNull();
      expect(JSON.parse(job!.ruleSnapshot!)).toEqual(AUTOMATION_SETTINGS);
    });
  });

  it("persists only deferred message identity until reaction grace is due", async () => {
    const t = harness();
    await seed(t);
    await asEnvironment(t, PRIMARY).mutation(api.slackIntegrations.heartbeat, {
      companyId: COMPANY_ID,
      integrationId: INTEGRATION_ID,
      healthy: true,
      capabilityRevision: 1,
    });
    const ruleId = "01990000-0000-7000-8000-000000000016";
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
        id: "01990000-0000-7000-8000-000000000017",
        companyId: company!._id,
        integrationId: integration!._id,
        channelId: "C789",
        channelName: "deferred",
        cloudProjectId: null,
        cycleId: null,
        trigger: { everyMessage: false, botMention: false, reactionRoutes: [] },
        autoInvestigate: false,
        autoAssign: false,
        configurationVersion: 2,
        rules: [
          {
            id: ruleId,
            name: "Reaction first",
            condition: { kind: "reaction", emoji: "eyes" },
            teamId: null,
            cloudProjectId: null,
            cycleId: null,
            initialStatusId: null,
            investigation: { timing: "off", triggerStatusId: null, successStatusId: null },
            assignmentTiming: "off",
          },
        ],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const environment = asEnvironment(t, PRIMARY);
    await environment.mutation(api.slackOperations.deferMessage, {
      companyId: COMPANY_ID,
      integrationId: INTEGRATION_ID,
      generation: 1,
      channelId: "C789",
      messageTs: "1800000000.000300",
      watchRevision: 1,
      candidateRuleId: ruleId,
      eligibleAt: NOW + 60_000,
    });
    expect(
      await environment.query(api.slackOperations.listDueMessages, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 1,
      }),
    ).toEqual([]);
    vi.setSystemTime(NOW + 60_000);
    expect(
      await environment.query(api.slackOperations.listDueMessages, {
        companyId: COMPANY_ID,
        integrationId: INTEGRATION_ID,
        generation: 1,
      }),
    ).toEqual([
      {
        channelId: "C789",
        messageTs: "1800000000.000300",
        watchRevision: 1,
        candidateRuleId: ruleId,
        eligibleAt: NOW + 60_000,
      },
    ]);
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("slackPendingIntake").collect();
      expect(Object.keys(row ?? {}).sort()).not.toContain("body");
    });
  });
});
