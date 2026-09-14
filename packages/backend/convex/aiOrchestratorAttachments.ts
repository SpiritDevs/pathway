// @effect-diagnostics globalDate:off -- Convex supplies transaction time.
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import { OrchestratorAttachment } from "@spiritdevs/contracts/aiOrchestrator";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@spiritdevs/contracts";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { readableChat, canDirectOrchestrator, readableOrchestrator } from "./aiOrchestrators.ts";
import { currentClaim } from "./aiOrchestratorJobs.ts";
import { sharedHistoryBoundary } from "./lib/aiOrchestratorContext.ts";
import { orchestratorAttachment } from "./lib/aiOrchestratorSchema.ts";
import { backendError } from "./lib/errors.ts";

const decodeAttachment = Schema.decodeUnknownSync(OrchestratorAttachment);
const PENDING_TTL = 24 * 60 * 60 * 1000;
const unavailable = (): never => {
  throw backendError(
    "attachment-unavailable",
    "This attachment is unavailable to this conversation.",
  );
};
const find = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorAttachments")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();

async function writableChat(ctx: QueryCtx, chatId: string, targetId: string) {
  const scope = await readableChat(ctx, chatId);
  const { row } = await readableOrchestrator(ctx, targetId);
  if (
    scope.chat.archived ||
    !scope.chat.orchestratorIds.includes(targetId) ||
    !canDirectOrchestrator(row, scope.user.clerkSubject)
  )
    return unavailable();
  return scope;
}

/** The direct upload and metadata verification follow threadQueue's storage protocol. */
export const prepare = mutation({
  args: { chatId: v.string(), targetId: v.string(), attachment: orchestratorAttachment },
  handler: async (ctx, args) => {
    const { user } = await writableChat(ctx, args.chatId, args.targetId);
    const attachment = decodeAttachment(args.attachment);
    const existing = await find(ctx, attachment.id);
    if (existing) {
      if (
        existing.chatId !== args.chatId ||
        existing.ownerSubject !== user.clerkSubject ||
        existing.messageId ||
        existing.expiresAt <= Date.now() ||
        Object.entries(attachment).some(
          ([key, value]) => existing.attachment[key as keyof typeof existing.attachment] !== value,
        )
      )
        return unavailable();
      if (existing.storageId) return { ready: true, uploadUrl: null };
    } else {
      await ctx.db.insert("aiOrchestratorAttachments", {
        id: attachment.id,
        chatId: args.chatId,
        ownerSubject: user.clerkSubject,
        attachment,
        expiresAt: Date.now() + PENDING_TTL,
      });
    }
    return { ready: false, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const finalize = mutation({
  args: { chatId: v.string(), id: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const { user } = await readableChat(ctx, args.chatId);
    const row = await find(ctx, args.id);
    if (
      !row ||
      row.chatId !== args.chatId ||
      row.ownerSubject !== user.clerkSubject ||
      row.expiresAt <= Date.now()
    )
      return unavailable();
    if (row.storageId === args.storageId) return null;
    if (row.storageId || row.messageId) return unavailable();
    const owned = await ctx.db
      .query("aiOrchestratorAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (owned) return unavailable();
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      !metadata ||
      metadata.size !== row.attachment.sizeBytes ||
      (metadata.contentType &&
        metadata.contentType.toLowerCase() !== row.attachment.mimeType.toLowerCase())
    )
      return unavailable();
    await ctx.db.patch(row._id, { storageId: args.storageId });
    return null;
  },
});

export async function bindConversationAttachments(
  ctx: MutationCtx,
  input: { chat: Doc<"aiOrchestratorChats">; subject: string; messageId: string; ids: string[] },
) {
  if (
    input.ids.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
    new Set(input.ids).size !== input.ids.length
  )
    return unavailable();
  const attachments = [];
  for (const id of input.ids) {
    const row = await find(ctx, id);
    if (
      !row ||
      row.chatId !== input.chat.id ||
      row.ownerSubject !== input.subject ||
      !row.storageId ||
      row.messageId ||
      row.expiresAt <= Date.now()
    )
      return unavailable();
    await ctx.db.patch(row._id, {
      messageId: input.messageId,
      sequence: input.chat.lastSequence + 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    attachments.push(row.attachment);
  }
  return attachments;
}

export const discard = mutation({
  args: { chatId: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    const { user } = await readableChat(ctx, args.chatId);
    const row = await find(ctx, args.id);
    if (!row) return null;
    if (row.chatId !== args.chatId || row.ownerSubject !== user.clerkSubject) return unavailable();
    // An unconfirmed send may already have bound the file. Removal never deletes sent evidence.
    if (row.messageId) return null;
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
    return null;
  },
});

const readArgs = {
  id: v.string(),
  companyId: v.optional(v.string()),
  jobId: v.optional(v.string()),
  generation: v.optional(v.number()),
};
async function readableAttachment(
  ctx: QueryCtx,
  args: { id: string; companyId?: string; jobId?: string; generation?: number },
) {
  const row = await find(ctx, args.id);
  if (!row?.storageId) return unavailable();
  if (args.jobId !== undefined) {
    if (!args.companyId || args.generation === undefined) return unavailable();
    const claim = await currentClaim(ctx, {
      companyId: args.companyId,
      jobId: args.jobId,
      generation: args.generation,
    });
    if (!claim || claim.chat.id !== row.chatId || row.sequence === undefined) return unavailable();
    const boundary = await sharedHistoryBoundary(ctx, claim.chat, claim.chat);
    if (
      boundary === null ||
      row.sequence < boundary ||
      row.sequence > (claim.job.contextThroughSequence ?? 0)
    )
      return unavailable();
  } else {
    const { member, user } = await readableChat(ctx, row.chatId);
    if (
      row.sequence === undefined
        ? row.ownerSubject !== user.clerkSubject || row.expiresAt <= Date.now()
        : row.sequence < member.fromSequence
    )
      return unavailable();
  }
  return { storageId: row.storageId, attachment: row.attachment };
}

/** Returns an authenticated endpoint, never a transferable storage URL. */
export const download = query({
  args: readArgs,
  handler: async (ctx, args) => {
    await readableAttachment(ctx, args);
    const site = process.env.CONVEX_SITE_URL;
    if (!site)
      throw backendError("attachment-unavailable", "Attachment downloads are not configured.");
    const url = new URL("/orchestrator-attachments", site);
    for (const [key, value] of Object.entries(args))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  },
});
export const read = internalQuery({ args: readArgs, handler: readableAttachment });
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("aiOrchestratorAttachments")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(100);
    for (const row of rows) {
      if (row.messageId) continue;
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
  },
});
