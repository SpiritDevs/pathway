// @effect-diagnostics globalDate:off -- Convex supplies transaction time for delivery leases.
/** The relay delivers only the latest unread, currently authorized conversation update. */
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";
import { hasChatAccess } from "./aiOrchestrators.ts";
const target = { chatId: v.string(), subject: v.string(), sequence: v.number() };
async function current(ctx: QueryCtx, args: { chatId: string; subject: string; sequence: number }) {
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", args.chatId))
    .unique();
  const notification = chat?.notification;
  if (
    !chat ||
    !chat.participantSubjects.includes(args.subject) ||
    chat.archived ||
    !notification?.enabled ||
    notification.sequence !== args.sequence ||
    notification.createdAt < Date.now() - 600000
  )
    return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", args.subject))
    .unique();
  const member = await ctx.db
    .query("aiOrchestratorChatMembers")
    .withIndex("by_chat_subject", (q) => q.eq("chatId", args.chatId).eq("subject", args.subject))
    .unique();
  if (
    !user ||
    !member ||
    member.readSequence >= args.sequence ||
    member.fromSequence > args.sequence ||
    !(await hasChatAccess(ctx, chat, user))
  )
    return null;
  return {
    title: notification.senderName,
    text: notification.text,
    urgent: notification.urgent,
    createdAt: notification.createdAt,
  };
}
export const isCurrent = query({
  args: target,
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return (await current(ctx, args)) !== null;
  },
});
export const claim = mutation({
  args: {},
  handler: async (ctx) => {
    await requireRelayControlPlane(ctx);
    const due = await ctx.db
      .query("aiOrchestratorPush")
      .withIndex("by_due", (q) => q.lte("dueAt", Date.now()))
      .take(50);
    const jobs = [];
    for (const row of due) {
      const notification = await current(ctx, row);
      if (!notification) {
        await ctx.db.delete(row._id);
        continue;
      }
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, { generation, dueAt: Date.now() + 60000 });
      jobs.push({
        chatId: row.chatId,
        subject: row.subject,
        sequence: row.sequence,
        generation,
        ...notification,
      });
    }
    return jobs;
  },
});
export const acknowledge = mutation({
  args: { ...target, generation: v.number() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("aiOrchestratorPush")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", args.chatId).eq("subject", args.subject))
      .unique();
    if (row?.sequence === args.sequence && row.generation === args.generation)
      await ctx.db.delete(row._id);
  },
});
