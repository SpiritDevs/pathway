import { defineTable } from "convex/server";
import { v } from "convex/values";

export const allowanceScope = v.union(
  v.object({ kind: v.literal("chat"), chatId: v.string() }),
  v.object({ kind: v.literal("thread"), environmentId: v.string(), threadId: v.string() }),
);
export const allowanceAllocation = v.object({
  provider: v.string(),
  accountKey: v.string(),
  windowKey: v.string(),
  windowLabel: v.string(),
  resetsAt: v.number(),
  authorizedPercent: v.number(),
  baselineUsedPercent: v.number(),
  observedUsedPercent: v.number(),
  observedAt: v.number(),
  state: v.union(
    v.literal("ready"),
    v.literal("near-limit"),
    v.literal("limit-reached"),
    v.literal("unavailable"),
    v.literal("reset"),
  ),
  detail: v.string(),
});
export const providerAllowanceTables = {
  providerAllowanceBudgets: defineTable({
    id: v.string(),
    companyId: v.string(),
    ownerSubject: v.string(),
    title: v.string(),
    scopes: v.array(allowanceScope),
    allocations: v.array(allowanceAllocation),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("closed")),
    revision: v.number(),
    detail: v.string(),
    creationIntent: v.optional(v.string()),
    sourceInstruction: v.optional(v.object({ messageId: v.string(), quote: v.string() })),
    scheduledResume: v.optional(
      v.object({
        at: v.number(),
        timeZone: v.string(),
        expiresAt: v.number(),
        allocations: v.array(
          v.object({
            provider: v.string(),
            accountKey: v.string(),
            windowKey: v.string(),
            windowLabel: v.optional(v.string()),
            authorizedPercent: v.number(),
          }),
        ),
        observations: v.array(allowanceAllocation),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_company_owner", ["companyId", "ownerSubject"]),
  providerAllowanceBindings: defineTable({
    companyId: v.string(),
    budgetId: v.string(),
    scopeKey: v.string(),
  })
    .index("by_scope", ["companyId", "scopeKey"])
    .index("by_budget", ["budgetId"]),
  providerAllowanceHistory: defineTable({
    budgetId: v.string(),
    revision: v.number(),
    allocations: v.array(allowanceAllocation),
    changedBy: v.string(),
    createdAt: v.number(),
  }).index("by_budget", ["budgetId", "revision"]),
};
