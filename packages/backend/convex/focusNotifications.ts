// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
import { FOCUS_NOTIFICATION_MAX_PER_USER } from "@spiritdevs/contracts/focus";
import {
  alertEventKey,
  alertProjectScopeKey,
  alertThreadScopeKey,
  resolveAlertPolicy,
} from "@spiritdevs/contracts/threadAlerts";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";
import { policyForScope } from "./lib/threadAlertPolicy.ts";

const attentionEventKind = v.union(
  v.literal("finished-unsettled"),
  v.literal("pending-approval"),
  v.literal("awaiting-input"),
  v.literal("failed"),
);

const notificationResult = v.object({
  id: v.string(),
  eventId: v.string(),
  environmentId: v.string(),
  threadId: v.string(),
  projectKey: v.string(),
  eventKind: attentionEventKind,
  createdAt: v.number(),
  alertProjectKey: v.optional(v.string()),
  alertEligibleAtCreation: v.boolean(),
  isRead: v.boolean(),
});

const READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UNREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NOTIFICATIONS_PER_USER = FOCUS_NOTIFICATION_MAX_PER_USER;
const CLEANUP_USER_BATCH_SIZE = 50;
const NO_CLEANUP_DUE = 8_640_000_000_000_000;

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw backendError("invalid-arguments", `${label} is required.`);
  return trimmed;
}

function focusProjectKey(value: string): string {
  const projectKey = required(value, "A project key");
  if (!/^[^:]+:.+$/.test(projectKey)) {
    throw backendError(
      "invalid-arguments",
      "A Focus project key must contain an environment id and project id.",
    );
  }
  return projectKey;
}

function encodeNotification(row: Doc<"focusNotifications">, isRead: boolean) {
  return {
    id: row.eventId,
    eventId: row.eventId,
    environmentId: row.environmentId,
    threadId: row.threadId,
    projectKey: row.projectKey,
    eventKind: row.eventKind,
    createdAt: row.createdAt,
    ...(row.alertProjectKey === undefined ? {} : { alertProjectKey: row.alertProjectKey }),
    alertEligibleAtCreation: row.alertEligibleAtCreation ?? false,
    isRead,
  };
}

async function stateForUser(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("focusNotificationStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function acknowledgementsForUser(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("focusNotificationAcknowledgements")
    .withIndex("by_user_and_event", (q) => q.eq("userId", userId))
    .collect();
}

async function deleteNotification(ctx: MutationCtx, row: Doc<"focusNotifications">) {
  const acknowledgement = await ctx.db
    .query("focusNotificationAcknowledgements")
    .withIndex("by_user_and_event", (q) => q.eq("userId", row.userId).eq("eventId", row.eventId))
    .unique();
  if (acknowledgement !== null) await ctx.db.delete(acknowledgement._id);
  await ctx.db.delete(row._id);
}

async function enforceCap(
  ctx: MutationCtx,
  userId: string,
): Promise<ReadonlyArray<Doc<"focusNotifications">>> {
  const rows = await ctx.db
    .query("focusNotifications")
    .withIndex("by_user_and_created_at", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_NOTIFICATIONS_PER_USER + 1);
  const excess = rows.slice(MAX_NOTIFICATIONS_PER_USER);
  for (const row of excess) await deleteNotification(ctx, row);
  return rows.slice(0, MAX_NOTIFICATIONS_PER_USER);
}

function nextCleanupAtForRows(
  rows: ReadonlyArray<Doc<"focusNotifications">>,
  readThrough: number,
  acknowledged: ReadonlySet<string>,
): number {
  let nextCleanupAt = NO_CLEANUP_DUE;
  for (const row of rows) {
    nextCleanupAt = Math.min(
      nextCleanupAt,
      row.createdAt <= readThrough || acknowledged.has(row.eventId)
        ? row.createdAt + READ_RETENTION_MS
        : row.createdAt + UNREAD_RETENTION_MS,
    );
  }
  return nextCleanupAt;
}

export const record = mutation({
  args: {
    eventId: v.string(),
    environmentId: v.string(),
    environmentPublicKey: v.string(),
    threadId: v.string(),
    projectKey: v.string(),
    alertProjectKey: v.optional(v.string()),
    eventKind: attentionEventKind,
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const eventId = required(args.eventId, "An Attention Event id");
    const environmentId = required(args.environmentId, "An environment id");
    const environmentPublicKey = required(args.environmentPublicKey, "An environment public key");
    const threadId = required(args.threadId, "A thread id");
    const projectKey = focusProjectKey(args.projectKey);
    const projectPrefix = `${environmentId}:`;
    if (!projectKey.startsWith(projectPrefix)) {
      throw backendError(
        "invalid-arguments",
        "The project key must belong to the event environment.",
      );
    }
    const alertProjectKey =
      args.alertProjectKey === undefined
        ? alertProjectScopeKey(environmentId, projectKey.slice(projectPrefix.length))
        : required(args.alertProjectKey, "An alert project key");
    const now = Date.now();
    const links = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_environment_key_and_revoked", (q) =>
        q
          .eq("environmentId", environmentId)
          .eq("environmentPublicKey", environmentPublicKey)
          .eq("revokedAt", null),
      )
      .collect();
    const userIds = new Set(links.map((link) => link.userId));
    let inserted = 0;

    for (const userId of userIds) {
      const duplicate = await ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_event", (q) => q.eq("userId", userId).eq("eventId", eventId))
        .unique();
      if (duplicate !== null) continue;

      const state = await stateForUser(ctx, userId);
      const createdAt = Math.max(now, (state?.readThrough ?? -1) + 1);

      const [globalPolicy, projectPolicy, threadPolicy] = await Promise.all([
        policyForScope(ctx, userId, "global", "global"),
        policyForScope(ctx, userId, "project", alertProjectKey),
        policyForScope(ctx, userId, "thread", alertThreadScopeKey(environmentId, threadId)),
      ]);
      const alertEligibleAtCreation = resolveAlertPolicy(
        globalPolicy ?? undefined,
        projectPolicy ?? undefined,
        threadPolicy ?? undefined,
      )[alertEventKey(args.eventKind)];
      await ctx.db.insert("focusNotifications", {
        eventId,
        userId,
        environmentId,
        environmentPublicKey,
        threadId,
        projectKey,
        eventKind: args.eventKind,
        alertProjectKey,
        alertEligibleAtCreation,
        createdAt,
      });
      inserted += 1;

      const keptRows = await enforceCap(ctx, userId);
      const acknowledged = new Set(
        (await acknowledgementsForUser(ctx, userId)).map((row) => row.eventId),
      );
      const nextCleanupAt = nextCleanupAtForRows(keptRows, state?.readThrough ?? 0, acknowledged);
      if (state === null) {
        await ctx.db.insert("focusNotificationStates", {
          userId,
          readThrough: 0,
          nextCleanupAt,
          updatedAt: now,
        });
      } else if (nextCleanupAt !== state.nextCleanupAt) {
        await ctx.db.patch(state._id, { nextCleanupAt, updatedAt: now });
      }
    }
    return inserted;
  },
});

export const unreadCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const state = await stateForUser(ctx, user.clerkSubject);
    const acknowledged = new Set(
      (await acknowledgementsForUser(ctx, user.clerkSubject)).map((row) => row.eventId),
    );
    return (
      await ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_created_at", (q) =>
          q.eq("userId", user.clerkSubject).gt("createdAt", state?.readThrough ?? 0),
        )
        .take(MAX_NOTIFICATIONS_PER_USER)
    ).filter((row) => !acknowledged.has(row.eventId)).length;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(notificationResult),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = Math.max(
      1,
      Math.min(Math.trunc(args.limit ?? MAX_NOTIFICATIONS_PER_USER), MAX_NOTIFICATIONS_PER_USER),
    );
    const rows = await ctx.db
      .query("focusNotifications")
      .withIndex("by_user_and_created_at", (q) => q.eq("userId", user.clerkSubject))
      .order("desc")
      .take(limit);
    const state = await stateForUser(ctx, user.clerkSubject);
    const acknowledged = new Set(
      (await acknowledgementsForUser(ctx, user.clerkSubject)).map((row) => row.eventId),
    );
    return rows.map((row) =>
      encodeNotification(
        row,
        row.createdAt <= (state?.readThrough ?? 0) || acknowledged.has(row.eventId),
      ),
    );
  },
});

export const markRead = mutation({
  args: { eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("focusNotifications")
      .withIndex("by_user_and_event", (q) =>
        q.eq("userId", user.clerkSubject).eq("eventId", args.eventId),
      )
      .unique();
    if (row === null)
      throw backendError("entity-not-found", "The Attention Event is not available.");
    const state = await stateForUser(ctx, user.clerkSubject);
    if (row.createdAt <= (state?.readThrough ?? 0)) return null;
    const existing = await ctx.db
      .query("focusNotificationAcknowledgements")
      .withIndex("by_user_and_event", (q) =>
        q.eq("userId", user.clerkSubject).eq("eventId", args.eventId),
      )
      .unique();
    if (existing !== null) return null;
    const now = Date.now();
    await ctx.db.insert("focusNotificationAcknowledgements", {
      userId: user.clerkSubject,
      eventId: args.eventId,
      acknowledgedAt: now,
    });
    const nextCleanupAt = Math.min(
      state?.nextCleanupAt ?? NO_CLEANUP_DUE,
      row.createdAt + READ_RETENTION_MS,
    );
    if (state !== null) await ctx.db.patch(state._id, { nextCleanupAt, updatedAt: now });
    else
      await ctx.db.insert("focusNotificationStates", {
        userId: user.clerkSubject,
        readThrough: 0,
        nextCleanupAt,
        updatedAt: now,
      });
    return null;
  },
});

export const markAllRead = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const [oldest, latest] = await Promise.all([
      ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_created_at", (q) => q.eq("userId", user.clerkSubject))
        .order("asc")
        .first(),
      ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_created_at", (q) => q.eq("userId", user.clerkSubject))
        .order("desc")
        .first(),
    ]);
    const state = await stateForUser(ctx, user.clerkSubject);
    const now = Date.now();
    const readThrough = Math.max(now, latest?.createdAt ?? 0, state?.readThrough ?? 0);
    for (const row of await acknowledgementsForUser(ctx, user.clerkSubject))
      await ctx.db.delete(row._id);
    const nextCleanupAt = oldest === null ? NO_CLEANUP_DUE : oldest.createdAt + READ_RETENTION_MS;
    if (state === null) {
      await ctx.db.insert("focusNotificationStates", {
        userId: user.clerkSubject,
        readThrough,
        nextCleanupAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(state._id, { readThrough, nextCleanupAt, updatedAt: now });
    }
    return null;
  },
});

export const pruneExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const states = await ctx.db
      .query("focusNotificationStates")
      .withIndex("by_next_cleanup", (q) => q.lt("nextCleanupAt", now + 1))
      .take(CLEANUP_USER_BATCH_SIZE);
    let removed = 0;

    for (const state of states) {
      const rows = await ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_created_at", (q) => q.eq("userId", state.userId))
        .order("desc")
        .collect();
      const acknowledged = new Set(
        (await acknowledgementsForUser(ctx, state.userId)).map((row) => row.eventId),
      );
      const kept: Doc<"focusNotifications">[] = [];
      for (const [index, row] of rows.entries()) {
        const isRead = row.createdAt <= state.readThrough || acknowledged.has(row.eventId);
        const readExpired = isRead && row.createdAt + READ_RETENTION_MS <= now;
        const unreadExpired = !isRead && row.createdAt + UNREAD_RETENTION_MS <= now;
        if (index >= MAX_NOTIFICATIONS_PER_USER || readExpired || unreadExpired) {
          await deleteNotification(ctx, row);
          removed += 1;
        } else {
          kept.push(row);
        }
      }

      const nextCleanupAt = nextCleanupAtForRows(kept, state.readThrough, acknowledged);
      await ctx.db.patch(state._id, { nextCleanupAt, updatedAt: now });
    }
    return removed;
  },
});
