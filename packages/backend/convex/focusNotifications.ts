// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";

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
});

const READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UNREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NOTIFICATIONS_PER_USER = 200;
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

function cloudTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw backendError("invalid-arguments", "An Attention Event timestamp must be non-negative.");
  }
  return value;
}

function encodeNotification(row: Doc<"focusNotifications">) {
  return {
    id: row.eventId,
    eventId: row.eventId,
    environmentId: row.environmentId,
    threadId: row.threadId,
    projectKey: row.projectKey,
    eventKind: row.eventKind,
    createdAt: row.createdAt,
  };
}

async function stateForUser(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("focusNotificationStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function enforceCap(ctx: MutationCtx, userId: string): Promise<number> {
  const rows = await ctx.db
    .query("focusNotifications")
    .withIndex("by_user_and_created_at", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_NOTIFICATIONS_PER_USER + 1);
  const excess = rows.slice(MAX_NOTIFICATIONS_PER_USER);
  for (const row of excess) await ctx.db.delete(row._id);
  return excess.length;
}

export const record = mutation({
  args: {
    eventId: v.string(),
    environmentId: v.string(),
    environmentPublicKey: v.string(),
    threadId: v.string(),
    projectKey: v.string(),
    eventKind: attentionEventKind,
    createdAt: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const eventId = required(args.eventId, "An Attention Event id");
    const environmentId = required(args.environmentId, "An environment id");
    const environmentPublicKey = required(args.environmentPublicKey, "An environment public key");
    const threadId = required(args.threadId, "A thread id");
    const projectKey = focusProjectKey(args.projectKey);
    const createdAt = cloudTimestamp(args.createdAt);
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

      await ctx.db.insert("focusNotifications", {
        eventId,
        userId,
        environmentId,
        environmentPublicKey,
        threadId,
        projectKey,
        eventKind: args.eventKind,
        createdAt,
      });
      inserted += 1;

      const nextCleanupAt = createdAt + UNREAD_RETENTION_MS;
      const state = await stateForUser(ctx, userId);
      if (state === null) {
        await ctx.db.insert("focusNotificationStates", {
          userId,
          readThrough: 0,
          nextCleanupAt,
          updatedAt: Date.now(),
        });
      } else if (nextCleanupAt < state.nextCleanupAt) {
        await ctx.db.patch(state._id, { nextCleanupAt, updatedAt: Date.now() });
      }
      await enforceCap(ctx, userId);
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
    return (
      await ctx.db
        .query("focusNotifications")
        .withIndex("by_user_and_created_at", (q) =>
          q.eq("userId", user.clerkSubject).gt("createdAt", state?.readThrough ?? 0),
        )
        .take(MAX_NOTIFICATIONS_PER_USER)
    ).length;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(notificationResult),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = Math.max(1, Math.min(Math.trunc(args.limit ?? 50), MAX_NOTIFICATIONS_PER_USER));
    const rows = await ctx.db
      .query("focusNotifications")
      .withIndex("by_user_and_created_at", (q) => q.eq("userId", user.clerkSubject))
      .order("desc")
      .take(limit);
    return rows.map(encodeNotification);
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
      const kept: Doc<"focusNotifications">[] = [];
      for (const [index, row] of rows.entries()) {
        const isRead = row.createdAt <= state.readThrough;
        const readExpired = isRead && row.createdAt + READ_RETENTION_MS <= now;
        const unreadExpired = !isRead && row.createdAt + UNREAD_RETENTION_MS <= now;
        if (index >= MAX_NOTIFICATIONS_PER_USER || readExpired || unreadExpired) {
          await ctx.db.delete(row._id);
          removed += 1;
        } else {
          kept.push(row);
        }
      }

      let nextCleanupAt = NO_CLEANUP_DUE;
      for (const row of kept) {
        nextCleanupAt = Math.min(
          nextCleanupAt,
          row.createdAt <= state.readThrough
            ? row.createdAt + READ_RETENTION_MS
            : row.createdAt + UNREAD_RETENTION_MS,
        );
      }
      await ctx.db.patch(state._id, { nextCleanupAt, updatedAt: now });
    }
    return removed;
  },
});
