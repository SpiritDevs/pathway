import { heartbeat as workerHeartbeat } from "../convex/aiOrchestratorJobs.ts";
import { pending as workerPending } from "../convex/workerWakeups.ts";
import {
  patchEnvironmentPresence,
  patchEnvironmentRuntime,
  readEnvironmentPresence,
} from "../convex/lib/environmentRuntime.ts";
import { notifyOrchestratorIssueChanges } from "../convex/lib/aiOrchestratorIssueSignals.ts";
// @effect-diagnostics globalDate:off -- Convex transaction time in fixtures.
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vite-plus/test";
import { defaultOrchestratorConfig } from "@spiritdevs/contracts/aiOrchestrator";
import { allowanceWindowKey, budgetAdmission } from "@spiritdevs/contracts/providerAllowanceBudget";
import { api, internal } from "../convex/_generated/api.js";
import { appendChatMessage, listChats } from "../convex/aiOrchestrators.ts";
import schema from "../convex/schema.ts";
import { environmentInbox } from "../convex/aiOrchestratorControls.ts";
import { functionHandler, measureDatabaseReads } from "./testDatabaseReads.ts";
import {
  notifyOrchestratorPriorityMail,
  notifyOrchestratorThreadUpdate,
} from "../convex/lib/aiOrchestratorSignals.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWKS_URL = "https://relay.example.test/.well-known/jwks.json";
const modules = {
  "../convex/workerWakeups.ts": () => import("../convex/workerWakeups.ts"),
  "../convex/aiOrchestratorControls.ts": () => import("../convex/aiOrchestratorControls.ts"),
  "../convex/aiOrchestratorAttachments.ts": () => import("../convex/aiOrchestratorAttachments.ts"),
  "../convex/http.ts": () => import("../convex/http.ts"),
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
  workerModels: [],
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
  it("exposes current readers with monotonic, history-scoped positions without unrelated user profiles", async () => {
    const t = harness();
    await seed(t);
    const { owner, id, chatId } = await personalChat(t);
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "first-read", text: "Hello" });
    await t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", chatId))
        .unique())!;
      await ctx.db.patch(chat._id, { kind: "group", participantSubjects: ["owner", "colleague"] });
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId,
        subject: "colleague",
        fromSequence: 2,
        readSequence: 1,
        updatedAt: Date.now(),
      });
    });
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "second-read", text: "Welcome" });
    const colleague = human(t, "colleague");
    await colleague.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 2 });
    await colleague.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 1 });
    const page = await owner.query(api.aiOrchestrators.messages, { chatId });
    expect(page.readers).toContainEqual({
      id: "colleague",
      kind: "user",
      name: "colleague",
      fromSequence: 2,
      readSequence: 2,
    });
    expect(page.readers.some((reader) => reader.id === "director")).toBe(false);
    expect(page.readers).toContainEqual({
      id,
      kind: "orchestrator",
      name: "Chief",
      fromSequence: 0,
    });
    expect(page.messages.every((message) => message.seenBy?.length === 0)).toBe(true);
    await expect(
      human(t, "director").query(api.aiOrchestrators.messages, { chatId }),
    ).rejects.toThrow();
    await owner.mutation(api.aiOrchestrators.removeParticipant, { chatId, subject: "colleague" });
    expect(
      (await owner.query(api.aiOrchestrators.messages, { chatId })).readers.some(
        (reader) => reader.id === "colleague",
      ),
    ).toBe(false);
  });
  it("counts only visible unread messages, respects joined history, and clears on read", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 105; i++) {
        const chat = (await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", chatId))
          .unique())!;
        await appendChatMessage(ctx, chat, {
          id: `unread-${i}`,
          senderKind: "orchestrator",
          senderId: chat.leadId,
          senderName: "Chief",
          text: `Reply ${i}`,
          status: "sent",
          replyToId: null,
        });
      }
    });
    expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]?.unreadCount).toBe(100);
    await t.run(async (ctx) => {
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_subject", (q) => q.eq("subject", "owner"))
        .first())!;
      await ctx.db.patch(member._id, { fromSequence: 104, readSequence: 0 });
    });
    const row = (await owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    expect(row.unreadCount).toBe(2);
    const page = await owner.query(api.aiOrchestrators.messages, { chatId });
    expect(row.lastMessageAt).toBe(page.messages.at(-1)?.createdAt);
    await owner.mutation(api.aiOrchestrators.markRead, { chatId, sequence: row.lastSequence });
    expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]?.unreadCount).toBe(0);
  });
  it("skips muted unread history without losing previews or unread messages after unmuting", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    const memberId = await t.run(async (ctx) => {
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", chatId).eq("subject", "owner"))
        .unique())!;
      await ctx.db.patch(member._id, { muted: true, markedUnread: true });
      const chat = (await ctx.db.query("aiOrchestratorChats").first())!;
      for (let sequence = 1; sequence <= 500; sequence++)
        await ctx.db.insert("aiOrchestratorMessages", {
          id: `muted-${sequence}`,
          chatId,
          sequence,
          senderKind: "orchestrator",
          senderId: chat.leadId,
          senderName: "Chief",
          text: "x".repeat(2000),
          status: "sent",
          replyToId: null,
          coordination: true,
          createdAt: sequence,
        });
      await ctx.db.patch(chat._id, { lastSequence: 500 });
      await appendChatMessage(
        ctx,
        { ...chat, lastSequence: 500 },
        {
          id: "needs-attention",
          senderKind: "orchestrator",
          senderId: chat.leadId,
          senderName: "Chief",
          text: "Please review",
          status: "sent",
          replyToId: null,
          coordination: false,
        },
        { enabled: true, urgent: true },
      );
      return member._id;
    });
    const measured = await owner.run(async (ctx) => {
      const meter = measureDatabaseReads(ctx.db);
      const rows = await functionHandler(listChats)({ ...ctx, db: meter.db }, {});
      return {
        rows,
        messageReads: meter.documents.get("aiOrchestratorMessages"),
        bytes: meter.bytes(),
      };
    });
    expect(measured.messageReads ?? 0).toBe(0);
    expect(measured.bytes).toBeLessThan(10_000);
    expect(measured.rows[0]).toMatchObject({
      lastMessage: "Please review",
      lastSequence: 501,
      unreadCount: 0,
      readSequence: 0,
    });
    expect(measured.rows[0]).not.toHaveProperty("notification");
    await t.run((ctx) => ctx.db.patch(memberId, { muted: false, markedUnread: false }));
    const unmuted = (await owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    expect(unmuted).toMatchObject({ unreadCount: 1, readSequence: 0, lastSequence: 501 });
    expect(unmuted.notification).toMatchObject({ enabled: true, urgent: true });
  });
  it("migrates unread attention in bounded batches and stops reading message bodies", async () => {
    vi.useFakeTimers();
    try {
      const t = harness();
      await seed(t);
      const { owner, chatId } = await personalChat(t);
      const memberId = await t.run(async (ctx) => {
        const chat = (await ctx.db.query("aiOrchestratorChats").first())!;
        const member = (await ctx.db.query("aiOrchestratorChatMembers").first())!;
        await ctx.db.patch(member._id, { attentionReady: undefined });
        await ctx.db.patch(chat._id, { lastVisibleSequence: undefined, lastSequence: 503 });
        for (let sequence = 1; sequence <= 503; sequence++)
          await ctx.db.insert("aiOrchestratorMessages", {
            id: `legacy-${sequence}`,
            chatId,
            sequence,
            senderKind: "orchestrator",
            senderId: chat.leadId,
            senderName: "Chief",
            text: "x".repeat(2000),
            status: "sent",
            replyToId: null,
            coordination: sequence <= 502,
            ...(sequence === 502 ? { mentions: [{ kind: "user" as const, id: "owner" }] } : {}),
            createdAt: sequence,
          });
        return member._id;
      });
      const before = (await owner.query(api.aiOrchestrators.listChats, {}))[0]!;
      expect(before.unreadCount).toBe(2);
      await t.mutation(internal.aiOrchestrators.backfillAttention, { memberId });
      expect(await t.run((ctx) => ctx.db.get(memberId))).toMatchObject({ attentionCursor: 50 });
      // New writes during the backfill must be counted once, even when a later batch reaches them.
      await t.run(async (ctx) => {
        const chat = (await ctx.db.query("aiOrchestratorChats").first())!;
        await appendChatMessage(ctx, chat, {
          id: "during-migration",
          senderKind: "orchestrator",
          senderId: chat.leadId,
          senderName: "Chief",
          text: "Review this",
          status: "sent",
          replyToId: null,
          coordination: false,
        });
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const measured = await owner.run(async (ctx) => {
        const meter = measureDatabaseReads(ctx.db);
        const rows = await functionHandler(listChats)({ ...ctx, db: meter.db }, {});
        return {
          row: rows[0],
          bodies: meter.documents.get("aiOrchestratorMessages") ?? 0,
          attention: meter.documents.get("aiOrchestratorAttention") ?? 0,
          bytes: meter.bytes(),
        };
      });
      expect(measured).toMatchObject({
        bodies: 0,
        attention: 3,
        row: { unreadCount: 3, lastMessage: "Review this", lastSequence: 504 },
      });
      expect(measured.bytes).toBeLessThan(10_000);
      await owner.mutation(api.aiOrchestrators.markRead, { chatId, sequence: 502 });
      expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]?.unreadCount).toBe(2);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  });
  it("shares conversation-list company checks only within the current request", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...chat } = (await ctx.db.query("aiOrchestratorChats").first())!;
      void _creationTime;
      await ctx.db.patch(_id, { companyIds: ["workspace"] });
      const {
        _id: memberId,
        _creationTime: memberCreatedAt,
        ...member
      } = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", chatId).eq("subject", "owner"))
        .unique())!;
      void memberId;
      void memberCreatedAt;
      for (let index = 1; index < 20; index++) {
        const id = `shared-workspace-${index}`;
        await ctx.db.insert("aiOrchestratorChats", { ...chat, id, companyIds: ["workspace"] });
        await ctx.db.insert("aiOrchestratorChatMembers", { ...member, chatId: id });
      }
    });
    const measured = await owner.run(async (ctx) => {
      const meter = measureDatabaseReads(ctx.db);
      const rows = await functionHandler(listChats)({ ...ctx, db: meter.db }, {});
      return {
        rows,
        companyReads: meter.documents.get("companies"),
        membershipReads: meter.documents.get("memberships"),
      };
    });
    expect(measured.rows).toHaveLength(20);
    expect(measured.companyReads).toBe(1);
    expect(measured.membershipReads).toBe(1);
    await t.run(async (ctx) => {
      const member = (await ctx.db
        .query("memberships")
        .withIndex("by_domain_id", (q) => q.eq("id", "member-owner"))
        .unique())!;
      await ctx.db.patch(member._id, { state: "left" });
    });
    expect(await owner.query(api.aiOrchestrators.listChats, {})).toEqual([]);
  });
  it("keeps internal wakes out of history, previews and unread counts without deleting them", async () => {
    const t = harness();
    await seed(t);
    const { owner, chatId } = await personalChat(t);
    await owner.mutation(api.aiOrchestrators.send, { chatId, id: "hello", text: "Hello Jarvis" });
    const before = (await owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    await t.run(async (ctx) => {
      for (let index = 0; index < 65; index++) {
        const chat = (await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", chatId))
          .unique())!;
        await appendChatMessage(ctx, chat, {
          id: `wake-${index}`,
          senderKind: "system",
          senderId: [
            "project-thread",
            "responsibility-review",
            "delegated-work",
            "private-inbox",
            "project-issue",
            "environment-presence",
          ][index % 6]!,
          senderName: "Pathway",
          text: "Internal review instructions",
          status: "queued",
          replyToId: null,
        });
      }
    });
    const page = await owner.query(api.aiOrchestrators.messages, { chatId });
    expect(page.messages.map((message) => message.id)).toEqual(["hello"]);
    expect(page.nextBefore).toBeNull();
    expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]).toMatchObject({
      lastMessage: "Hello Jarvis",
      lastSequence: before.lastSequence,
      readSequence: before.readSequence,
      unreadCount: 0,
      updatedAt: before.updatedAt,
    });
    expect(await t.run((ctx) => ctx.db.query("aiOrchestratorMessages").collect())).toHaveLength(66);
    // Existing previews may already contain an internal prompt; public reads recover the real message.
    await t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", chatId))
        .unique())!;
      await ctx.db.patch(chat._id, {
        lastMessage: "Internal review instructions",
        lastVisibleSequence: undefined,
        lastVisibleAt: undefined,
      });
    });
    expect((await owner.query(api.aiOrchestrators.listChats, {}))[0]?.lastMessage).toBe(
      "Hello Jarvis",
    );
    await t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", chatId))
        .unique())!;
      await appendChatMessage(ctx, chat, {
        id: "joined",
        senderKind: "system",
        senderId: "participants",
        senderName: "Pathway",
        text: "A participant joined.",
        status: "sent",
        replyToId: null,
      });
    });
    expect((await owner.query(api.aiOrchestrators.messages, { chatId })).messages.at(-1)?.id).toBe(
      "joined",
    );
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
  it("publishes activity only while claimed and preserves seen receipts after completion", async () => {
    const test = await coordinatorHarness();
    const page = async () => ({
      ...(await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })),
      activity: await test.owner.query(api.aiOrchestrators.activity, { chatId: test.chatId }),
    });
    const queued = await page();
    expect(queued.activity).toEqual([]);
    expect(queued.messages.find((message) => message.id === "greeting")?.seenAt).toBeUndefined();
    const run = (await test.claim())!;
    const working = await page();
    expect(working.activity).toEqual([{ id: test.id, expiresAt: expect.any(Number) }]);
    const seenAt = working.messages.find((message) => message.id === "greeting")?.seenAt;
    expect(seenAt).toEqual(expect.any(Number));
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: decision(),
    });
    const completed = await page();
    expect(completed.activity).toEqual([]);
    expect(completed.messages.find((message) => message.id === "greeting")).toMatchObject({
      status: "sent",
      seenAt,
      seenBy: [test.id],
    });
  });

  it("does not expose activity for messages outside a participant's shared history", async () => {
    const test = await coordinatorHarness();
    await test.t.run(async (ctx) => {
      const chat = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique();
      await ctx.db.patch(chat!._id, { companyIds: ["workspace"] });
    });
    await test.claim();
    await test.owner.mutation(api.aiOrchestrators.invite, {
      chatId: test.chatId,
      subject: "colleague",
      history: "from-now",
    });
    const page = await human(test.t, "colleague").query(api.aiOrchestrators.messages, {
      chatId: test.chatId,
    });
    expect(
      await human(test.t, "colleague").query(api.aiOrchestrators.activity, { chatId: test.chatId }),
    ).toEqual([]);
    expect(page.messages.some((message) => message.id === "greeting")).toBe(false);
  });
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

    expect(await test.claim()).toBeNull();
    // A specialist can explicitly request a lead decision without echoing every answer.
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: group.id,
      id: "lead-decision",
      text: "Chief, consolidate the API decision.",
      targetId: test.id,
    });
    const lead = (await test.claim())!;
    expect(lead.name).toBe("Chief");
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

  it.each(["legacy", "observed", "non-proactive"] as const)(
    "returns delayed findings for %s assignments, bound to the completed run",
    async (mode) => {
      const test = await coordinatorHarness();
      await seedCoordinatorProject(test.t);
      if (mode === "non-proactive")
        await test.owner.mutation(api.aiOrchestrators.configure, {
          id: test.id,
          revision: 1,
          config: { ...config(), proactive: false },
        });
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
          status: mode === "observed" ? "working" : "completed",
          detail: "Completed",
          prompt: "Read README",
          completionNotified: false,
          resultRequired: true,
          resultCollected: false,
          createdAt: Date.now(),
          updatedAt: Date.now() - 300_000,
        });
      });
      expect(await test.claim()).toBeNull();
      expect(
        await test
          .environment()
          .query(api.aiOrchestratorJobs.pendingWorkResults, { companyId: "workspace" }),
      ).toEqual([
        {
          workId: "result-work",
          threadId: "worker",
          ...(mode === "observed" ? { runId: "run-done" } : {}),
        },
      ]);
      if (mode === "observed") {
        await test.t.run(async (ctx) => {
          const thread = (await ctx.db.query("agentThreads").first())!;
          const shell: unknown = thread.shell;
          if (typeof shell !== "object" || shell === null) throw new Error("Missing shell");
          await ctx.db.patch(thread._id, {
            shell: {
              ...shell,
              latestRunId: "later-run",
              activeRunId: "later-run",
              status: "running",
            },
          });
        });
      }
      await test.owner.mutation(api.aiOrchestrators.send, {
        chatId: test.chatId,
        id: "inspect-worker",
        text: "Read the delegated conversation",
      });
      const inspect = (await test.claim())!;
      const readDecision = {
        companyId: "workspace",
        jobId: inspect.id,
        generation: inspect.generation,
        result: { ...decision(), actions: [{ kind: "readWork", workId: "result-work" }] },
      };
      await test.t.run(async (ctx) => {
        const row = await ctx.db.query("aiOrchestratorWork").first();
        await ctx.db.patch(row!._id, { chatId: "another-conversation" });
      });
      await expect(
        test.environment().mutation(api.aiOrchestratorJobs.complete, readDecision),
      ).rejects.toThrow("Only this conversation");
      await test.t.run(async (ctx) => {
        const row = await ctx.db.query("aiOrchestratorWork").first();
        await ctx.db.patch(row!._id, { chatId: test.chatId });
      });
      await test.environment().mutation(api.aiOrchestratorJobs.complete, readDecision);
      const requested = (
        await test.environment().query(api.aiOrchestratorJobs.pendingWorkResults, {
          companyId: "workspace",
        })
      ).find((item) => item.readRequestId);
      expect(requested?.readRequestId).toEqual(expect.any(String));
      const excerpt = {
        ...requested!,
        companyId: "workspace",
        runId: "run-done",
        text: "assistant: The verified findings are available directly from the worker.",
      };
      expect(
        await test
          .environment("laptop")
          .mutation(api.aiOrchestratorJobs.collectWorkResult, excerpt),
      ).toBe(false);
      expect(
        await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, {
          ...excerpt,
          readRequestId: "stale",
        }),
      ).toBe(false);
      expect(
        await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, excerpt),
      ).toBe(true);
      expect(
        await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, excerpt),
      ).toBe(false);
      const readReply = (await test.claim())!;
      expect(JSON.parse(readReply.context).actionResults).toContain(
        "The verified findings are available directly from the worker.",
      );
      expect(JSON.parse(readReply.context).work[0].conversation).toContain(
        "The verified findings are available directly from the worker.",
      );
      expect(readReply.context).toContain(
        "The verified findings are available directly from the worker.",
      );
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: readReply.id,
        generation: readReply.generation,
        result: decision(),
      });
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
      expect(
        await test
          .environment()
          .mutation(api.aiOrchestratorJobs.collectWorkResult, { ...args, text: "   " }),
      ).toBe(false);
      expect(
        await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, args),
      ).toBe(true);
      expect(
        await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, args),
      ).toBe(false);
      expect((await test.claim())?.context).toContain("The verification word is lighthouse.");
    },
  );
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
    const failedPage = await test.owner.query(api.aiOrchestrators.messages, {
      chatId: test.chatId,
    });
    expect(await test.owner.query(api.aiOrchestrators.activity, { chatId: test.chatId })).toEqual(
      [],
    );
    const seenAt = failedPage.messages.find((message) => message.id === "greeting")?.seenAt;
    expect(seenAt).toEqual(expect.any(Number));
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
    const retriedPage = await test.owner.query(api.aiOrchestrators.messages, {
      chatId: test.chatId,
    });
    expect(retriedPage.messages.find((message) => message.id === "greeting")?.seenAt).toBe(seenAt);

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
          resultCollected: true,
          resultText: `Findings from ${id}`,
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
    expect(messages.filter((m) => m.senderKind === "system")).toHaveLength(0);
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
    expect(work[0]).toMatchObject({
      title: "Review priorities",
      projectId: null,
      createdAt: expect.any(Number),
    });
    const createdAt = work[0]!.createdAt;
    await test.t.run(async (ctx) => {
      const row = await ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_domain_id", (q) => q.eq("id", work[0]!.id))
        .unique();
      await ctx.db.patch(row!._id, { status: "completed", updatedAt: createdAt + 1000 });
    });
    expect(
      (await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId }))[0]?.createdAt,
    ).toBe(createdAt);
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
    ).toBe(test.id);
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
      await patchEnvironmentPresence(ctx, row, { lastSeenAt: Date.now() - 91000 });
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

  it("leaves presence to the coordinator heartbeat when a claim opts out", async () => {
    const test = await coordinatorHarness();
    const stale = Date.now() - 60_000;
    const presence = () =>
      test.t.run(async (ctx) => {
        const row = (await ctx.db.query("environmentRegistrations").collect()).find(
          (r) => r.environmentId === "studio",
        )!;
        return (await readEnvironmentPresence(ctx, row)).lastSeenAt;
      });
    await test.t.run(async (ctx) => {
      const row = (await ctx.db.query("environmentRegistrations").collect()).find(
        (r) => r.environmentId === "studio",
      )!;
      await patchEnvironmentPresence(ctx, row, { lastSeenAt: stale });
    });

    await test.environment("studio").mutation(api.aiOrchestratorJobs.claim, {
      companyId: "workspace",
      providers: [],
      refreshPresence: false,
    });
    expect(await presence()).toBe(stale);

    await test.environment("studio").mutation(api.aiOrchestratorJobs.heartbeat, {
      companyId: "workspace",
    });
    expect(await presence()).toBeGreaterThan(stale);
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

describe("shared orchestrator avatars", () => {
  it("shares manager-controlled identity and preserves it when an older client saves", async () => {
    const t = harness();
    await seed(t);
    const shared = {
      ...config(),
      kind: "custom" as const,
      companyId: "workspace",
      shared: true,
      managerSubjects: ["director"],
    };
    const id = await human(t).mutation(api.aiOrchestrators.create, { config: shared });
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .filter((q) => q.eq(q.field("id"), "member-director"))
        .unique();
      await ctx.db.insert("companyOwners", {
        companyId: member!.companyId,
        membershipId: member!._id,
        grantedByMembershipId: null,
        createdAt: Date.now(),
      });
    });
    const avatar = { shape: "cloud", eyes: "soft" };
    const personality = {
      shared: { warmth: 70, playfulness: 40, energy: 20, curiosity: 85, expressiveness: 60 },
      avatar: { energy: 10 },
    };
    await human(t, "director").mutation(api.aiOrchestrators.configure, {
      id,
      revision: 1,
      config: { ...shared, avatar, personality },
    });
    const colleague = human(t, "colleague");
    expect(
      (await colleague.query(api.aiOrchestrators.list, { companyId: "workspace" }))[0],
    ).toMatchObject({ avatar, personality, canManage: false });
    await expect(
      colleague.mutation(api.aiOrchestrators.configure, {
        id,
        revision: 2,
        config: { ...shared, color: "pink" },
      }),
    ).rejects.toThrow("management permission");
    const { avatar: _avatar, personality: _personality, ...legacy } = shared;
    await human(t).mutation(api.aiOrchestrators.configure, {
      id,
      revision: 2,
      config: { ...legacy, name: "Renamed" },
    });
    expect(
      (await colleague.query(api.aiOrchestrators.list, { companyId: "workspace" }))[0],
    ).toMatchObject({ name: "Renamed", avatar, personality });
  });
  it("rejects malformed appearance and out-of-range personality without modifying identity", async () => {
    const t = harness();
    await seed(t);
    const { owner, id } = await personalChat(t);
    for (const invalid of [
      { avatar: { shape: "bad", eyes: "oval" } },
      {
        personality: {
          shared: { warmth: 200, playfulness: 50, energy: 50, curiosity: 50, expressiveness: 50 },
        },
      },
    ]) {
      await expect(
        owner.mutation(api.aiOrchestrators.configure, {
          id,
          revision: 1,
          config: { ...config(), ...invalid },
        }),
      ).rejects.toThrow();
    }
    expect((await owner.query(api.aiOrchestrators.list, {}))[0]?.revision).toBe(1);
  });
  it("projects only the owner's personal identity and hides archived or deleted identities", async () => {
    const t = harness();
    await seed(t);
    const { owner, id } = await personalChat(t);
    const avatar = await owner.query(api.aiOrchestrators.personalAvatar, {});
    expect(avatar).toMatchObject({ id, name: "Chief", color: "violet" });
    expect(avatar).not.toHaveProperty("instructions");
    expect(avatar).not.toHaveProperty("persona");
    expect(await human(t, "colleague").query(api.aiOrchestrators.personalAvatar, {})).toBeNull();
    await owner.mutation(api.aiOrchestrators.setStatus, { id, status: "archived" });
    expect(await owner.query(api.aiOrchestrators.personalAvatar, {})).toBeNull();
  });
  it("shares only visual identity with conversation participants outside the contact directory", async () => {
    const t = harness();
    await seed(t);
    const owner = human(t);
    const id = await owner.mutation(api.aiOrchestrators.ensurePersonal, {});
    const chatId = await owner.mutation(api.aiOrchestrators.createChat, {
      title: "Team",
      orchestratorIds: [id],
      leadId: id,
      companyIds: ["workspace"],
    });
    const colleague = human(t, "colleague");
    expect(await colleague.query(api.aiOrchestrators.conversationAvatars, {})).toEqual([]);
    await owner.mutation(api.aiOrchestrators.invite, {
      chatId,
      subject: "colleague",
      history: "all",
    });
    expect(await colleague.query(api.aiOrchestrators.list, {})).toEqual([]);
    const avatars = await colleague.query(api.aiOrchestrators.conversationAvatars, {});
    expect(avatars).toHaveLength(1);
    expect(avatars[0]).toMatchObject({
      id,
      avatar: config().avatar,
      personality: config().personality,
    });
    expect(avatars[0]).not.toHaveProperty("instructions");
    expect(avatars[0]).not.toHaveProperty("persona");
    expect(await human(t, "director").query(api.aiOrchestrators.conversationAvatars, {})).toEqual(
      [],
    );
  });
  it("reports personal-avatar activity from leases and clears it on completion", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    const running = await test.owner.query(api.aiOrchestrators.personalAvatar, {});
    expect(running?.activityExpiresAt).toBeGreaterThan(Date.now());
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: decision(),
    });
    expect(
      (await test.owner.query(api.aiOrchestrators.personalAvatar, {}))?.activityExpiresAt,
    ).toBe(0);
  });
  it.each(["curious", "unsupported", undefined])(
    "persists response expression %s without changing work status",
    async (expression) => {
      const test = await coordinatorHarness();
      const run = (await test.claim())!;
      expect(run.personality).toEqual(config().personality);
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: { ...decision(), ...(expression === undefined ? {} : { expression }) },
      });
      const messages = await test.owner.query(api.aiOrchestrators.messages, {
        chatId: test.chatId,
      });
      expect(
        messages.messages.find((message) => message.senderKind === "orchestrator"),
      ).toMatchObject({
        expression: expression === "curious" ? "curious" : "neutral",
        status: "sent",
        text: decision().message,
      });
      expect(await test.owner.query(api.aiOrchestrators.activity, { chatId: test.chatId })).toEqual(
        [],
      );
    },
  );
});

async function seedInspectionThread(t: Harness) {
  await seedCoordinatorProject(t);
  return t.run(async (ctx) => {
    const project = (await ctx.db.query("cloudProjects").first())!;
    const shell = {
      id: "existing-thread",
      projectId: "local-project",
      title: "Existing PR work",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: "existing-thread",
      },
      locations: [],
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: "old-run",
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
      id: "existing-index",
      companyId: project.companyId,
      environmentId: "studio",
      cloudProjectId: project._id,
      localProjectId: "local-project",
      threadId: "existing-thread",
      shell,
      updatedAt: Date.now(),
    });
    return { rowId, shell };
  });
}

async function projectContact(test: Awaited<ReturnType<typeof coordinatorHarness>>, name: string) {
  const id = await test.owner.mutation(api.aiOrchestrators.create, {
    config: { ...config(), name, kind: "project", companyId: "workspace", projectId: "project" },
  });
  const chatId = await test.owner.mutation(api.aiOrchestrators.createChat, {
    title: name,
    orchestratorIds: [id],
    leadId: id,
    companyIds: ["workspace"],
  });
  return { id, chatId };
}

const inspectAction = {
  kind: "inspect",
  companyId: "workspace",
  environmentId: "studio",
  projectId: "project",
  request: { kind: "readFile", path: "README.md" },
};

describe("coordinator direct inspection and continuity", () => {
  it("reads in the owning environment and resumes the same request without a worker", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), message: "", actions: [inspectAction] },
    });
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect())).toHaveLength(0);
    expect(await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).toHaveLength(
      0,
    );
    expect(await test.claim()).toBeNull();
    expect(
      await test
        .environment("laptop")
        .query(api.aiOrchestratorJobs.pendingInspections, { companyId: "workspace" }),
    ).toEqual([]);
    const [read] = await test
      .environment()
      .query(api.aiOrchestratorJobs.pendingInspections, { companyId: "workspace" });
    expect(read).toMatchObject({ localProjectId: "local-project", request: inspectAction.request });
    expect(
      await test.environment("laptop").mutation(api.aiOrchestratorJobs.collectInspection, {
        companyId: "workspace",
        id: read!.id,
        text: "Wrong environment",
      }),
    ).toBe(false);
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.collectInspection, {
        companyId: "workspace",
        id: read!.id,
        text: "README.md: the service uses WebSockets.",
      }),
    ).toBe(true);
    const next = (await test.claim())!;
    expect(next.id).toBe(run.id);
    expect(next.context).toContain("the service uses WebSockets");
    expect(next.context).toContain("Call me Corey");
  });

  it("withdraws an inspection when access changes before delivery", async () => {
    const test = await coordinatorHarness();
    await seedCoordinatorProject(test.t);
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [inspectAction] },
    });
    const [read] = await test
      .environment()
      .query(api.aiOrchestratorJobs.pendingInspections, { companyId: "workspace" });
    await test.t.run(async (ctx) => {
      const project = (await ctx.db.query("cloudProjects").first())!;
      await ctx.db.patch(project._id, { archivedAt: Date.now() });
    });
    expect(
      await test
        .environment()
        .query(api.aiOrchestratorJobs.pendingInspections, { companyId: "workspace" }),
    ).toEqual([]);
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.collectInspection, {
        companyId: "workspace",
        id: read!.id,
        text: "Must not enter context",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("queues a PR follow-up in the original thread and waits for that message's result", async () => {
    const test = await coordinatorHarness();
    await seedInspectionThread(test.t);
    await test.t.run(async (ctx) => {
      const orchestrator = (await ctx.db.query("aiOrchestrators").first())!;
      await ctx.db.patch(orchestrator._id, {
        workerModels: [
          {
            id: "unavailable-preset",
            name: "Unavailable new-worker model",
            environmentId: "studio",
            guidance: "For new work",
            cost: "lower",
            selection: { instanceId: "codex", model: "unavailable" },
          },
        ],
      });
      const environment = (await ctx.db.query("environmentRegistrations").first())!;
      await ctx.db.patch(environment._id, {
        orchestratorDelegationCatalog: workerCatalog,
        orchestratorDelegationCatalogAt: Date.now(),
      });
    });
    const run = (await test.claim())!;
    const input = {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "continueThread",
            companyId: "workspace",
            environmentId: "studio",
            threadId: "existing-thread",
            title: "Push PR",
            prompt: "Push the PR for this work.",
          },
        ],
      },
    };
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, input)).toBe(true);
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, input)).toBe(false);
    const [command] = await test
      .environment()
      .mutation(api.environmentCommands.claim, { companyId: "workspace" });
    expect(command).toMatchObject({
      kind: "sendMessage",
      args: { kind: "sendMessage", threadId: "existing-thread" },
    });
    expect(JSON.stringify(command!.args)).toContain("orchestrator_handoff");
    expect(JSON.stringify(command!.args)).toContain("Verification");
    await test.environment().mutation(api.environmentCommands.reportStatus, {
      companyId: "workspace",
      commandId: command!.id,
      claimGeneration: command!.claimGeneration,
      state: "succeeded",
      result: { kind: "sendMessage", threadId: "existing-thread", turnId: null },
      error: null,
    });
    expect(await test.claim()).toBeNull();
    const [work] = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(work).toMatchObject({
      threadId: "existing-thread",
      status: "working",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      selectionReason: "Continuing with the existing thread's model.",
    });
    const [pending] = await test
      .environment()
      .query(api.aiOrchestratorJobs.pendingWorkResults, { companyId: "workspace" });
    expect(pending).toMatchObject({ workId: work!.id, messageId: `${command!.id}:message` });
    const result = {
      companyId: "workspace",
      workId: work!.id,
      threadId: "existing-thread",
      runId: "new-run",
      messageId: `${command!.id}:message`,
      status: "completed" as const,
      text: "Evidence. ".repeat(2000) + "PR pushed: https://example.test/pull/42",
    };
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, {
        ...result,
        messageId: "wrong-message",
      }),
    ).toBe(false);
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.collectWorkResult, result),
    ).toBe(true);
    const update = (await test.claim())!;
    expect(update.context).toContain("PR pushed: https://example.test/pull/42");
    expect(await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).toHaveLength(
      1,
    );
  });

  it("rejects an unavailable thread instead of creating a replacement", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await expect(
      test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: {
          ...decision(),
          actions: [
            {
              kind: "continueThread",
              companyId: "workspace",
              environmentId: "studio",
              threadId: "missing",
              title: "Follow-up",
              prompt: "Continue",
            },
          ],
        },
      }),
    ).rejects.toThrow("unavailable");
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect())).toHaveLength(0);
  });
});

describe("one responder for activity", () => {
  it("selects the project coordinator over Chief and deduplicates delivered events", async () => {
    const test = await coordinatorHarness();
    const { rowId, shell } = await seedInspectionThread(test.t);
    const project = await projectContact(test, "Project lead");
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    const notify = () =>
      test.t.run(async (ctx) => {
        const row = (await ctx.db.get(rowId))!;
        await notifyOrchestratorThreadUpdate(ctx, row, { ...shell, status: "running" });
      });
    await notify();
    await notify();
    const jobs = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(jobs.filter((job) => job.threadSignalId)).toHaveLength(1);
    expect(jobs.find((job) => job.threadSignalId)?.orchestratorId).toBe(project.id);
    const update = (await test.claim())!;
    expect(update.name).toBe("Project lead");
    expect(update.routing).toBeUndefined();
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: update.id,
      generation: update.generation,
      result: decision(),
    });
    await notify();
    expect(await test.claim()).toBeNull();
  });

  it("uses a lightweight election for overlapping roles and wakes only the winner", async () => {
    const test = await coordinatorHarness();
    const { rowId, shell } = await seedInspectionThread(test.t);
    const first = await projectContact(test, "First coordinator");
    const second = await projectContact(test, "Second coordinator");
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await test.t.run(async (ctx) => {
      const row = (await ctx.db.get(rowId))!;
      await notifyOrchestratorThreadUpdate(ctx, row, { ...shell, status: "running" });
    });
    const route = (await test.claim())!;
    expect(route.routing?.candidates.map((candidate) => candidate.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(route.selection.model).toBe("gpt-5.6-luna");
    const selected = route.routing!.candidates.find(
      (candidate) => candidate.id !== (route.name === "First coordinator" ? first.id : second.id),
    )!;
    const election = {
      companyId: "workspace",
      jobId: route.id,
      generation: route.generation,
      result: { message: "", attention: "none", actions: [], summary: "", routeTo: selected.id },
    };
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, election)).toBe(true);
    expect(await test.environment().mutation(api.aiOrchestratorJobs.complete, election)).toBe(
      false,
    );
    const winner = (await test.claim())!;
    expect(winner.name).toBe(selected.name);
    expect(winner.routing).toBeUndefined();
    expect(winner.selection.model).toBe("gpt-6-astra");
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: winner.id,
      generation: winner.generation,
      result: decision(),
    });
    expect(await test.claim()).toBeNull();
  });
});

it("retains a queued continuation while paused and rechecks project access before dispatch", async () => {
  const test = await coordinatorHarness();
  await seedInspectionThread(test.t);
  const run = (await test.claim())!;
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: run.id,
    generation: run.generation,
    result: {
      ...decision(),
      actions: [
        {
          kind: "continueThread",
          companyId: "workspace",
          environmentId: "studio",
          threadId: "existing-thread",
          title: "Follow-up",
          prompt: "Continue this work",
        },
      ],
    },
  });
  await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "paused" });
  expect(
    await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
  ).toHaveLength(0);
  expect((await test.t.run((ctx) => ctx.db.query("environmentCommands").first()))?.state).toBe(
    "pending",
  );
  await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "active" });
  await test.t.run(async (ctx) => {
    const project = (await ctx.db.query("cloudProjects").first())!;
    await ctx.db.patch(project._id, { archivedAt: Date.now() });
  });
  expect(
    await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
  ).toHaveLength(0);
});

it("resumes an unanswered inspection with an explicit unavailable result at its deadline", async () => {
  const test = await coordinatorHarness();
  await seedCoordinatorProject(test.t);
  const run = (await test.claim())!;
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: run.id,
    generation: run.generation,
    result: { ...decision(), actions: [inspectAction] },
  });
  await test.t.run(async (ctx) => {
    const read = (await ctx.db.query("aiOrchestratorInspections").first())!;
    const job = (await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_domain_id", (q) => q.eq("id", run.id))
      .unique())!;
    await ctx.db.patch(read._id, { createdAt: Date.now() - 200000 });
    await ctx.db.patch(job._id, { notBefore: 0 });
  });
  const resumed = (await test.claim())!;
  expect(resumed.id).toBe(run.id);
  expect(resumed.context).toContain("did not return this inspection in time");
  expect(
    await test
      .environment()
      .query(api.aiOrchestratorJobs.pendingInspections, { companyId: "workspace" }),
  ).toEqual([]);
});

const workerCatalog = {
  defaultSelection: { instanceId: "codex", model: "routine" },
  truncated: false,
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      name: "Work",
      available: true,
      models: ["routine", "complex"].map((id) => ({
        id,
        name: id,
        options: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      })),
    },
  ],
};

async function workerSelectionHarness(withLaptopPreset = false) {
  const test = await coordinatorHarness();
  const record = (await test.owner.query(api.aiOrchestrators.list, {}))[0]!;
  await test.owner.mutation(api.aiOrchestrators.configure, {
    id: test.id,
    revision: record.revision,
    config: {
      ...config(),
      workerModels: [
        {
          id: "routine-worker",
          name: "Routine",
          environmentId: "studio",
          guidance: "Focused edits and tests.",
          cost: "lower",
          selection: {
            instanceId: "codex",
            model: "routine",
            options: [{ id: "effort", value: "low" }],
          },
        },
        ...(withLaptopPreset
          ? [
              {
                id: "laptop-worker",
                name: "Laptop worker",
                environmentId: "laptop",
                guidance: "Routine laptop work",
                cost: "lower" as const,
                selection: { instanceId: "laptop-provider", model: "laptop-model" },
              },
            ]
          : []),
      ],
    },
  });
  const run = (await test.environment().mutation(api.aiOrchestratorJobs.claim, {
    companyId: "workspace",
    providers: [{ instanceId: "codex", driver: "codex" }],
    delegationCatalog: workerCatalog,
  }))!;
  const delegate = (
    selection: {
      instanceId: string;
      model: string;
      options?: { id: string; value: string }[];
    } | null,
  ) =>
    test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [
          {
            kind: "delegate",
            title: "Focused work",
            companyId: "workspace",
            projectId: null,
            environmentId: "studio",
            prompt: "Check the requested behavior.",
            selection,
            selectionReason: "Complex debugging needs stronger reasoning.",
          },
        ],
      },
    });
  return { ...test, run, delegate };
}

describe("task-aware worker selections", () => {
  it("provides the eligible environment's catalog and task presets in coordinator context", async () => {
    const test = await workerSelectionHarness();
    const context = JSON.parse(test.run.context);
    const studio = context.environments.find((item: { id: string }) => item.id === "studio");
    expect(studio.delegationCatalog).toEqual(workerCatalog);
    expect(studio.workerModels[0]).toMatchObject({ name: "Routine", cost: "lower" });
    expect(context.environments.some((item: { id: string }) => item.id === "other")).toBe(false);
  });
  it("resolves null to the environment's first configured worker preset with provenance", async () => {
    const test = await workerSelectionHarness();
    await test.delegate(null);
    const rows = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(rows[0]).toMatchObject({
      selection: { model: "routine", options: [{ id: "effort", value: "low" }] },
      selectionReason: "Default worker preset: Routine.",
    });
    const command = await test.t.run((ctx) => ctx.db.query("environmentCommands").first());
    expect(command?.args).toMatchObject({ modelSelection: { model: "routine" } });
  });
  it("preserves an explicit model and reasoning override over the preset", async () => {
    const test = await workerSelectionHarness();
    const requested = {
      instanceId: "codex",
      model: "complex",
      options: [{ id: "effort", value: "high" }],
    };
    await test.delegate(requested);
    const rows = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(rows[0]).toMatchObject({
      selection: requested,
      selectionReason: "Complex debugging needs stronger reasoning.",
    });
  });
  it.each([
    { instanceId: "missing", model: "routine" },
    { instanceId: "codex", model: "invented" },
    { instanceId: "codex", model: "routine", options: [{ id: "effort", value: "ultra" }] },
  ])(
    "shows unavailable or unsupported explicit selection %j without launching work",
    async (selection) => {
      const test = await workerSelectionHarness();
      await test.delegate(selection);
      const rows = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
      expect(rows[0]).toMatchObject({ status: "failed", selection });
      expect(rows[0]?.detail).toContain("No fallback");
      expect(await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).toEqual([]);
      const job = await test.t.run((ctx) =>
        ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_domain_id", (q) => q.eq("id", test.run.id))
          .unique(),
      );
      expect(job?.contextResults).toContain("No fallback");
    },
  );
  it.each([undefined, Date.now() - 120001])(
    "defers expired or undated catalog validation to the target (%s)",
    async (publishedAt) => {
      const test = await workerSelectionHarness();
      await test.t.run(async (ctx) => {
        const registration = (await ctx.db.query("environmentRegistrations").collect()).find(
          (row) => row.environmentId === "studio",
        )!;
        await patchEnvironmentRuntime(ctx, registration, {
          orchestratorDelegationCatalogAt: publishedAt,
        });
      });
      const requested = { instanceId: "codex", model: "newly-discovered" };
      await test.delegate(requested);
      const rows = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
      expect(rows[0]?.selection).toEqual(requested);
    },
  );
  it.each(["missing-provider", "missing-model"])(
    "defers %s in a truncated catalog",
    async (missing) => {
      const test = await workerSelectionHarness();
      await test.t.run(async (ctx) => {
        const registration = (await ctx.db.query("environmentRegistrations").collect()).find(
          (row) => row.environmentId === "studio",
        )!;
        await patchEnvironmentRuntime(ctx, registration, {
          orchestratorDelegationCatalog: { ...workerCatalog, truncated: true },
        });
      });
      const requested = {
        instanceId: missing === "missing-provider" ? "omitted" : "codex",
        model: "omitted",
      };
      await test.delegate(requested);
      expect(
        (await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId }))[0],
      ).toMatchObject({ status: "queued", selection: requested });
    },
  );
  it.each([
    [false, true],
    [false, false],
    [true, true],
  ])("redirect preserves explicit=%s with destination preset=%s", async (explicit, withPreset) => {
    const test = await workerSelectionHarness(withPreset);
    const requested = explicit ? { instanceId: "codex", model: "complex" } : null;
    await test.delegate(requested);
    const original = (
      await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId })
    )[0]!;
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "move-worker",
      text: "Move it to laptop",
    });
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: {
        ...decision(),
        actions: [{ kind: "redirectWork", workId: original.id, environmentId: "laptop" }],
      },
    });
    const work = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
    expect(work.find((row) => row.id !== original.id)).toMatchObject({
      environmentId: "laptop",
      selection:
        requested ?? (withPreset ? { instanceId: "laptop-provider", model: "laptop-model" } : null),
    });
  });
  it("keeps worker presets when an older client updates unrelated settings", async () => {
    const test = await workerSelectionHarness();
    const current = (await test.owner.query(api.aiOrchestrators.list, {}))[0]!;
    const { workerModels: _omitted, ...olderConfig } = config();
    await test.owner.mutation(api.aiOrchestrators.configure, {
      id: test.id,
      revision: current.revision,
      config: { ...olderConfig, name: "Renamed" },
    });
    const updated = (await test.owner.query(api.aiOrchestrators.list, {}))[0]!;
    expect(updated.workerModels?.[0]?.name).toBe("Routine");
    expect(updated.name).toBe("Renamed");
  });
});

describe("conversation attachments", () => {
  const metadata = (id = "attachment-file") => ({
    id,
    name: "notes.txt",
    type: "file" as const,
    mimeType: "text/plain",
    sizeBytes: 5,
  });
  async function upload(
    test: Awaited<ReturnType<typeof coordinatorHarness>>,
    id = "attachment-file",
  ) {
    const attachment = metadata(id);
    await test.owner.mutation(api.aiOrchestratorAttachments.prepare, {
      chatId: test.chatId,
      targetId: test.id,
      attachment,
    });
    const storageId = await test.t.run((ctx) =>
      ctx.storage.store(new Blob(["hello"], { type: "text/plain" })),
    );
    await test.owner.mutation(api.aiOrchestratorAttachments.finalize, {
      chatId: test.chatId,
      id,
      storageId,
    });
    return attachment;
  }
  it("binds ready files atomically, preserves metadata through history, and retries a send once", async () => {
    const test = await coordinatorHarness();
    const attachment = await upload(test);
    expect(
      await test.owner.mutation(api.aiOrchestratorAttachments.prepare, {
        chatId: test.chatId,
        targetId: test.id,
        attachment,
      }),
    ).toEqual({ ready: true, uploadUrl: null });
    const args = { chatId: test.chatId, id: "with-file", text: "", attachmentIds: [attachment.id] };
    const sequence = await test.owner.mutation(api.aiOrchestrators.send, args);
    expect(await test.owner.mutation(api.aiOrchestrators.send, args)).toBe(sequence);
    expect(
      (await test.owner.query(api.aiOrchestrators.listChats, {})).find(
        (chat) => chat.id === test.chatId,
      )?.lastMessage,
    ).toBe("notes.txt");
    expect(
      await test.t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("aiOrchestratorChats")
              .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
              .unique()
          )?.lastMessage,
      ),
    ).toBe("notes.txt");
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages.at(
        -1,
      )?.attachments,
    ).toEqual([attachment]);
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, { ...args, attachmentIds: [] }),
    ).rejects.toThrow();
    await test.owner.mutation(api.aiOrchestratorAttachments.discard, {
      chatId: test.chatId,
      id: attachment.id,
    });
    expect(
      await test.owner.query(internal.aiOrchestratorAttachments.read, { id: attachment.id }),
    ).toMatchObject({ attachment });
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, { ...args, id: "reuse" }),
    ).rejects.toThrow("unavailable");
  });
  it("rejects unfinished, mismatched, duplicate, oversized and foreign attachments", async () => {
    const test = await coordinatorHarness();
    const args = { chatId: test.chatId, targetId: test.id, attachment: metadata() };
    await test.owner.mutation(api.aiOrchestratorAttachments.prepare, args);
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, {
        chatId: test.chatId,
        id: "unfinished",
        text: "Read",
        attachmentIds: [args.attachment.id],
      }),
    ).rejects.toThrow("unavailable");
    const storageId = await test.t.run((ctx) =>
      ctx.storage.store(new Blob(["wrong size"], { type: "text/plain" })),
    );
    await expect(
      test.owner.mutation(api.aiOrchestratorAttachments.finalize, {
        chatId: test.chatId,
        id: args.attachment.id,
        storageId,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      test.owner.mutation(api.aiOrchestratorAttachments.prepare, {
        ...args,
        attachment: { ...metadata("huge"), sizeBytes: 51 * 1024 * 1024 },
      }),
    ).rejects.toThrow();
    await upload(test, "ready");
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, {
        chatId: test.chatId,
        id: "duplicate",
        text: "Read",
        attachmentIds: ["ready", "ready"],
      }),
    ).rejects.toThrow();
    await expect(
      human(test.t, "colleague").query(internal.aiOrchestratorAttachments.read, { id: "ready" }),
    ).rejects.toThrow();
    await expect(
      human(test.t, "colleague").mutation(api.aiOrchestratorAttachments.finalize, {
        chatId: test.chatId,
        id: "ready",
        storageId,
      }),
    ).rejects.toThrow();
  });
  it("checks live history boundaries and revocation for humans", async () => {
    const test = await coordinatorHarness();
    await upload(test);
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "with-file",
      text: "Read",
      attachmentIds: ["attachment-file"],
    });
    await test.t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      await ctx.db.patch(chat._id, { participantSubjects: ["owner", "colleague"] });
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId: test.chatId,
        subject: "colleague",
        fromSequence: 3,
        readSequence: 3,
        updatedAt: Date.now(),
      });
    });
    const colleague = human(test.t, "colleague");
    await expect(
      colleague.query(internal.aiOrchestratorAttachments.read, { id: "attachment-file" }),
    ).rejects.toThrow();
    await test.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "colleague"))
        .unique())!;
      await ctx.db.patch(member._id, { fromSequence: 0 });
    });
    expect(
      await colleague.query(internal.aiOrchestratorAttachments.read, { id: "attachment-file" }),
    ).toMatchObject({ attachment: metadata() });
    await test.owner.mutation(api.aiOrchestrators.removeParticipant, {
      chatId: test.chatId,
      subject: "colleague",
    });
    await expect(
      colleague.query(internal.aiOrchestratorAttachments.read, { id: "attachment-file" }),
    ).rejects.toThrow();
  });
  it("checks current runtime lease, assigned host, generation and conversation", async () => {
    const test = await coordinatorHarness();
    const greeting = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: greeting.id,
      generation: greeting.generation,
      result: decision(),
    });
    await upload(test);
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "with-file",
      text: "Read",
      attachmentIds: ["attachment-file"],
    });
    const job = (await test.claim())!;
    expect(job.attachments).toEqual([metadata()]);
    const args = {
      id: "attachment-file",
      companyId: "workspace",
      jobId: job.id,
      generation: job.generation,
    };
    expect(
      await test.environment().query(internal.aiOrchestratorAttachments.read, args),
    ).toMatchObject({ attachment: metadata() });
    const endpoint = `/orchestrator-attachments?id=attachment-file&companyId=workspace&jobId=${job.id}&generation=${job.generation}`;
    const runtimeDownload = await test.environment().fetch(endpoint);
    expect(runtimeDownload.status).toBe(200);
    expect(await runtimeDownload.text()).toBe("hello");
    expect((await test.environment("laptop").fetch(endpoint)).status).toBe(403);
    await expect(
      test.environment("laptop").query(internal.aiOrchestratorAttachments.read, args),
    ).rejects.toThrow();
    await expect(
      test.environment().query(internal.aiOrchestratorAttachments.read, {
        ...args,
        generation: job.generation + 1,
      }),
    ).rejects.toThrow();
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: job.id,
      generation: job.generation,
      result: decision(),
    });
    await expect(
      test.environment().query(internal.aiOrchestratorAttachments.read, args),
    ).rejects.toThrow();
  });
  it("retains recent attachments for follow-up reasoning without widening history", async () => {
    const test = await coordinatorHarness();
    const first = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: first.id,
      generation: first.generation,
      result: decision(),
    });
    await upload(test);
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "file-turn",
      text: "Read",
      attachmentIds: ["attachment-file"],
    });
    const attached = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: attached.id,
      generation: attached.generation,
      result: decision(),
    });
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "followup",
      text: "What did that file say?",
    });
    expect((await test.claim())?.attachments).toEqual([metadata()]);
  });
  it("expires abandoned uploads without deleting sent files", async () => {
    const test = await coordinatorHarness();
    await upload(test, "sent");
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "bound",
      text: "Read",
      attachmentIds: ["sent"],
    });
    await upload(test, "abandoned");
    await test.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("aiOrchestratorAttachments")
        .withIndex("by_domain_id", (q) => q.eq("id", "abandoned"))
        .unique())!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    await test.t.mutation(internal.aiOrchestratorAttachments.prune, {});
    await expect(
      test.owner.query(internal.aiOrchestratorAttachments.read, { id: "abandoned" }),
    ).rejects.toThrow();
    expect(
      await test.owner.query(internal.aiOrchestratorAttachments.read, { id: "sent" }),
    ).toMatchObject({ attachment: metadata("sent") });
  });
  it("discards a client-known unfinalized blob without touching bound or foreign storage", async () => {
    const test = await coordinatorHarness();
    await test.owner.mutation(api.aiOrchestratorAttachments.prepare, {
      chatId: test.chatId,
      targetId: test.id,
      attachment: metadata("pending"),
    });
    const storageId = await test.t.run((ctx) =>
      ctx.storage.store(new Blob(["hello"], { type: "text/plain" })),
    );
    await expect(
      human(test.t, "colleague").mutation(api.aiOrchestratorAttachments.discard, {
        chatId: test.chatId,
        id: "pending",
        storageId,
      }),
    ).rejects.toThrow();
    const threadStorage = await test.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["hello"], { type: "text/plain" }));
      const company = (await ctx.db.query("companies").first())!;
      const membership = (await ctx.db.query("memberships").first())!;
      await ctx.db.insert("threadQueueAttachments", {
        companyId: company._id,
        issuedByMembershipId: membership._id,
        storageId,
        attachment: metadata(),
        createdAt: Date.now(),
      });
      return storageId;
    });
    await expect(
      test.owner.mutation(api.aiOrchestratorAttachments.discard, {
        chatId: test.chatId,
        id: "pending",
        storageId: threadStorage,
      }),
    ).rejects.toThrow();
    await expect(
      test.owner.mutation(api.aiOrchestratorAttachments.finalize, {
        chatId: test.chatId,
        id: "pending",
        storageId: threadStorage,
      }),
    ).rejects.toThrow();
    expect(await test.t.run(async (ctx) => (await ctx.storage.get(threadStorage))?.size)).toBe(5);
    await upload(test, "bound");
    const bound = await test.owner.query(internal.aiOrchestratorAttachments.read, { id: "bound" });
    await expect(
      test.owner.mutation(api.aiOrchestratorAttachments.discard, {
        chatId: test.chatId,
        id: "pending",
        storageId: bound.storageId,
      }),
    ).rejects.toThrow();
    expect(await test.t.run(async (ctx) => (await ctx.storage.get(bound.storageId))?.size)).toBe(5);
    await test.owner.mutation(api.aiOrchestratorAttachments.discard, {
      chatId: test.chatId,
      id: "pending",
      storageId,
    });
    expect(await test.t.run(async (ctx) => (await ctx.storage.get(storageId)) === null)).toBe(true);
    expect(await test.t.run(async (ctx) => (await ctx.storage.get(bound.storageId))?.size)).toBe(5);
  });
  it("serves bounded prefixes only after the same download authorization", async () => {
    const test = await coordinatorHarness();
    await upload(test);
    const endpoint = "/orchestrator-attachments?id=attachment-file";
    const response = await test.owner.fetch(endpoint, { headers: { Range: "bytes=0-2" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-2/5");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(await response.text()).toBe("hel");
    expect((await test.t.fetch(endpoint, { headers: { Range: "bytes=0-2" } })).status).toBe(403);
    for (const range of ["bytes=2-4", "bytes=0-99", "bytes=0-2,3-4"])
      expect((await test.owner.fetch(endpoint, { headers: { Range: range } })).status).toBe(416);
  });
  it("serves real bytes through authenticated HTTP and refuses unauthenticated requests", async () => {
    const test = await coordinatorHarness();
    await upload(test);
    const response = await test.owner.fetch("/orchestrator-attachments?id=attachment-file");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await test.t.fetch("/orchestrator-attachments?id=attachment-file")).status).toBe(403);
    await test.owner.mutation(api.aiOrchestratorAttachments.discard, {
      chatId: test.chatId,
      id: "attachment-file",
    });
    expect((await test.owner.fetch("/orchestrator-attachments?id=attachment-file")).status).toBe(
      403,
    );
  });
});

async function workerControlHarness() {
  const test = await coordinatorHarness();
  await test.t.run(async (ctx) => {
    await ctx.db.insert("aiOrchestratorWork", {
      id: "controlled-work",
      chatId: test.chatId,
      orchestratorId: test.id,
      title: "Worker",
      environmentId: "studio",
      projectId: null,
      threadId: "worker-thread",
      commandId: "worker-start",
      companyId: "workspace",
      status: "working",
      detail: "Running",
      prompt: "Implement",
      sourceSequence: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  const send = (id: string, text = "Follow up") =>
    test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: { kind: "sendWork", workId: "controlled-work", id, text, mode: "queue" },
    });
  const read = () =>
    test.owner.query(api.aiOrchestratorControls.conversation, {
      chatId: test.chatId,
      workId: "controlled-work",
    });
  const accept = (id: string, revision = 0) =>
    test.environment().mutation(api.aiOrchestratorControls.accept, {
      companyId: "workspace",
      workId: "controlled-work",
      id,
      revision,
    });
  return { ...test, send, read, accept };
}
describe("private orchestrator worker conversations", () => {
  it("fences edits and reordered delivery, preserves idempotency, and freezes accepted content", async () => {
    const test = await workerControlHarness();
    await test.send("first");
    await test.send("second", "Second");
    await test.send("first");
    expect((await test.read()).messages).toHaveLength(2);
    await expect(test.send("first", "Changed")).rejects.toThrow("already used");
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: {
        kind: "editWorkMessage",
        workId: "controlled-work",
        id: "first",
        revision: 0,
        text: "Revised",
      },
    });
    expect(await test.accept("first")).toBeNull();
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: {
        kind: "reorderWorkMessages",
        workId: "controlled-work",
        queue: [
          { id: "second", revision: 0 },
          { id: "first", revision: 1 },
        ],
      },
    });
    expect(await test.accept("first", 2)).toBeNull();
    expect((await test.accept("second", 1))?.text).toBe("Second");
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.control, {
        chatId: test.chatId,
        action: { kind: "removeWorkMessage", workId: "controlled-work", id: "second", revision: 1 },
      }),
    ).rejects.toThrow("delivery already accepted");
    expect((await test.accept("second", 1))?.id).toBe("second");
    await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
      companyId: "workspace",
      workId: "controlled-work",
      id: "second",
      revision: 1,
      failed: false,
      detail: "Durable dispatch",
    });
    expect((await test.accept("first", 2))?.text).toBe("Revised");
    expect((await test.read()).messages.find((m) => m.id === "second")?.state).toBe("delivered");
  });
  it("removes only pending content and rejects stale queue snapshots", async () => {
    const test = await workerControlHarness();
    await test.send("first");
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: { kind: "removeWorkMessage", workId: "controlled-work", id: "first", revision: 0 },
    });
    expect(await test.accept("first")).toBeNull();
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.control, {
        chatId: test.chatId,
        action: {
          kind: "reorderWorkMessages",
          workId: "controlled-work",
          queue: [{ id: "first", revision: 0 }],
        },
      }),
    ).rejects.toThrow("queue changed");
    expect((await test.send("first")).state).toBe("removed");
  });
  it("routes descendant questions once, escalates, answers the original request and avoids wakeup loops", async () => {
    const test = await workerControlHarness();
    const report = {
      companyId: "workspace",
      workId: "controlled-work",
      threadId: "child-thread",
      requestId: "question-request",
      questions: [{ id: "choice", question: "Which format?" }],
      open: true,
    };
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, report);
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, report);
    const before = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(before.filter((j) => j.id.startsWith("worker-question:"))).toHaveLength(1);
    const question = (await test.read()).questions[0]!;
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: { kind: "escalateWorkQuestion", workId: "controlled-work", questionId: question.id },
    });
    expect((await test.read()).questions[0]?.state).toBe("escalated");
    const answer = {
      kind: "answerWorkQuestion",
      workId: "controlled-work",
      id: "answer",
      questionId: question.id,
      answers: { choice: "JSON" },
    };
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: answer,
    });
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: answer,
    });
    const accepted = await test.accept("answer");
    expect(accepted).toMatchObject({
      threadId: "child-thread",
      requestId: "question-request",
      answers: { choice: "JSON" },
    });
    await test
      .environment()
      .mutation(api.aiOrchestratorControls.reportQuestion, { ...report, open: false });
    expect((await test.read()).questions[0]?.state).toBe("resolved");
    const after = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(after.length).toBe(before.length);
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.control, {
        chatId: test.chatId,
        action: { ...answer, id: "new-answer" },
      }),
    ).rejects.toThrow("no longer open");
  });
  it("delivers answers ahead of follow-ups waiting for a blocked turn", async () => {
    const test = await workerControlHarness();
    await test.send("followup");
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
      companyId: "workspace",
      workId: "controlled-work",
      threadId: "worker-thread",
      requestId: "blocking",
      questions: [{ id: "format", question: "Which format?" }],
      open: true,
    });
    const question = (await test.read()).questions[0]!;
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: {
        kind: "answerWorkQuestion",
        workId: "controlled-work",
        id: "reply",
        questionId: question.id,
        answers: { format: "JSON" },
      },
    });
    expect(await test.accept("followup")).toBeNull();
    expect((await test.accept("reply"))?.requestId).toBe("blocking");
  });
  it("tracks the new follow-up run instead of recycling an older completed result", async () => {
    const test = await workerControlHarness();
    await test.send("followup");
    await test.accept("followup");
    await test.t.run(async (ctx) => {
      const work = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
      await ctx.db.patch(work._id, {
        status: "completed",
        resultRunId: "old-run",
        resultCollected: true,
        completionNotified: true,
        resultText: "Old result",
      });
    });
    await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
      companyId: "workspace",
      workId: "controlled-work",
      id: "followup",
      revision: 0,
      failed: false,
      detail: "Dispatched",
      runId: "new-run",
    });
    const work = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
    expect(work[1]).toMatchObject({
      status: "working",
      resultRunId: "new-run",
      resultCollected: false,
      completionNotified: false,
    });
    expect(work[0]?.resultText).toBe("Old result");
    expect(work[1]?.resultText).toBeUndefined();
  });
  it("rejects foreign environment, conversation audience, revoked capability and stopped authority", async () => {
    const test = await workerControlHarness();
    await test.send("first");
    await expect(
      test.environment("laptop").mutation(api.aiOrchestratorControls.accept, {
        companyId: "workspace",
        workId: "controlled-work",
        id: "first",
        revision: 0,
      }),
    ).rejects.toThrow("cannot access");
    await expect(
      human(test.t, "colleague").query(api.aiOrchestratorControls.conversation, {
        chatId: test.chatId,
        workId: "controlled-work",
      }),
    ).rejects.toThrow("access");
    await test.t.run(async (ctx) => {
      const row = (await ctx.db.query("aiOrchestrators").collect())[0]!;
      await ctx.db.patch(row._id, {
        capabilities: row.capabilities.filter((c) => c !== "threads.control"),
      });
    });
    expect(await test.accept("first")).toBeNull();
    await expect(test.send("second")).rejects.toThrow("not enabled");
    await test.t.run(async (ctx) => {
      const row = (await ctx.db.query("aiOrchestrators").collect())[0]!;
      await ctx.db.patch(row._id, { capabilities: config().capabilities });
      const work = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
      await ctx.db.patch(work._id, { stopRequested: true });
    });
    await expect(test.send("second")).rejects.toThrow("cannot renew");
    expect(await test.accept("first")).toBeNull();
  });
  it("keeps requested stop uncertain until a terminal worker observation", async () => {
    const test = await workerControlHarness();
    const result = await test.owner.mutation(api.aiOrchestratorControls.stop, {
      chatId: test.chatId,
      workId: "controlled-work",
    });
    expect(result.detail).toContain("Waiting");
    const work = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
    expect(work[0]).toMatchObject({ stopRequested: true, status: "unknown" });
    const commands = await test.t.run((ctx) => ctx.db.query("environmentCommands").collect());
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "interrupt" });
    await test.owner.mutation(api.aiOrchestratorControls.stop, {
      chatId: test.chatId,
      workId: "controlled-work",
    });
    expect(await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).toHaveLength(
      1,
    );
  });
  it("accepts coordinator follow-up actions and exposes their receipts in context without a reasoning loop", async () => {
    const test = await workerControlHarness();
    const run = (await test.claim())!;
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.complete, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
        result: {
          ...decision(),
          actions: [
            {
              kind: "sendWork",
              workId: "controlled-work",
              id: "coordinator-followup",
              text: "Check errors",
              mode: "queue",
            },
          ],
        },
      }),
    ).toBe(true);
    expect((await test.read()).messages[0]?.state).toBe("pending");
    const jobs = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(jobs.find((j) => j.id === run.id)?.status).toBe("completed");
  });
});

describe("conversation replies to delegated work", () => {
  it("sends through the existing composer without another orchestrator job or thread", async () => {
    const test = await workerControlHarness();
    const before = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    const args = {
      chatId: test.chatId,
      id: "human-followup",
      workId: "controlled-work",
      text: "Please include the screenshots.",
    };
    await test.owner.mutation(api.aiOrchestrators.send, args);
    await test.owner.mutation(api.aiOrchestrators.send, args);
    const messages = (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId }))
      .messages;
    expect(messages.filter((m) => m.id === args.id)).toHaveLength(1);
    expect(messages.find((m) => m.id === args.id)).toMatchObject({
      worker: { workId: "controlled-work" },
      delivery: { state: "pending" },
      text: args.text,
    });
    expect((await test.read()).messages[0]).toMatchObject({
      threadId: "worker-thread",
      text: args.text,
    });
    expect(await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect())).toHaveLength(
      before.length,
    );
    expect(await test.t.run((ctx) => ctx.db.query("environmentCommands").collect())).toHaveLength(
      0,
    );
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: {
        kind: "editWorkMessage",
        workId: "controlled-work",
        id: args.id,
        revision: 0,
        text: "Include images and video.",
      },
    });
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages.find(
        (m) => m.id === args.id,
      )?.text,
    ).toBe("Include images and video.");
  });
  it("escalates as normal messages and routes multipart quoted replies to one original request", async () => {
    const test = await workerControlHarness();
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
      companyId: "workspace",
      workId: "controlled-work",
      threadId: "worker-thread",
      requestId: "choose",
      open: true,
      questions: [
        { id: "format", question: "Which format?" },
        { id: "audience", question: "Who is this for?" },
      ],
    });
    const question = (await test.read()).questions[0]!;
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: { kind: "escalateWorkQuestion", workId: "controlled-work", questionId: question.id },
    });
    const page = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
    const fields = page.messages.filter((m) => m.worker?.questionId === question.id);
    expect(fields.map((m) => m.text)).toEqual(["Which format?", "Who is this for?"]);
    expect(new Set(fields.map((m) => m.sequence)).size).toBe(2);
    for (const [index, field] of fields.entries()) {
      await test.owner.mutation(api.aiOrchestrators.send, {
        chatId: test.chatId,
        id: `answer-${index}`,
        text: index === 0 ? "PDF" : "The board",
        replyToId: field.id,
      });
      if (index === 0) expect((await test.read()).messages).toHaveLength(0);
    }
    expect((await test.read()).messages[0]).toMatchObject({
      mode: "answer",
      threadId: "worker-thread",
      answers: { format: "PDF", audience: "The board" },
    });
    const latest = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
    expect(latest.messages.at(-1)?.reply).toMatchObject({ text: "Who is this for?" });
    const jobs = await test.t.run((ctx) => ctx.db.query("aiOrchestratorJobs").collect());
    expect(jobs.filter((j) => j.id.startsWith("worker-question:"))).toHaveLength(1);
    expect(jobs.filter((j) => j.messageId.startsWith("answer-"))).toHaveLength(0);
  });
  it("keeps secret answers out of the conversation mailbox", async () => {
    const test = await workerControlHarness();
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
      companyId: "workspace",
      workId: "controlled-work",
      threadId: "worker-thread",
      requestId: "secret",
      open: true,
      questions: [{ id: "password", question: "Password?", isSecret: true }],
    });
    const question = (await test.read()).questions[0]!;
    expect(question.questions[0]?.isSecret).toBe(true);
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.control, {
        chatId: test.chatId,
        action: {
          kind: "answerWorkQuestion",
          workId: "controlled-work",
          id: "answer",
          questionId: question.id,
          answers: { password: "not-for-chat" },
        },
      }),
    ).rejects.toThrow("private questions");
    expect((await test.read()).messages).toHaveLength(0);
  });
  it("rejects stale reorders even when the queue still contains the same IDs", async () => {
    const test = await workerControlHarness();
    await test.send("first");
    await test.send("second");
    const action = {
      kind: "reorderWorkMessages",
      workId: "controlled-work",
      queue: [
        { id: "second", revision: 0 },
        { id: "first", revision: 0 },
      ],
    };
    await test.owner.mutation(api.aiOrchestratorControls.control, { chatId: test.chatId, action });
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.control, { chatId: test.chatId, action }),
    ).rejects.toThrow("queue changed");
  });
  it("cancels pending visible messages when work stops", async () => {
    const test = await workerControlHarness();
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "pending-stop",
      workId: "controlled-work",
      text: "Next task",
    });
    await test.owner.mutation(api.aiOrchestratorControls.stop, {
      chatId: test.chatId,
      workId: "controlled-work",
    });
    expect((await test.read()).messages[0]?.state).toBe("removed");
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages.find(
        (m) => m.id === "pending-stop",
      )?.status,
    ).toBe("cancelled");
  });
  it("recovers accepted delivery after pausing without authorizing a new message", async () => {
    const test = await workerControlHarness();
    await test.send("accepted");
    await test.accept("accepted");
    await test.t.run(async (ctx) => {
      const contact = await ctx.db
        .query("aiOrchestrators")
        .withIndex("by_domain_id", (q) => q.eq("id", test.id))
        .unique();
      await ctx.db.patch(contact!._id, { status: "paused" });
    });
    expect((await test.accept("accepted"))?.state).toBe("accepted");
    const inbox = await test
      .environment()
      .query(api.aiOrchestratorControls.environmentInbox, { companyId: "workspace" });
    expect(inbox.find((i) => i.workId === "controlled-work")).toMatchObject({
      stopped: true,
      message: { id: "accepted" },
    });
    await expect(test.send("new")).rejects.toThrow("not enabled");
  });
});

it("pins the original uncollected run before dispatching and shares one report owner for steering", async () => {
  const test = await workerControlHarness();
  await test.send("steer");
  await test.environment().mutation(api.aiOrchestratorControls.accept, {
    companyId: "workspace",
    workId: "controlled-work",
    id: "steer",
    revision: 0,
    rootRunId: "original-run",
  });
  await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
    companyId: "workspace",
    workId: "controlled-work",
    id: "steer",
    revision: 0,
    failed: false,
    detail: "Steered",
    runId: "original-run",
    messageId: "steered-message",
  });
  let work = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
  expect(work).toHaveLength(1);
  expect(work[0]?.resultRunId).toBe("original-run");
  await test.send("followup");
  await test.accept("followup");
  await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
    companyId: "workspace",
    workId: "controlled-work",
    id: "followup",
    revision: 0,
    failed: false,
    detail: "Dispatched",
    runId: "next-run",
    messageId: "next-message",
  });
  work = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
  expect(work.map((w) => w.resultRunId)).toEqual(["original-run", "next-run"]);
  const pending = await test
    .environment()
    .query(api.aiOrchestratorJobs.pendingWorkResults, { companyId: "workspace" });
  expect(pending.map((item) => item.runId)).toEqual(
    expect.arrayContaining(["original-run", "next-run"]),
  );
  const visible = await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId });
  expect(visible).toHaveLength(1);
  expect(visible[0]?.id).toBe("controlled-work");
});

it("targets the real answer message when stopping a resumed child", async () => {
  const test = await workerControlHarness();
  await test.send("answer");
  await test.accept("answer");
  await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
    companyId: "workspace",
    workId: "controlled-work",
    id: "answer",
    revision: 0,
    failed: false,
    detail: "Resumed",
    runId: "resumed-run",
    messageId: "message:question-answer:request",
  });
  await test.owner.mutation(api.aiOrchestratorControls.stop, {
    chatId: test.chatId,
    workId: "controlled-work",
  });
  const commands = await test.t.run((ctx) => ctx.db.query("environmentCommands").collect());
  expect(
    commands.some(
      (command) =>
        command.args.kind === "interrupt" &&
        command.args.messageId === "message:question-answer:request",
    ),
  ).toBe(true);
});

describe("worker conversation review regressions", () => {
  it("keeps the newest open questions and the root mailbox after many follow-up results", async () => {
    const test = await workerControlHarness();
    await test.send("still-pending", "Include the final report");
    await test.t.run(async (ctx) => {
      const root = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
      const { _id, _creationTime, ...fields } = root;
      await ctx.db.patch(_id, { status: "completed" });
      for (let i = 0; i < 55; i++)
        await ctx.db.insert("aiOrchestratorWork", {
          ...fields,
          id: `result-${i}`,
          controlWorkId: root.id,
          controlMessageId: `message-${i}`,
          status: "completed",
        });
    });
    for (let i = 0; i < 12; i++)
      await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
        companyId: "workspace",
        workId: "controlled-work",
        threadId: `child-${i}`,
        requestId: `request-${i}`,
        open: true,
        questions: [{ id: "format", question: `Question ${i}` }],
      });
    const run = (await test.claim())!;
    const conversations = JSON.parse(run.context).workerConversations;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      workId: "controlled-work",
      messages: [expect.objectContaining({ id: "still-pending" })],
    });
    expect(conversations[0].questions).toHaveLength(10);
    expect(conversations[0].questions[0].requestId).toBe("request-11");
    expect(conversations[0].questions.at(-1).requestId).toBe("request-2");
  });

  it.each(["paused", "deleted"] as const)(
    "cancels terminal-root instructions when an orchestrator is %s with stop",
    async (status) => {
      const test = await workerControlHarness();
      await test.t.run(async (ctx) => {
        const root = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
        await ctx.db.patch(root._id, { status: "completed" });
      });
      await test.owner.mutation(api.aiOrchestrators.send, {
        chatId: test.chatId,
        id: "pending-on-root",
        workId: "controlled-work",
        text: "Next task",
      });
      await test.owner.mutation(api.aiOrchestrators.setStatus, {
        id: test.id,
        status,
        stopWork: true,
      });
      const rows = await test.t.run((ctx) =>
        ctx.db.query("aiOrchestratorWorkerMessages").collect(),
      );
      expect(rows[0]?.state).toBe("removed");
      if (status === "paused") {
        await test.owner.mutation(api.aiOrchestrators.setStatus, { id: test.id, status: "active" });
        expect(await test.accept("pending-on-root")).toBeNull();
        expect(
          (
            await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })
          ).messages.find((message) => message.id === "pending-on-root")?.status,
        ).toBe("cancelled");
      }
    },
  );

  it("keeps an older active follow-up visible when newer results are completed", async () => {
    const test = await workerControlHarness();
    const activeId = await test.t.run(async (ctx) => {
      const root = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
      const { _id, _creationTime, ...fields } = root;
      await ctx.db.patch(_id, { status: "completed" });
      const activeId = await ctx.db.insert("aiOrchestratorWork", {
        ...fields,
        id: "active-child",
        controlWorkId: root.id,
        controlMessageId: "active-message",
        status: "working",
        detail: "Older child still working",
      });
      for (let i = 0; i < 105; i++)
        await ctx.db.insert("aiOrchestratorWork", {
          ...fields,
          id: `completed-child-${i}`,
          controlWorkId: root.id,
          controlMessageId: `done-${i}`,
          status: "completed",
          detail: "Newer child finished",
        });
      return activeId;
    });
    expect(await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId })).toEqual([
      expect.objectContaining({
        id: "controlled-work",
        status: "working",
        detail: "Older child still working",
      }),
    ]);
    await test.owner.mutation(api.aiOrchestratorControls.stop, {
      chatId: test.chatId,
      workId: "controlled-work",
    });
    expect((await test.t.run((ctx) => ctx.db.get(activeId)))?.stopRequested).toBe(true);
    await test.t.run((ctx) => ctx.db.patch(activeId, { status: "completed" }));
    expect(
      (await test.owner.query(api.aiOrchestrators.work, { chatId: test.chatId }))[0]?.status,
    ).toBe("completed");
  });

  it("allows a new quoted answer after cancelling the pending answer", async () => {
    const test = await workerControlHarness();
    await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
      companyId: "workspace",
      workId: "controlled-work",
      threadId: "worker-thread",
      requestId: "question-retry",
      open: true,
      questions: [{ id: "format", question: "Which format?" }],
    });
    const question = (await test.read()).questions[0]!;
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: { kind: "escalateWorkQuestion", workId: "controlled-work", questionId: question.id },
    });
    const prompt = (
      await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })
    ).messages.find((message) => message.worker?.questionId === question.id)!;
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "first-answer",
      text: "PDF",
      replyToId: prompt.id,
    });
    await test.owner.mutation(api.aiOrchestratorControls.control, {
      chatId: test.chatId,
      action: {
        kind: "removeWorkMessage",
        workId: "controlled-work",
        id: "first-answer",
        revision: 0,
      },
    });
    expect((await test.read()).questions[0]?.state).toBe("escalated");
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "second-answer",
      text: "CSV",
      replyToId: prompt.id,
    });
    expect((await test.accept("second-answer"))?.answers).toEqual({ format: "CSV" });
  });

  it.each([false, true])(
    "rejects replies to private prompts without persisting the answer (legacy: %s)",
    async (legacy) => {
      const test = await workerControlHarness();
      await test.environment().mutation(api.aiOrchestratorControls.reportQuestion, {
        companyId: "workspace",
        workId: "controlled-work",
        threadId: "worker-thread",
        requestId: "private-question",
        open: true,
        questions: [{ id: "password", question: "Password?", isSecret: true }],
      });
      const question = (await test.read()).questions[0]!;
      await test.owner.mutation(api.aiOrchestratorControls.control, {
        chatId: test.chatId,
        action: {
          kind: "escalateWorkQuestion",
          workId: "controlled-work",
          questionId: question.id,
        },
      });
      const prompt = (
        await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })
      ).messages.find((message) => message.worker?.questionId === question.id)!;
      if (legacy)
        await test.t.run(async (ctx) => {
          const stored = await ctx.db
            .query("aiOrchestratorMessages")
            .withIndex("by_domain_id", (q) => q.eq("id", prompt.id))
            .unique();
          await ctx.db.patch(stored!._id, { worker: { workId: "controlled-work" } });
        });
      const page = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
      expect(page.messages.find((message) => message.id === prompt.id)?.worker?.isSecret).toBe(
        true,
      );
      await expect(
        test.owner.mutation(api.aiOrchestrators.send, {
          chatId: test.chatId,
          id: "private-answer",
          workId: "controlled-work",
          replyToId: prompt.id,
          text: "must-not-be-stored",
        }),
      ).rejects.toThrow();
      expect(
        await test.t.run((ctx) =>
          ctx.db
            .query("aiOrchestratorMessages")
            .withIndex("by_domain_id", (q) => q.eq("id", "private-answer"))
            .unique(),
        ),
      ).toBeNull();
      expect((await test.read()).messages).toHaveLength(0);
    },
  );

  it("routes replies to a user-authored worker message without permission to direct the group lead", async () => {
    const test = await workerControlHarness();
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "my-worker-message",
      workId: "controlled-work",
      text: "Check this",
    });
    await test.t.run(async (ctx) => {
      const owner = (await ctx.db.query("aiOrchestrators").collect())[0]!;
      const { _id, _creationTime, ...fields } = owner;
      await ctx.db.insert("aiOrchestrators", {
        ...fields,
        id: "unrelated-lead",
        ownerSubject: "colleague",
        directorSubjects: [],
        managerSubjects: [],
      });
      const chat = (await ctx.db.query("aiOrchestratorChats").collect())[0]!;
      await ctx.db.patch(chat._id, {
        kind: "group",
        leadId: "unrelated-lead",
        orchestratorIds: [test.id, "unrelated-lead"],
      });
    });
    const page = await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId });
    expect(
      page.messages.find((message) => message.id === "my-worker-message")?.worker?.orchestratorId,
    ).toBe(test.id);
    await test.owner.mutation(api.aiOrchestrators.send, {
      chatId: test.chatId,
      id: "my-worker-reply",
      replyToId: "my-worker-message",
      text: "And report the details",
    });
    expect(
      (await test.read()).messages.find((message) => message.id === "my-worker-reply")?.text,
    ).toBe("And report the details");
  });

  it("cancels queued delivery on archive while retaining accepted receipt recovery", async () => {
    const test = await workerControlHarness();
    await test.send("accepted-before-archive");
    await test.accept("accepted-before-archive");
    await test.send("pending-before-archive");
    await test.owner.mutation(api.aiOrchestrators.updateChat, {
      chatId: test.chatId,
      archived: true,
    });
    expect((await test.accept("accepted-before-archive"))?.recoveryOnly).toBe(true);
    await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
      companyId: "workspace",
      workId: "controlled-work",
      id: "accepted-before-archive",
      revision: 0,
      failed: false,
      detail: "Recovered receipt",
    });
    expect(await test.accept("pending-before-archive")).toBeNull();
    expect(
      (
        await test
          .environment()
          .query(api.aiOrchestratorControls.environmentInbox, { companyId: "workspace" })
      ).find((row) => row.workId === "controlled-work"),
    ).toMatchObject({ message: null, stopped: true });
    await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, {
      companyId: "workspace",
      workId: "controlled-work",
      commandId: "worker-start",
      threadId: "worker-thread",
      confirmed: true,
      detail: "All owned runs and descendants terminal",
    });
    await test.owner.mutation(api.aiOrchestrators.updateChat, {
      chatId: test.chatId,
      archived: false,
    });
    expect(await test.accept("pending-before-archive")).toBeNull();
  });
});

describe("structured human attention", () => {
  it("keeps coordination visible without notifications or unread counters unless mentioned", async () => {
    const test = await businessHarness();
    await test.t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      await ctx.db.patch(chat._id, { kind: "group", participantSubjects: ["owner", "colleague"] });
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", "owner"))
        .unique())!;
      await ctx.db.patch(member._id, { readSequence: chat.lastSequence });
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId: chat.id,
        subject: "colleague",
        fromSequence: chat.lastSequence + 1,
        readSequence: chat.lastSequence,
        updatedAt: Date.now(),
      });
      await appendChatMessage(
        ctx,
        { ...chat, kind: "group", participantSubjects: ["owner", "colleague"] },
        {
          id: "coordination",
          senderKind: "orchestrator",
          senderId: test.id,
          senderName: "Chief",
          text: "Agent coordination",
          status: "sent",
          replyToId: null,
          coordination: true,
        },
        { enabled: true, urgent: true },
      );
    });
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.unreadCount).toBe(0);
    expect(
      (await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.notification,
    ).toBeUndefined();
    expect(await test.relay.mutation(api.aiOrchestratorPush.claim, {})).toEqual([]);
    expect(
      (await test.owner.query(api.aiOrchestrators.messages, { chatId: test.chatId })).messages.some(
        (m) => m.id === "coordination",
      ),
    ).toBe(true);
    await test.t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      await appendChatMessage(
        ctx,
        chat,
        {
          id: "attention",
          senderKind: "orchestrator",
          senderId: test.id,
          senderName: "Chief",
          text: "Decision needed",
          status: "sent",
          replyToId: null,
          coordination: true,
          mentions: [{ kind: "user", id: "owner" }],
        },
        { enabled: true, urgent: true },
      );
    });
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.unreadCount).toBe(1);
    expect(
      (await test.relay.mutation(api.aiOrchestratorPush.claim, {})).map((job) => job.subject),
    ).toEqual(["owner"]);
    const colleagueChat = (
      await human(test.t, "colleague").query(api.aiOrchestrators.listChats, {})
    ).find((chat) => chat.id === test.chatId)!;
    expect(colleagueChat.unreadCount).toBe(0);
    expect(colleagueChat.notification).toBeUndefined();
  });

  it("human-only sends have stable mentions, no worker job, and reject forged nonmembers", async () => {
    const test = await businessHarness();
    const args = {
      chatId: test.chatId,
      id: "human-note",
      text: "For you",
      humanOnly: true,
      mentions: [{ kind: "user" as const, id: "owner" }],
    };
    await test.owner.mutation(api.aiOrchestrators.send, args);
    await test.owner.mutation(api.aiOrchestrators.send, args);
    expect(
      await test.t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("aiOrchestratorJobs")
              .withIndex("by_message", (q) => q.eq("messageId", "human-note"))
              .collect()
          ).length,
      ),
    ).toBe(0);
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, {
        ...args,
        id: "forged",
        mentions: [{ kind: "user", id: "colleague" }],
      }),
    ).rejects.toThrow("current conversation participant");
    await expect(
      human(test.t, "colleague").query(api.aiOrchestrators.messages, { chatId: test.chatId }),
    ).rejects.toThrow();
    await expect(
      human(test.t, "colleague").query(api.aiOrchestrators.mentionRecipients, {
        chatId: test.chatId,
      }),
    ).rejects.toThrow();
    await expect(
      test.owner.mutation(api.aiOrchestrators.send, { ...args, id: "mixed", targetId: test.id }),
    ).rejects.toThrow("cannot dispatch");
  });
});

describe("notification membership boundary", () => {
  it("does not expose a conversation or push content through a stale membership and forged mention", async () => {
    const test = await businessHarness();
    await test.t.run(async (ctx) => {
      const chat = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId: chat.id,
        subject: "director",
        fromSequence: 0,
        readSequence: 0,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(chat._id, {
        notification: {
          sequence: chat.lastSequence,
          senderName: "Secret",
          text: "Secret content",
          urgent: true,
          enabled: true,
          createdAt: Date.now(),
          coordination: true,
          mentions: [{ kind: "user", id: "director" }],
        },
      });
      await ctx.db.insert("aiOrchestratorPush", {
        chatId: chat.id,
        subject: "director",
        sequence: chat.lastSequence,
        generation: 0,
        dueAt: Date.now(),
      });
    });
    expect(await human(test.t, "director").query(api.aiOrchestrators.listChats, {})).toEqual([]);
    expect(
      (await test.relay.mutation(api.aiOrchestratorPush.claim, {})).some(
        (job) => job.subject === "director",
      ),
    ).toBe(false);
  });
});

describe("conversation lifecycle and personal menu preferences", () => {
  it("persists personal preferences, keeps manual unread until explicit opening, and hides muted counts", async () => {
    const test = await coordinatorHarness();
    await test.owner.mutation(api.aiOrchestrators.setChatPreferences, {
      chatId: test.chatId,
      pinned: true,
      markedUnread: true,
    });
    await test.owner.mutation(api.aiOrchestrators.markRead, { chatId: test.chatId, sequence: 1 });
    let chat = (await test.owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    expect(chat).toMatchObject({ pinned: true, markedUnread: true, unreadCount: 1 });
    await test.owner.mutation(api.aiOrchestrators.setChatPreferences, {
      chatId: test.chatId,
      muted: true,
    });
    chat = (await test.owner.query(api.aiOrchestrators.listChats, {}))[0]!;
    expect(chat).toMatchObject({ muted: true, unreadCount: 0 });
    expect(chat.notification).toBeUndefined();
    await test.owner.mutation(api.aiOrchestrators.setChatPreferences, {
      chatId: test.chatId,
      markedUnread: false,
      muted: false,
      pinned: false,
    });
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]).toMatchObject({
      pinned: false,
      markedUnread: false,
      muted: false,
    });
    await expect(
      human(test.t, "colleague").mutation(api.aiOrchestrators.setChatPreferences, {
        chatId: test.chatId,
        pinned: true,
      }),
    ).rejects.toThrow();
  });
  it("requires confirmation and ownership, archives recoverably, and retains a deleted tombstone", async () => {
    const test = await coordinatorHarness();
    await expect(
      test.owner.mutation(api.aiOrchestrators.deleteChat, {
        chatId: test.chatId,
        confirmed: false,
      }),
    ).rejects.toThrow("Confirm deletion");
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.archived).toBe(false);
    await expect(
      human(test.t, "colleague").mutation(api.aiOrchestrators.deleteChat, {
        chatId: test.chatId,
        confirmed: true,
      }),
    ).rejects.toThrow();
    await test.owner.mutation(api.aiOrchestrators.updateChat, {
      chatId: test.chatId,
      archived: true,
    });
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
      "archived",
    );
    expect(await test.claim()).toBeNull();
    await test.owner.mutation(api.aiOrchestrators.updateChat, {
      chatId: test.chatId,
      archived: false,
    });
    expect(await test.claim()).toBeNull();
    await test.owner.mutation(api.aiOrchestrators.deleteChat, {
      chatId: test.chatId,
      confirmed: true,
    });
    await test.owner.mutation(api.aiOrchestrators.deleteChat, {
      chatId: test.chatId,
      confirmed: true,
    });
    expect(await test.owner.query(api.aiOrchestrators.listChats, {})).toEqual([]);
    const rows = await test.t.run((ctx) => ctx.db.query("aiOrchestratorChats").collect());
    expect(rows.find((row) => row.id === test.chatId)?.lifecycle).toBe("deleted");
  });
  it("keeps offline deletion pending, fences reasoning, authenticates receipts and isolates reused threads", async () => {
    const test = await workerControlHarness();
    const run = (await test.claim())!;
    await test.t.run(async (ctx) => {
      const work = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
      const { _id, _creationTime, ...other } = work;
      await ctx.db.insert("aiOrchestratorWork", {
        ...other,
        id: "unrelated",
        chatId: "different-chat",
        commandId: "different-command",
      });
    });
    await test.owner.mutation(api.aiOrchestrators.deleteChat, {
      chatId: test.chatId,
      confirmed: true,
    });
    await test.owner.mutation(api.aiOrchestrators.deleteChat, {
      chatId: test.chatId,
      confirmed: true,
    });
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
      "deleting",
    );
    expect(
      await test.environment().mutation(api.aiOrchestratorJobs.renew, {
        companyId: "workspace",
        jobId: run.id,
        generation: run.generation,
      }),
    ).toBe(false);
    const receipt = {
      companyId: "workspace",
      workId: "controlled-work",
      commandId: "worker-start",
      threadId: "worker-thread",
      confirmed: true,
      detail: "Owned runs and descendants terminal",
    };
    await expect(
      test
        .environment("other")
        .mutation(api.aiOrchestratorControls.reportConversationStop, receipt),
    ).rejects.toThrow();
    await expect(
      test.owner.mutation(api.aiOrchestratorControls.reportConversationStop, receipt),
    ).rejects.toThrow();
    await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, {
      ...receipt,
      confirmed: false,
      detail: "Offline/uncertain",
    });
    await expect(
      test.owner.mutation(api.aiOrchestrators.updateChat, { chatId: test.chatId, archived: false }),
    ).rejects.toThrow("confirmed termination");
    await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, receipt);
    expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
      "deleting",
    );
    await test.environment().mutation(api.aiOrchestratorJobs.confirmStopped, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
    });
    expect(await test.owner.query(api.aiOrchestrators.listChats, {})).toEqual([]);
    const rows = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
    expect(rows.find((row) => row.id === "unrelated")).toMatchObject({ status: "working" });
    expect(rows.find((row) => row.id === "unrelated")?.stopRequested).toBeUndefined();
    expect(rows.find((row) => row.id === "controlled-work")).toMatchObject({
      status: "cancelled",
      stopConfirmed: true,
    });
  });
});

it("atomically cancels unclaimed dispatch and fences later claims without restarting on restore", async () => {
  const test = await coordinatorHarness();
  const run = (await test.claim())!;
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: run.id,
    generation: run.generation,
    result: { ...decision(), actions: [{ ...delegate("Queued task"), projectId: null }] },
  });
  await test.owner.mutation(api.aiOrchestrators.updateChat, {
    chatId: test.chatId,
    archived: true,
  });
  expect(
    await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
  ).toEqual([]);
  const rows = await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect());
  expect(rows[0]).toMatchObject({ status: "cancelled", stopConfirmed: true });
  await test.owner.mutation(api.aiOrchestrators.updateChat, {
    chatId: test.chatId,
    archived: false,
  });
  expect(
    await test.environment().mutation(api.environmentCommands.claim, { companyId: "workspace" }),
  ).toEqual([]);
});

it("keeps accepted deliveries uncertain and gives late follow-up runs their own stop receipts", async () => {
  const test = await workerControlHarness();
  await test.send("in-flight");
  await test.accept("in-flight");
  await test.owner.mutation(api.aiOrchestrators.updateChat, {
    chatId: test.chatId,
    archived: true,
  });
  const receipt = {
    companyId: "workspace",
    workId: "controlled-work",
    commandId: "worker-start",
    threadId: "worker-thread",
    confirmed: true,
    detail: "Root terminal",
  };
  expect(
    await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, receipt),
  ).toBe(false);
  await test.environment().mutation(api.aiOrchestratorControls.acknowledge, {
    companyId: "workspace",
    workId: "controlled-work",
    id: "in-flight",
    revision: 0,
    failed: false,
    detail: "Recovered",
    runId: "late-run",
    messageId: "late-message",
  });
  const inbox = await test
    .environment()
    .query(api.aiOrchestratorControls.environmentInbox, { companyId: "workspace" });
  expect(
    inbox.find((row) => row.workId === "worker-result:controlled-work:in-flight"),
  ).toMatchObject({ cancellationRequested: true, stopRunId: "late-run" });
  await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, receipt);
  expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
    "archiving",
  );
  await test.environment().mutation(api.aiOrchestratorControls.reportConversationStop, {
    ...receipt,
    workId: "worker-result:controlled-work:in-flight",
    commandId: "orchestrator-message:15:controlled-work:in-flight",
  });
  expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
    "archived",
  );
});

it("keeps allowance and tool authority on an unrelated run of a reused thread", async () => {
  const test = await businessHarness();
  await test.t.run(async (ctx) => {
    const work = (await ctx.db.query("aiOrchestratorWork").collect())[0]!;
    const chat = (await ctx.db.query("aiOrchestratorChats").collect()).find(
      (chat) => chat.id === test.chatId,
    )!;
    const { _id: _chatDoc, _creationTime: _chatTime, ...chatData } = chat;
    await ctx.db.insert("aiOrchestratorChats", {
      ...chatData,
      id: "other-conversation",
      lastSequence: 0,
    });
    const { _id, _creationTime, ...data } = work;
    await ctx.db.insert("aiOrchestratorWork", {
      ...data,
      id: "other-assignment",
      chatId: "other-conversation",
      threadId: "shared-thread",
      commandId: "other-command",
      continuation: true,
      resultRunId: "other-run",
      resultMessageId: "other-message",
    });
    await ctx.db.patch(work._id, { threadId: "shared-thread" });
  });
  await test.owner.mutation(api.aiOrchestrators.updateChat, {
    chatId: test.chatId,
    archived: true,
  });
  const origin = {
    ...test.delegatedOrigin,
    execution: { threadId: "shared-thread", runId: "other-run", messageId: "other-message" },
  };
  expect(
    (
      await test
        .environment()
        .query(api.aiOrchestratorJobs.workerAccess, { ...origin, localProjectId: null })
    ).allowed,
  ).toBe(true);
  expect(
    await test.environment().query(api.providerAllowanceBudgets.forScopes, {
      companyId: "workspace",
      scopes: [],
      origin,
    }),
  ).toEqual([]);
  expect(
    (
      await test.environment().query(api.aiOrchestratorJobs.workerAccess, {
        ...test.delegatedOrigin,
        localProjectId: null,
      })
    ).allowed,
  ).toBe(false);
});

it("does not confirm an unclaimed root while a separate delivery is accepted", async () => {
  const test = await workerControlHarness();
  await test.send("accepted");
  await test.accept("accepted");
  await test.t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!;
    const member = (await ctx.db.query("memberships").collect()).find(
      (member) => member.id === "member-owner",
    )!;
    await ctx.db.insert("environmentCommands", {
      id: "worker-start",
      companyId: company._id,
      targetEnvironmentId: "studio",
      cloudProjectId: null,
      bindingId: null,
      kind: "startThread",
      args: { kind: "startThread", prompt: "Task", modelSelection: null },
      issuedByMembershipId: member._id,
      orchestratorId: test.id,
      onBehalfOfActor: {
        kind: "agent",
        provider: `orchestrator:${test.id}`,
        onBehalfOfMembershipId: member.id,
      },
      state: "pending",
      claimedByEnvironmentId: null,
      claimGeneration: 0,
      claimExpiresAt: null,
      expiresAt: Date.now() + 60000,
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  await test.owner.mutation(api.aiOrchestrators.updateChat, {
    chatId: test.chatId,
    archived: true,
  });
  const work = (await test.t.run((ctx) => ctx.db.query("aiOrchestratorWork").collect()))[0]!;
  expect(work).toMatchObject({
    stopRequested: true,
    stopConfirmed: false,
    status: "unknown",
    controlsPending: true,
  });
  expect((await test.owner.query(api.aiOrchestrators.listChats, {}))[0]?.lifecycle).toBe(
    "archiving",
  );
});

describe("bounded cross-conversation discovery", () => {
  it("pages past 100 conversations and retains ambiguous matches without choosing one", async () => {
    const test = await coordinatorHarness();
    const { discoverConversations } = await import("../convex/lib/aiOrchestratorContext.ts");
    await test.t.run(async (ctx) => {
      const original = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      const { _id, _creationTime, ...record } = original;
      void _id;
      void _creationTime;
      for (let i = 0; i < 105; i++) {
        const id = `recall-${i}`;
        await ctx.db.insert("aiOrchestratorChats", {
          ...record,
          id,
          title: i >= 103 ? "Apollo decision" : "Other",
        });
        const member = (await ctx.db
          .query("aiOrchestratorChatMembers")
          .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "owner"))
          .unique())!;
        const { _id: memberId, _creationTime: memberTime, ...fields } = member;
        void memberId;
        void memberTime;
        await ctx.db.insert("aiOrchestratorChatMembers", { ...fields, chatId: id });
      }
    });
    const found: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await test.t.run(async (ctx) => {
        const source = (await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
          .unique())!;
        const orchestrator = (await ctx.db
          .query("aiOrchestrators")
          .withIndex("by_domain_id", (q) => q.eq("id", test.id))
          .unique())!;
        return discoverConversations(ctx, orchestrator, source, "Apollo", cursor);
      });
      expect(result.matches.length).toBeLessThanOrEqual(25);
      found.push(...result.matches.map((match) => match.chatId));
      cursor = result.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(5);
    expect(found).toEqual(["recall-103", "recall-104"]);
  });
});

describe("conversation recall visibility", () => {
  it("rechecks source membership between a read request and its delivery", async () => {
    const test = await coordinatorHarness();
    const run = (await test.claim())!;
    await test.environment().mutation(api.aiOrchestratorJobs.complete, {
      companyId: "workspace",
      jobId: run.id,
      generation: run.generation,
      result: { ...decision(), actions: [{ kind: "readConversation", chatId: test.chatId }] },
    });
    await test.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "owner"))
        .unique())!;
      await ctx.db.delete(member._id);
    });
    // Revoking the current audience also makes the continuation itself ineligible.
    expect(await test.claim()).toBeNull();
  });

  it("does not disclose titles after history boundaries, membership or project changes", async () => {
    const test = await coordinatorHarness();
    const { discoverConversations, conversationRetrievalBoundary } =
      await import("../convex/lib/aiOrchestratorContext.ts");
    await test.t.run(async (ctx) => {
      const source = (await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
        .unique())!;
      const orchestrator = (await ctx.db
        .query("aiOrchestrators")
        .withIndex("by_domain_id", (q) => q.eq("id", test.id))
        .unique())!;
      await ctx.db.patch(source._id, { title: "Confidential Apollo" });
      const member = (await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "owner"))
        .unique())!;
      await ctx.db.patch(member._id, { fromSequence: 100 });
      expect((await discoverConversations(ctx, orchestrator, source, "Apollo")).matches).toEqual(
        [],
      );
      expect(
        await conversationRetrievalBoundary(
          ctx,
          { ...orchestrator, projectId: "other" },
          source,
          source,
        ),
      ).toBeNull();
      expect(
        await conversationRetrievalBoundary(ctx, orchestrator, source, {
          ...source,
          participantSubjects: ["colleague"],
        }),
      ).toBeNull();
      await ctx.db.delete(member._id);
      expect(await conversationRetrievalBoundary(ctx, orchestrator, source, source)).toBeNull();
    });
  });

  it("excludes forgotten sources beyond 20 tombstones and across personal/project scopes", async () => {
    const test = await coordinatorHarness();
    const { withoutForgottenSources } = await import("../convex/lib/aiOrchestratorContext.ts");
    await test.t.run(async (ctx) => {
      const orchestrator = (await ctx.db
        .query("aiOrchestrators")
        .withIndex("by_domain_id", (q) => q.eq("id", test.id))
        .unique())!;
      const message = (await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_chat_sequence", (q) => q.eq("chatId", test.chatId))
        .first())!;
      for (let i = 0; i < 25; i++)
        await ctx.db.insert("aiOrchestratorMemory", {
          id: `forgot-${i}`,
          orchestratorId: test.id,
          ownerSubject: "owner",
          text: "",
          source: "",
          scope: "orchestrator",
          explicit: false,
          forgotten: true,
          updatedAt: i,
          sourceChatId: test.chatId,
          sourceSequence: i === 0 ? message.sequence : 100 + i,
        });
      expect(await withoutForgottenSources(ctx, orchestrator, [message])).toEqual([]);
      const shared = {
        ...orchestrator,
        id: "another",
        projectId: "project",
        companyId: "workspace",
      };
      expect(await withoutForgottenSources(ctx, shared, [message])).toHaveLength(1);
      await ctx.db.insert("aiOrchestratorMemory", {
        id: "project-forgotten",
        orchestratorId: test.id,
        ownerSubject: "owner",
        text: "",
        source: "",
        scope: "project",
        explicit: false,
        forgotten: true,
        updatedAt: 0,
        sourceChatId: test.chatId,
        sourceSequence: message.sequence,
        sharedProjectId: "project",
        sharedCompanyId: "workspace",
      });
      expect(await withoutForgottenSources(ctx, shared, [message])).toEqual([]);
      expect(
        await withoutForgottenSources(ctx, { ...shared, projectId: "elsewhere" }, [message]),
      ).toHaveLength(1);
      await ctx.db.insert("aiOrchestratorMemory", {
        id: "personal-forgotten",
        orchestratorId: test.id,
        ownerSubject: "owner",
        text: "",
        source: "",
        scope: "personal",
        explicit: false,
        forgotten: true,
        updatedAt: 0,
        sourceChatId: test.chatId,
        sourceSequence: message.sequence,
      });
      expect(await withoutForgottenSources(ctx, { ...shared, projectId: null }, [message])).toEqual(
        [],
      );
    });
  });
});

it("delivers ID-free discovery through the coordinator contract and preserves archived recall", async () => {
  const test = await coordinatorHarness();
  const archived = "archived-recall";
  await test.t.run(async (ctx) => {
    const source = (await ctx.db
      .query("aiOrchestratorChats")
      .withIndex("by_domain_id", (q) => q.eq("id", test.chatId))
      .unique())!;
    const { _id, _creationTime, ...fields } = source;
    void _id;
    void _creationTime;
    await ctx.db.insert("aiOrchestratorChats", {
      ...fields,
      id: archived,
      title: "Apollo planning",
      archived: true,
      lifecycle: "archived",
    });
    const member = (await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", test.chatId).eq("subject", "owner"))
      .unique())!;
    const { _id: memberId, _creationTime: memberTime, ...membership } = member;
    void memberId;
    void memberTime;
    await ctx.db.insert("aiOrchestratorChatMembers", { ...membership, chatId: archived });
    const original = (await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_chat_sequence", (q) => q.eq("chatId", test.chatId))
      .first())!;
    const { _id: messageId, _creationTime: messageTime, ...message } = original;
    void messageId;
    void messageTime;
    for (let i = 1; i <= 25; i++)
      await ctx.db.insert("aiOrchestratorMessages", {
        ...message,
        id: `archived-message-${i}`,
        chatId: archived,
        sequence: i,
        text: i === 1 ? "Decision: use the old Apollo engine" : `Update ${i}`,
      });
  });
  const run = (await test.claim())!;
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: run.id,
    generation: run.generation,
    result: { ...decision(), actions: [{ kind: "findConversations", query: "Apollo" }] },
  });
  const continued = (await test.claim())!;
  expect(continued.context).toContain("Apollo planning");
  expect(continued.context).toContain(archived);
  expect(continued.context).toContain("nextCursor");
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: continued.id,
    generation: continued.generation,
    result: {
      ...decision(),
      actions: [{ kind: "readConversation", chatId: archived, beforeSequence: 6 }],
    },
  });
  const older = (await test.claim())!;
  expect(older.context).toContain("Decision: use the old Apollo engine");
  expect(older.context).not.toContain("Update 25");
  await test.environment().mutation(api.aiOrchestratorJobs.complete, {
    companyId: "workspace",
    jobId: older.id,
    generation: older.generation,
    result: {
      ...decision(),
      actions: [{ kind: "readConversation", chatId: archived, beforeSequence: 6 }],
    },
  });
  await test.t.run(async (ctx) => {
    const member = (await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", archived).eq("subject", "owner"))
      .unique())!;
    await ctx.db.delete(member._id);
  });
  const revoked = (await test.claim())!;
  expect(revoked.context).not.toContain("Decision: use the old Apollo engine");
  expect(revoked.context).not.toContain("Apollo planning");
  expect(revoked.context).toContain("unavailable");
});

it("keeps a thread-specific control inbox independent of unrelated worker history", async () => {
  const test = await workerControlHarness();
  await test.send("pending-message");
  await test.t.run(async (ctx) => {
    const template = (await ctx.db.query("aiOrchestratorWork").first())!;
    const { _id, _creationTime, ...work } = template;
    void _id;
    void _creationTime;
    for (let i = 0; i < 100; i++)
      await ctx.db.insert("aiOrchestratorWork", {
        ...work,
        id: `unrelated-${i}`,
        threadId: `other-thread-${i}`,
        commandId: `other-command-${i}`,
        status: "completed",
        controlsPending: true,
        prompt: "large unrelated assignment ".repeat(100),
      });
    await ctx.db.insert("aiOrchestratorWork", {
      ...work,
      id: "launch-being-stopped",
      threadId: null,
      commandId: "stopped-launch-command",
      stopRequested: true,
      controlsPending: true,
    });
  });
  const measured = await test.environment().run(async (ctx) => {
    const meter = measureDatabaseReads(ctx.db);
    const result = await functionHandler(environmentInbox)(
      { ...ctx, db: meter.db },
      { companyId: "workspace", threadId: "worker-thread" },
    );
    return { result, reads: meter.documents.get("aiOrchestratorWork") };
  });
  expect(measured.result).toHaveLength(2);
  expect(measured.result[0]).toMatchObject({
    workId: "controlled-work",
    message: { id: "pending-message", revision: 0 },
  });
  expect(measured.result[1]).toMatchObject({
    workId: "launch-being-stopped",
    cancellationRequested: true,
  });
  expect(measured.reads).toBeLessThanOrEqual(3);
  await test.t.run(async (ctx) => {
    const { _id, _creationTime, ...work } = (await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_domain_id", (q) => q.eq("id", "controlled-work"))
      .unique())!;
    void _id;
    void _creationTime;
    for (let i = 0; i < 100; i++)
      await ctx.db.insert("aiOrchestratorWork", {
        ...work,
        id: `newer-control-${i}`,
        commandId: `newer-command-${i}`,
        controlMessageId: `delivered-${i}`,
        controlsPending: false,
        status: "completed",
      });
  });
  const olderPending = await test.environment().query(api.aiOrchestratorControls.environmentInbox, {
    companyId: "workspace",
    threadId: "worker-thread",
  });
  expect(olderPending).toEqual(measured.result);
});

it("reuses control inbox permission reads within a transaction without caching revoked authority", async () => {
  const test = await workerControlHarness();
  await test.t.run(async (ctx) => {
    const { _id, _creationTime, ...work } = (await ctx.db.query("aiOrchestratorWork").first())!;
    void _id;
    void _creationTime;
    for (let i = 0; i < 20; i++)
      await ctx.db.insert("aiOrchestratorWork", {
        ...work,
        id: `sibling-${i}`,
        threadId: `sibling-thread-${i}`,
        commandId: `sibling-command-${i}`,
      });
  });
  const measured = await test.environment().run(async (ctx) => {
    const meter = measureDatabaseReads(ctx.db);
    const result = await functionHandler(environmentInbox)(
      { ...ctx, db: meter.db },
      { companyId: "workspace" },
    );
    return {
      result,
      companyReads: meter.documents.get("companies"),
      chatReads: meter.documents.get("aiOrchestratorChats"),
    };
  });
  expect(measured.result).toHaveLength(21);
  expect(measured.chatReads).toBe(1);
  expect(measured.companyReads).toBeLessThan(15);
  await test.t.run(async (ctx) => {
    const member = (await ctx.db.query("memberships").collect()).find(
      (row) => row.id === "member-owner",
    );
    if (!member) throw new Error("Missing owner");
    await ctx.db.patch(member._id, { state: "left" });
  });
  expect(
    await test
      .environment()
      .query(api.aiOrchestratorControls.environmentInbox, { companyId: "workspace" }),
  ).toEqual([]);
});

it("does not rewrite unchanged worker catalogs on every claim, but refreshes them before expiry", async () => {
  const test = await coordinatorHarness();
  const args = {
    companyId: "workspace",
    providers: [{ instanceId: "codex", driver: "codex" }],
    delegationCatalog: workerCatalog,
  };
  await test.environment().mutation(api.aiOrchestratorJobs.claim, args);
  const registration = () => test.t.run((ctx) => ctx.db.query("environmentRuntime").unique());
  const first = (await registration())!;
  await test.t.run((ctx) =>
    ctx.db.patch(first._id, { orchestratorDelegationCatalogAt: Date.now() - 10_000 }),
  );
  const before = (await registration())!.orchestratorDelegationCatalogAt;
  await test.environment().mutation(api.aiOrchestratorJobs.claim, args);
  expect((await registration())!.orchestratorDelegationCatalogAt).toBe(before);
  const changedCatalog = { ...workerCatalog, truncated: true };
  await test.environment().mutation(api.aiOrchestratorJobs.claim, {
    ...args,
    delegationCatalog: changedCatalog,
  });
  expect((await registration())!.orchestratorDelegationCatalog).toEqual(changedCatalog);
  expect((await registration())!.orchestratorDelegationCatalogAt).toBeGreaterThan(before!);
  await test.t.run((ctx) =>
    ctx.db.patch(first._id, { orchestratorDelegationCatalogAt: Date.now() - 60_000 }),
  );
  await test.environment().mutation(api.aiOrchestratorJobs.claim, {
    ...args,
    delegationCatalog: changedCatalog,
  });
  expect((await registration())!.orchestratorDelegationCatalogAt).toBeGreaterThan(before!);
});

it("renews idle worker presence without scanning work or changing authorization", async () => {
  const test = await coordinatorHarness();
  const args = { companyId: "workspace", delegationCatalog: workerCatalog };
  await test.environment().mutation(api.aiOrchestratorJobs.heartbeat, args);
  const registration = () =>
    test.t.run((ctx) =>
      ctx.db
        .query("environmentRegistrations")
        .withIndex("by_environment", (q) => q.eq("environmentId", "studio"))
        .unique(),
    );
  const before = await registration();
  await test.t.run(async (ctx) => {
    const presence = (await ctx.db.query("environmentPresence").first())!;
    await ctx.db.patch(presence._id, { lastSeenAt: 1 });
  });
  const measured = await test.environment().run(async (ctx) => {
    const meter = measureDatabaseReads(ctx.db);
    await functionHandler(workerHeartbeat)({ ...ctx, db: meter.db }, { companyId: "workspace" });
    return Object.fromEntries(meter.documents);
  });
  expect(measured["environmentRuntime"] ?? 0).toBe(0);
  expect(measured["aiOrchestratorJobs"] ?? 0).toBe(0);
  expect(measured["aiOrchestratorWork"] ?? 0).toBe(0);
  expect(await registration()).toEqual(before);
  const runtime = await test.t.run((ctx) => ctx.db.query("environmentRuntime").first());
  expect(runtime?.orchestratorDelegationCatalog).toEqual(workerCatalog);
  expect(before?.orchestratorDelegationCatalog).toBeUndefined();
});

it("watches bounded worker readiness without loading chat history or presence", async () => {
  const test = await coordinatorHarness();
  const check = (kind: "reasoning" | "inspections" | "results") =>
    test.environment().query(api.workerWakeups.pending, { companyId: "workspace", kind });
  expect(await check("reasoning")).toBe(true);
  expect(await check("inspections")).toBe(false);
  expect(await check("results")).toBe(false);
  const measured = await test.environment().run(async (ctx) => {
    const meter = measureDatabaseReads(ctx.db);
    await functionHandler(workerPending)(
      { ...ctx, db: meter.db },
      { companyId: "workspace", kind: "reasoning" },
    );
    return Object.fromEntries(meter.documents);
  });
  expect(measured["aiOrchestratorJobs"]).toBe(1);
  expect(measured["aiOrchestratorMessages"] ?? 0).toBe(0);
  expect(measured["environmentPresence"] ?? 0).toBe(0);
  await test.t.run(async (ctx) => {
    for (const job of await ctx.db.query("aiOrchestratorJobs").collect())
      await ctx.db.patch(job._id, { status: "completed" });
  });
  expect(await check("reasoning")).toBe(false);
  await expect(
    test.owner.query(api.workerWakeups.pending, { companyId: "workspace", kind: "reasoning" }),
  ).rejects.toThrow();
  await test.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_environment", (q) => q.eq("environmentId", "studio"))
      .unique())!;
    await ctx.db.patch(row._id, { state: "revoked" });
  });
  await expect(check("reasoning")).rejects.toThrow();
});
