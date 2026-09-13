// @effect-diagnostics globalDate:off -- Convex uses the transaction clock.
import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

export const KEEP_QUEUE_LISTED = Number.MAX_SAFE_INTEGER;
export const QUEUE_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
