// @effect-diagnostics globalDate:off -- Timer transitions use the Convex transaction clock.
/** Personal time sessions. The indexed running-session read serializes starts across devices. */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { sessionFields, sessionWire } from "./lib/businessToolsSchema.ts";

function encode(row: Doc<"trackedSessions">) {
  const { id, description, projectKey, projectName, startedAt, stoppedAt, durationMs } = row;
  return { id, description, projectKey, projectName, startedAt, stoppedAt, durationMs };
}
function validate(value: { description: string; projectKey: string; projectName: string }) {
  const description = value.description.trim();
  if (
    !description ||
    description.length > 2_000 ||
    value.projectKey.length > 1_000 ||
    value.projectName.length > 500
  )
    throw backendError("invalid-arguments", "Enter a description up to 2,000 characters.");
  return { ...value, description };
}
export const listMine = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())), since: v.optional(v.string()) },
  returns: v.object({
    active: v.union(sessionWire, v.null()),
    entries: v.array(sessionWire),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.since && !Number.isFinite(Date.parse(args.since)))
      throw backendError("invalid-arguments", "Choose a valid history period.");
    const active = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state", (q) => q.eq("userId", user._id).eq("state", "running"))
      .first();
    const page = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state_and_stopped_at", (q) =>
        q
          .eq("userId", user._id)
          .eq("state", "stopped")
          .gte("stoppedAt", args.since ? new Date(args.since).toISOString() : ""),
      )
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: 50 });
    return {
      active: active ? encode(active) : null,
      entries: page.page.map(encode),
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Summary reads cover only the current local week, never lifetime history. */
export const recentTotals = query({
  args: { todayStart: v.string(), weekStart: v.string() },
  returns: v.object({
    todayMs: v.number(),
    weekMs: v.number(),
    todayClippedMs: v.number(),
    weekClippedMs: v.number(),
    complete: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const today = Date.parse(args.todayStart),
      week = Date.parse(args.weekStart),
      now = Date.now();
    if (
      ![today, week].every(Number.isFinite) ||
      week > today ||
      today > now ||
      week < now - 8 * 86_400_000 ||
      today < now - 26 * 3_600_000
    ) {
      throw backendError("invalid-arguments", "Choose the current local day and week.");
    }
    const rows = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state_and_stopped_at", (q) =>
        q
          .eq("userId", user._id)
          .eq("state", "stopped")
          .gte("stoppedAt", new Date(week).toISOString()),
      )
      .take(2_001);
    // Never present a read-ceiling subtotal as the full period total.
    if (rows.length > 2_000)
      return { todayMs: 0, weekMs: 0, todayClippedMs: 0, weekClippedMs: 0, complete: false };
    const totals = { todayMs: 0, weekMs: 0, todayClippedMs: 0, weekClippedMs: 0, complete: true };
    for (const row of rows) {
      const start = Date.parse(row.startedAt),
        stop = Date.parse(row.stoppedAt!);
      totals.weekMs += row.durationMs;
      totals.weekClippedMs += Math.max(0, stop - Math.max(start, week));
      if (stop >= today) {
        totals.todayMs += row.durationMs;
        totals.todayClippedMs += Math.max(0, stop - Math.max(start, today));
      }
    }
    return totals;
  },
});
export const start = mutation({
  args: { id: v.string(), ...sessionFields },
  returns: sessionWire,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!args.id.trim()) throw backendError("invalid-arguments", "A timer identity is required.");
    const existing = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if (existing) return encode(existing);
    const active = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state", (q) => q.eq("userId", user._id).eq("state", "running"))
      .first();
    if (active)
      throw backendError(
        "timer-already-running",
        "A timer is already running. Stop that timer before starting another.",
      );
    const fields = validate({
      description: args.description,
      projectKey: args.projectKey,
      projectName: args.projectName,
    });
    const id = await ctx.db.insert("trackedSessions", {
      ...fields,
      id: args.id,
      userId: user._id,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      durationMs: 0,
      state: "running",
    });
    const created = await ctx.db.get(id);
    if (!created) throw backendError("entity-not-found", "The timer could not be started.");
    return encode(created);
  },
});
export const stop = mutation({
  args: { id: v.string() },
  returns: sessionWire,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if (!row) throw backendError("entity-not-found", "That timer does not exist for this account.");
    if (row.state !== "running") return encode(row);
    const now = Date.now();
    const patch = {
      stoppedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - Date.parse(row.startedAt)),
      state: "stopped" as const,
    };
    await ctx.db.patch(row._id, patch);
    return encode({ ...row, ...patch });
  },
});
export const remove = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if (!row || row.state === "deleted") return null;
    if (row.state === "running")
      throw backendError("timer-running", "Stop the timer before deleting it.");
    await ctx.db.patch(row._id, { state: "deleted" });
    return null;
  },
});
export const importLocal = mutation({
  args: {
    entries: v.array(
      v.object({
        id: v.string(),
        ...sessionFields,
        startedAt: v.string(),
        stoppedAt: v.string(),
        durationMs: v.number(),
      }),
    ),
  },
  returns: v.object({ imported: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.entries.length > 200)
      throw backendError("invalid-arguments", "Import no more than 200 sessions at once.");
    let imported = 0;
    for (const entry of args.entries) {
      const id = `local:${entry.id}`;
      const existing = await ctx.db
        .query("trackedSessions")
        .withIndex("by_user_and_id", (q) => q.eq("userId", user._id).eq("id", id))
        .unique();
      if (existing) continue;
      const start = Date.parse(entry.startedAt);
      const stop = Date.parse(entry.stoppedAt);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start)
        throw backendError(
          "invalid-arguments",
          "Imported sessions must have valid start and stop dates.",
        );
      const fields = validate({
        description: entry.description,
        projectKey: entry.projectKey,
        projectName: entry.projectName,
      });
      await ctx.db.insert("trackedSessions", {
        ...fields,
        id,
        userId: user._id,
        startedAt: new Date(start).toISOString(),
        stoppedAt: new Date(stop).toISOString(),
        durationMs: stop - start,
        state: "stopped",
      });
      imported++;
    }
    return { imported };
  },
});
