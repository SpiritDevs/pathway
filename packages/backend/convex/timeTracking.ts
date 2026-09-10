// @effect-diagnostics globalDate:off -- Timer transitions use the Convex transaction clock.
/** Personal time sessions. The indexed running-session read serializes starts across devices. */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import {
  requireCompanyActor,
  requirePermission,
  requireRecordPermission,
  requireUser,
} from "./lib/identity.ts";
import {
  activitySessionWire,
  sessionFields,
  sessionWire,
  trackedInterval,
  trackedState,
} from "./lib/businessToolsSchema.ts";
import {
  activeSessions,
  encodeActivity,
  manualRunningSession,
  summarizeActivities,
  TRACKED_READ_LIMIT,
  validateIntervals,
} from "./lib/trackedTime.ts";

function encode(row: Doc<"trackedSessions">) {
  const { id, description, projectKey, projectName, startedAt, stoppedAt, durationMs } = row;
  return {
    id,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
    ...(row.environmentId === undefined ? {} : { environmentId: row.environmentId }),
    description,
    projectKey,
    projectName,
    startedAt,
    stoppedAt,
    durationMs,
    source: row.source ?? "manual",
  };
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
    const active = await manualRunningSession(ctx, user._id);
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
      const stop = Date.parse(row.stoppedAt!);
      totals.weekMs += row.durationMs;
      totals.weekClippedMs += summarizeActivities([encodeActivity(row)], week, now + 1, now).workMs;
      if (stop >= today) {
        totals.todayMs += row.durationMs;
        totals.todayClippedMs += summarizeActivities(
          [encodeActivity(row)],
          today,
          now + 1,
          now,
        ).workMs;
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
    if (existing) {
      if (existing.source && existing.source !== "manual")
        throw backendError("invalid-arguments", "Choose a new manual timer identity.");
      return encode(existing);
    }
    const active = await manualRunningSession(ctx, user._id);
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
      ...(args.title?.trim() ? { title: args.title.trim().slice(0, 200) } : {}),
      id: args.id,
      userId: user._id,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      durationMs: 0,
      state: "running",
      source: "manual",
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
    if (row.source === "agent")
      throw backendError(
        "invalid-arguments",
        "Agent timers follow their thread. Pause or stop the agent instead.",
      );
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
    if (row.state === "running" || row.state === "paused")
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

export const listActive = query({
  args: {},
  returns: v.object({ sessions: v.array(activitySessionWire), complete: v.boolean() }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const result = await activeSessions(ctx, user._id);
    return { sessions: result.rows.map(encodeActivity), complete: result.complete };
  },
});

const totalsWireFields = {
  workMs: v.number(),
  elapsedMs: v.number(),
  manualMs: v.number(),
  agentMs: v.number(),
  issueMs: v.number(),
};
export const overview = query({
  args: {
    since: v.string(),
    until: v.string(),
    timezoneOffsetMinutes: v.optional(v.number()),
    dayBoundaries: v.optional(
      v.array(v.object({ date: v.string(), start: v.number(), end: v.number() })),
    ),
    projectKey: v.optional(v.string()),
  },
  returns: v.object({
    complete: v.boolean(),
    totals: v.object(totalsWireFields),
    projects: v.array(
      v.object({ projectKey: v.string(), projectName: v.string(), ...totalsWireFields }),
    ),
    days: v.array(v.object({ date: v.string(), ...totalsWireFields })),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const since = Date.parse(args.since),
      until = Date.parse(args.until),
      now = Date.now();
    const offset = args.timezoneOffsetMinutes ?? 0;
    if (
      !Number.isFinite(since) ||
      !Number.isFinite(until) ||
      since >= until ||
      until - since > 93 * 86_400_000 ||
      !Number.isInteger(offset) ||
      Math.abs(offset) > 14 * 60
    ) {
      throw backendError("invalid-arguments", "Choose a time tracking range of at most 93 days.");
    }
    const boundaries = args.dayBoundaries;
    if (
      boundaries &&
      (boundaries.length === 0 ||
        boundaries.length > 94 ||
        boundaries[0]!.start > since ||
        boundaries.at(-1)!.end < until ||
        boundaries.some(
          (day, index) =>
            !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
            !Number.isFinite(day.start) ||
            !Number.isFinite(day.end) ||
            day.end - day.start < 22 * 3_600_000 ||
            day.end - day.start > 26 * 3_600_000 ||
            (index > 0 &&
              (day.start !== boundaries[index - 1]!.end ||
                day.date <= boundaries[index - 1]!.date)),
        ))
    ) {
      throw backendError(
        "invalid-arguments",
        "Choose contiguous local calendar days covering the time range.",
      );
    }
    const [active, stopped] = await Promise.all([
      activeSessions(ctx, user._id),
      ctx.db
        .query("trackedSessions")
        .withIndex("by_user_and_state_and_stopped_at", (q) =>
          q
            .eq("userId", user._id)
            .eq("state", "stopped")
            .gte("stoppedAt", new Date(since).toISOString()),
        )
        .order("desc")
        .take(TRACKED_READ_LIMIT + 1),
    ]);
    const complete = active.complete && stopped.length + active.rows.length <= TRACKED_READ_LIMIT;
    const sessions = [...active.rows, ...stopped]
      .slice(0, TRACKED_READ_LIMIT)
      .filter(
        (row) =>
          Date.parse(row.startedAt) < until &&
          (args.projectKey === undefined || row.projectKey === args.projectKey),
      )
      .map(encodeActivity)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // Leave paginated history available, but never label a bounded subtotal as full analytics.
    if (!complete)
      return {
        complete,
        totals: summarizeActivities([], since, until, now),
        projects: [],
        days: [],
      };
    const groups = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const group = groups.get(session.projectKey) ?? [];
      group.push(session);
      groups.set(session.projectKey, group);
    }
    const projects = [...groups]
      .map(([projectKey, group]) => ({
        projectKey,
        projectName: group[0]!.projectName,
        ...summarizeActivities(group, since, until, now),
      }))
      .sort((a, b) => b.workMs - a.workMs);
    const days = [];
    const dayMs = 86_400_000,
      offsetMs = offset * 60_000;
    if (boundaries) {
      for (const day of boundaries) {
        if (day.end <= since || day.start >= until) continue;
        days.push({
          date: day.date,
          ...summarizeActivities(
            sessions,
            Math.max(since, day.start),
            Math.min(until, day.end),
            now,
          ),
        });
      }
    } else {
      for (
        let day = Math.floor((since - offsetMs) / dayMs) * dayMs + offsetMs;
        day < until;
        day += dayMs
      ) {
        days.push({
          date: new Date(day - offsetMs).toISOString().slice(0, 10),
          ...summarizeActivities(sessions, Math.max(since, day), Math.min(until, day + dayMs), now),
        });
      }
    }
    return {
      complete,
      totals: summarizeActivities(sessions, since, until, now),
      projects,
      days,
    };
  },
});

/** The authenticated environment publishes durable snapshots; revisions make reconnect replay safe. */
export const syncAgentSession = mutation({
  args: {
    companyId: v.string(),
    session: v.object({
      id: v.string(),
      threadId: v.string(),
      localProjectId: v.string(),
      description: v.string(),
      title: v.optional(v.string()),
      startedAt: v.string(),
      stoppedAt: v.union(v.string(), v.null()),
      state: trackedState,
      intervals: v.array(trackedInterval),
      runningSince: v.union(v.number(), v.null()),
      observedAt: v.number(),
      revision: v.number(),
    }),
  },
  returns: v.object({
    outcome: v.union(v.literal("published"), v.literal("unchanged"), v.literal("unbound")),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    if (actor.kind !== "environment")
      throw backendError(
        "permission-denied",
        "Only the registered environment may publish agent time.",
      );
    const session = args.session;
    const id = `agent:${actor.company._id}:${actor.registration.environmentId}:${session.id}`;
    const existing = await ctx.db
      .query("trackedSessions")
      .withIndex("by_company_environment_and_id", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("environmentId", actor.registration.environmentId)
          .eq("id", id),
      )
      .unique();
    if (
      existing &&
      (existing.state === "deleted" ||
        (existing.revision ?? -1) >= session.revision ||
        (existing.state === "stopped" && session.state !== "stopped"))
    )
      return { outcome: "unchanged" as const };
    if (
      existing &&
      (existing.source !== "agent" ||
        existing.threadId !== session.threadId ||
        Date.parse(existing.startedAt) !== Date.parse(session.startedAt) ||
        (existing.localProjectId !== undefined &&
          existing.localProjectId !== session.localProjectId))
    ) {
      throw backendError(
        "invalid-arguments",
        "An agent time snapshot cannot change its original activity identity.",
      );
    }

    // Final receipts may arrive after project removal. The authenticated environment can finish
    // its own existing session without moving it to a new owner or requiring a surviving binding.
    let project: Doc<"cloudProjects"> | null = null;
    if (!existing || session.state !== "stopped") {
      const bindings = await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_environment", (q) =>
          q
            .eq("companyId", actor.company._id)
            .eq("environmentId", actor.registration.environmentId),
        )
        .take(2_001);
      if (bindings.length > 2_000)
        throw backendError("invalid-arguments", "This environment has too many project bindings.");
      const binding = bindings.find(
        (row) => row.localProjectId === session.localProjectId && row.status === "active",
      );
      if (!binding) return { outcome: "unbound" as const };
      project = await ctx.db.get(binding.cloudProjectId);
      if (!project || project.deletedAt !== null) return { outcome: "unbound" as const };
      requireRecordPermission(actor, "projects.manage", project.teamIds);
    }
    const owner =
      !existing && actor.registration.registeredByMembershipId !== null
        ? await ctx.db.get(actor.registration.registeredByMembershipId)
        : null;
    const userId =
      existing?.userId ??
      (owner?.state === "active" && owner.companyId === actor.company._id
        ? owner.userId
        : undefined);
    if (userId === undefined) return { outcome: "unbound" as const };
    const durationMs = validateIntervals(session.intervals);
    const start = Date.parse(session.startedAt),
      stop = session.stoppedAt === null ? null : Date.parse(session.stoppedAt);
    if (
      !session.id.trim() ||
      session.id.length > 1_000 ||
      !session.threadId.trim() ||
      session.threadId.length > 1_000 ||
      !Number.isSafeInteger(session.revision) ||
      session.revision < 0 ||
      !Number.isFinite(start) ||
      !Number.isFinite(session.observedAt) ||
      session.observedAt < start ||
      session.observedAt > Date.now() + 60_000 ||
      (stop !== null && (!Number.isFinite(stop) || stop < start || stop > session.observedAt)) ||
      (session.state === "stopped") !== (stop !== null) ||
      (session.state === "running") !== (session.runningSince !== null) ||
      (session.runningSince !== null &&
        (!Number.isFinite(session.runningSince) ||
          session.runningSince < start ||
          session.runningSince > session.observedAt)) ||
      session.intervals.some(
        (interval) =>
          interval.start < start ||
          interval.end > (session.runningSince ?? stop ?? session.observedAt),
      )
    ) {
      throw backendError(
        "invalid-arguments",
        "Agent time snapshot has inconsistent dates or state.",
      );
    }
    const fields = validate({
      description:
        existing && session.state === "stopped" && !session.title
          ? existing.description
          : session.description,
      projectKey: existing?.projectKey ?? project!.id,
      projectName: existing?.projectName ?? project!.name,
    });
    const patch = {
      ...fields,
      ...(session.title ? { title: session.title.slice(0, 200) } : {}),
      startedAt: new Date(start).toISOString(),
      stoppedAt: stop === null ? null : new Date(stop).toISOString(),
      durationMs,
      state: session.state,
      source: "agent" as const,
      threadId: session.threadId,
      companyId: actor.company._id,
      environmentId: actor.registration.environmentId,
      localProjectId: existing?.localProjectId ?? session.localProjectId,
      intervals: session.intervals,
      runningSince: session.runningSince,
      observedAt: session.observedAt,
      revision: session.revision,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("trackedSessions", { id, userId, ...patch });
    return { outcome: "published" as const };
  },
});
