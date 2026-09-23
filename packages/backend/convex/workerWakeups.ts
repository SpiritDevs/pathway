// @effect-diagnostics globalDate:off -- Reasoning readiness uses the Convex query clock.
/** Read-only hints: claims still own authorization, readiness, and lease fencing. */
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { requireCompanyActor } from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";

export const pending = query({
  args: {
    companyId: v.string(),
    kind: v.union(
      v.literal("commands"),
      v.literal("mail"),
      v.literal("reasoning"),
      v.literal("inspections"),
      v.literal("results"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, { companyId, kind }) => {
    const actor = await requireCompanyActor(ctx, companyId);
    if (actor.kind !== "environment")
      throw backendError("permission-denied", "Only environments may watch worker queues.");
    const environmentId = actor.registration.environmentId;
    if (kind === "commands") {
      for (const state of ["pending", "claimed"] as const) {
        if (
          await ctx.db
            .query("environmentCommands")
            .withIndex("by_company_target_state", (q) =>
              q
                .eq("companyId", actor.company._id)
                .eq("targetEnvironmentId", environmentId)
                .eq("state", state),
            )
            .first()
        )
          return true;
      }
      return false;
    }
    if (kind === "mail") {
      const groups = await Promise.all([
        ctx.db
          .query("mailAccounts")
          .withIndex("by_primary", (q) =>
            q.eq("companyId", actor.company._id).eq("primaryEnvironmentId", environmentId),
          )
          .take(26),
        ctx.db
          .query("mailAccounts")
          .withIndex("by_backup", (q) =>
            q.eq("companyId", actor.company._id).eq("backupEnvironmentId", environmentId),
          )
          .take(26),
      ]);
      // Claim rotates oversized groups. Keep its recovery cadence until it can visit them all.
      if (groups.some((group) => group.length > 25)) return true;
      for (const account of new Map(
        groups.flat().map((account) => [account._id, account]),
      ).values()) {
        if (account.status !== "active" || !account.brain) continue;
        for (const status of ["pending", "running"] as const) {
          if (
            await ctx.db
              .query("mailJobs")
              .withIndex("by_account_status", (q) =>
                q.eq("accountId", account.id).eq("status", status),
              )
              .first()
          )
            return true;
        }
      }
      return false;
    }
    if (kind === "inspections") {
      return (
        (await ctx.db
          .query("aiOrchestratorInspections")
          .withIndex("by_environment_status", (q) =>
            q.eq("companyId", companyId).eq("environmentId", environmentId).eq("status", "pending"),
          )
          .first()) !== null
      );
    }
    if (kind === "reasoning") {
      // Only claimable jobs wake reasoning. Delegated work refreshes itself on its own events.
      const now = Date.now();
      if (
        await ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_company_ready", (q) =>
            q.eq("companyId", companyId).eq("status", "queued").lte("notBefore", now),
          )
          .first()
      )
        return true;
      const running = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "running"))
        .take(32);
      return running.some((job) => job.leaseExpiresAt <= now);
    }
    if (
      await ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_environment_read", (q) =>
          q.eq("companyId", companyId).eq("environmentId", environmentId).eq("readRequested", true),
        )
        .first()
    )
      return true;
    for (const status of ["working", "unknown"] as const) {
      if (
        await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_company_environment_status", (q) =>
            q.eq("companyId", companyId).eq("environmentId", environmentId).eq("status", status),
          )
          .first()
      )
        return true;
    }
    for (const collected of [false, undefined]) {
      for (const status of ["completed", "failed", "cancelled"] as const) {
        if (
          await ctx.db
            .query("aiOrchestratorWork")
            .withIndex("by_environment_result", (q) =>
              q
                .eq("companyId", companyId)
                .eq("environmentId", environmentId)
                .eq("resultCollected", collected)
                .eq("status", status),
            )
            .first()
        )
          return true;
      }
    }
    return false;
  },
});
