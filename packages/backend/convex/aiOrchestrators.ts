import { nextResponsibilityReview } from "./aiOrchestratorReviews.ts";
// @effect-diagnostics globalDate:off -- Convex supplies deterministic transaction time.
/** Authenticated orchestration contacts and continuing conversations. */
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import {
  OrchestratorConfig,
  defaultOrchestratorConfig,
} from "@spiritdevs/contracts/aiOrchestrator";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  requireUser,
  requireCompanyActor,
  requirePermission,
  requireRecordPermission,
} from "./lib/identity.ts";
import { hasRecordPermission } from "../src/permissions.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { orchestratorConfig, orchestratorMemoryScope } from "./lib/aiOrchestratorSchema.ts";
import { requestOrchestratorStop } from "./lib/aiOrchestratorWork.ts";
import { workVisibilityForConversation } from "./lib/aiOrchestratorContext.ts";

const fail = (message: string): never => {
  throw backendError("orchestrator-request", message);
};
const decodeConfig = Schema.decodeUnknownSync(OrchestratorConfig);
const unique = (values: readonly string[]) => [...new Set(values)];
export async function findOrchestrator(ctx: QueryCtx, id: string) {
  return await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
}
export function canManageOrchestrator(row: Doc<"aiOrchestrators">, subject: string) {
  return row.ownerSubject === subject || row.managerSubjects.includes(subject);
}
export function canDirectOrchestrator(row: Doc<"aiOrchestrators">, subject: string) {
  return canManageOrchestrator(row, subject) || row.directorSubjects.includes(subject);
}
async function hasCompanyAccess(ctx: QueryCtx, companyId: string, user: Doc<"users">) {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyId))
    .unique();
  if (!company || company.lifecycleState !== "active") return false;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", company._id).eq("userId", user._id))
    .unique();
  return membership?.state === "active";
}
export async function hasChatAccess(
  ctx: QueryCtx,
  chat: Doc<"aiOrchestratorChats">,
  user: Doc<"users">,
) {
  for (const companyId of chat.companyIds)
    if (!(await hasCompanyAccess(ctx, companyId, user))) return false;
  return true;
}
export async function readableOrchestrator(ctx: QueryCtx, id: string) {
  const user = await requireUser(ctx);
  const row = await findOrchestrator(ctx, id);
  if (!row || row.status === "deleted") return fail("This orchestrator is no longer available.");
  if (row.companyId && !(await hasCompanyAccess(ctx, row.companyId, user)))
    return fail("Your workspace access has changed.");
  if (row.ownerSubject !== user.clerkSubject) {
    if (!row.shared || !row.companyId) return fail("You do not have access to this orchestrator.");
    const actor = await requireCompanyActor(ctx, row.companyId);
    if (actor.kind !== "member") return fail("A signed-in member is required.");
  }
  return { row, user };
}
async function managedOrchestrator(ctx: QueryCtx, id: string) {
  const result = await readableOrchestrator(ctx, id);
  if (!canManageOrchestrator(result.row, result.user.clerkSubject))
    return fail("You need management permission to change this orchestrator.");
  return result;
}
export function publicOrchestrator(row: Doc<"aiOrchestrators">, subject: string) {
  const { _id, _creationTime, ...record } = row;
  return {
    ...record,
    canManage: canManageOrchestrator(row, subject),
    canDirect: canDirectOrchestrator(row, subject),
  };
}
async function validateConfig(ctx: QueryCtx, input: unknown, ownerSubject: string) {
  let config: OrchestratorConfig;
  try {
    config = decodeConfig(input);
  } catch {
    return fail("Some orchestrator settings are invalid.");
  }
  if (
    !config.name.trim() ||
    config.name.length > 100 ||
    config.instructions.length > 24000 ||
    config.persona.length > 4000 ||
    config.responsibilities.length > 12000
  )
    return fail("Use a name under 100 characters and keep instructions under 24,000 characters.");
  if (![0, 15, 60, 240, 1440].includes(config.reviewIntervalMinutes ?? 0))
    return fail("Choose a supported responsibility review interval.");
  if (
    !Number.isInteger(config.maxAssignments) ||
    config.maxAssignments < 1 ||
    config.maxAssignments > 32
  )
    return fail("Choose between 1 and 32 active assignments.");
  if (
    config.models.length > 12 ||
    config.environmentIds.length > 50 ||
    config.directorSubjects.length > 100 ||
    config.managerSubjects.length > 20
  )
    return fail("This configuration contains too many entries.");
  if (unique(config.models.map((m) => m.id)).length !== config.models.length)
    return fail("Model choices must have distinct identities.");
  if (
    (config.workerModels ?? []).some(
      (choice) => !choice.name.trim() || !choice.environmentId.trim(),
    ) ||
    unique((config.workerModels ?? []).map((choice) => choice.id)).length !==
      (config.workerModels ?? []).length
  )
    return fail("Worker presets need a name, an environment and distinct identities.");
  if (config.kind === "project" && (!config.companyId || !config.projectId))
    return fail("Choose a workspace and project for a project orchestrator.");
  if (config.shared && !config.companyId)
    return fail("Choose a workspace before sharing an orchestrator.");
  if (config.companyId) {
    const actor = await requireCompanyActor(ctx, config.companyId);
    if (actor.kind !== "member") return fail("A signed-in member is required.");
    if (config.shared) requirePermission(actor, "remoteAgents.dispatch");
    if (config.projectId) {
      const project = await ctx.db
        .query("cloudProjects")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", config.projectId!),
        )
        .unique();
      if (
        !project ||
        project.companyId !== actor.company._id ||
        project.deletedAt !== null ||
        project.archivedAt !== null
      )
        return fail("The project does not belong to this workspace.");
      requireRecordPermission(actor, "projects.read", project.teamIds);
    }
    for (const subject of unique([...config.managerSubjects, ...config.directorSubjects])) {
      if (subject === ownerSubject) continue;
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
        .unique();
      if (!user) return fail("Choose an existing workspace member for permissions.");
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_user", (q) =>
          q.eq("companyId", actor.company._id).eq("userId", user._id),
        )
        .unique();
      if (!member || member.state !== "active")
        return fail("Only active workspace members can receive orchestrator permissions.");
    }
  } else if (config.directorSubjects.length || config.managerSubjects.length)
    return fail("Personal orchestrators are managed and directed by their owner.");
  const { workerModels, ...base } = config;
  return {
    ...base,
    name: config.name.trim(),
    capabilities: unique(config.capabilities),
    directorSubjects: unique(config.directorSubjects),
    managerSubjects: unique(config.managerSubjects),
    models: config.models.map((m) => ({
      ...m,
      selection: {
        instanceId: m.selection.instanceId,
        model: m.selection.model,
        ...(m.selection.options
          ? { options: m.selection.options.map((option) => ({ ...option })) }
          : {}),
      },
    })),
    ...(workerModels
      ? {
          workerModels: workerModels.map((choice) => ({
            ...choice,
            selection: {
              instanceId: choice.selection.instanceId,
              model: choice.selection.model,
              ...(choice.selection.options
                ? { options: choice.selection.options.map((option) => ({ ...option })) }
                : {}),
            },
          })),
        }
      : {}),
    environmentIds: unique(config.environmentIds),
  };
}

export const list = query({
  args: { companyId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const owned = await ctx.db
      .query("aiOrchestrators")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", user.clerkSubject))
      .take(200);
    let shared: Doc<"aiOrchestrators">[] = [];
    if (args.companyId) {
      await requireCompanyActor(ctx, args.companyId);
      shared = await ctx.db
        .query("aiOrchestrators")
        .withIndex("by_company", (q) => q.eq("companyId", args.companyId!).eq("shared", true))
        .take(200);
    }
    const visible = [];
    for (const row of new Map([...owned, ...shared].map((row) => [row.id, row])).values()) {
      if (
        row.status === "deleted" ||
        (row.companyId && !(await hasCompanyAccess(ctx, row.companyId, user)))
      )
        continue;
      visible.push(publicOrchestrator(row, user.clerkSubject));
    }
    return visible;
  },
});
export const ensurePersonal = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const owned = await ctx.db
      .query("aiOrchestrators")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", user.clerkSubject))
      .take(200);
    // A deliberately deleted Chief should not be recreated by a subscribed client.
    const existing = owned.find((r) => r.kind === "personal");
    if (existing) return existing.id;
    const id = mintDomainId(Date.now());
    const now = Date.now();
    await ctx.db.insert("aiOrchestrators", {
      ...defaultOrchestratorConfig(),
      models: [],
      workerModels: [],
      capabilities: [...defaultOrchestratorConfig().capabilities],
      directorSubjects: [],
      managerSubjects: [],
      environmentIds: [],
      id,
      ownerSubject: user.clerkSubject,
      status: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});
export const create = mutation({
  args: { config: v.object(orchestratorConfig) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const config = await validateConfig(ctx, args.config, user.clerkSubject);
    const id = mintDomainId(Date.now()),
      now = Date.now();
    await ctx.db.insert("aiOrchestrators", {
      ...config,
      ...(nextResponsibilityReview(config, now) === undefined
        ? {}
        : { nextReviewAt: nextResponsibilityReview(config, now)! }),
      id,
      ownerSubject: user.clerkSubject,
      status: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});
export const configure = mutation({
  args: { id: v.string(), revision: v.number(), config: v.object(orchestratorConfig) },
  handler: async (ctx, args) => {
    const { row } = await managedOrchestrator(ctx, args.id);
    if (row.revision !== args.revision)
      return fail(
        "This orchestrator changed on another device. Reload its settings before saving.",
      );
    const config = await validateConfig(ctx, args.config, row.ownerSubject);
    await ctx.db.patch(row._id, {
      ...config,
      nextReviewAt: nextResponsibilityReview({ ...config, status: row.status }, Date.now()),
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    return row.revision + 1;
  },
});
export const setStatus = mutation({
  args: {
    id: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("archived"),
      v.literal("deleted"),
    ),
    stopWork: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { row } = await managedOrchestrator(ctx, args.id);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: args.status,
      nextReviewAt: nextResponsibilityReview({ ...row, status: args.status }, now),
      ...(args.stopWork || args.status === "deleted" ? { workStoppedBefore: now } : {}),
      revision: row.revision + 1,
      updatedAt: now,
    });
    if (args.stopWork || args.status === "deleted") {
      await requestOrchestratorStop(ctx, row);
      for (const status of ["queued", "running"] as const) {
        const jobs = await ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_orchestrator_status", (q) =>
            q.eq("orchestratorId", row.id).eq("status", status),
          )
          .take(200);
        for (const job of jobs) {
          await ctx.db.patch(job._id, {
            status: "cancelled",
            generation: job.generation + 1,
            updatedAt: now,
          });
          const message = await ctx.db
            .query("aiOrchestratorMessages")
            .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
            .unique();
          if (message) await ctx.db.patch(message._id, { status: "cancelled" });
        }
      }
    }
    if (args.status === "deleted") {
      const memories = await ctx.db
        .query("aiOrchestratorMemory")
        .withIndex("by_orchestrator", (q) => q.eq("orchestratorId", row.id))
        .take(500);
      for (const memory of memories) await ctx.db.delete(memory._id);
    }
    return null;
  },
});

export async function readableChat(ctx: QueryCtx, id: string) {
  const user = await requireUser(ctx);
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
  const member = await ctx.db
    .query("aiOrchestratorChatMembers")
    .withIndex("by_chat_subject", (q) => q.eq("chatId", id).eq("subject", user.clerkSubject))
    .unique();
  if (!chat || !member || !(await hasChatAccess(ctx, chat, user)))
    return fail("You do not have access to this conversation.");
  return { chat, member, user };
}
export async function appendChatMessage(
  ctx: MutationCtx,
  chat: Doc<"aiOrchestratorChats">,
  message: {
    id: string;
    senderKind: "user" | "orchestrator" | "system";
    senderId: string;
    senderName: string;
    text: string;
    status: "queued" | "sent";
    replyToId: string | null;
  },
  notification?: { urgent: boolean; enabled: boolean },
) {
  const sequence = chat.lastSequence + 1,
    now = Date.now();
  await ctx.db.insert("aiOrchestratorMessages", {
    ...message,
    chatId: chat.id,
    sequence,
    createdAt: now,
  });
  await ctx.db.patch(chat._id, {
    lastSequence: sequence,
    ...(message.senderKind !== "system" || message.senderId === "participants"
      ? { lastMessage: message.text.slice(0, 160), updatedAt: now }
      : {}),
    ...(notification
      ? {
          notification: {
            ...notification,
            sequence,
            senderName: message.senderName,
            text: message.text.slice(0, 160),
            createdAt: now,
          },
        }
      : {}),
  });
  for (const subject of chat.participantSubjects) {
    if (notification?.enabled) {
      const pending = await ctx.db
        .query("aiOrchestratorPush")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", subject))
        .unique();
      const fields = {
        chatId: chat.id,
        subject,
        sequence,
        dueAt: now + (notification.urgent ? 0 : 2000),
      };
      if (pending) await ctx.db.patch(pending._id, fields);
      else await ctx.db.insert("aiOrchestratorPush", { ...fields, generation: 0 });
    }
    const member = await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", subject))
      .unique();
    if (member)
      await ctx.db.patch(member._id, {
        updatedAt: now,
        ...(message.senderKind === "user" && message.senderId === subject
          ? { readSequence: sequence }
          : {}),
      });
  }
  return sequence;
}
export const listChats = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_subject", (q) => q.eq("subject", user.clerkSubject))
      .order("desc")
      .take(100);
    const rows = await Promise.all(
      memberships.map(async (member) => {
        const chat = await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", member.chatId))
          .unique();
        if (!chat || !(await hasChatAccess(ctx, chat, user))) return null;
        // Internal wake messages remain available to reasoning, not the human conversation.
        const latest = await ctx.db
          .query("aiOrchestratorMessages")
          .withIndex("by_chat_sequence", (q) =>
            q.eq("chatId", chat.id).gte("sequence", member.fromSequence),
          )
          .filter((q) =>
            q.or(q.neq(q.field("senderKind"), "system"), q.eq(q.field("senderId"), "participants")),
          )
          .order("desc")
          .first();
        const {
          _id,
          _creationTime,
          summary: _summary,
          summaryThroughSequence: _summaryThroughSequence,
          notification,
          ...record
        } = chat;
        return {
          ...record,
          lastMessage: latest?.text.slice(0, 160) ?? "",
          lastSequence: latest?.sequence ?? 0,
          readSequence: member.readSequence,
          ...(notification && notification.sequence >= member.fromSequence ? { notification } : {}),
        };
      }),
    );
    return rows.filter((r) => r !== null);
  },
});
export const createChat = mutation({
  args: {
    title: v.string(),
    orchestratorIds: v.array(v.string()),
    leadId: v.string(),
    companyIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx),
      now = Date.now();
    const ids = unique(args.orchestratorIds);
    if (
      !ids.length ||
      ids.length > 12 ||
      !ids.includes(args.leadId) ||
      !args.title.trim() ||
      args.title.length > 120 ||
      args.companyIds.length > 12
    )
      return fail("Choose a title and between one and twelve orchestrators, including a lead.");
    const contacts = await Promise.all(ids.map((id) => readableOrchestrator(ctx, id)));
    if (
      !canDirectOrchestrator(contacts.find((c) => c.row.id === args.leadId)!.row, user.clerkSubject)
    )
      return fail("You need permission to direct the group lead.");
    const companies = unique([
      ...args.companyIds,
      ...contacts.flatMap((c) => (c.row.companyId ? [c.row.companyId] : [])),
    ]);
    for (const companyId of companies) {
      const actor = await requireCompanyActor(ctx, companyId);
      requirePermission(actor, "remoteAgents.dispatch");
    }
    if (ids.length === 1) {
      const existing = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_owner", (q) => q.eq("ownerSubject", user.clerkSubject))
        .take(200);
      const dm = existing.find((c) => c.kind === "dm" && c.leadId === ids[0]);
      if (dm) {
        await ctx.db.patch(dm._id, { archived: false });
        return dm.id;
      }
    }
    const id = mintDomainId(Date.now());
    await ctx.db.insert("aiOrchestratorChats", {
      id,
      title: args.title.trim(),
      kind: ids.length === 1 ? "dm" : "group",
      ownerSubject: user.clerkSubject,
      orchestratorIds: ids,
      leadId: args.leadId,
      participantSubjects: [user.clerkSubject],
      companyIds: companies,
      archived: false,
      lastSequence: 0,
      lastMessage: "",
      summary: "",
      summaryThroughSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("aiOrchestratorChatMembers", {
      chatId: id,
      subject: user.clerkSubject,
      fromSequence: 0,
      readSequence: 0,
      updatedAt: now,
    });
    return id;
  },
});
export const messages = query({
  args: { chatId: v.string(), before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { member } = await readableChat(ctx, args.chatId);
    const rows = await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_chat_sequence", (q) =>
        q
          .eq("chatId", args.chatId)
          .gte("sequence", member.fromSequence)
          .lt("sequence", args.before ?? Number.MAX_SAFE_INTEGER),
      )
      .filter((q) =>
        q.or(q.neq(q.field("senderKind"), "system"), q.eq(q.field("senderId"), "participants")),
      )
      .order("desc")
      .take(60);
    return {
      messages: rows.toReversed().map(({ _id, _creationTime, ...m }) => m),
      nextBefore: rows.length === 60 ? rows.at(-1)!.sequence : null,
    };
  },
});

export const activity = query({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const { member, chat } = await readableChat(ctx, args.chatId);
    const running = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_chat_status", (q) => q.eq("chatId", args.chatId).eq("status", "running"))
      .take(20);
    const activity = new Map<string, number>();
    for (const job of running) {
      if (!chat.orchestratorIds.includes(job.orchestratorId)) continue;
      const trigger = await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
        .unique();
      if (trigger && trigger.sequence >= member.fromSequence)
        activity.set(
          job.orchestratorId,
          Math.max(activity.get(job.orchestratorId) ?? 0, job.leaseExpiresAt),
        );
    }
    return [...activity].map(([id, expiresAt]) => ({ id, expiresAt }));
  },
});

export const invite = mutation({
  args: {
    chatId: v.string(),
    orchestratorId: v.optional(v.string()),
    subject: v.optional(v.string()),
    history: v.union(v.literal("all"), v.literal("from-now")),
  },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    if (chat.ownerSubject !== user.clerkSubject)
      return fail("Only the conversation owner can change its participants.");
    if (Boolean(args.orchestratorId) === Boolean(args.subject))
      return fail("Choose one person or orchestrator to invite.");
    if (chat.archived) return fail("Unarchive the conversation before adding participants.");
    const now = Date.now(),
      fromSequence = args.history === "all" ? 0 : chat.lastSequence + 1;
    let companyIds = chat.companyIds;
    if (args.orchestratorId) {
      if (chat.orchestratorIds.includes(args.orchestratorId)) return null;
      if (chat.orchestratorIds.length >= 12)
        return fail("A conversation can include up to twelve orchestrators.");
      const { row } = await readableOrchestrator(ctx, args.orchestratorId);
      if (!canDirectOrchestrator(row, user.clerkSubject))
        return fail("You need direction permission to invite this orchestrator.");
      companyIds = unique([...companyIds, ...(row.companyId ? [row.companyId] : [])]);
      for (const subject of chat.participantSubjects) {
        const participant = await ctx.db
          .query("users")
          .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
          .unique();
        if (!participant) return fail("A participant is no longer available.");
        for (const companyId of companyIds)
          if (!(await hasCompanyAccess(ctx, companyId, participant)))
            return fail(
              "Every participant must have access to the invited orchestrator's workspace.",
            );
      }
      await ctx.db.patch(chat._id, {
        orchestratorIds: [...chat.orchestratorIds, row.id],
        orchestratorHistory: [
          ...(chat.orchestratorHistory ?? []),
          { orchestratorId: row.id, fromSequence },
        ],
        companyIds,
        kind: "group",
      });
    } else {
      const subject = args.subject!;
      if (chat.participantSubjects.includes(subject)) return null;
      if (chat.participantSubjects.length >= 20)
        return fail("A conversation can include up to twenty people.");
      const participant = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
        .unique();
      if (!participant || !companyIds.length)
        return fail("Choose a member of this conversation's workspace.");
      for (const companyId of companyIds)
        if (!(await hasCompanyAccess(ctx, companyId, participant)))
          return fail("The invited person needs access to every workspace in this conversation.");
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId: chat.id,
        subject,
        fromSequence,
        readSequence: fromSequence === 0 ? 0 : chat.lastSequence,
        updatedAt: now,
      });
      await ctx.db.patch(chat._id, {
        participantSubjects: [...chat.participantSubjects, subject],
        kind: "group",
      });
    }
    // Rebuild the compacted context after changing the audience. Existing leases must renew.
    await ctx.db.patch(chat._id, {
      summary: "",
      summaryThroughSequence: 0,
      revision: (chat.revision ?? 0) + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get(chat._id);
    await appendChatMessage(ctx, updated!, {
      id: mintDomainId(now),
      senderKind: "system",
      senderId: "participants",
      senderName: "Pathway",
      text: `${args.orchestratorId ? "An orchestrator" : "A participant"} joined. ${args.history === "all" ? "Conversation history is shared." : "Only messages from now are shared."}`,
      status: "sent",
      replyToId: null,
    });
    return null;
  },
});

export const removeParticipant = mutation({
  args: {
    chatId: v.string(),
    orchestratorId: v.optional(v.string()),
    subject: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    if (chat.ownerSubject !== user.clerkSubject && args.subject !== user.clerkSubject)
      return fail("Only the owner can remove another participant.");
    if (Boolean(args.orchestratorId) === Boolean(args.subject))
      return fail("Choose one participant.");
    if (args.orchestratorId) {
      if (args.orchestratorId === chat.leadId)
        return fail("Choose another conversation lead before removing this orchestrator.");
      await ctx.db.patch(chat._id, {
        orchestratorIds: chat.orchestratorIds.filter((id) => id !== args.orchestratorId),
        orchestratorHistory: (chat.orchestratorHistory ?? []).filter(
          (entry) => entry.orchestratorId !== args.orchestratorId,
        ),
        updatedAt: Date.now(),
      });
    } else {
      if (args.subject === chat.ownerSubject)
        return fail("The conversation owner cannot leave. Archive it instead.");
      const member = await ctx.db
        .query("aiOrchestratorChatMembers")
        .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", args.subject!))
        .unique();
      if (member) await ctx.db.delete(member._id);
      await ctx.db.patch(chat._id, {
        participantSubjects: chat.participantSubjects.filter((subject) => subject !== args.subject),
        updatedAt: Date.now(),
      });
    }
    await ctx.db.patch(chat._id, {
      revision: (chat.revision ?? 0) + 1,
      summary: "",
      summaryThroughSequence: 0,
    });
    return null;
  },
});
export const send = mutation({
  args: {
    chatId: v.string(),
    id: v.string(),
    text: v.string(),
    targetId: v.optional(v.string()),
    replyToId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { chat, member, user } = await readableChat(ctx, args.chatId);
    if (chat.archived) return fail("Unarchive this conversation to send a message.");
    if (!args.text.trim() || args.text.length > 32000)
      return fail("Messages must contain between 1 and 32,000 characters.");
    const existing = await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (existing) {
      const existingJob = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_message", (q) => q.eq("messageId", existing.id))
        .unique();
      if (
        existing.chatId !== chat.id ||
        existing.senderId !== user.clerkSubject ||
        existing.text !== args.text.trim() ||
        existing.replyToId !== (args.replyToId ?? null) ||
        existingJob?.orchestratorId !== (args.targetId ?? chat.leadId)
      )
        return fail("That message identity is already in use.");
      return existing.sequence;
    }
    const target = args.targetId ?? chat.leadId;
    if (!chat.orchestratorIds.includes(target))
      return fail("Choose an orchestrator in this conversation.");
    const { row } = await readableOrchestrator(ctx, target);
    if (!canDirectOrchestrator(row, user.clerkSubject))
      return fail("You need direction permission to assign work to this orchestrator.");
    if (args.replyToId) {
      const reply = await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_domain_id", (q) => q.eq("id", args.replyToId!))
        .unique();
      if (!reply || reply.chatId !== chat.id || reply.sequence < member.fromSequence)
        return fail("The replied-to message is unavailable.");
    }
    const sequence = await appendChatMessage(ctx, chat, {
      id: args.id,
      senderKind: "user",
      senderId: user.clerkSubject,
      senderName: user.displayName,
      text: args.text.trim(),
      status: "queued",
      replyToId: args.replyToId ?? null,
    });
    const now = Date.now();
    await ctx.db.insert("aiOrchestratorJobs", {
      id: mintDomainId(Date.now()),
      orchestratorId: target,
      chatId: chat.id,
      messageId: args.id,
      companyId: row.companyId ?? chat.companyIds[0] ?? "",
      status: "queued",
      environmentId: null,
      generation: 0,
      leaseExpiresAt: 0,
      modelIndex: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    });
    return sequence;
  },
});
export const markRead = mutation({
  args: { chatId: v.string(), sequence: v.number() },
  handler: async (ctx, args) => {
    const { chat, member } = await readableChat(ctx, args.chatId);
    if (!Number.isSafeInteger(args.sequence) || args.sequence < 0)
      return fail("Invalid read position.");
    if (Math.min(chat.lastSequence, args.sequence) <= member.readSequence) return null;
    await ctx.db.patch(member._id, {
      readSequence: Math.max(member.readSequence, Math.min(chat.lastSequence, args.sequence)),
    });
    return null;
  },
});
export const updateChat = mutation({
  args: {
    chatId: v.string(),
    title: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    leadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    if (chat.ownerSubject !== user.clerkSubject)
      return fail("Only the conversation owner can change its settings.");
    if (args.title !== undefined && (!args.title.trim() || args.title.length > 120))
      return fail("Use a conversation name under 120 characters.");
    if (args.leadId) {
      if (!chat.orchestratorIds.includes(args.leadId))
        return fail("The lead must belong to this conversation.");
      const { row } = await readableOrchestrator(ctx, args.leadId);
      if (!canDirectOrchestrator(row, user.clerkSubject))
        return fail("You need permission to direct the selected lead.");
    }
    await ctx.db.patch(chat._id, {
      ...(args.title !== undefined ? { title: args.title.trim() } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
      ...(args.leadId ? { leadId: args.leadId } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const work = query({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const { member, chat, user } = await readableChat(ctx, args.chatId);
    const rows = await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(100);
    const canSee = workVisibilityForConversation(ctx, {
      ...chat,
      participantSubjects: [user.clerkSubject],
    });
    const visible = [];
    for (const row of rows)
      if ((row.sourceSequence ?? 0) >= member.fromSequence && (await canSee(row)))
        visible.push(row);
    return visible.map(
      ({
        id,
        title,
        orchestratorId,
        environmentId,
        projectId,
        threadId,
        status,
        detail,
        selection,
        selectionReason,
        createdAt,
      }) => ({
        id,
        title,
        orchestratorId,
        environmentId,
        projectId,
        threadId,
        status,
        detail,
        selection,
        selectionReason,
        createdAt,
      }),
    );
  },
});
export const memories = query({
  args: { orchestratorId: v.string() },
  handler: async (ctx, args) => {
    const { row, user } = await managedOrchestrator(ctx, args.orchestratorId);
    const own = await ctx.db
      .query("aiOrchestratorMemory")
      .withIndex("by_orchestrator_forgotten", (q) =>
        q.eq("orchestratorId", args.orchestratorId).eq("forgotten", false),
      )
      .order("desc")
      .take(500);
    const personal =
      !row.shared && user.clerkSubject === row.ownerSubject
        ? await ctx.db
            .query("aiOrchestratorMemory")
            .withIndex("by_owner_scope_forgotten", (q) =>
              q.eq("ownerSubject", row.ownerSubject).eq("scope", "personal").eq("forgotten", false),
            )
            .order("desc")
            .take(100)
        : [];
    return [...new Map([...own, ...personal].map((memory) => [memory.id, memory])).values()]
      .filter(
        (memory) =>
          user.clerkSubject === row.ownerSubject || memory.sharedCompanyId === row.companyId,
      )
      .map(({ _id, _creationTime, ownerSubject: _ownerSubject, ...m }) => m);
  },
});
export const saveMemory = mutation({
  args: {
    orchestratorId: v.string(),
    id: v.optional(v.string()),
    text: v.string(),
    scope: orchestratorMemoryScope,
    confirmSharing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { row, user } = await managedOrchestrator(ctx, args.orchestratorId);
    if (!args.text.trim() || args.text.length > 8000)
      return fail("Memories must contain between 1 and 8,000 characters.");
    if (args.scope === "personal" && row.shared)
      return fail("Personal memories belong to private orchestrators.");
    if (args.scope === "project" && !row.projectId)
      return fail("Project memories need an attached project.");
    const sharing = args.scope === "project" || row.shared;
    if (sharing && !args.confirmSharing)
      return fail("Confirm that this memory can be shared with the workspace before saving it.");
    const id = args.id ?? mintDomainId(Date.now()),
      now = Date.now();
    const existing = args.id
      ? await ctx.db
          .query("aiOrchestratorMemory")
          .withIndex("by_domain_id", (q) => q.eq("id", id))
          .unique()
      : null;
    if (args.id && (!existing || existing.orchestratorId !== row.id))
      return fail("This memory is unavailable.");
    if (
      existing &&
      user.clerkSubject !== row.ownerSubject &&
      existing.sharedCompanyId !== row.companyId
    )
      return fail("This memory is private to its owner.");
    if (existing) {
      if (existing.text !== args.text.trim()) {
        const { _id, _creationTime, ...previous } = existing;
        await ctx.db.insert("aiOrchestratorMemory", {
          ...previous,
          id: mintDomainId(now),
          forgotten: true,
          text: "",
          source: "",
          updatedAt: now,
        });
      }
      await ctx.db.patch(existing._id, {
        text: args.text.trim(),
        scope: args.scope,
        explicit: true,
        source: "User instruction",
        sourceChatId: undefined,
        sourceSequence: undefined,
        sharedCompanyId: sharing ? row.companyId! : undefined,
        sharedProjectId: sharing && row.projectId ? row.projectId : undefined,
        forgotten: false,
        updatedAt: now,
      });
    } else
      await ctx.db.insert("aiOrchestratorMemory", {
        id,
        orchestratorId: row.id,
        ownerSubject: row.ownerSubject,
        text: args.text.trim(),
        scope: args.scope,
        explicit: true,
        source: "User instruction",
        ...(sharing
          ? {
              sharedCompanyId: row.companyId!,
              ...(row.projectId ? { sharedProjectId: row.projectId } : {}),
            }
          : {}),
        forgotten: false,
        updatedAt: now,
      });
    return id;
  },
});
export const forgetMemory = mutation({
  args: { orchestratorId: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    const { row, user } = await managedOrchestrator(ctx, args.orchestratorId);
    const memory = await ctx.db
      .query("aiOrchestratorMemory")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (!memory || memory.orchestratorId !== args.orchestratorId)
      return fail("This memory is unavailable.");
    if (user.clerkSubject !== row.ownerSubject && memory.sharedCompanyId !== row.companyId)
      return fail("This memory is private to its owner.");
    await ctx.db.patch(memory._id, {
      forgotten: true,
      text: "",
      source: "",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const configurationChoices = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "remoteAgents.dispatch");
    const projects = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(500);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(500);
    const members = await Promise.all(
      memberships
        .filter((member) => member.state === "active")
        .map(async (member) => {
          const user = await ctx.db.get(member.userId);
          return user ? { subject: user.clerkSubject, name: user.displayName } : null;
        }),
    );
    return {
      projects: projects
        .filter(
          (project) =>
            project.deletedAt === null &&
            project.archivedAt === null &&
            hasRecordPermission(actor.permissions, "projects.read", project.teamIds),
        )
        .map((project) => ({ id: project.id, name: project.name })),
      members: members.filter((member) => member !== null),
    };
  },
});

export const cancelMessage = mutation({
  args: { chatId: v.string(), messageId: v.string() },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    const message = await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", args.messageId))
      .unique();
    if (!message || message.chatId !== chat.id || message.senderId !== user.clerkSubject)
      return fail("You can only cancel your own messages.");
    if (message.status !== "queued")
      return fail("This message has already started. Stop its orchestrator to interrupt work.");
    const job = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_message", (q) => q.eq("messageId", message.id))
      .unique();
    if (job && job.status !== "queued") return fail("This message has already started.");
    if (job)
      await ctx.db.patch(job._id, {
        status: "cancelled",
        generation: job.generation + 1,
        updatedAt: Date.now(),
      });
    await ctx.db.patch(message._id, { status: "cancelled" });
    return null;
  },
});

export const retryMessage = mutation({
  args: { chatId: v.string(), messageId: v.string() },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    if (chat.archived) return fail("Unarchive this conversation before retrying.");
    const message = await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", args.messageId))
      .unique();
    if (
      !message ||
      message.chatId !== chat.id ||
      message.senderKind !== "user" ||
      message.senderId !== user.clerkSubject
    )
      return fail("You can only retry your own requests.");
    const job = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_message", (q) => q.eq("messageId", message.id))
      .unique();
    if (!job || job.status !== "failed") return fail("Only a failed request can be retried.");
    const { row } = await readableOrchestrator(ctx, job.orchestratorId);
    if (!chat.orchestratorIds.includes(row.id) || !canDirectOrchestrator(row, user.clerkSubject))
      return fail("Your direction permission has changed.");
    if (row.status !== "active") return fail("Resume this orchestrator before retrying.");
    await ctx.db.patch(job._id, {
      status: "queued",
      generation: job.generation + 1,
      leaseExpiresAt: 0,
      modelIndex: 0,
      attempts: 0,
      failedEnvironmentIds: [],
      contextResults: "",
      error: "",
      updatedAt: Date.now(),
    });
    await ctx.db.patch(message._id, { status: "queued" });
    return null;
  },
});
