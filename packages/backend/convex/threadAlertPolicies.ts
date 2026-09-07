// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
import { ALERT_EVENT_KEYS } from "@spiritdevs/contracts/threadAlerts";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { alertChoices, alertScopeKind, policyForScope } from "./lib/threadAlertPolicy.ts";

function requireScopeKey(scopeKind: "global" | "project" | "thread", scopeKey: string) {
  if (
    scopeKey.length === 0 ||
    scopeKey.trim() !== scopeKey ||
    (scopeKind === "global" && scopeKey !== "global")
  ) {
    throw backendError(
      "invalid-arguments",
      "An alert scope requires a non-empty key; the global key is global.",
    );
  }
}

export const list = query({
  args: { projectKeys: v.array(v.string()), threadKeys: v.array(v.string()) },
  returns: v.array(
    v.object({ scopeKind: alertScopeKind, scopeKey: v.string(), choices: alertChoices }),
  ),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const projectKeys = new Set(args.projectKeys);
    const threadKeys = new Set(args.threadKeys);
    const rows = await ctx.db
      .query("threadAlertPolicies")
      .withIndex("by_user_and_scope", (q) => q.eq("userId", user.clerkSubject))
      .collect();
    return rows.flatMap((row) =>
      row.scopeKind !== "global" &&
      !(row.scopeKind === "project" ? projectKeys : threadKeys).has(row.scopeKey)
        ? []
        : [
            {
              scopeKind: row.scopeKind,
              scopeKey: row.scopeKey,
              choices: Object.fromEntries(
                ALERT_EVENT_KEYS.filter((key) => row[key] !== undefined).map((key) => [
                  key,
                  row[key],
                ]),
              ),
            },
          ],
    );
  },
});

export const upsert = mutation({
  args: { scopeKind: alertScopeKind, scopeKey: v.string(), choices: alertChoices },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    requireScopeKey(args.scopeKind, args.scopeKey);
    if (
      args.scopeKind === "global" &&
      ALERT_EVENT_KEYS.some((key) => args.choices[key] === undefined)
    ) {
      throw backendError(
        "invalid-arguments",
        "Global alert policy requires all four event choices.",
      );
    }
    const existing = await policyForScope(ctx, user.clerkSubject, args.scopeKind, args.scopeKey);
    const choices = Object.fromEntries(
      ALERT_EVENT_KEYS.filter((key) => args.choices[key] !== undefined).map((key) => [
        key,
        args.choices[key],
      ]),
    );
    if (Object.keys(choices).length === 0) {
      if (existing !== null) await ctx.db.delete(existing._id);
    } else {
      const row = {
        userId: user.clerkSubject,
        scopeKind: args.scopeKind,
        scopeKey: args.scopeKey,
        ...choices,
        updatedAt: Date.now(),
      };
      if (existing === null) await ctx.db.insert("threadAlertPolicies", row);
      else await ctx.db.replace(existing._id, row);
    }
    return null;
  },
});

export const reset = mutation({
  args: { scopeKind: alertScopeKind, scopeKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    requireScopeKey(args.scopeKind, args.scopeKey);
    const row = await policyForScope(ctx, user.clerkSubject, args.scopeKind, args.scopeKey);
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});
