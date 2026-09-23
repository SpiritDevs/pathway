// @effect-diagnostics globalDate:off -- Convex uses the transaction clock.
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";

export const KEEP_QUEUE_LISTED = Number.MAX_SAFE_INTEGER;
export const QUEUE_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const QUEUE_CLEANUP_BATCH_SIZE = 32;

export async function trackQueueAttachments(ctx: MutationCtx, message: Doc<"threadQueueMessages">) {
  if (message.attachmentReferencesTracked) return;
  for (const id of new Set(message.attachmentIds)) {
    const attachmentId = ctx.db.normalizeId("threadQueueAttachments", id);
    if (attachmentId && (await ctx.db.get(attachmentId)))
      await ctx.db.insert("threadQueueAttachmentReferences", {
        attachmentId,
        messageId: message._id,
      });
  }
  await ctx.db.patch(message._id, { attachmentReferencesTracked: true });
}

/** Dropping a message's references lets the upload sweep reclaim bytes no other message uses. */
export async function deleteQueueMessage(ctx: MutationCtx, message: Doc<"threadQueueMessages">) {
  const refs = await ctx.db
    .query("threadQueueAttachmentReferences")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  for (const ref of refs) await ctx.db.delete(ref._id);
  await ctx.db.delete(message._id);
}

/** Explicit thread deletion bypasses the publication grace period, never the pending-work checks. */
export async function scheduleOrphanQueueCleanup(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  environmentId: string,
  threadId: string,
) {
  const row = await ctx.db
    .query("threadQueueThreads")
    .withIndex("by_company_environment_and_thread", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId).eq("threadId", threadId),
    )
    .unique();
  if (row?.state === "delivered" && row.queuedCount === 0)
    await ctx.scheduler.runAfter(0, internal.threadQueue.pruneOrphan, {
      queueId: row._id,
      confirmedDeletion: true,
    });
}

/** Deletes one page of delivered receipts only after their owning thread has disappeared. */
export async function pruneOrphanQueue(
  ctx: MutationCtx,
  queueId: Id<"threadQueueThreads">,
  confirmedDeletion: boolean,
): Promise<number> {
  const row = await ctx.db.get(queueId);
  if (
    !row ||
    row.state !== "delivered" ||
    row.queuedCount !== 0 ||
    (!confirmedDeletion && row.updatedAt > Date.now() - QUEUE_ORPHAN_GRACE_MS)
  )
    return 0;
  const published = await ctx.db
    .query("agentThreads")
    .withIndex("by_company_and_environment_and_thread", (q) =>
      q
        .eq("companyId", row.companyId)
        .eq("environmentId", row.environmentId)
        .eq("threadId", row.threadId),
    )
    .first();
  if (published) return 0;
  const messages = () =>
    ctx.db.query("threadQueueMessages").withIndex("by_queue_and_sequence", (q) =>
      q
        .eq("companyId", row.companyId)
        .eq("threadId", row.threadId)
        .eq("queueThreadId", row.queueVersion === 1 ? row._id : undefined),
    );
  // Canceled messages remain editable/retryable and must not disappear with old receipts.
  for (const state of ["queued", "accepted", "blocked", "canceled"] as const) {
    const pending = await ctx.db
      .query("threadQueueMessages")
      .withIndex("by_queue_and_state", (q) =>
        q
          .eq("companyId", row.companyId)
          .eq("threadId", row.threadId)
          .eq("queueThreadId", row.queueVersion === 1 ? row._id : undefined)
          .eq("state", state),
      )
      .first();
    if (pending) return 0;
  }
  const page = await messages().take(QUEUE_CLEANUP_BATCH_SIZE);
  for (const message of page) await deleteQueueMessage(ctx, message);
  if (await messages().first())
    await ctx.scheduler.runAfter(0, internal.threadQueue.pruneOrphan, {
      queueId,
      confirmedDeletion,
    });
  else await ctx.db.delete(row._id);
  return page.length;
}

/** Storage can be registered in another product surface, so deleting queue metadata is not enough. */
export async function pruneQueueAttachment(ctx: MutationCtx, row: Doc<"threadQueueAttachments">) {
  if (
    await ctx.db
      .query("threadQueueAttachmentReferences")
      .withIndex("by_attachment", (q) => q.eq("attachmentId", row._id))
      .first()
  )
    return;
  const shared =
    (await ctx.db
      .query("aiOrchestratorAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", row.storageId))
      .first()) ||
    (await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_storage_id", (q) => q.eq("storageId", row.storageId))
      .first()) ||
    (await ctx.db
      .query("issueAttachments")
      .withIndex("by_storage_id", (q) => q.eq("storageId", row.storageId))
      .first());
  if (!shared) await ctx.storage.delete(row.storageId);
  await ctx.db.delete(row._id);
}

/** A published shell replaces the queue row after a grace period for client sync handoff. */
export async function finishQueueListingHandoff(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  environmentId: string,
  threadId: string,
) {
  const row = await ctx.db
    .query("threadQueueThreads")
    .withIndex("by_company_environment_and_thread", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId).eq("threadId", threadId),
    )
    .unique();
  if (
    !row ||
    row.state !== "delivered" ||
    (row.listingExpiresAt !== undefined && row.listingExpiresAt !== KEEP_QUEUE_LISTED)
  )
    return;
  const canceled = await ctx.db
    .query("threadQueueMessages")
    .withIndex("by_queue_and_state", (q) =>
      q
        .eq("companyId", companyId)
        .eq("threadId", threadId)
        .eq("queueThreadId", row.queueVersion === 1 ? row._id : undefined)
        .eq("state", "canceled"),
    )
    .first();
  if (canceled) return;
  await ctx.db.patch(row._id, { listingExpiresAt: Date.now() + QUEUE_DELIVERED_RETENTION_MS });
}
