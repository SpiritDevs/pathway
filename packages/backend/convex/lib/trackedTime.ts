// @effect-diagnostics globalDate:off -- Convex transaction clock and ISO wire dates.
/** Active intervals are measured separately from credited work, which can overlap or have a minimum. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { backendError } from "./errors.ts";

export interface TrackedInterval {
  start: number;
  end: number;
}
export const AGENT_ACTIVITY_LEASE_MS = 90_000;
export const TRACKED_READ_LIMIT = 2_000;

export function validateIntervals(intervals: readonly TrackedInterval[], maxCount = 10_000) {
  if (intervals.length > maxCount)
    throw backendError("invalid-arguments", "Too many time tracking intervals.");
  let previousEnd = -Infinity;
  for (const interval of intervals) {
    if (
      !Number.isFinite(interval.start) ||
      !Number.isFinite(interval.end) ||
      interval.start < 0 ||
      interval.end < interval.start ||
      interval.start < previousEnd
    ) {
      throw backendError(
        "invalid-arguments",
        "Time tracking intervals must be ordered and cannot overlap.",
      );
    }
    previousEnd = interval.end;
  }
  return intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

export function encodeActivity(row: Doc<"trackedSessions">) {
  const source = row.source ?? "manual";
  const intervals =
    row.intervals ??
    (row.stoppedAt ? [{ start: Date.parse(row.startedAt), end: Date.parse(row.stoppedAt) }] : []);
  return {
    id: row.id,
    ...(row.title ? { title: row.title } : {}),
    description: row.description,
    projectKey: row.projectKey,
    projectName: row.projectName,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    durationMs: row.durationMs,
    source,
    state: row.state === "deleted" ? ("stopped" as const) : row.state,
    threadId: row.threadId ?? null,
    issueId: row.issueId ?? null,
    intervals,
    runningSince:
      row.runningSince ??
      (row.state === "running" && source === "manual" ? Date.parse(row.startedAt) : null),
    observedAt: row.observedAt ?? null,
  };
}
export type ActivitySession = ReturnType<typeof encodeActivity>;

/** Legacy rows omit source; both index ranges participate in the manual-start transaction. */
export async function manualRunningSession(ctx: QueryCtx, userId: Id<"users">) {
  const [legacy, manual] = await Promise.all(
    [undefined, "manual" as const].map((source) =>
      ctx.db
        .query("trackedSessions")
        .withIndex("by_user_state_source", (q) =>
          q.eq("userId", userId).eq("state", "running").eq("source", source),
        )
        .first(),
    ),
  );
  return manual ?? legacy ?? null;
}

export async function activeSessions(ctx: QueryCtx, userId: Id<"users">) {
  const [running, paused] = await Promise.all([
    ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state", (q) => q.eq("userId", userId).eq("state", "running"))
      .take(TRACKED_READ_LIMIT + 1),
    ctx.db
      .query("trackedSessions")
      .withIndex("by_user_and_state", (q) => q.eq("userId", userId).eq("state", "paused"))
      .take(TRACKED_READ_LIMIT + 1),
  ]);
  return {
    rows: [...running, ...paused].slice(0, TRACKED_READ_LIMIT),
    complete: running.length + paused.length <= TRACKED_READ_LIMIT,
  };
}

export async function recordIssueSession(
  ctx: MutationCtx,
  input: {
    userId: Id<"users">;
    issueId: string;
    companyId: Id<"companies">;
    description: string;
    projectKey: string;
    projectName: string;
    activeIntervals?: readonly TrackedInterval[];
  },
) {
  const id = `issue:${input.companyId}:${input.issueId}`;
  const existing = await ctx.db
    .query("trackedSessions")
    .withIndex("by_user_and_id", (q) => q.eq("userId", input.userId).eq("id", id))
    .unique();
  if (existing) return;
  const intervals = [...(input.activeIntervals ?? [])];
  const measuredMs = validateIntervals(intervals, 256);
  const now = Date.now();
  if (
    measuredMs > 86_400_000 ||
    intervals.some(
      (interval) => interval.end > now + 5_000 || interval.start < now - 30 * 86_400_000,
    )
  )
    throw backendError(
      "invalid-arguments",
      "Task composition time must be within the last 30 days and below 24 hours.",
    );
  // Duration is derived from actual intervals; clients cannot inflate credit with an independent number.
  await ctx.db.insert("trackedSessions", {
    id,
    userId: input.userId,
    companyId: input.companyId,
    issueId: input.issueId,
    source: "issue",
    title: input.description.slice(0, 200),
    description: `Created task: ${input.description}`.slice(0, 2_000),
    projectKey: input.projectKey,
    projectName: input.projectName,
    startedAt: new Date(intervals[0]?.start ?? now).toISOString(),
    stoppedAt: new Date(now).toISOString(),
    durationMs: Math.max(60_000, measuredMs),
    state: "stopped",
    intervals,
  });
}

export function unionDuration(intervals: readonly TrackedInterval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0,
    end = -Infinity;
  for (const interval of sorted) {
    total += Math.max(0, interval.end - Math.max(interval.start, end));
    end = Math.max(end, interval.end);
  }
  return total;
}
export function activityIntervals(session: ActivitySession, now: number) {
  const intervals = [...session.intervals];
  if (session.state === "running" && session.runningSince !== null) {
    const end =
      session.source === "agent"
        ? Math.min(now, (session.observedAt ?? session.runningSince) + AGENT_ACTIVITY_LEASE_MS)
        : now;
    intervals.push({ start: session.runningSince, end: Math.max(session.runningSince, end) });
  }
  return intervals;
}
export function summarizeActivities(
  sessions: readonly ActivitySession[],
  since: number,
  until: number,
  now: number,
) {
  const totals = { workMs: 0, elapsedMs: 0, manualMs: 0, agentMs: 0, issueMs: 0 };
  const allIntervals: TrackedInterval[] = [];
  for (const session of sessions) {
    const intervals = activityIntervals(session, now)
      .map(({ start, end }) => ({ start: Math.max(start, since), end: Math.min(end, until) }))
      .filter(({ start, end }) => end > start);
    let workMs = intervals.reduce((sum, { start, end }) => sum + end - start, 0);
    if (session.source === "issue") {
      const completedAt = Date.parse(session.stoppedAt!);
      const measuredMs = session.intervals.reduce((sum, { start, end }) => sum + end - start, 0);
      // Minimum credit belongs to the creation day; it never invents an elapsed interval.
      if (completedAt >= since && completedAt < until)
        workMs += Math.max(0, session.durationMs - measuredMs);
    }
    totals.workMs += workMs;
    totals[`${session.source}Ms`] += workMs;
    allIntervals.push(...intervals);
  }
  totals.elapsedMs = unionDuration(allIntervals);
  return totals;
}
