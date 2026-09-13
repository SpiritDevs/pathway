import { notifyOrchestratorIssueChanges } from "../convex/lib/aiOrchestratorIssueSignals.ts";
// @effect-diagnostics globalDate:off -- Convex transaction time in fixtures.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";
import { defaultOrchestratorConfig } from "@spiritdevs/contracts/aiOrchestrator";
import { allowanceWindowKey, budgetAdmission } from "@spiritdevs/contracts/providerAllowanceBudget";
import { api, internal } from "../convex/_generated/api.js";
import { appendChatMessage } from "../convex/aiOrchestrators.ts";
import schema from "../convex/schema.ts";
import {
  notifyOrchestratorPriorityMail,
  notifyOrchestratorThreadUpdate,
} from "../convex/lib/aiOrchestratorSignals.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWKS_URL = "https://relay.example.test/.well-known/jwks.json";
const modules = {
  "../convex/aiOrchestratorPush.ts": () => import("../convex/aiOrchestratorPush.ts"),
  "../convex/aiOrchestratorEvents.ts": () => import("../convex/aiOrchestratorEvents.ts"),
  "../convex/aiOrchestratorReviews.ts": () => import("../convex/aiOrchestratorReviews.ts"),
  "../convex/mail.ts": () => import("../convex/mail.ts"),
  "../convex/mailRelay.ts": () => import("../convex/mailRelay.ts"),
  "../convex/timeTracking.ts": () => import("../convex/timeTracking.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/environmentCommands.ts": () => import("../convex/environmentCommands.ts"),
  "../convex/aiOrchestratorJobs.ts": () => import("../convex/aiOrchestratorJobs.ts"),
  "../convex/aiOrchestrators.ts": () => import("../convex/aiOrchestrators.ts"),
  "../convex/providerAllowanceBudgets.ts": () => import("../convex/providerAllowanceBudgets.ts"),
};
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;
const human = (t: Harness, subject = "owner") =>
  t.withIdentity({
    issuer: "https://clerk.example.test",
    subject,
    tokenIdentifier: `clerk|${subject}`,
  });
const config = () => ({
  ...defaultOrchestratorConfig(),
  models: [],
  environmentIds: [],
  capabilities: [...defaultOrchestratorConfig().capabilities],
  directorSubjects: [],
  managerSubjects: [],
});
async function seed(t: Harness) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", {
      id: "workspace",
      name: "Workspace",
      issueKeyPrefix: "WS",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const subject of ["owner", "director", "colleague"]) {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: `member-${subject}`,
        companyId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (subject === "owner")
        await ctx.db.insert("companyOwners", {
          companyId,
          membershipId,
          grantedByMembershipId: null,
          createdAt: now,
        });
    }
    return companyId;
  });
}
async function personalChat(t: Harness) {
  const owner = human(t);
  const id = await owner.mutation(api.aiOrchestrators.ensurePersonal, {});
  const chatId = await owner.mutation(api.aiOrchestrators.createChat, {
    title: "Chief",
    orchestratorIds: [id],
    leadId: id,
    companyIds: [],
  });
  return { owner, id, chatId };
}
describe("persistent orchestrator identities and messages", () => {
  it("provisions one personal Chief and reuses its continuing DM", async () => {
    const t = harness();
    await seed(t);
    const { owner, id, chatId } = await personalChat(t);
    expect(await owner.mutation(api.aiOrchestrators.ensurePersonal, {})).toBe(id);
    expect(
      await owner.mutation(api.aiOrchestrators.createChat, {
        title: "Another title",
        orchestratorIds: [id],
        leadId: id,
        companyIds: [],
      }),
    ).toBe(chatId);
    expect(await human(t, "colleague").query(api.aiOrchestrators.list, {})).toEqual([]);
    await expect(
      human(t, "colleague").query(api.aiOrchestrators.messages, { chatId }),
    ).rejects.toThrow("access");
  });
  it("queues messages once when a client retries an unconfirmed send", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    const message = { chatId, id: "message-1", text: "Coordinate the release" };
    expect(await owner.mutation(api.aiOrchestrators.send, message)).toBe(1);
    expect(await owner.mutation(api.aiOrchestrators.send, message)).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
    await expect(
      owner.mutation(api.aiOrchestrators.send, { ...message, text: "Different request" }),
    ).rejects.toThrow("already in use");
  });
  it("cancels unstarted messages atomically and cannot cancel one already claimed", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "first", text: "First" });
    await owner.mutation(api.aiOrchestrators.cancelMessage, { chatId, messageId: "first" });
    expect((await owner.query(api.aiOrchestrators.messages, { chatId })).messages[0]?.status).toBe(
      "cancelled",
    );
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "second", text: "Second" });
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_message", (q) => q.eq("messageId", "second"))
        .unique();
      await ctx.db.patch(job!._id, { status: "running" });
    });
    await expect(
      owner.mutation(api.aiOrchestrators.cancelMessage, { chatId, messageId: "second" }),
    ).rejects.toThrow("already started");
  });
  it("paginates history without duplicates or missing messages", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await t.run(async (ctx) => {
      const chat = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", chatId))
        .unique();
      for (let sequence = 1; sequence <= 125; sequence++)
        await ctx.db.insert("aiOrchestratorMessages", {
          id: `m-${sequence}`,
          chatId,
          sequence,
          senderKind: "user",
          senderId: "owner",
          senderName: "Owner",
          text: String(sequence),
          status: "sent",
          replyToId: null,
          createdAt: sequence,
        });
      await ctx.db.patch(chat!._id, { lastSequence: 125 });
    });
    const first = await owner.query(api.aiOrchestrators.messages, { chatId });
    const second = await owner.query(api.aiOrchestrators.messages, {
      chatId,
      before: first.nextBefore!,
    });
    const third = await owner.query(api.aiOrchestrators.messages, {
      chatId,
      before: second.nextBefore!,
    });
    expect(
      [...third.messages, ...second.messages, ...first.messages].map((message) => message.sequence),
    ).toEqual(Array.from({ length: 125 }, (_, index) => index + 1));
    expect(third.nextBefore).toBeNull();
    await owner.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 125 });
    await owner.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 3 });
    expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]?.readSequence).toBe(125);
    await expect(
      owner.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 0.5 }),
    ).rejects.toThrow("Invalid read");
  });
  it("keeps direction separate from changing permissions", async () => {
    const t = harness();
    await seed(t);
    const id = await human(t).mutation(api.aiOrchestrators.create, {
      config: { ...config(), companyId: "workspace", shared: true, directorSubjects: ["director"] },
    });
    const director = human(t, "director");
    const visible = (await director.query(api.aiOrchestrators.list, { companyId: "workspace" }))[0];
    expect(visible).toMatchObject({ canDirect: true, canManage: false });
    await expect(
      director.mutation(api.aiOrchestrators.configure, {
        id,
        revision: 1,
        config: {
          ...config(),
          companyId: "workspace",
          shared: true,
          managerSubjects: ["director"],
        },
      }),
    ).rejects.toThrow("management permission");
    await expect(
      human(t, "colleague").mutation(api.aiOrchestrators.createChat, {
        title: "Private direction",
        orchestratorIds: [id],
        leadId: id,
        companyIds: [],
      }),
    ).rejects.toThrow("permission to direct");
  });
  it("rejects stale settings saves and invalid assignment limits", async () => {
    const t = harness();
    await seed(t);
    const { owner, id } = await personalChat(t);
    await owner.mutation(api.aiOrchestrators.configure, {
      id,
      revision: 1,
      config: { ...config(), name: "Chief of staff", maxAssignments: 2 },
    });
    await expect(
      owner.mutation(api.aiOrchestrators.configure, { id, revision: 1, config: config() }),
    ).rejects.toThrow("another device");
    await expect(
      owner.mutation(api.aiOrchestrators.configure, {
        id,
        revision: 2,
        config: { ...config(), maxAssignments: 0 },
      }),
    ).rejects.toThrow("1 and 32");
    expect((await owner.query(api.aiOrchestrators.list, {}))[0]?.name).toBe("Chief of staff");
  });
  it("removes conversation access and list previews when workspace membership is revoked", async () => {
    const t = harness();
    await seed(t);
    const { owner, id } = await personalChat(t);
    const chatId = await owner.mutation(api.aiOrchestrators.createChat, {
      title: "Group",
      orchestratorIds: [
        id,
        await owner.mutation(api.aiOrchestrators.create, {
          config: { ...config(), name: "Server", kind: "custom" },
        }),
      ],
      leadId: id,
      companyIds: ["workspace"],
    });
    await owner.mutation(api.aiOrchestrators.send, {
      chatId,
      id: "private",
      text: "Workspace details",
    });
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_domain_id", (q) => q.eq("id", "member-owner"))
        .unique();
      await ctx.db.patch(member!._id, { state: "locked" });
    });
    await expect(owner.query(api.aiOrchestrators.messages, { chatId })).rejects.toThrow("access");
    expect(
      (await owner.query(api.aiOrchestrators.listChats, {})).some((chat) => chat.id === chatId),
    ).toBe(false);
  });
  it("retains forgotten and corrected source exclusions without retaining their text", async () => {
    const t = harness();
    await seed(t);
    const { owner, id } = await personalChat(t);
    const memoryId = await owner.mutation(api.aiOrchestrators.saveMemory, {
      orchestratorId: id,
      text: "Call me Captain",
      scope: "orchestrator",
    });
    await owner.mutation(api.aiOrchestrators.saveMemory, {
      orchestratorId: id,
      id: memoryId,
      text: "Call me Corey",
      scope: "personal",
    });
    expect(
      (await owner.query(api.aiOrchestrators.memories, { orchestratorId: id })).map(
        (memory) => memory.text,
      ),
    ).toEqual(["Call me Corey"]);
    await owner.mutation(api.aiOrchestrators.forgetMemory, { orchestratorId: id, id: memoryId });
    expect(await owner.query(api.aiOrchestrators.memories, { orchestratorId: id })).toEqual([]);
    expect(
      (await t.run((ctx) => ctx.db.query("aiOrchestratorMemory").collect())).every(
        (memory) => memory.forgotten && memory.text === "" && memory.source === "",
      ),
    ).toBe(true);
    await expect(
      human(t, "colleague").query(api.aiOrchestrators.memories, { orchestratorId: id }),
    ).rejects.toThrow("access");
  });
  it("archives and restores conversations without deleting their history", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "m", text: "Remember our plan" });
    await owner.mutation(api.aiOrchestrators.updateChat, { chatId, archived: true });
    await expect(
      owner.mutation(api.aiOrchestrators.send, { chatId, id: "m2", text: "Continue" }),
    ).rejects.toThrow("Unarchive");
    await owner.mutation(api.aiOrchestrators.updateChat, { chatId, archived: false });
    expect((await owner.query(api.aiOrchestrators.messages, { chatId })).messages[0]?.text).toBe(
      "Remember our plan",
    );
  });
});

async function coordinatorHarness() {
  const t = harness();
  const company = await seed(t);
  const chat = await personalChat(t);
  await t.run(async (ctx) => {
    const memberships = await ctx.db.query("memberships").collect();
    for (const [environmentId, subject] of [
      ["studio", "owner"],
      ["other", "colleague"],
      ["laptop", "owner"],
    ]) {
      const member = memberships.find((m) => m.id === `member-${subject}`)!;
      await ctx.db.insert("environmentRegistrations", {
        id: `registration-${environmentId}`,
        companyId: company,
        environmentId: environmentId!,
        publicKeyThumbprint: `key-${environmentId}`,
        descriptor: {},
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: Date.now(),
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: member._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  const environment = (environmentId = "studio") =>
    t.withIdentity({
      issuer: "https://relay.example.test",
      subject: environmentId,
      tokenIdentifier: `relay|${environmentId}`,
      cnf: { jkt: `key-${environmentId}` },
    });
  const claim = () =>
    environment().mutation(api.aiOrchestratorJobs.claim, {
      companyId: "workspace",
      providers: [{ instanceId: "codex", driver: "codex" }],
    });
  await chat.owner.mutation(api.aiOrchestrators.send, {
    chatId: chat.chatId,
    id: "greeting",
    text: "Call me Corey. Keep updates concise.",
  });
  return { t, ...chat, environment, claim };
}
const decision = () => ({
  message: "Hi Corey!",
  actions: [],
  summary: "The user prefers Corey and concise updates.",
});

describe("coordinator reasoning claims and action boundaries", () => {
  it("wakes the owner's private coordinator once for priority mail and rechecks mailbox access", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    const mailID = await test.t.run(async (ctx) => {
      const company = (await ctx.db.query("companies").first())!;
      const owner = (await ctx.db.query("memberships").collect()).find(
        (row) => row.id === "member-owner",
      )!;
      const now = Date.now();
      await ctx.db.insert("mailAccounts", {
        id: "private-account",
        companyId: company._id,
        ownerMembershipId: owner._id,
        ownerSubject: "owner",
        email: "owner@example.test",
        oauthClientId: "test-client",
        credentialSource: "byo",
        status: "active",
        lastClaimAt: 0,
        lastAuthCheckAt: now,
        nextSyncAt: now,
        generation: 0,
        createdAt: now,
        updatedAt: now,
      });
      const id = await ctx.db.insert("mailMessages", {
        id: "private-priority-mail",
        accountId: "private-account",
        companyId: company._id,
        ownerMembershipId: owner._id,
        ownerSubject: "owner",
        providerMessageId: "test-provider-message",
        providerThreadId: "test-mail-thread",
        from: { email: "sender@example.test" },
        to: ["owner@example.test"],
        cc: [],
        subject: "Private approval request",
        snippet: "Please review by tomorrow.",
        receivedAt: now,
        labels: ["INBOX"],
        attachments: [],
        read: false,
        bucket: "priority",
        reason: "Needs a decision",
        analysisStatus: "ready",
        briefing: "Review the approval request.",
        classificationRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const message = (await ctx.db.get(id))!;
      await notifyOrchestratorPriorityMail(ctx, message);
      await notifyOrchestratorPriorityMail(ctx, message);
      return id;
    });
    const jobs = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(jobs.filter((job) => job.mailMessageId)).toHaveLength(1);
    const run = (await test.claim())!;
    expect(JSON.parse(run.context).privateMail).toMatchObject({
      subject: "Private approval request",
      source: "private-inbox",
    });
    const messages = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
    expect(
      messages.messages.some((message) => message.text.includes("Private approval request")),
    ).toBe(false);
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { ...decision(), actions: [delegate("Forward private mail to project work")] },
      }),
    ).rejects.toThrow("Private");
    await test.t.run((ctx) => ctx.db.patch(mailID, { read: true }));
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: decision(),
      }),
    ).toBe(false);
    await test.t.run((ctx) => ctx.db.patch(mailID, { read: false }));
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: {
          ...decision(),
          actions: [{ ...delegate("Review the owner's private priority mail"), projectId: null }],
        },
      }),
    ).toBe(true);
    expect(
      (await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId }))[0]?.projectId,
    ).toBeNull();
    expect(await human(test.t, "colleague").query(api.aiOrchestrators.listChats, {})).toEqual([]);
  });
  it("opens a continuing collaboration without copying the originating DM or granting foreign dispatch", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const server = await test.owner.mutation(api.aiOrchestrators.create, {
      config: {
        ...config(),
        name: "Server",
        kind: "project",
        companyId: "workspace",
        projectId: "project",
      },
    });
    const run = (await test.claim())!;
    expect(
      JSON.parse(run.context).directory.some((contact: { id: string }) => contact.id === server),
    ).toBe(true);
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "collaborate",
            title: "Shared API",
            orchestratorIds: [server],
            text: "Please prepare the API contract for the app.",
          },
        ],
      },
    });
    const chats = await test.owner.query(api.aiOrchestrators.listChats, {});
    const group = chats.find((chat) => chat.kind === "group")!;
    expect(group.orchestratorIds).toEqual([test.id, server]);
    const messages = await test.owner.query(api.aiOrchestrators.messages, { chatId: group.id });
    expect(messages.messages.map((message) => message.text)).toEqual([
      "Please prepare the API contract for the app.",
    ]);
    const next = (await test.claim())!;
    expect(next.name).toBe("Server");
    expect(next.context).not.toContain("Call me Corey.");
    expect(
      JSON.parse(next.context).projects.every(
        (project: { id: string }) => project.id === "project",
      ),
    ).toBe(true);
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: next.id,
        generation: next.generation,
        result: { ...decision(), actions: [{ ...delegate(), projectId: "foreign-project" }] },
      }),
    ).rejects.toThrow("authorized project");
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect())).toHaveLength(0);
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: next.id,
      generation: next.generation,
      result: { ...decision(), message: "The API contract is ready." },
    });
    const followup = (await test.claim())!;
    expect(JSON.parse(followup.context).actionResults).toContain(group.id);
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: followup.id,
      generation: followup.generation,
      result: { ...decision(), message: "The project group is ready." },
    });

    const lead = (await test.claim())!;
    expect(lead.name).toBe("Chief");
    expect(JSON.parse(lead.context).chat.id).toBe(group.id);
    expect(lead.context).toContain("The API contract is ready.");
  });

  it("publishes a bounded notification for a committed reply and excludes it from later invitations", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    const reply = { ...decision(), attention: "urgent", message: "Review the deployment blocker." };
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: reply,
    });
    const chat = (await test.owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    expect(chat.notification).toMatchObject({
      text: reply.message,
      urgent: true,
      enabled: true,
      sequence: chat.lastSequence,
    });
    await test.t.run(async (ctx) => {
      const row = await ctx.db.query("aiOrchestratorChats").first();
      await ctx.db.patch(row!._id, { companyIds: ["workspace"] });
    });
    await test.owner.mutation(api.aiOrchestrators.invite, {
      chatId: test.chatId,
      subject: "colleague",
      history: "from-now",
    });
    expect(
      (await human(test.t, "colleague").query(api.aiOrchestrators.listChats, {}))[0]?.notification,
    ).toBeUndefined();
  });

  it("collects one final result from the owning environment and rejects a stale run", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    await test.owner.mutation(api.aiOrchestrators.cancelMessage, {
      chatId: test.chatId,
      messageId: "greeting",
    });
    await test.t.run(async (ctx) => {
      const company = await ctx.db.query("companies").first();
      await ctx.db.insert("agentThreads", {
        id: "thread-index",
        companyId: company!._id,
        environmentId: "studio",
        cloudProjectId: null,
        localProjectId: "project",
        threadId: "worker",
        updatedAt: Date.now(),
        shell: {
          id: "worker",
          projectId: "project",
          title: "Read README",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "worker" },
          locations: [],
          forkedFrom: null,
          activeProviderThreadId: null,
          latestRunId: "run-done",
          activeRunId: null,
          status: "completed",
          pendingRuntimeRequest: null,
          latestVisibleMessage: null,
          latestUserMessageAt: null,
          hasActionableProposedPlan: false,
          itemCount: 2,
          visibleItemCount: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
          settledAt: null,
          createdBy: "agent",
          creationSource: "mcp",
        },
      });
      await ctx.db.insert("aiOrchestratorWork", {
        id: "result-work",
        chatId: test.chatId,
        orchestratorId: test.id,
        title: "Read README",
        companyId: "workspace",
        environmentId: "studio",
        projectId: "project",
        threadId: "worker",
        status: "completed",
        detail: "Completed",
        prompt: "Read README",
        completionNotified: false,
        resultRequired: true,
        resultCollected: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(await test.claim()).toBeNull();
    expect(
      await test
        .environment()
        .query(api.aiOrchestratorJobs.pendingWorkResults, { companyId: "workspace" }),
    ).toEqual([{ workId: "result-work", threadId: "worker" }]);
    const args = {
      companyId: "workspace",
      workId: "result-work",
      threadId: "worker",
      runId: "run-done",
      text: "The verification word is lighthouse.",
    };
    expect(
      await test.environment("laptop").mutation(api.aiOrchestratorJobs.collectWorkResult, args),
    ).toBe(false);
    expect(
      await test
        .environment()
        .mutation(api.aiOrchestratorJobs.collectWorkResult, { ...args, runId: "stale-run" }),
    ).toBe(false);
    expect(await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, args)).toBe(
      true,
    );
    expect(await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, args)).toBe(
      false,
    );
    expect((await test.claim())?.context).toContain("The verification word is lighthouse.");
  });
  it("retries a failed request once using current permissions and a new claim generation", async () => {
    const test = await coordinatorHarness();
    const first = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.failRun, {
      companyId: "workspace",
      jobId: first.id,
      generation: first.generation,
      error: "The model was unavailable",
      retryModel: false,
    });
    await test.owner.mutation(api.aiOrchestrators.retryMessage, {
      chatId: test.chatId,
      messageId: "greeting",
    });
    await expect(
      test.owner.mutation(api.aiOrchestrators.retryMessage, {
        chatId: test.chatId,
        messageId: "greeting",
      }),
    ).rejects.toThrow("Only a failed request");
    const retry = (await test.claim())!;
    expect(retry.generation).toBeGreaterThan(first.generation);
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: first.id,
        generation: first.generation,
        result: decision(),
      }),
    ).toBe(false);
  });
  it("fences an in-flight answer when the audience changes and honors join-time history", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    const second = await test.owner.mutation(api.aiOrchestrators.create, {
      config: { ...config(), name: "Server" },
    });
    await test.owner.mutation(api.aiOrchestrators.invite, {
      chatId: test.chatId,
      orchestratorId: second,
      history: "from-now",
    });
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: decision(),
      }),
    ).toBe(false);
    await test.t.run(async (ctx) => {
      const job = await ctx.db.query("aiOrchestratorJobs").first();
      await ctx.db.patch(job!._id, { status: "cancelled" });
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "shared-now",
      text: "Coordinate from this point.",
      targetId: second,
    });
    const next = (await test.claim())!;
    expect(next.context).not.toContain("Call me Corey.");
    expect(next.context).toContain("Coordinate from this point.");
    await test.owner.mutation(api.aiOrchestrators.removeParticipant, {
      chatId: test.chatId,
      orchestratorId: second,
    });
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.renew, {
        companyId: "workspace",
        jobId: next.id,
        generation: next.generation,
      }),
    ).toBe(false);
  });
  it("allows a workspace member to join from now and removes their read access on leaving", async () => {
    const test = await coordinatorHarness();
    const chatId = await test.owner.mutation(api.aiOrchestrators.createChat, {
      title: "Work",
      orchestratorIds: [test.id],
      leadId: test.id,
      companyIds: ["workspace"],
    });
    // An existing personal DM is reused; associate this fixture with its workspace first.
    await test.t.run(async (ctx) => {
      const chat = await ctx.db.query("aiOrchestratorChats").first();
      await ctx.db.patch(chat!._id, { companyIds: ["workspace"] });
    });
    await test.owner.mutation(api.aiOrchestrators.invite, {
      chatId,
      subject: "colleague",
      history: "from-now",
    });
    const colleague = human(test.t, "colleague");
    expect(
      (await colleague.query(api.aiOrchestrators.messages, { chatId })).messages
        .map((m) => m.text)
        .join(" "),
    ).not.toContain("Call me Corey.");
    await colleague.mutation(api.aiOrchestrators.removeParticipant, {
      chatId,
      subject: "colleague",
    });
    await expect(colleague.query(api.aiOrchestrators.messages, { chatId })).rejects.toThrow(
      "access",
    );
  });
  it("keeps the current request intact when recent history exceeds the context budget", async () => {
    const test = await coordinatorHarness();
    const request = "Current instruction ".repeat(1500);
    await test.t.run(async (ctx) => {
      const greeting = await ctx.db.query("aiOrchestratorMessages").first();
      await ctx.db.patch(greeting!._id, { text: request });
      for (let i = 2; i < 45; i++)
        await ctx.db.insert("aiOrchestratorMessages", {
          id: `later-${i}`,
          chatId: test.chatId,
          sequence: i,
          senderKind: "user",
          senderId: "owner",
          senderName: "Owner",
          text: "Later queued context ".repeat(1200),
          status: "queued",
          replyToId: null,
          createdAt: Date.now() + i,
        });
    });
    const run = (await test.claim())!;
    const context = JSON.parse(run.context) as {
      respondingToMessageId: string;
      messages: Array<{ id: string; text: string }>;
    };
    expect(context.respondingToMessageId).toBe("greeting");
    expect(context.messages.find((m) => m.id === "greeting")?.text).toBe(request);
    expect(context.messages.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(48000);
  });
  it("does not bring private DM context or its sourced memories into a group", async () => {
    const test = await coordinatorHarness();
    const first = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: first.id,
      generation: first.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "remember",
            text: "Private preferred name",
            sourceMessageId: "greeting",
            sourceQuote: "Call me Corey.",
          },
        ],
      },
    });
    const second = await test.owner.mutation(api.aiOrchestrators.create, {
      config: { ...config(), name: "Server" },
    });
    const group = await test.owner.mutation(api.aiOrchestrators.createChat, {
      title: "Shared launch",
      orchestratorIds: [test.id, second],
      leadId: test.id,
      companyIds: [],
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: group,
      id: "group-request",
      text: "Coordinate the launch",
    });
    const run = (await test.claim())!;
    expect(run.context).not.toContain("Private preferred name");
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { ...decision(), actions: [{ kind: "readConversation", chatId: test.chatId }] },
      }),
    ).rejects.toThrow("Private conversation context");
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: group })).messages,
    ).toHaveLength(1);
  });
  it("shares explicitly personal preferences across the owner's private orchestrators", async () => {
    const test = await coordinatorHarness();
    await test.owner.mutation(api.aiOrchestrators.saveMemory, {
      orchestratorId: test.id,
      text: "Call me Captain",
      scope: "personal",
    });
    await test.owner.mutation(api.aiOrchestrators.cancelMessage, {
      chatId: test.chatId,
      messageId: "greeting",
    });
    const second = await test.owner.mutation(api.aiOrchestrators.create, {
      config: { ...config(), name: "Inbox" },
    });
    const chatId = await test.owner.mutation(api.aiOrchestrators.createChat, {
      title: "Inbox",
      orchestratorIds: [second],
      leadId: second,
      companyIds: [],
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId,
      id: "inbox-hello",
      text: "Hello",
    });
    expect((await test.claim())?.context).toContain("Call me Captain");
  });
  it("batches completed assignments into one durable proactive update without repeating it", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const first = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: first.id,
      generation: first.generation,
      result: decision(),
    });
    await test.t.run(async (ctx) => {
      for (const id of ["api", "ios"])
        await ctx.db.insert("aiOrchestratorWork", {
          id,
          chatId: test.chatId,
          orchestratorId: test.id,
          title: id,
          companyId: "workspace",
          environmentId: "studio",
          projectId: "project",
          threadId: `thread-${id}`,
          status: "completed",
          detail: "Completed by worker",
          prompt: "Implement",
          completionNotified: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
    });
    const update = (await test.claim())!;
    expect(update.context).toContain("api: completed");
    expect(update.context).toContain("ios: completed");
    expect(await test.claim()).toBeNull();
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: update.id,
      generation: update.generation,
      result: { ...decision(), message: "Both assignments finished." },
    });
    expect(await test.claim()).toBeNull();
    const messages = (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId }))
      .messages;
    expect(messages.filter((m) => m.senderKind === "system")).toHaveLength(1);
    expect(messages.at(-1)?.text).toBe("Both assignments finished.");
  });
  it("uses Astra high and persists exactly one reply under the current generation", async () => {
    const test = await coordinatorHarness();
    const run = await test.claim();
    expect(run?.selection).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(await test.claim()).toBeNull();
    const args = {
      companyId: "workspace",
      jobId: run!.id,
      generation: run!.generation,
      result: decision(),
    };
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, args)).toBe(true);
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, args)).toBe(false);
    const history = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
    expect(history.messages.map((m) => m.text)).toEqual([
      "Call me Corey. Keep updates concise.",
      "Hi Corey!",
    ]);
  });
  it("does not let another company environment read a private assistant", async () => {
    const test = await coordinatorHarness();
    expect(
      await test.environment("other").mutation(api.aiOrchestratorJobs.claim, {
        companyId: "workspace",
        providers: [{ instanceId: "codex", driver: "codex" }],
      }),
    ).toBeNull();
    await expect(
      test.owner.mutation(api.aiOrchestratorJobs.claim, { companyId: "workspace", providers: [] }),
    ).rejects.toThrow("authorized environment");
  });
  it("fences an expired host and a settings change before publishing", async () => {
    const test = await coordinatorHarness();
    const first = (await test.claim())!;
    await test.t.run(async (ctx) => {
      const row = await ctx.db.query("aiOrchestratorJobs").first();
      await ctx.db.patch(row!._id, { leaseExpiresAt: 0 });
    });
    const second = (await test.environment("laptop").mutation(api.aiOrchestratorJobs.claim, {
      companyId: "workspace",
      providers: [{ instanceId: "codex", driver: "codex" }],
    }))!;
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: first.id,
        generation: first.generation,
        result: decision(),
      }),
    ).toBe(false);
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: 1,
      config: { ...config(), persona: "Updated persona" },
    });
    expect(
      await test.environment("laptop").mutation(api.aiOrchestratorJobs.renew, {
        companyId: "workspace",
        jobId: second.id,
        generation: second.generation,
      }),
    ).toBe(false);
  });
  it("rejects direct shell actions atomically without posting a misleading reply", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { ...decision(), actions: [{ kind: "shell", command: "touch a-file" }] },
      }),
    ).rejects.toThrow();
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages,
    ).toHaveLength(1);
  });
  it("records sourced memory and excludes forgotten facts from old history", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "remember",
            text: "The user prefers Corey.",
            sourceMessageId: "greeting",
            sourceQuote: "Call me Corey.",
          },
        ],
      },
    });
    const memories = await test.owner.query(api.aiOrchestrators.memories, {
      orchestratorId: test.id,
    });
    expect(memories).toHaveLength(1);
    await test.owner.mutation(api.aiOrchestrators.forgetMemory, {
      orchestratorId: test.id,
      id: memories[0]!.id,
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "next",
      text: "Hello again.",
    });
    const next = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: next.id,
        generation: next.generation,
        result: {
          ...decision(),
          actions: [
            {
              kind: "remember",
              text: "The user prefers Corey.",
              sourceMessageId: "greeting",
              sourceQuote: "Call me Corey.",
            },
          ],
        },
      }),
    ).rejects.toThrow("old messages");
  });
});

async function seedCoordinatorProject(t: Harness) {
  await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").first())!;
    const now = Date.now();
    const project = await ctx.db.insert("cloudProjects", {
      id: "project",
      companyId: company._id,
      name: "Project",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("environmentBindings", {
      id: "binding",
      companyId: company._id,
      cloudProjectId: project,
      environmentId: "studio",
      localProjectId: "local-project",
      localWorkspaceRoot: "/isolated/project",
      status: "active",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}
const delegate = (title = "Assignment") => ({
  kind: "delegate" as const,
  title,
  companyId: "workspace",
  projectId: "project",
  environmentId: "studio",
  prompt: "Implement the requested change and report what was verified.",
  selection: null,
});

describe("coordinator delegation and stopping", () => {
  it("keeps descendants of a finished root stopped after the contact resumes", async () => {
    const test = await businessHarness();
    await test.t.run(async (ctx) => {
      const work = await ctx.db.query("aiOrchestratorWork").first();
      await ctx.db.patch(work!._id, { status: "completed" });
    });
    const access = { ...test.delegatedOrigin, localProjectId: null };
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, access)).allowed,
    ).toBe(true);
    await test.owner.mutation(api.aiOrchestrators.setStatus, {
      id: test.id,
      status: "paused",
      stopWork: true,
    });
    await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "active" });
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, access)).allowed,
    ).toBe(false);
    await expect(
      test.environment().query(api.providerAllowanceBudgets.forScopes, {
        companyId: "workspace",
        scopes: [],
        origin: test.delegatedOrigin,
      }),
    ).rejects.toThrow("stopped");
  });
  it("delegates PA work without a project and keeps its authority tied to that conversation", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [{ ...delegate("Review priorities"), projectId: null }] },
    });
    const [command] = await test
      .environment()
      .mutation(api.environmentCommands.claim, { companyId: "workspace" });
    expect(command!.cloudProjectId).toBeNull();
    const input = {
      companyId: "workspace",
      orchestratorId: test.id,
      commandId: command!.id,
      localProjectId: null,
    };
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, input)).allowed,
    ).toBe(true);
    expect(
      (
        await test.environment().query(api.aiOrchestratorJobs.workerAccess, {
          ...input,
          localProjectId: "unrelated-project",
        })
      ).allowed,
    ).toBe(false);
    const work = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ title: "Review priorities", projectId: null });
    await test.owner.mutation(api.aiOrchestrators.setStatus, {
      id: test.id,
      status: "paused",
      stopWork: true,
    });
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, input)).allowed,
    ).toBe(false);
  });
  it("does not let a project coordinator escape its project with a PA assignment", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    await test.t.run(async (ctx) => {
      const orchestrator = await ctx.db.query("aiOrchestrators").first();
      await ctx.db.patch(orchestrator!._id, {
        projectId: "project",
        companyId: "workspace",
        kind: "project",
      });
    });
    const run = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { ...decision(), actions: [{ ...delegate(), projectId: null }] },
      }),
    ).rejects.toThrow("own coordinator");
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect())).toHaveLength(0);
  });
  it("rechecks worker privileges and project bindings after a delegation has started", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [delegate()] },
    });
    const [command] = await test
      .environment()
      .mutation(api.environmentCommands.claim, { companyId: "workspace" });
    const input = {
      companyId: "workspace",
      orchestratorId: test.id,
      commandId: command!.id,
      localProjectId: "local-project",
    };
    expect(
      await test.environment().query(api.aiOrchestratorJobs.workerAccess, input),
    ).toMatchObject({
      allowed: true,
      capabilities: expect.arrayContaining(["tasks.manage", "mail.read"]),
    });
    expect(
      (
        await test.environment().query(api.aiOrchestratorJobs.workerAccess, {
          ...input,
          localProjectId: "another-project",
        })
      ).allowed,
    ).toBe(false);
    expect(
      (await test.environment("laptop").query(api.aiOrchestratorJobs.workerAccess, input)).allowed,
    ).toBe(false);
    await test.t.run(async (ctx) => {
      const orchestrator = await ctx.db.query("aiOrchestrators").first();
      await ctx.db.patch(orchestrator!._id, {
        capabilities: orchestrator!.capabilities.filter((c) => c !== "tasks.manage"),
      });
    });
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, input)).capabilities,
    ).not.toContain("tasks.manage");
    await test.owner.mutation(api.aiOrchestrators.setStatus, {
      id: test.id,
      status: "paused",
      stopWork: true,
    });
    expect(
      (await test.environment().query(api.aiOrchestratorJobs.workerAccess, input)).allowed,
    ).toBe(false);
  });
  it("does not expose older work or result text to a participant joining from now", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [delegate("Private earlier work")] },
    });
    await test.t.run(async (ctx) => {
      const chat = await ctx.db.query("aiOrchestratorChats").first();
      await ctx.db.patch(chat!._id, { companyIds: ["workspace"] });
      const work = await ctx.db.query("aiOrchestratorWork").first();
      await ctx.db.patch(work!._id, { resultText: "Private final answer" });
    });
    await test.owner.mutation(api.aiOrchestrators.invite, {
      chatId: test.chatId,
      subject: "colleague",
      history: "from-now",
    });
    expect(
      await human(test.t, "colleague").query(api.aiOrchestrators.work, { chatId: test.chatId }),
    ).toEqual([]);
    const own = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(own[0]?.title).toBe("Private earlier work");
    expect(own[0]).not.toHaveProperty("resultText");
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "next-request",
      text: "Continue from here",
    });
    const next = await test.claim();
    expect(next?.context).not.toContain("Private earlier work");
    expect(next?.context).not.toContain("Private final answer");
  });
  it("queues five assignments, dispatches four, and retains pending work across pause and resume", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: Array.from({ length: 5 }, (_, i) => delegate(`Assignment ${i + 1}`)),
      },
    });
    const rows = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.commandId)).toHaveLength(4);
    await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "paused" });
    expect(
      await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
    ).toEqual([]);
    expect(
      (await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).every(
        (row) => row.state === "pending",
      ),
    ).toBe(true);
    await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "active" });
    expect(
      await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
    ).toHaveLength(4);
  });
  it("rechecks revoked delegation privileges at the environment command boundary", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [delegate()] },
    });
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: 1,
      config: {
        ...config(),
        capabilities: config().capabilities.filter((cap) => cap !== "threads.delegate"),
      },
    });
    expect(
      await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
    ).toEqual([]);
    expect((await test.t.run((ctx) => ctx.db.query("environmentCommands").first()))?.state).toBe(
      "canceled",
    );
  });
  it("cancels work before acceptance and leaves accepted work visibly unconfirmed", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [delegate("Unstarted"), delegate("Accepted")] },
    });
    await test.t.run(async (ctx) => {
      const work = (await ctx.db.query("aiOrchestratorWork").collect()).find(
        (row) => row.title === "Accepted",
      )!;
      const commands = await ctx.db.query("environmentCommands").collect();
      const actual = commands.find((c) => c.id === work.commandId)!;
      await ctx.db.patch(actual._id, {
        state: "claimed",
        claimGeneration: 1,
        claimedByEnvironmentId: "studio",
        claimExpiresAt: Date.now() + 90000,
      });
      await ctx.db.patch(work._id, { threadId: "worker-thread", status: "working" });
    });
    await test.owner.mutation(api.aiOrchestrators.setStatus, {
      id: test.id,
      status: "paused",
      stopWork: true,
    });
    const work = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
    expect(work.find((row) => row.title === "Unstarted")?.status).toBe("cancelled");
    expect(work.find((row) => row.title === "Accepted")?.status).toBe("unknown");
    expect(
      (await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).filter(
        (row) => row.kind === "interrupt",
      ),
    ).toHaveLength(1);
  });
});

function allowanceSnapshot(usedPercent = 40, accountKey = "test-account") {
  const now = Date.now();
  return {
    instanceId: "codex",
    provider: "codex" as const,
    accountKey,
    status: "ok" as const,
    source: "provider",
    updatedAt: new Date(now).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    usageLines: [],
    limits: [
      {
        window: "Weekly",
        windowKey: "weekly" as const,
        usedPercent,
        fetchedAt: new Date(now).toISOString(),
        resetsAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  };
}
async function budgetHarness() {
  const test = await coordinatorHarness();
  const scopes = [{ kind: "chat" as const, chatId: test.chatId }];
  const allocation = (used = 40, account = "test-account") => {
    const snapshot = allowanceSnapshot(used, account);
    return { snapshot, windowKey: allowanceWindowKey(snapshot.limits[0]!), authorizedPercent: 10 };
  };
  const args = {
    companyId: "workspace",
    budgetId: "budget",
    title: "Tonight's assignment",
    scopes,
    allocations: [allocation()],
  };
  const budget = await test.owner.mutation(api.providerAllowanceBudgets.create, args);
  const observe = (used: number, environment = "studio", revision = 1, account = "test-account") =>
    test.environment(environment).mutation(api.providerAllowanceBudgets.observe, {
      companyId: "workspace",
      budgetId: "budget",
      revision,
      scopes,
      snapshot: allowanceSnapshot(used, account),
    });
  return { ...test, args, scopes, allocation, budget, observe };
}
describe("durable assignment allowance budgets", () => {
  it("resumes a scheduled allocation once from fresh readings, including a new quota window", async () => {
    const test = await budgetHarness();
    await test.owner.mutation(api.providerAllowanceBudgets.scheduleResume, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      at: Date.now() + 60000,
      timeZone: "Australia/Sydney",
      allocations: [test.allocation()],
    });
    expect((await test.observe(44, "studio", 2)).status).toBe("paused");
    await test.t.run(async (ctx) => {
      const budget = await ctx.db.query("providerAllowanceBudgets").first();
      await ctx.db.patch(budget!._id, {
        scheduledResume: { ...budget!.scheduledResume!, at: Date.now() - 1000 },
      });
    });
    const snapshot = allowanceSnapshot(3);
    snapshot.limits[0]!.resetsAt = "2100-01-01T00:00:00.000Z";
    const resumed = await test.environment().mutation(api.providerAllowanceBudgets.observe, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 2,
      scopes: test.scopes,
      snapshot,
    });
    expect(resumed).toMatchObject({
      status: "active",
      revision: 3,
      allocations: [{ baselineUsedPercent: 3, authorizedPercent: 10 }],
    });
    expect(resumed.scheduledResume).toBeUndefined();
    expect((await test.observe(5, "studio", 3)).allocations[0]!.baselineUsedPercent).toBe(3);
  });
  it("keeps work held after a missed schedule and allows the owner to cancel before it runs", async () => {
    const test = await budgetHarness();
    await test.owner.mutation(api.providerAllowanceBudgets.scheduleResume, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      at: Date.now() + 60000,
      timeZone: "UTC",
      allocations: [test.allocation()],
    });
    await test.t.run(async (ctx) => {
      const budget = await ctx.db.query("providerAllowanceBudgets").first();
      await ctx.db.patch(budget!._id, {
        scheduledResume: {
          ...budget!.scheduledResume!,
          at: Date.now() - 3600001,
          expiresAt: Date.now() - 1,
        },
      });
    });
    const held = await test.observe(44, "studio", 2);
    expect(held.status).toBe("paused");
    expect(held.scheduledResume).toBeUndefined();
    expect(held.detail).toContain("missed");
    await test.owner.mutation(api.providerAllowanceBudgets.scheduleResume, {
      companyId: "workspace",
      budgetId: "budget",
      revision: held.revision,
      at: Date.now() + 60000,
      timeZone: "UTC",
      allocations: [test.allocation()],
    });
    await test.owner.mutation(api.providerAllowanceBudgets.cancelScheduledResume, {
      companyId: "workspace",
      budgetId: "budget",
    });
    const [cancelled] = await test.owner.query(api.providerAllowanceBudgets.list, {
      companyId: "workspace",
    });
    expect(cancelled!.scheduledResume).toBeUndefined();
    expect(cancelled!.status).toBe("paused");
  });
  it("allocates a sourced chat allowance once from its current human instruction", async () => {
    const test = await coordinatorHarness();
    const text = "Use 10% of the usage allowance tonight for this work.";
    await test.t.run(async (ctx) => {
      const message = await ctx.db.query("aiOrchestratorMessages").first();
      await ctx.db.patch(message!._id, { text });
    });
    const run = (await test.claim())!;
    const snapshot = allowanceSnapshot(40);
    const action = {
      kind: "allocateAllowance",
      title: "Tonight",
      sourceQuote: text,
      authorizedPercent: 10,
      windowKey: allowanceWindowKey(snapshot.limits[0]!),
    };
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [action] },
      allowanceExecution: {
        provider: "codex",
        accountKey: "test-account",
        revisions: [],
        snapshot,
      },
    });
    const [budget] = await test.owner.query(api.providerAllowanceBudgets.list, {
      companyId: "workspace",
    });
    expect(budget).toMatchObject({
      sourceInstruction: { messageId: "greeting", quote: text },
      allocations: [{ baselineUsedPercent: 40, authorizedPercent: 10 }],
    });
    const continued = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: continued.id,
      generation: continued.generation,
      result: { ...decision(), actions: [action] },
      allowanceExecution: {
        provider: "codex",
        accountKey: "test-account",
        revisions: [{ id: budget!.id, revision: budget!.revision }],
        snapshot: allowanceSnapshot(45),
      },
    });
    const repeated = await test.owner.query(api.providerAllowanceBudgets.list, {
      companyId: "workspace",
    });
    expect(repeated).toHaveLength(1);
    expect(repeated[0]!.allocations[0]!.baselineUsedPercent).toBe(40);
  });
  it("rejects an allowance invented from an ordinary greeting", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    const snapshot = allowanceSnapshot();
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: {
          ...decision(),
          actions: [
            {
              kind: "allocateAllowance",
              title: "Invented",
              sourceQuote: "Use 10% of the allowance",
              authorizedPercent: 10,
              windowKey: allowanceWindowKey(snapshot.limits[0]!),
            },
          ],
        },
        allowanceExecution: {
          provider: "codex",
          accountKey: "test-account",
          revisions: [],
          snapshot,
        },
      }),
    ).rejects.toThrow("current user's instruction");
    expect(
      await test.owner.query(api.providerAllowanceBudgets.list, { companyId: "workspace" }),
    ).toHaveLength(0);
  });
  it("binds remote descendants to the same baseline before their cloud shell exists", async () => {
    const test = await budgetHarness();
    const target = {
      kind: "thread" as const,
      environmentId: "laptop",
      threadId: "new-remote-worker",
    };
    const inherit = { companyId: "workspace", scopes: test.scopes, target };
    await test.environment().mutation(api.providerAllowanceBudgets.inherit, inherit);
    await test.environment().mutation(api.providerAllowanceBudgets.inherit, inherit);
    const descendants = await test
      .environment("laptop")
      .query(api.providerAllowanceBudgets.forScopes, {
        companyId: "workspace",
        scopes: [target],
      });
    expect(descendants).toHaveLength(1);
    expect(descendants[0]?.allocations[0]?.baselineUsedPercent).toBe(40);
    expect(descendants[0]?.scopes).toEqual([...test.scopes, target]);
    await test.environment("laptop").mutation(api.providerAllowanceBudgets.observe, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      scopes: [target],
      snapshot: allowanceSnapshot(50),
    });
    expect((await test.observe(48)).allocations[0]?.observedUsedPercent).toBe(50);
    await expect(
      test.environment("other").mutation(api.providerAllowanceBudgets.inherit, {
        ...inherit,
        target: { ...target, threadId: "unauthorized" },
      }),
    ).rejects.toThrow("cannot access");
    await expect(
      test.environment().mutation(api.providerAllowanceBudgets.inherit, {
        ...inherit,
        target: { ...target, environmentId: "unregistered" },
      }),
    ).rejects.toThrow("Register");
  });
  it("holds a late coordinator decision atomically after the owner pauses its allowance", async () => {
    const test = await budgetHarness();
    const run = (await test.claim())!;
    await test.owner.mutation(api.providerAllowanceBudgets.pause, {
      companyId: "workspace",
      budgetId: "budget",
    });
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: decision(),
        allowanceExecution: {
          provider: "codex",
          accountKey: "test-account",
          revisions: [{ id: "budget", revision: 1 }],
        },
      }),
    ).toBe(false);
    const job = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").first());
    expect(job).toMatchObject({ status: "queued", attempts: 0, environmentId: null });
    expect(job?.notBefore).toBeGreaterThan(Date.now());
    expect(await test.claim()).toBeNull();
    const { messages } = await test.owner.query(api.aiOrchestrators.messages, {
      chatId: test.chatId,
    });
    expect(messages.some((message) => message.text === "Hi Corey!")).toBe(false);
    expect(messages.find((message) => message.id === "greeting")?.status).toBe("queued");
  });
  it("commits a decision only with a current authorized account and rejects changed creation retries", async () => {
    const test = await budgetHarness();
    const run = (await test.claim())!;
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: decision(),
        allowanceExecution: {
          provider: "codex",
          accountKey: "test-account",
          revisions: [{ id: "budget", revision: 1 }],
        },
      }),
    ).toBe(true);
    await expect(
      test.owner.mutation(api.providerAllowanceBudgets.create, {
        ...test.args,
        allocations: [{ ...test.allocation(), authorizedPercent: 20 }],
      }),
    ).rejects.toThrow("another allocation");
  });
  it("shares one baseline across eligible environments and retains observed overshoot", async () => {
    const test = await budgetHarness();
    await test.observe(46);
    const stopped = await test.observe(51, "laptop");
    expect(stopped.allocations[0]).toMatchObject({
      baselineUsedPercent: 40,
      observedUsedPercent: 51,
      state: "limit-reached",
    });
    expect(
      budgetAdmission(stopped, { provider: "codex", accountKey: "test-account" }, Date.now()),
    ).toMatchObject({ canStart: false, shouldInterrupt: true });
    const restored = await test.owner.query(api.providerAllowanceBudgets.list, {
      companyId: "workspace",
    });
    expect(restored[0]?.allocations).toEqual(stopped.allocations);
    expect(await test.owner.mutation(api.providerAllowanceBudgets.create, test.args)).toEqual(
      stopped,
    );
  });
  it("requires the human owner to renew authorization and fences old observations", async () => {
    const test = await budgetHarness();
    await test.observe(50);
    await test.owner.mutation(api.providerAllowanceBudgets.pause, {
      companyId: "workspace",
      budgetId: "budget",
    });
    const resume = {
      companyId: "workspace",
      budgetId: "budget",
      revision: 2,
      allocations: [test.allocation(55)],
    };
    await expect(
      test.environment().mutation(api.providerAllowanceBudgets.resume, resume),
    ).rejects.toThrow("Only the owner");
    await expect(
      human(test.t, "colleague").mutation(api.providerAllowanceBudgets.resume, resume),
    ).rejects.toThrow("Only the owner");
    await test.owner.mutation(api.providerAllowanceBudgets.resume, resume);
    const late = await test.observe(70, "studio", 1);
    expect(late).toMatchObject({ revision: 3, status: "active" });
    expect(late.allocations[0]).toMatchObject({ baselineUsedPercent: 55, observedUsedPercent: 55 });
    const history = await test.t.run((ctx) => ctx.db.query("providerAllowanceHistory").collect());
    expect(history[0]?.allocations[0]?.observedUsedPercent).toBe(50);
    await expect(test.owner.mutation(api.providerAllowanceBudgets.resume, resume)).rejects.toThrow(
      "changed",
    );
  });
  it("rejects private conversation access and account fallback without another allocation", async () => {
    const test = await budgetHarness();
    await expect(
      test.environment("other").query(api.providerAllowanceBudgets.forScopes, {
        companyId: "workspace",
        scopes: test.scopes,
      }),
    ).rejects.toThrow("cannot access");
    await expect(
      test.environment("other").mutation(api.providerAllowanceBudgets.observe, {
        companyId: "workspace",
        budgetId: "budget",
        revision: 1,
        scopes: test.scopes,
        snapshot: allowanceSnapshot(80),
      }),
    ).rejects.toThrow("cannot access");
    const unknown = await test.observe(5, "studio", 1, "another-account");
    expect(unknown.allocations[0]?.observedUsedPercent).toBe(40);
    expect(
      budgetAdmission(unknown, { provider: "codex", accountKey: "another-account" }, Date.now()),
    ).toMatchObject({ canStart: false, shouldInterrupt: true });
    const renewed = await test.owner.mutation(api.providerAllowanceBudgets.resume, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      allocations: [test.allocation(), test.allocation(5, "another-account")],
    });
    expect(renewed).toBeNull();
    const [budget] = await test.owner.query(api.providerAllowanceBudgets.list, {
      companyId: "workspace",
    });
    expect(
      budgetAdmission(budget!, { provider: "codex", accountKey: "another-account" }, Date.now())
        .canStart,
    ).toBe(true);
  });
  it("retains the guard on missing telemetry, near-limit consumption, and window reset", async () => {
    const test = await budgetHarness();
    const near = await test.observe(49);
    expect(
      budgetAdmission(near, { provider: "codex", accountKey: "test-account" }, Date.now()),
    ).toMatchObject({ canStart: false, shouldInterrupt: false });
    const missing = await test.environment().mutation(api.providerAllowanceBudgets.observe, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      scopes: test.scopes,
      snapshot: null,
    });
    expect(missing.allocations[0]).toMatchObject({ observedUsedPercent: 49, state: "unavailable" });
    const reset = allowanceSnapshot(0);
    reset.limits[0]!.resetsAt = "2099-02-01T00:00:00.000Z";
    const changed = await test.environment().mutation(api.providerAllowanceBudgets.observe, {
      companyId: "workspace",
      budgetId: "budget",
      revision: 1,
      scopes: test.scopes,
      snapshot: reset,
    });
    expect(changed.allocations[0]).toMatchObject({ observedUsedPercent: 49, state: "reset" });
    expect((await test.observe(49)).allocations[0]?.state).toBe("reset");
  });
});

async function businessHarness() {
  const test = await coordinatorHarness();
  const run = (await test.claim())!;
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: run.id,
    generation: run.generation,
    result: {
      ...decision(),
      actions: [{ ...delegate("Personal business work"), projectId: null }],
    },
  });
  const [command] = await test
    .environment()
    .mutation(api.environmentCommands.claim, { companyId: "workspace" });
  const delegatedOrigin = {
    companyId: "workspace",
    orchestratorId: test.id,
    commandId: command!.id,
  };
  await test.t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").first())!;
    const members = await ctx.db.query("memberships").collect();
    for (const subject of ["owner", "colleague"]) {
      const member = members.find((m) => m.id === `member-${subject}`)!;
      await ctx.db.insert("mailAccounts", {
        id: `mail-${subject}`,
        companyId: company._id,
        ownerMembershipId: member._id,
        ownerSubject: subject,
        email: `${subject}@example.test`,
        oauthClientId: "test-client",
        credentialSource: "byo",
        status: "active",
        lastClaimAt: 0,
        lastAuthCheckAt: Date.now(),
        nextSyncAt: 0,
        generation: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  const relay = test.t.withIdentity({
    issuer: "https://relay.example.test",
    subject: "pathway-relay",
    tokenKind: "relay-control-plane",
    tokenIdentifier: "relay|control",
  });
  return { ...test, delegatedOrigin, relay };
}

describe("delegated PA business tools", () => {
  it("reads only the PA owner's mail and rejects another environment or forged human origin", async () => {
    const test = await businessHarness();
    const args = { companyId: "workspace", delegatedOrigin: test.delegatedOrigin };
    expect((await test.environment().query(api.mail.listAccounts, args)).map((a) => a.id)).toEqual([
      "mail-owner",
    ]);
    await expect(
      test.environment().query(api.mail.listDrafts, { ...args, accountId: "mail-colleague" }),
    ).rejects.toThrow("another member");
    await expect(test.environment("laptop").query(api.mail.listAccounts, args)).rejects.toThrow(
      "PA assignment",
    );
    await expect(test.owner.query(api.mail.listAccounts, args)).rejects.toThrow("PA assignment");
    await expect(
      test.environment().query(api.mail.listAccounts, { companyId: "workspace" }),
    ).rejects.toThrow("owner");
  });
  it("queues an authorized draft and rechecks revoked sending privileges at delivery", async () => {
    const test = await businessHarness();
    const args = { companyId: "workspace", delegatedOrigin: test.delegatedOrigin };
    const draftId = await test.environment().mutation(api.mail.saveDraft, {
      ...args,
      accountId: "mail-owner",
      to: ["recipient@example.test"],
      subject: "Test draft",
      text: "No network delivery occurs in this fixture.",
    });
    await test.environment().mutation(api.mail.requestSend, { ...args, draftId });
    const contact = (await test.owner.query(api.aiOrchestrators.list, {}))[0]!;
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: contact.revision,
      config: { ...config(), capabilities: config().capabilities.filter((c) => c !== "mail.send") },
    });
    expect(
      await test.relay.mutation(api.mailRelay.claimOutbox, {
        accountId: "mail-owner",
        leaseToken: "test",
      }),
    ).toBeNull();
    const draft = (
      await test.owner.query(api.mail.listDrafts, {
        companyId: "workspace",
        accountId: "mail-owner",
      })
    )[0]!;
    expect(draft).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("permission"),
    });
    await expect(
      test.environment().mutation(api.mail.requestSend, { ...args, draftId }),
    ).rejects.toThrow("PA assignment");
    await test.owner.mutation(api.mail.requestSend, { companyId: "workspace", draftId });
    expect(
      await test.relay.mutation(api.mailRelay.claimOutbox, {
        accountId: "mail-owner",
        leaseToken: "human-send",
      }),
    ).toMatchObject({ id: draftId, status: "sending" });
  });
  it("blocks business access after stopping work or expanding its human audience", async () => {
    const test = await businessHarness();
    const args = { delegatedOrigin: test.delegatedOrigin };
    const chat = await test.t.run((ctx) =>
      ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique(),
    );
    await test.t.run((ctx) =>
      ctx.db.patch(chat!._id, { participantSubjects: ["owner", "colleague"] }),
    );
    await expect(test.environment().query(api.timeTracking.listMine, args)).rejects.toThrow(
      "PA assignment",
    );
    await test.t.run((ctx) => ctx.db.patch(chat!._id, { participantSubjects: ["owner"] }));
    expect(await test.environment().query(api.timeTracking.listMine, args)).toMatchObject({
      active: null,
    });
    await test.owner.mutation(api.aiOrchestrators.setStatus, {
      id: test.id,
      status: "paused",
      stopWork: true,
    });
    await expect(test.environment().query(api.timeTracking.listMine, args)).rejects.toThrow(
      "PA assignment",
    );
  });
  it("uses the owner's existing timer and preserves single-timer and idempotency behavior", async () => {
    const test = await businessHarness();
    const args = { delegatedOrigin: test.delegatedOrigin };
    const start = {
      ...args,
      id: "timer-test",
      description: "PA planning",
      projectKey: "",
      projectName: "",
    };
    const started = await test.environment().mutation(api.timeTracking.start, start);
    expect(await test.environment().mutation(api.timeTracking.start, start)).toEqual(started);
    expect((await test.owner.query(api.timeTracking.listMine, {})).active?.id).toBe("timer-test");
    expect(
      (await human(test.t, "colleague").query(api.timeTracking.listMine, {})).active,
    ).toBeNull();
    await expect(
      test.environment().mutation(api.timeTracking.start, { ...start, id: "another" }),
    ).rejects.toThrow("already running");
    await test.environment().mutation(api.timeTracking.stop, { ...args, id: "timer-test" });
    await test.environment().mutation(api.timeTracking.remove, { ...args, id: "timer-test" });
    expect((await test.owner.query(api.timeTracking.listMine, {})).entries).toEqual([]);
  });
});

describe("scheduled responsibility reviews", () => {
  it("requires a response to a direct human request", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { message: "", attention: "none", actions: [], summary: "No update" },
      }),
    ).rejects.toThrow("invalid");
  });
  it("queues a single review through the ordinary claim path and coalesces overlapping ticks", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: 1,
      config: { ...config(), reviewIntervalMinutes: 60 },
    });
    const contact = await test.t.run((ctx) =>
      ctx.db
        .query("aiOrchestrators")
        .withIndex("by_domain_id", (q) => q.eq("id", test.id))
        .unique(),
    );
    await test.t.run((ctx) => ctx.db.patch(contact!._id, { nextReviewAt: Date.now() - 1 }));
    await test.t.mutation(internal.aiOrchestratorReviews.wakeDue, {});
    await test.t.run((ctx) => ctx.db.patch(contact!._id, { nextReviewAt: Date.now() - 1 }));
    await test.t.mutation(internal.aiOrchestratorReviews.wakeDue, {});
    const reviews = await test.t.run(async (ctx) =>
      (await ctx.db.query("aiOrchestratorJobs").collect()).filter(
        (job) => job.responsibilityReview,
      ),
    );
    expect(reviews).toHaveLength(1);
    const review = (await test.claim())!;
    expect(review.id).toBe(reviews[0]!.id);
    expect(JSON.parse(review.context)).toMatchObject({
      responsibilities: config().responsibilities,
      workspaceActivity: { recentThreads: [], recentIssues: [] },
    });
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: review.id,
      generation: review.generation,
      result: { ...decision(), message: "", attention: "none" },
    });
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages.at(
        -1,
      )?.senderId,
    ).toBe("responsibility-review");
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorPush").collect())).toHaveLength(1);
  });
  it("cancels an unclaimed review when proactive work is disabled", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: 1,
      config: { ...config(), reviewIntervalMinutes: 15 },
    });
    const contact = await test.t.run((ctx) =>
      ctx.db
        .query("aiOrchestrators")
        .withIndex("by_domain_id", (q) => q.eq("id", test.id))
        .unique(),
    );
    await test.t.run((ctx) => ctx.db.patch(contact!._id, { nextReviewAt: Date.now() - 1 }));
    await test.t.mutation(internal.aiOrchestratorReviews.wakeDue, {});
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: 2,
      config: { ...config(), proactive: false, reviewIntervalMinutes: 15 },
    });
    expect(await test.claim()).toBeNull();
    const reviews = await test.t.run(async (ctx) =>
      (await ctx.db.query("aiOrchestratorJobs").collect()).filter(
        (job) => job.responsibilityReview,
      ),
    );
    expect(reviews[0]?.status).toBe("cancelled");
  });
});

describe("coordinator environment observations", () => {
  it("attributes fresh host resources to the authenticated environment and rejects stale or human reports", async () => {
    const test = await coordinatorHarness();
    const resources = {
      sampledAt: Date.now(),
      cpuUtilization: 0.25,
      cpuCount: 8,
      availableMemoryBytes: 8000000,
      totalMemoryBytes: 16000000,
    };
    await test
      .environment()
      .mutation(api.aiOrchestratorJobs.reportHostResources, { companyId: "workspace", resources });
    const run = (await test.claim())!;
    const environments = JSON.parse(run.context).environments;
    expect(environments.find((e: { id: string }) => e.id === "studio").resources).toEqual(
      resources,
    );
    expect(environments.find((e: { id: string }) => e.id === "laptop").resources).toBeNull();
    await expect(
      test.owner.mutation(api.aiOrchestratorJobs.reportHostResources, {
        companyId: "workspace",
        resources,
      }),
    ).rejects.toThrow("environment");
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.reportHostResources, {
        companyId: "workspace",
        resources: { ...resources, sampledAt: Date.now() - 91000 },
      }),
    ).rejects.toThrow("fresh");
  });
});

describe("coordinator work control", () => {
  it("redirects only unaccepted work and preserves the conversation assignment scope", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [{ ...delegate("Portable PA assignment"), projectId: null }],
      },
    });
    const original = (
      await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId })
    )[0]!;
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "redirect",
      text: "Move the unstarted assignment to my laptop.",
    });
    const redirect = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: redirect.id,
      generation: redirect.generation,
      result: {
        ...decision(),
        actions: [{ kind: "redirectWork", workId: original.id, environmentId: "laptop" }],
      },
    });
    const work = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(work.find((w) => w.id === original.id)?.status).toBe("cancelled");
    const replacement = work.find((w) => w.id !== original.id)!;
    expect(replacement).toMatchObject({
      environmentId: "laptop",
      projectId: null,
      status: "queued",
    });
    expect(
      await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
    ).toEqual([]);
    const accepted = await test
      .environment("laptop")
      .mutation(api.environmentCommands.claim, { companyId: "workspace" });
    expect(accepted).toHaveLength(1);
    const followup = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: followup.id,
        generation: followup.generation,
        result: {
          ...decision(),
          actions: [{ kind: "redirectWork", workId: replacement.id, environmentId: "studio" }],
        },
      }),
    ).rejects.toThrow("Accepted or uncertain");
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: followup.id,
      generation: followup.generation,
      result: { ...decision(), actions: [{ kind: "stopWork", workId: replacement.id }] },
    });
    expect(
      (await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId })).find(
        (w) => w.id === replacement.id,
      ),
    ).toMatchObject({ status: "unknown", detail: expect.stringContaining("confirm") });
  });
});

describe("ordinary thread completion signals", () => {
  it("ignores initial discovery, coalesces a real completion, and rechecks access before replying", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    const { rowId, projectId } = await test.t.run(async (ctx) => {
      const project = (await ctx.db.query("cloudProjects").first())!;
      const shell = {
        id: "ordinary",
        projectId: "local-project",
        title: "Build login",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "ordinary" },
        locations: [],
        forkedFrom: null,
        activeProviderThreadId: null,
        latestRunId: "run-completed",
        activeRunId: null,
        status: "completed",
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: null,
        hasActionableProposedPlan: false,
        itemCount: 2,
        visibleItemCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        createdBy: "user",
        creationSource: "web",
      };
      const rowId = await ctx.db.insert("agentThreads", {
        id: "ordinary-index",
        companyId: project.companyId,
        environmentId: "studio",
        cloudProjectId: project._id,
        localProjectId: "local-project",
        threadId: "ordinary",
        shell,
        updatedAt: Date.now(),
      });
      const row = (await ctx.db.get(rowId))!;
      await notifyOrchestratorThreadUpdate(ctx, row, undefined);
      expect(
        (await ctx.db.query("aiOrchestratorJobs").collect()).filter((job) => job.threadSignalId),
      ).toHaveLength(0);
      const previous = { ...shell, status: "running", activeRunId: "run-completed" };
      await notifyOrchestratorThreadUpdate(ctx, row, previous);
      await notifyOrchestratorThreadUpdate(ctx, row, previous);
      return { rowId, projectId: project._id };
    });
    expect(
      await test.t.run(
        async (ctx) =>
          (await ctx.db.query("aiOrchestratorJobs").collect()).filter((job) => job.threadSignalId)
            .length,
      ),
    ).toBe(1);
    const update = (await test.claim())!;
    expect(JSON.parse(update.context).threadUpdate).toMatchObject({
      title: "Build login",
      status: "completed",
      projectId: "project",
    });
    await test.t.run((ctx) => ctx.db.patch(projectId, { archivedAt: Date.now() }));
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: update.id,
        generation: update.generation,
        result: decision(),
      }),
    ).toBe(false);
    expect(await test.claim()).toBeNull();
    expect(await test.t.run((ctx) => ctx.db.get(rowId))).not.toBeNull();
  });
});

describe("project issue signals", () => {
  it("coalesces issue changes and withdraws context when that issue is removed", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    const contactId = await test.owner.mutation(api.aiOrchestrators.create, {
      config: {
        ...config(),
        kind: "project",
        companyId: "workspace",
        projectId: "project",
        name: "Project coordinator",
      },
    });
    const chatId = await test.owner.mutation(api.aiOrchestrators.createChat, {
      title: "Project coordinator",
      orchestratorIds: [contactId],
      leadId: contactId,
      companyIds: ["workspace"],
    });
    const issueRow = await test.t.run(async (ctx) => {
      const company = (await ctx.db.query("companies").first())!;
      const now = Date.now();
      const id = await ctx.db.insert("issues", {
        id: "new-issue",
        companyId: company._id,
        key: "WS-1",
        keyNumber: 1,
        title: "Draft launch plan",
        description: "Coordinate the launch tasks.",
        statusId: "todo",
        priority: "high",
        assignee: null,
        projectId: "project",
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "a",
        labelIds: [],
        dueDate: null,
        triage: false,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      });
      await notifyOrchestratorIssueChanges(ctx, company, ["new-issue", "new-issue"]);
      await notifyOrchestratorIssueChanges(ctx, company, ["new-issue"]);
      return id;
    });
    expect(
      await test.t.run(
        async (ctx) =>
          (await ctx.db.query("aiOrchestratorJobs").collect()).filter((job) => job.issueSignalId)
            .length,
      ),
    ).toBe(1);
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId })).messages.some((m) =>
        m.text.includes("Draft launch plan"),
      ),
    ).toBe(false);
    const run = (await test.claim())!;
    expect(JSON.parse(run.context).issueUpdate).toMatchObject({
      key: "WS-1",
      title: "Draft launch plan",
      projectId: "project",
    });
    await test.t.run((ctx) => ctx.db.patch(issueRow, { deletedAt: Date.now() }));
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: decision(),
      }),
    ).toBe(false);
  });
});

describe("environment presence signals", () => {
  it("wakes once when a host goes offline and queues recovery when it returns", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await test.t.run(async (ctx) => {
      const row = (await ctx.db.query("environmentRegistrations").collect()).find(
        (r) => r.environmentId === "studio",
      )!;
      await ctx.db.patch(row._id, { lastSeenAt: Date.now() - 91000 });
    });
    await test.t.mutation(internal.aiOrchestratorEvents.checkOffline, {});
    await test.t.mutation(internal.aiOrchestratorEvents.checkOffline, {});
    expect(
      await test.t.run(
        async (ctx) =>
          (await ctx.db.query("aiOrchestratorJobs").collect()).filter(
            (job) => job.environmentSignalId,
          ).length,
      ),
    ).toBe(1);
    const offline = (await test.environment("laptop").mutation(api.aiOrchestratorJobs.claim, {
      companyId: "workspace",
      providers: [{ instanceId: "codex", driver: "codex" }],
    }))!;
    expect(JSON.parse(offline.context).environmentUpdate).toMatchObject({
      environmentId: "studio",
      online: false,
    });
    await test.environment("laptop").mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: offline.id,
      generation: offline.generation,
      result: {
        ...decision(),
        message: "Studio is offline. Its accepted work may still be running.",
      },
    });
    const recovered = (await test.claim())!;
    expect(JSON.parse(recovered.context).environmentUpdate).toMatchObject({
      environmentId: "studio",
      online: true,
    });
  });
});

describe("shared sourced preferences", () => {
  it("shares a requested preference across private contacts and clears it when forgotten", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "global-preference",
      text: "Call me Captain across all my orchestrators.",
    });
    const preference = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: preference.id,
      generation: preference.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "remember",
            scope: "personal",
            text: "The owner prefers Captain.",
            sourceMessageId: "global-preference",
            sourceQuote: "Call me Captain across all my orchestrators.",
          },
        ],
      },
    });
    const otherId = await test.owner.mutation(api.aiOrchestrators.create, {
      config: { ...config(), kind: "custom", name: "Sidekick" },
    });
    const otherChat = await test.owner.mutation(api.aiOrchestrators.createChat, {
      title: "Sidekick",
      orchestratorIds: [otherId],
      leadId: otherId,
      companyIds: ["workspace"],
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: otherChat,
      id: "sidekick-greeting",
      text: "Hello, I used to prefer Captain.",
    });
    const hello = (await test.claim())!;
    expect(JSON.parse(hello.context).memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "The owner prefers Captain." })]),
    );
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: hello.id,
      generation: hello.generation,
      result: decision(),
    });
    const memory = (
      await test.owner.query(api.aiOrchestrators.memories, { orchestratorId: test.id })
    )[0]!;
    expect(
      await test.owner.query(api.aiOrchestrators.memories, { orchestratorId: otherId }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memory.id, scope: "personal" })]),
    );
    await test.owner.mutation(api.aiOrchestrators.forgetMemory, {
      orchestratorId: test.id,
      id: memory.id,
    });
    const tombstone = await test.t.run((ctx) =>
      ctx.db
        .query("aiOrchestratorMemory")
        .withIndex("by_domain_id", (q) => q.eq("id", memory.id))
        .unique(),
    );
    expect(tombstone).toMatchObject({ forgotten: true, text: "", source: "" });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: otherChat,
      id: "after-forget",
      text: "Hello again.",
    });
    const after = (await test.claim())!;
    expect(JSON.parse(after.context).memories).toEqual([]);
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: after.id,
        generation: after.generation,
        result: {
          ...decision(),
          actions: [
            {
              kind: "remember",
              text: "The owner prefers Captain.",
              sourceMessageId: "sidekick-greeting",
              sourceQuote: "prefer Captain",
            },
          ],
        },
      }),
    ).rejects.toThrow("old messages");
  });
});

describe("background orchestrator notifications", () => {
  it("leases coalesced updates and prevents an older receipt from removing the next update", async () => {
    const test = await businessHarness();
    const publish = async (id: string) =>
      test.t.run(async (ctx) => {
        const chat = (await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
          .unique())!;
        await appendChatMessage(
          ctx,
          chat,
          {
            id,
            senderKind: "orchestrator",
            senderId: test.id,
            senderName: "Chief",
            text: id,
            status: "sent",
            replyToId: null,
          },
          { urgent: true, enabled: true },
        );
      });
    await publish("First update");
    await publish("Latest update");
    await expect(test.owner.mutation(api.aiOrchestratorPush.claim, {})).rejects.toThrow();
    const [first] = await test.relay.mutation(api.aiOrchestratorPush.claim, {});
    expect(first).toMatchObject({ subject: "owner", text: "Latest update" });
    expect(await test.relay.mutation(api.aiOrchestratorPush.claim, {})).toEqual([]);
    await publish("Newer update");
    const acknowledge = {
      chatId: first!.chatId,
      subject: first!.subject,
      sequence: first!.sequence,
      generation: first!.generation,
    };
    await test.relay.mutation(api.aiOrchestratorPush.acknowledge, acknowledge);
    const [next] = await test.relay.mutation(api.aiOrchestratorPush.claim, {});
    expect(next).toMatchObject({ text: "Newer update" });
    const target = { chatId: next!.chatId, subject: next!.subject, sequence: next!.sequence };
    expect(await test.relay.query(api.aiOrchestratorPush.isCurrent, target)).toBe(true);
    await test.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "owner"))
        .unique())!;
      await ctx.db.patch(member._id, { readSequence: next!.sequence });
    });
    expect(await test.relay.query(api.aiOrchestratorPush.isCurrent, target)).toBe(false);
  });
  it("withdraws pending private push data after workspace membership is revoked", async () => {
    const test = await businessHarness();
    await test.t.run(async (ctx) => {
      const chat = (await ctx.db.query("aiOrchestratorChats").first())!;
      await ctx.db.patch(chat._id, { companyIds: ["workspace"] });
      const pending = (await ctx.db.query("aiOrchestratorPush").first())!;
      await ctx.db.patch(pending._id, { dueAt: 0 });
    });
    const [job] = await test.relay.mutation(api.aiOrchestratorPush.claim, {});
    expect(job?.subject).toBe("owner");
    await test.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("memberships")
        .withIndex("by_domain_id", (q) => q.eq("id", "member-owner"))
        .unique())!;
      await ctx.db.patch(member._id, { state: "locked" });
    });
    expect(
      await test.relay.query(api.aiOrchestratorPush.isCurrent, {
        chatId: job!.chatId,
        subject: job!.subject,
        sequence: job!.sequence,
      }),
    ).toBe(false);
  });
});
