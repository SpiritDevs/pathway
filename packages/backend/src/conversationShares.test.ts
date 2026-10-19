// @effect-diagnostics globalDate:off -- Convex fixtures use epoch timestamps.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vite-plus/test";
import type { ConversationShareSession, PersonalConversation } from "@spiritdevs/contracts";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";
import { hashConnectGrantToken } from "./connectGrants.ts";

const RELAY = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY}/.well-known/jwks.json`;
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/conversationShares.ts": () => import("../convex/conversationShares.ts"),
  "../convex/connectGrants.ts": () => import("../convex/connectGrants.ts"),
  "../convex/focusNotifications.ts": () => import("../convex/focusNotifications.ts"),
};
const address = { environmentId: "environment-a", threadId: "thread-a" };
const refs = {
  upsert: makeFunctionReference<
    "mutation",
    typeof address & { ownerUserId: string; shell: unknown },
    null
  >("conversationShares:upsert"),
  share: makeFunctionReference<
    "mutation",
    typeof address & { companyId: string; recipientUserId: string; access: "view" | "collaborate" },
    string
  >("conversationShares:share"),
  revoke: makeFunctionReference<"mutation", { shareId: string }, null>("conversationShares:revoke"),
  session: makeFunctionReference<
    "query",
    { environmentId: string; shareId: string },
    ConversationShareSession | null
  >("conversationShares:session"),
  list: makeFunctionReference<"query", Record<string, never>, PersonalConversation[]>(
    "conversationShares:list",
  ),
  connect: makeFunctionReference<
    "action",
    { shareId: string },
    { token: string; environmentId: string; expiresAt: number }
  >("conversationShares:issueConnectGrant"),
  reconcile: makeFunctionReference<
    "mutation",
    { environmentId: string; threadIds: string[] },
    null
  >("conversationShares:reconcile"),
};
const shell = (threadId = "thread-a") => ({
  id: threadId,
  ownerUserId: "owner",
  projectId: null,
  title: "Personal conversation",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});

async function harness() {
  const t = convexTest(schema, modules);
  const asUser = (subject: string) =>
    t.withIdentity({
      issuer: "https://clerk.example.test",
      subject,
      tokenIdentifier: `clerk|${subject}`,
    });
  const env = t.withIdentity({
    issuer: RELAY,
    subject: address.environmentId,
    tokenIdentifier: `relay|${address.environmentId}`,
  });
  const relay = t.withIdentity({
    issuer: RELAY,
    subject: "pathway-relay",
    tokenIdentifier: "relay|control",
    tokenKind: "relay-control-plane",
  });
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const company = await ctx.db.insert("companies", {
      id: "company-a",
      name: "Company A",
      workspaceKind: "organization",
      issueKeyPrefix: "A",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const memberships = [];
    for (const subject of ["owner", "recipient", "outsider"]) {
      const user = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      if (subject !== "outsider")
        memberships.push(
          await ctx.db.insert("memberships", {
            id: `membership-${subject}`,
            companyId: company,
            userId: user,
            state: "active",
            displayNameSnapshot: subject,
            emailSnapshot: `${subject}@example.test`,
            invitedByMembershipId: null,
            joinedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
        );
    }
    await ctx.db.insert("relayEnvironmentLinks", {
      userId: "owner",
      environmentId: address.environmentId,
      displayName: "Studio",
      environmentLabel: "Studio",
      environmentPublicKey: "public-key-a",
      endpointHttpBaseUrl: "https://environment.example.test",
      endpointWsBaseUrl: "wss://environment.example.test",
      endpointProviderKind: "pathway_relay",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
      createdByDeviceId: null,
      revokedAt: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    return { memberships, company };
  });
  await env.mutation(refs.upsert, { ...address, ownerUserId: "owner", shell: shell() });
  return {
    t,
    env,
    relay,
    owner: asUser("owner"),
    recipient: asUser("recipient"),
    outsider: asUser("outsider"),
    seeded,
  };
}

describe("personal conversation sharing", () => {
  it("keeps discovery private, requires a common active company, and leaves sharing to the owner", async () => {
    const h = await harness();
    expect(await h.owner.query(refs.list, {})).toHaveLength(1);
    expect(await h.recipient.query(refs.list, {})).toEqual([]);
    await expect(
      h.owner.mutation(refs.share, {
        ...address,
        companyId: "company-a",
        recipientUserId: "outsider",
        access: "view",
      }),
    ).rejects.toThrow("active member");
    await expect(
      h.recipient.mutation(refs.share, {
        ...address,
        companyId: "company-a",
        recipientUserId: "owner",
        access: "collaborate",
      }),
    ).rejects.toThrow("Only the conversation owner");
    const shareId = await h.owner.mutation(refs.share, {
      ...address,
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "view",
    });
    expect(await h.recipient.query(refs.list, {})).toEqual([
      expect.objectContaining({ access: "view", shareId }),
    ]);
    expect(await h.outsider.query(refs.list, {})).toEqual([]);
    await expect(h.recipient.mutation(refs.revoke, { shareId })).rejects.toThrow(
      "Only the conversation owner",
    );
    await h.owner.mutation(refs.revoke, { shareId });
    expect(await h.recipient.query(refs.list, {})).toEqual([]);
    expect(
      await h.env.query(refs.session, { environmentId: address.environmentId, shareId }),
    ).toBeNull();
  });

  it("checks current access and both memberships, including multiple conversations on one environment", async () => {
    const h = await harness();
    const shareId = await h.owner.mutation(refs.share, {
      ...address,
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "view",
    });
    await h.env.mutation(refs.upsert, {
      ...address,
      threadId: "thread-b",
      ownerUserId: "owner",
      shell: shell("thread-b"),
    });
    await h.owner.mutation(refs.share, {
      ...address,
      threadId: "thread-b",
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "collaborate",
    });
    expect(
      (await h.env.query(refs.session, { environmentId: address.environmentId, shareId }))
        ?.conversations,
    ).toEqual(
      expect.arrayContaining([
        { threadId: "thread-a", ownerUserId: "owner", access: "view" },
        { threadId: "thread-b", ownerUserId: "owner", access: "collaborate" },
      ]),
    );
    await h.t.run((ctx) => ctx.db.patch(h.seeded.memberships[0]!, { state: "left" }));
    expect(
      await h.env.query(refs.session, { environmentId: address.environmentId, shareId }),
    ).toBeNull();
    expect(await h.recipient.query(refs.list, {})).toEqual([]);
  });

  it("mints a recipient-bound, single-use grant and invalidates it on revoke", async () => {
    const h = await harness();
    const shareId = await h.owner.mutation(refs.share, {
      ...address,
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "collaborate",
    });
    await expect(h.outsider.action(refs.connect, { shareId })).rejects.toThrow(
      "not shared with you",
    );
    const grant = await h.recipient.action(refs.connect, { shareId });
    const tokenHash = await hashConnectGrantToken(grant.token);
    expect(await h.relay.mutation(api.connectGrants.validate, { tokenHash })).toMatchObject({
      status: "accepted",
      conversationShareId: shareId,
      conversationUserId: "recipient",
    });
    expect(await h.relay.mutation(api.connectGrants.validate, { tokenHash })).toMatchObject({
      status: "refused",
    });
    const next = await h.recipient.action(refs.connect, { shareId });
    await h.owner.mutation(refs.revoke, { shareId });
    expect(
      await h.relay.mutation(api.connectGrants.validate, {
        tokenHash: await hashConnectGrantToken(next.token),
      }),
    ).toMatchObject({ status: "refused" });
  });

  it("notifies the owner and current recipients once without requiring broad environment links", async () => {
    const h = await harness();
    const shareId = await h.owner.mutation(refs.share, {
      ...address,
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "view",
    });
    const event = {
      eventId: "personal-event",
      ...address,
      environmentPublicKey: "public-key-a",
      projectKey: null,
      ownerUserId: "owner",
      eventKind: "finished-unsettled" as const,
    };
    expect(await h.relay.mutation(api.focusNotifications.record, event)).toBe(2);
    expect(await h.relay.mutation(api.focusNotifications.record, event)).toBe(0);
    expect(await h.recipient.query(api.focusNotifications.list, {})).toHaveLength(1);
    expect(await h.outsider.query(api.focusNotifications.list, {})).toEqual([]);
    await h.owner.mutation(refs.revoke, { shareId });
    expect(
      await h.relay.mutation(api.focusNotifications.record, { ...event, eventId: "after-revoke" }),
    ).toBe(1);
  });

  it("removes discovery and access on project attachment and reconciliation", async () => {
    const h = await harness();
    const shareId = await h.owner.mutation(refs.share, {
      ...address,
      companyId: "company-a",
      recipientUserId: "recipient",
      access: "view",
    });
    await h.env.mutation(refs.upsert, {
      ...address,
      ownerUserId: "owner",
      shell: { ...shell(), projectId: "project-a" },
    });
    expect(await h.owner.query(refs.list, {})).toEqual([]);
    expect(
      await h.env.query(refs.session, { environmentId: address.environmentId, shareId }),
    ).toBeNull();
    await h.env.mutation(refs.upsert, { ...address, ownerUserId: "owner", shell: shell() });
    await h.env.mutation(refs.reconcile, { environmentId: address.environmentId, threadIds: [] });
    expect(await h.owner.query(refs.list, {})).toEqual([]);
  });
});
