import { alertThreadScopeKey } from "@spiritdevs/contracts/threadAlerts";
import { v } from "convex/values";

import type { MutationCtx, QueryCtx } from "../_generated/server.js";

export const alertScopeKind = v.union(
  v.literal("global"),
  v.literal("project"),
  v.literal("thread"),
);
export const alertChoices = v.object({
  completion: v.optional(v.boolean()),
  permission: v.optional(v.boolean()),
  input: v.optional(v.boolean()),
  failure: v.optional(v.boolean()),
});

export async function policyForScope(
  ctx: QueryCtx,
  userId: string,
  scopeKind: "global" | "project" | "thread",
  scopeKey: string,
) {
  return await ctx.db
    .query("threadAlertPolicies")
    .withIndex("by_user_and_scope", (q) =>
      q.eq("userId", userId).eq("scopeKind", scopeKind).eq("scopeKey", scopeKey),
    )
    .unique();
}

export async function deleteThreadAlertPolicies(
  ctx: MutationCtx,
  environmentId: string,
  threadId: string,
) {
  const rows = await ctx.db
    .query("threadAlertPolicies")
    .withIndex("by_scope", (q) =>
      q.eq("scopeKind", "thread").eq("scopeKey", alertThreadScopeKey(environmentId, threadId)),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}
