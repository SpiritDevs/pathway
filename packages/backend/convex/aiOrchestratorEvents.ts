import { patchEnvironmentPresence } from "./lib/environmentRuntime.ts";
// @effect-diagnostics globalDate:off -- The presence sweep uses Convex transaction time.
import { notifyOrchestratorEnvironmentChange } from "./lib/aiOrchestratorEnvironmentSignals.ts";
/** Event fan-out runs after the originating domain transaction commits. */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { notifyOrchestratorIssueChanges } from "./lib/aiOrchestratorIssueSignals.ts";

export const issueChanges = internalMutation({
  args: { companyId: v.id("companies"), issueIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    if (company?.lifecycleState === "active")
      await notifyOrchestratorIssueChanges(ctx, company, args.issueIds);
  },
});

/** Each registration transitions once; the next page is eligible on the next cloud clock tick. */
export const checkOffline = internalMutation({
  args: {},
  handler: async (ctx) => {
    const registrations = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_orchestrator_presence", (q) =>
        q
          .eq("state", "active")
          .eq("orchestratorPresence", "online")
          .lt("lastSeenAt", Date.now() - 90000),
      )
      .take(100);
    const presenceRows = await ctx.db
      .query("environmentPresence")
      .withIndex("by_presence", (q) =>
        q.eq("orchestratorPresence", "online").lt("lastSeenAt", Date.now() - 90000),
      )
      .take(100);
    for (const presence of presenceRows) {
      await ctx.db.patch(presence._id, { orchestratorPresence: "offline" });
      const registration = await ctx.db.get(presence.registrationId);
      if (registration?.state === "active")
        await notifyOrchestratorEnvironmentChange(ctx, registration);
    }
    for (const registration of registrations) {
      await patchEnvironmentPresence(ctx, registration, { orchestratorPresence: "offline" });
      await notifyOrchestratorEnvironmentChange(ctx, registration);
    }
  },
});
