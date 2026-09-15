import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { backendError } from "./errors.ts";

export const conversationFenced = (chat: { archived: boolean; lifecycle?: string }) =>
  chat.archived || !!chat.lifecycle;

export async function conversationWork(ctx: QueryCtx, chatId: string) {
  const work = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  const jobs = (
    await Promise.all(
      (["queued", "running", "cancelled"] as const).map((status) =>
        ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_chat_status", (q) => q.eq("chatId", chatId).eq("status", status))
          .collect(),
      ),
    )
  ).flat();
  return { work, jobs };
}

/** A tombstone is retained; no cancellation evidence or message history is purged here. */
export async function reconcileConversationLifecycle(
  ctx: MutationCtx,
  chat: Doc<"aiOrchestratorChats">,
) {
  if (chat.lifecycle !== "archiving" && chat.lifecycle !== "deleting") return;
  const { work, jobs } = await conversationWork(ctx, chat.id);
  const pending =
    work.filter((row) => row.stopRequested && !row.stopConfirmed).length +
    jobs.filter((row) => row.stopRequested && !row.stopConfirmed).length;
  await ctx.db.patch(chat._id, {
    lifecycle: pending ? chat.lifecycle : chat.lifecycle === "deleting" ? "deleted" : "archived",
    lifecycleDetail: pending
      ? `Stop requested; awaiting confirmation for ${pending} assignment(s). Offline or unobservable workers remain pending.`
      : "Conversation work stopped.",
  });
}

export async function assertConversationDispatch(ctx: QueryCtx, chatId: string) {
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", chatId))
    .unique();
  if (!chat || conversationFenced(chat))
    throw backendError("conversation-stopping", "This conversation is archived or stopping.");
  return chat;
}
