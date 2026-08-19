/** Atomic Convex persistence operations used exclusively by the hosted relay Worker. */
import { v } from "convex/values";
import * as DateTime from "effect/DateTime";

import type { Doc, Id, TableNames } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { isEnvironmentIdentity, requireIdentity } from "./lib/identity.ts";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const preferences = v.object({
  liveActivitiesEnabled: v.boolean(),
  notificationsEnabled: v.boolean(),
  notifyOnApproval: v.boolean(),
  notifyOnInput: v.boolean(),
  notifyOnCompletion: v.boolean(),
  notifyOnFailure: v.boolean(),
});
const activityPhase = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting_for_approval"),
  v.literal("waiting_for_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stale"),
);
const activityState = v.object({
  environmentId: v.string(),
  threadId: v.string(),
  projectTitle: v.string(),
  threadTitle: v.string(),
  phase: activityPhase,
  headline: v.string(),
  detail: v.optional(v.string()),
  modelTitle: v.string(),
  updatedAt: v.string(),
  deepLink: v.string(),
});
const aggregateRow = v.object({
  environmentId: v.string(),
  threadId: v.string(),
  projectTitle: v.string(),
  threadTitle: v.string(),
  modelTitle: v.string(),
  phase: activityPhase,
  status: v.string(),
  updatedAt: v.string(),
  deepLink: v.string(),
});
const aggregateState = v.object({
  title: v.string(),
  subtitle: v.string(),
  activeCount: v.number(),
  updatedAt: v.string(),
  activities: v.array(aggregateRow),
});
const endpointProviderKind = v.union(
  v.literal("manual"),
  v.literal("cloudflare_tunnel"),
  v.literal("pathway_relay"),
);
const deliveryKind = v.union(
  v.literal("live_activity_start"),
  v.literal("live_activity_update"),
  v.literal("live_activity_end"),
  v.literal("push_notification"),
);
const deviceResult = v.object({
  deviceId: v.string(),
  label: v.string(),
  platform: v.literal("ios"),
  iosMajorVersion: v.number(),
  appVersion: nullableString,
  notifications: v.object({
    enabled: v.boolean(),
    notifyOnApproval: v.boolean(),
    notifyOnInput: v.boolean(),
    notifyOnCompletion: v.boolean(),
    notifyOnFailure: v.boolean(),
  }),
  liveActivities: v.object({ enabled: v.boolean() }),
  updatedAt: v.string(),
});
const liveActivityTargetResult = v.object({
  userId: v.string(),
  deviceId: v.string(),
  platform: v.literal("ios"),
  iosMajorVersion: v.number(),
  appVersion: nullableString,
  bundleId: nullableString,
  apsEnvironment: v.union(v.literal("sandbox"), v.literal("production"), v.null()),
  pushToken: nullableString,
  pushToStartToken: nullableString,
  preferences,
  activityPushToken: nullableString,
  remoteStartQueuedAt: nullableString,
  remoteStartedAt: nullableString,
  endedAt: nullableString,
  lastAggregate: v.union(aggregateState, v.null()),
  lastLiveActivityDeliveryAt: nullableString,
});
const environmentLinkResult = v.object({
  environmentId: v.string(),
  label: v.string(),
  endpoint: v.object({
    httpBaseUrl: v.string(),
    wsBaseUrl: v.string(),
    providerKind: endpointProviderKind,
  }),
  linkedAt: v.string(),
});
const linkedEnvironmentResult = v.object({
  environmentId: v.string(),
  label: v.string(),
  environmentPublicKey: v.string(),
  endpoint: v.object({
    httpBaseUrl: v.string(),
    wsBaseUrl: v.string(),
    providerKind: endpointProviderKind,
  }),
  linkedAt: v.string(),
});
const allocationResult = v.object({
  userId: v.string(),
  environmentId: v.string(),
  hostname: v.string(),
  tunnelId: nullableString,
  tunnelName: v.string(),
  dnsRecordId: nullableString,
  readyAt: nullableString,
  updatedAt: v.string(),
});
const allocationReservationResult = v.union(
  v.object({ status: v.literal("reserved"), allocation: allocationResult }),
  v.object({
    status: v.literal("limit_exceeded"),
    maxTunnels: v.number(),
    activeTunnels: v.number(),
  }),
);
const deliveryAttemptInput = {
  id: v.string(),
  createdAt: v.string(),
  userId: nullableString,
  environmentId: nullableString,
  threadId: nullableString,
  deviceId: nullableString,
  kind: v.string(),
  sourceJobId: nullableString,
  tokenSuffix: nullableString,
  apnsStatus: nullableNumber,
  apnsReason: nullableString,
  apnsId: nullableString,
  transportError: nullableString,
};

function toAllocation(row: Doc<"relayManagedEndpointAllocations">) {
  return {
    userId: row.userId,
    environmentId: row.environmentId,
    hostname: row.hostname,
    tunnelId: row.tunnelId,
    tunnelName: row.tunnelName,
    dnsRecordId: row.dnsRecordId,
    readyAt: row.readyAt,
    updatedAt: row.updatedAt,
  };
}

async function deleteIds(ctx: MutationCtx, ids: Id<TableNames>[]) {
  for (const id of ids) await ctx.db.delete(id);
}

export const health = query({
  args: {},
  returns: v.literal(true),
  handler: async (ctx) => {
    await requireRelayControlPlane(ctx);
    return true as const;
  },
});

// Mobile devices ----------------------------------------------------------------

export const registerDevice = mutation({
  args: {
    userId: v.string(),
    now: v.string(),
    registration: v.object({
      deviceId: v.string(),
      label: v.string(),
      platform: v.literal("ios"),
      iosMajorVersion: v.number(),
      appVersion: v.optional(v.string()),
      bundleId: v.optional(v.string()),
      apsEnvironment: v.optional(v.union(v.literal("sandbox"), v.literal("production"))),
      pushToken: v.optional(v.string()),
      pushToStartToken: v.optional(v.string()),
      preferences,
    }),
  },
  returns: v.null(),
  handler: async (ctx, { userId, registration, now }) => {
    await requireRelayControlPlane(ctx);
    if (registration.pushToken !== undefined) {
      const owners = await ctx.db
        .query("relayMobileDevices")
        .withIndex("by_push_token", (q) => q.eq("pushToken", registration.pushToken!))
        .collect();
      for (const owner of owners)
        await ctx.db.patch(owner._id, { pushToken: null, updatedAt: now });
    }
    if (registration.pushToStartToken !== undefined) {
      const owners = await ctx.db
        .query("relayMobileDevices")
        .withIndex("by_push_to_start_token", (q) =>
          q.eq("pushToStartToken", registration.pushToStartToken!),
        )
        .collect();
      for (const owner of owners)
        await ctx.db.patch(owner._id, { pushToStartToken: null, updatedAt: now });
    }
    const existing = await ctx.db
      .query("relayMobileDevices")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", userId).eq("deviceId", registration.deviceId),
      )
      .unique();
    const fields = {
      label: registration.label,
      platform: registration.platform,
      iosMajorVersion: registration.iosMajorVersion,
      appVersion: registration.appVersion ?? null,
      preferences: registration.preferences,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("relayMobileDevices", {
        userId,
        deviceId: registration.deviceId,
        ...fields,
        bundleId: registration.bundleId ?? null,
        apsEnvironment: registration.apsEnvironment ?? null,
        pushToken: registration.pushToken ?? null,
        pushToStartToken: registration.pushToStartToken ?? null,
        createdAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        ...fields,
        bundleId: registration.bundleId ?? existing.bundleId,
        apsEnvironment: registration.apsEnvironment ?? existing.apsEnvironment,
        pushToken: registration.pushToken ?? existing.pushToken,
        pushToStartToken: registration.pushToStartToken ?? existing.pushToStartToken,
      });
    }
    return null;
  },
});

export const unregisterDevice = mutation({
  args: { userId: v.string(), deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const live = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .collect();
    const devices = await ctx.db
      .query("relayMobileDevices")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .collect();
    await deleteIds(
      ctx,
      [...live, ...devices].map((row) => row._id),
    );
    return null;
  },
});

export const listDevices = query({
  args: { userId: v.string() },
  returns: v.array(deviceResult),
  handler: async (ctx, { userId }) => {
    await requireRelayControlPlane(ctx);
    const rows = await ctx.db
      .query("relayMobileDevices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((row) => ({
      deviceId: row.deviceId,
      label: row.label,
      platform: row.platform,
      iosMajorVersion: row.iosMajorVersion,
      appVersion: row.appVersion,
      notifications: {
        enabled: row.preferences.notificationsEnabled,
        notifyOnApproval: row.preferences.notifyOnApproval,
        notifyOnInput: row.preferences.notifyOnInput,
        notifyOnCompletion: row.preferences.notifyOnCompletion,
        notifyOnFailure: row.preferences.notifyOnFailure,
      },
      liveActivities: { enabled: row.preferences.liveActivitiesEnabled },
      updatedAt: row.updatedAt,
    }));
  },
});

// Live activities ---------------------------------------------------------------

export const registerLiveActivity = mutation({
  args: {
    userId: v.string(),
    deviceId: v.string(),
    activityPushToken: v.string(),
    now: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const owners = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_activity_push_token", (q) => q.eq("activityPushToken", args.activityPushToken))
      .collect();
    for (const owner of owners)
      await ctx.db.patch(owner._id, {
        activityPushToken: null,
        remoteStartQueuedAt: null,
        remoteStartedAt: null,
        endedAt: args.now,
        updatedAt: args.now,
      });
    const existing = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    const fields = {
      activityPushToken: args.activityPushToken,
      remoteStartQueuedAt: null,
      remoteStartedAt: args.now,
      endedAt: null,
      lastAggregate: null,
      lastLiveActivityDeliveryAt: null,
      updatedAt: args.now,
    };
    if (existing === null)
      await ctx.db.insert("relayLiveActivities", {
        userId: args.userId,
        deviceId: args.deviceId,
        ...fields,
        createdAt: args.now,
      });
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

export const listLiveActivityTargets = query({
  args: { userId: v.string() },
  returns: v.array(liveActivityTargetResult),
  handler: async (ctx, { userId }) => {
    await requireRelayControlPlane(ctx);
    const devices = await ctx.db
      .query("relayMobileDevices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return await Promise.all(
      devices.map(async (device) => {
        const live = await ctx.db
          .query("relayLiveActivities")
          .withIndex("by_user_and_device", (q) =>
            q.eq("userId", userId).eq("deviceId", device.deviceId),
          )
          .unique();
        return {
          userId,
          deviceId: device.deviceId,
          platform: device.platform,
          iosMajorVersion: device.iosMajorVersion,
          appVersion: device.appVersion,
          bundleId: device.bundleId,
          apsEnvironment: device.apsEnvironment,
          pushToken: device.pushToken,
          pushToStartToken: device.pushToStartToken,
          preferences: device.preferences,
          activityPushToken: live?.activityPushToken ?? null,
          remoteStartQueuedAt: live?.remoteStartQueuedAt ?? null,
          remoteStartedAt: live?.remoteStartedAt ?? null,
          endedAt: live?.endedAt ?? null,
          lastAggregate: live?.lastAggregate ?? null,
          lastLiveActivityDeliveryAt: live?.lastLiveActivityDeliveryAt ?? null,
        };
      }),
    );
  },
});

export const markLiveActivityDelivery = mutation({
  args: {
    userId: v.string(),
    deviceId: v.string(),
    kind: deliveryKind,
    aggregate: v.union(aggregateState, v.null()),
    deliveredAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const existing = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    const starting = args.kind === "live_activity_start";
    const ending = args.kind === "live_activity_end";
    const patch = {
      remoteStartedAt: starting ? args.deliveredAt : (existing?.remoteStartedAt ?? null),
      remoteStartQueuedAt: null,
      endedAt: ending ? args.deliveredAt : starting ? null : (existing?.endedAt ?? null),
      activityPushToken: starting || ending ? null : (existing?.activityPushToken ?? null),
      lastAggregate: args.aggregate,
      lastLiveActivityDeliveryAt: args.deliveredAt,
      updatedAt: args.deliveredAt,
    };
    if (existing === null)
      await ctx.db.insert("relayLiveActivities", {
        userId: args.userId,
        deviceId: args.deviceId,
        ...patch,
        createdAt: args.deliveredAt,
      });
    else await ctx.db.patch(existing._id, patch);
    return null;
  },
});

export const markLiveActivityStartQueued = mutation({
  args: { userId: v.string(), deviceId: v.string(), queuedAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    const fields = {
      remoteStartQueuedAt: row?.remoteStartQueuedAt ?? args.queuedAt,
      endedAt: null,
      updatedAt: args.queuedAt,
    };
    if (row) await ctx.db.patch(row._id, fields);
    else
      await ctx.db.insert("relayLiveActivities", {
        userId: args.userId,
        deviceId: args.deviceId,
        activityPushToken: null,
        remoteStartedAt: null,
        lastAggregate: null,
        lastLiveActivityDeliveryAt: null,
        createdAt: args.queuedAt,
        ...fields,
      });
    return null;
  },
});
export const clearLiveActivityStartQueued = mutation({
  args: { userId: v.string(), deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayLiveActivities")
      .withIndex("by_user_and_device", (q) =>
        q.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (row) await ctx.db.patch(row._id, { remoteStartQueuedAt: null });
    return null;
  },
});
export const invalidateLiveActivityDeliveryToken = mutation({
  args: { userId: v.string(), deviceId: v.string(), kind: deliveryKind, invalidatedAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (args.kind === "push_notification" || args.kind === "live_activity_start") {
      const row = await ctx.db
        .query("relayMobileDevices")
        .withIndex("by_user_and_device", (q) =>
          q.eq("userId", args.userId).eq("deviceId", args.deviceId),
        )
        .unique();
      if (row)
        await ctx.db.patch(row._id, {
          ...(args.kind === "push_notification" ? { pushToken: null } : { pushToStartToken: null }),
          updatedAt: args.invalidatedAt,
        });
      if (args.kind === "live_activity_start") {
        const live = await ctx.db
          .query("relayLiveActivities")
          .withIndex("by_user_and_device", (q) =>
            q.eq("userId", args.userId).eq("deviceId", args.deviceId),
          )
          .unique();
        if (live)
          await ctx.db.patch(live._id, {
            remoteStartQueuedAt: null,
            updatedAt: args.invalidatedAt,
          });
      }
    } else {
      const row = await ctx.db
        .query("relayLiveActivities")
        .withIndex("by_user_and_device", (q) =>
          q.eq("userId", args.userId).eq("deviceId", args.deviceId),
        )
        .unique();
      if (row)
        await ctx.db.patch(row._id, {
          activityPushToken: null,
          remoteStartQueuedAt: null,
          remoteStartedAt: null,
          endedAt: args.invalidatedAt,
          updatedAt: args.invalidatedAt,
        });
    }
    return null;
  },
});

// Environment links -------------------------------------------------------------

export const upsertEnvironmentLink = mutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    environmentLabel: v.string(),
    environmentPublicKey: v.string(),
    endpointHttpBaseUrl: v.string(),
    endpointWsBaseUrl: v.string(),
    endpointProviderKind,
    notificationsEnabled: v.boolean(),
    liveActivitiesEnabled: v.boolean(),
    managedTunnelsEnabled: v.boolean(),
    createdByDeviceId: nullableString,
    now: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    const { now, ...input } = args;
    const fields = { ...input, revokedAt: null, updatedAt: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("relayEnvironmentLinks", { ...fields, createdAt: now });
    return null;
  },
});

function activeLink(row: Doc<"relayEnvironmentLinks">) {
  return row.revokedAt === null;
}
function activeDeliveryLink(row: Doc<"relayEnvironmentLinks">) {
  return activeLink(row) && (row.notificationsEnabled || row.liveActivitiesEnabled);
}

export const listUsersForEnvironment = query({
  args: { environmentId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return (
      await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId))
        .collect()
    )
      .filter(activeDeliveryLink)
      .map((row) => row.userId);
  },
});
export const listDeliveryUsersForEnvironment = query({
  args: { environmentId: v.string(), environmentPublicKey: v.string() },
  returns: v.array(
    v.object({
      userId: v.string(),
      notificationsEnabled: v.boolean(),
      liveActivitiesEnabled: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return (
      await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_environment_and_key", (q) =>
          q
            .eq("environmentId", args.environmentId)
            .eq("environmentPublicKey", args.environmentPublicKey),
        )
        .collect()
    )
      .filter(activeDeliveryLink)
      .map((row) => ({
        userId: row.userId,
        notificationsEnabled: row.notificationsEnabled,
        liveActivitiesEnabled: row.liveActivitiesEnabled,
      }));
  },
});
export const listPublicKeysForEnvironment = query({
  args: { environmentId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const rows = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId))
      .collect();
    return [
      ...new Set(
        rows
          .filter(activeLink)
          .map((row) => row.environmentPublicKey)
          .filter(Boolean),
      ),
    ];
  },
});
export const listEnvironmentLinksForUser = query({
  args: { userId: v.string() },
  returns: v.array(environmentLinkResult),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return (
      await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect()
    )
      .filter(activeLink)
      .map((row) => ({
        environmentId: row.environmentId,
        label: row.displayName?.trim() || row.environmentLabel.trim() || row.environmentId,
        endpoint: {
          httpBaseUrl: row.endpointHttpBaseUrl,
          wsBaseUrl: row.endpointWsBaseUrl,
          providerKind: row.endpointProviderKind as
            | "manual"
            | "cloudflare_tunnel"
            | "pathway_relay",
        },
        linkedAt: row.createdAt,
      }));
  },
});
export const getEnvironmentLinkForUser = query({
  args: { userId: v.string(), environmentId: v.string() },
  returns: v.union(linkedEnvironmentResult, v.null()),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    return !row || !activeLink(row)
      ? null
      : {
          environmentId: row.environmentId,
          label: row.displayName?.trim() || row.environmentLabel.trim() || row.environmentId,
          environmentPublicKey: row.environmentPublicKey,
          endpoint: {
            httpBaseUrl: row.endpointHttpBaseUrl,
            wsBaseUrl: row.endpointWsBaseUrl,
            providerKind: row.endpointProviderKind as
              | "manual"
              | "cloudflare_tunnel"
              | "pathway_relay",
          },
          linkedAt: row.createdAt,
        };
  },
});

/**
 * Sets the signed-in account's durable name for one linked environment.
 *
 * The user-authored value is deliberately separate from `environmentLabel`: the relay refreshes
 * that host-provided label whenever an environment relinks, while this name must survive those
 * metadata updates. Passing `null` restores the current host-provided name.
 */
export const renameEnvironmentLink = mutation({
  args: { environmentId: v.string(), displayName: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (isEnvironmentIdentity(identity)) {
      throw backendError(
        "permission-denied",
        "An environment cannot rename links owned by a user account.",
      );
    }
    const environmentId = args.environmentId.trim();
    if (environmentId.length === 0 || environmentId !== args.environmentId) {
      throw backendError("invalid-arguments", "An environment id must be non-empty and trimmed.");
    }
    let displayName: string | null = null;
    if (args.displayName !== null) {
      displayName = args.displayName.trim();
      if (displayName.length === 0 || displayName.length > 120) {
        throw backendError(
          "invalid-arguments",
          "An environment name must contain between 1 and 120 characters.",
        );
      }
    }
    const row = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", identity.subject).eq("environmentId", environmentId),
      )
      .unique();
    if (!row || !activeLink(row)) {
      throw backendError("entity-not-found", "This environment is not linked to your account.");
    }
    if ((row.displayName ?? null) === displayName) return null;
    await ctx.db.patch(row._id, {
      displayName: displayName ?? undefined,
      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
    return null;
  },
});
export const revokeEnvironmentLink = mutation({
  args: { userId: v.string(), environmentId: v.string(), now: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    if (!row || !activeLink(row)) return false;
    await ctx.db.patch(row._id, { revokedAt: args.now, updatedAt: args.now });
    return true;
  },
});

async function revokeCredentialsIfUnlinked(
  ctx: MutationCtx,
  environmentId: string,
  environmentPublicKey: string,
  now: string,
) {
  const links = await ctx.db
    .query("relayEnvironmentLinks")
    .withIndex("by_environment_key_and_revoked", (q) =>
      q
        .eq("environmentId", environmentId)
        .eq("environmentPublicKey", environmentPublicKey)
        .eq("revokedAt", null),
    )
    .first();
  if (links !== null) return false;
  const credentials = await ctx.db
    .query("relayEnvironmentCredentials")
    .withIndex("by_environment_key_and_revoked", (q) =>
      q
        .eq("environmentId", environmentId)
        .eq("environmentPublicKey", environmentPublicKey)
        .eq("revokedAt", null),
    )
    .collect();
  let changed = false;
  for (const credential of credentials)
    if (credential.revokedAt === null) {
      await ctx.db.patch(credential._id, { revokedAt: now, updatedAt: now });
      changed = true;
    }
  return changed;
}

export const revokeEnvironmentLinkWithCredentials = mutation({
  args: { userId: v.string(), environmentId: v.string(), now: v.string() },
  returns: v.object({ linkRevoked: v.boolean(), credentialsRevoked: v.boolean() }),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    if (!row || !activeLink(row)) return { linkRevoked: false, credentialsRevoked: false };
    await ctx.db.patch(row._id, { revokedAt: args.now, updatedAt: args.now });
    return {
      linkRevoked: true,
      credentialsRevoked: await revokeCredentialsIfUnlinked(
        ctx,
        args.environmentId,
        row.environmentPublicKey,
        args.now,
      ),
    };
  },
});

/**
 * Linking is one logical commit: the active link and its replacement credential become visible
 * together, and a key displaced by the relink loses its credentials once no active link uses it.
 */
export const replaceEnvironmentLinkAndCredential = mutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    environmentLabel: v.string(),
    environmentPublicKey: v.string(),
    endpointHttpBaseUrl: v.string(),
    endpointWsBaseUrl: v.string(),
    endpointProviderKind,
    notificationsEnabled: v.boolean(),
    liveActivitiesEnabled: v.boolean(),
    managedTunnelsEnabled: v.boolean(),
    createdByDeviceId: nullableString,
    credentialId: v.string(),
    credentialHash: v.string(),
    now: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const existingCredentialId = await ctx.db
      .query("relayEnvironmentCredentials")
      .withIndex("by_credential_id", (q) => q.eq("credentialId", args.credentialId))
      .first();
    const existingCredentialHash = await ctx.db
      .query("relayEnvironmentCredentials")
      .withIndex("by_credential_hash", (q) => q.eq("credentialHash", args.credentialHash))
      .first();
    if (existingCredentialId || existingCredentialHash) {
      throw new Error("Credential id or hash already exists.");
    }

    const previousLink = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    const previousKey = previousLink?.environmentPublicKey;
    const link = {
      userId: args.userId,
      environmentId: args.environmentId,
      environmentLabel: args.environmentLabel,
      environmentPublicKey: args.environmentPublicKey,
      endpointHttpBaseUrl: args.endpointHttpBaseUrl,
      endpointWsBaseUrl: args.endpointWsBaseUrl,
      endpointProviderKind: args.endpointProviderKind,
      notificationsEnabled: args.notificationsEnabled,
      liveActivitiesEnabled: args.liveActivitiesEnabled,
      managedTunnelsEnabled: args.managedTunnelsEnabled,
      createdByDeviceId: args.createdByDeviceId,
      revokedAt: null,
      updatedAt: args.now,
    } as const;
    if (previousLink) await ctx.db.patch(previousLink._id, link);
    else await ctx.db.insert("relayEnvironmentLinks", { ...link, createdAt: args.now });

    const currentCredentials = await ctx.db
      .query("relayEnvironmentCredentials")
      .withIndex("by_environment_key_and_revoked", (q) =>
        q
          .eq("environmentId", args.environmentId)
          .eq("environmentPublicKey", args.environmentPublicKey)
          .eq("revokedAt", null),
      )
      .collect();
    await ctx.db.insert("relayEnvironmentCredentials", {
      credentialId: args.credentialId,
      environmentId: args.environmentId,
      environmentPublicKey: args.environmentPublicKey,
      credentialHash: args.credentialHash,
      revokedAt: null,
      createdAt: args.now,
      updatedAt: args.now,
    });
    for (const credential of currentCredentials) {
      if (credential.revokedAt === null)
        await ctx.db.patch(credential._id, { revokedAt: args.now, updatedAt: args.now });
    }
    if (previousKey !== undefined && previousKey !== args.environmentPublicKey) {
      await revokeCredentialsIfUnlinked(ctx, args.environmentId, previousKey, args.now);
    }
    return null;
  },
});

// Managed endpoints -------------------------------------------------------------

const allocationKeyArgs = { userId: v.string(), environmentId: v.string() };
export const getManagedEndpointAllocation = query({
  args: allocationKeyArgs,
  returns: v.union(allocationResult, v.null()),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayManagedEndpointAllocations")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    return row ? toAllocation(row) : null;
  },
});
export const reserveManagedEndpointAllocation = mutation({
  args: { ...allocationKeyArgs, hostname: v.string(), tunnelName: v.string(), now: v.string() },
  returns: allocationReservationResult,
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const existing = await ctx.db
      .query("relayManagedEndpointAllocations")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", args.userId).eq("environmentId", args.environmentId),
      )
      .unique();
    if (existing) return { status: "reserved" as const, allocation: toAllocation(existing) };

    // Capacity and reservation are one transaction. Counting allocation rows, including in-flight
    // provisioning, makes the indexed read conflict with a concurrent insert so Convex retries the
    // loser against the newly reserved slot.
    const override = await ctx.db
      .query("relayManagedTunnelLimits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const maxTunnels = override?.maxTunnels ?? 3;
    const activeTunnels = (
      await ctx.db
        .query("relayManagedEndpointAllocations")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect()
    ).filter((allocation) => allocation.environmentId !== args.environmentId).length;
    if (activeTunnels >= maxTunnels) {
      return { status: "limit_exceeded" as const, maxTunnels, activeTunnels };
    }

    const byHostname = await ctx.db
      .query("relayManagedEndpointAllocations")
      .withIndex("by_hostname", (q) => q.eq("hostname", args.hostname))
      .first();
    const byName = await ctx.db
      .query("relayManagedEndpointAllocations")
      .withIndex("by_tunnel_name", (q) => q.eq("tunnelName", args.tunnelName))
      .first();
    if (byHostname || byName)
      throw new Error("Managed endpoint hostname or tunnel name is already reserved.");
    const id = await ctx.db.insert("relayManagedEndpointAllocations", {
      userId: args.userId,
      environmentId: args.environmentId,
      hostname: args.hostname,
      tunnelName: args.tunnelName,
      tunnelId: null,
      dnsRecordId: null,
      readyAt: null,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { status: "reserved" as const, allocation: toAllocation((await ctx.db.get(id))!) };
  },
});

async function allocationByKey(ctx: MutationCtx, userId: string, environmentId: string) {
  return await ctx.db
    .query("relayManagedEndpointAllocations")
    .withIndex("by_user_and_environment", (q) =>
      q.eq("userId", userId).eq("environmentId", environmentId),
    )
    .unique();
}
export const recordManagedEndpointTunnel = mutation({
  args: { ...allocationKeyArgs, tunnelId: v.string(), now: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (row) await ctx.db.patch(row._id, { tunnelId: args.tunnelId, updatedAt: args.now });
    return null;
  },
});
export const recordManagedEndpointDns = mutation({
  args: { ...allocationKeyArgs, dnsRecordId: v.string(), now: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (row) await ctx.db.patch(row._id, { dnsRecordId: args.dnsRecordId, updatedAt: args.now });
    return null;
  },
});
export const markManagedEndpointReady = mutation({
  args: { ...allocationKeyArgs, now: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (row) await ctx.db.patch(row._id, { readyAt: args.now, updatedAt: args.now });
    return null;
  },
});
export const claimManagedEndpointRelease = mutation({
  args: {
    ...allocationKeyArgs,
    tunnelId: v.string(),
    updatedAt: v.string(),
    claimedAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (!row || row.tunnelId !== args.tunnelId || row.updatedAt !== args.updatedAt) return false;
    await ctx.db.patch(row._id, { updatedAt: args.claimedAt });
    return true;
  },
});
export const claimManagedEndpointDeprovision = mutation({
  args: { ...allocationKeyArgs, updatedAt: v.string(), claimedAt: v.string() },
  returns: nullableString,
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (!row || row.updatedAt !== args.updatedAt) return null;
    await ctx.db.patch(row._id, { updatedAt: args.claimedAt });
    return args.claimedAt;
  },
});
export const removeManagedEndpointAllocation = mutation({
  args: allocationKeyArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
export const removeClaimedManagedEndpointAllocation = mutation({
  args: { ...allocationKeyArgs, updatedAt: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await allocationByKey(ctx, args.userId, args.environmentId);
    if (!row || row.updatedAt !== args.updatedAt) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});

export const ensureManagedTunnelCapacity = query({
  args: allocationKeyArgs,
  returns: v.object({ allowed: v.boolean(), maxTunnels: v.number(), activeTunnels: v.number() }),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const override = await ctx.db
      .query("relayManagedTunnelLimits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const maxTunnels = override?.maxTunnels ?? 3;
    const allocations = await ctx.db
      .query("relayManagedEndpointAllocations")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const activeTunnels = allocations.filter(
      (allocation) => allocation.environmentId !== args.environmentId,
    ).length;
    return { allowed: activeTunnels < maxTunnels, maxTunnels, activeTunnels };
  },
});

// Credentials -------------------------------------------------------------------

export const insertEnvironmentCredential = mutation({
  args: {
    credentialId: v.string(),
    environmentId: v.string(),
    environmentPublicKey: v.string(),
    credentialHash: v.string(),
    now: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (
      await ctx.db
        .query("relayEnvironmentCredentials")
        .withIndex("by_credential_id", (q) => q.eq("credentialId", args.credentialId))
        .first()
    )
      throw new Error("Credential id already exists.");
    if (
      await ctx.db
        .query("relayEnvironmentCredentials")
        .withIndex("by_credential_hash", (q) => q.eq("credentialHash", args.credentialHash))
        .first()
    )
      throw new Error("Credential hash already exists.");
    const rows = await ctx.db
      .query("relayEnvironmentCredentials")
      .withIndex("by_environment_key_and_revoked", (q) =>
        q
          .eq("environmentId", args.environmentId)
          .eq("environmentPublicKey", args.environmentPublicKey)
          .eq("revokedAt", null),
      )
      .collect();
    const { now, ...credential } = args;
    await ctx.db.insert("relayEnvironmentCredentials", {
      ...credential,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const row of rows)
      if (row.revokedAt === null) await ctx.db.patch(row._id, { revokedAt: now, updatedAt: now });
    return null;
  },
});
export const authenticateEnvironmentCredential = query({
  args: { credentialHash: v.string() },
  returns: v.union(
    v.object({
      credentialId: v.string(),
      environmentId: v.string(),
      environmentPublicKey: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayEnvironmentCredentials")
      .withIndex("by_credential_hash", (q) => q.eq("credentialHash", args.credentialHash))
      .unique();
    if (!row || row.revokedAt !== null) return null;
    const link = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_environment_key_and_revoked", (q) =>
        q
          .eq("environmentId", row.environmentId)
          .eq("environmentPublicKey", row.environmentPublicKey)
          .eq("revokedAt", null),
      )
      .first();
    return link !== null
      ? {
          credentialId: row.credentialId,
          environmentId: row.environmentId,
          environmentPublicKey: row.environmentPublicKey,
        }
      : null;
  },
});
export const revokeEnvironmentCredentialsForPublicKey = mutation({
  args: { environmentId: v.string(), environmentPublicKey: v.string(), now: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return await revokeCredentialsIfUnlinked(
      ctx,
      args.environmentId,
      args.environmentPublicKey,
      args.now,
    );
  },
});

// Agent activity ----------------------------------------------------------------

export const upsertAgentActivityRow = mutation({
  args: { environmentPublicKey: v.string(), state: activityState, createdAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayAgentActivityRows")
      .withIndex("by_environment_key_and_thread", (q) =>
        q
          .eq("environmentId", args.state.environmentId)
          .eq("environmentPublicKey", args.environmentPublicKey)
          .eq("threadId", args.state.threadId),
      )
      .unique();
    const fields = { state: args.state, phase: args.state.phase, updatedAt: args.state.updatedAt };
    if (row) await ctx.db.patch(row._id, fields);
    else
      await ctx.db.insert("relayAgentActivityRows", {
        environmentId: args.state.environmentId,
        environmentPublicKey: args.environmentPublicKey,
        threadId: args.state.threadId,
        ...fields,
        createdAt: args.createdAt,
      });
    return null;
  },
});
export const removeAgentActivityRow = mutation({
  args: { environmentId: v.string(), environmentPublicKey: v.string(), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayAgentActivityRows")
      .withIndex("by_environment_key_and_thread", (q) =>
        q
          .eq("environmentId", args.environmentId)
          .eq("environmentPublicKey", args.environmentPublicKey)
          .eq("threadId", args.threadId),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
export const pruneTerminalAgentActivityRows = mutation({
  args: { updatedBefore: v.string(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const limit = Math.max(0, Math.min(Math.trunc(args.limit ?? 500), 1000));
    const completed = await ctx.db
      .query("relayAgentActivityRows")
      .withIndex("by_phase_and_updated_at", (q) =>
        q.eq("phase", "completed").lt("updatedAt", args.updatedBefore),
      )
      .take(limit);
    const failed = await ctx.db
      .query("relayAgentActivityRows")
      .withIndex("by_phase_and_updated_at", (q) =>
        q.eq("phase", "failed").lt("updatedAt", args.updatedBefore),
      )
      .take(limit - completed.length);
    const terminal = [...completed, ...failed];
    await deleteIds(
      ctx,
      terminal.map((row) => row._id),
    );
    return terminal.length;
  },
});
export const listAgentActivityRowsForUser = query({
  args: { userId: v.string() },
  returns: v.array(activityState),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const links = (
      await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect()
    ).filter((row) => activeLink(row) && row.liveActivitiesEnabled);
    const states = (
      await Promise.all(
        links.map((link) =>
          ctx.db
            .query("relayAgentActivityRows")
            .withIndex("by_environment_key_and_thread", (q) =>
              q
                .eq("environmentId", link.environmentId)
                .eq("environmentPublicKey", link.environmentPublicKey),
            )
            .collect(),
        ),
      )
    )
      .flat()
      .map((row) => row.state);
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
});
export const getAgentActivityRowForUserThread = query({
  args: { userId: v.string(), environmentId: v.string(), threadId: v.string() },
  returns: v.union(activityState, v.null()),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const links = (
      await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_user_and_environment", (q) =>
          q.eq("userId", args.userId).eq("environmentId", args.environmentId),
        )
        .collect()
    ).filter(activeLink);
    const rows = (
      await Promise.all(
        links.map((link) =>
          ctx.db
            .query("relayAgentActivityRows")
            .withIndex("by_environment_key_and_thread", (q) =>
              q
                .eq("environmentId", args.environmentId)
                .eq("environmentPublicKey", link.environmentPublicKey)
                .eq("threadId", args.threadId),
            )
            .collect(),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows[0]?.state ?? null;
  },
});

// Delivery idempotency -----------------------------------------------------------

export const recordDeliveryAttempt = mutation({
  args: deliveryAttemptInput,
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (
      await ctx.db
        .query("relayDeliveryAttempts")
        .withIndex("by_attempt_id", (q) => q.eq("id", args.id))
        .first()
    )
      throw new Error("Delivery attempt id already exists.");
    if (
      args.sourceJobId !== null &&
      (await ctx.db
        .query("relayDeliveryAttempts")
        .withIndex("by_source_job", (q) => q.eq("sourceJobId", args.sourceJobId))
        .first())
    )
      throw new Error("Delivery source job already exists.");
    await ctx.db.insert("relayDeliveryAttempts", args);
    return null;
  },
});
export const claimDeliverySourceJob = mutation({
  args: { ...deliveryAttemptInput, leaseExpiresBefore: v.string() },
  returns: v.union(v.literal("claimed"), v.literal("completed"), v.literal("in_flight")),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (args.sourceJobId === null) throw new Error("A source job id is required.");
    const existing = await ctx.db
      .query("relayDeliveryAttempts")
      .withIndex("by_source_job", (q) => q.eq("sourceJobId", args.sourceJobId))
      .unique();
    if (!existing) {
      if (
        await ctx.db
          .query("relayDeliveryAttempts")
          .withIndex("by_attempt_id", (q) => q.eq("id", args.id))
          .first()
      )
        throw new Error("Delivery attempt id already exists.");
      const { leaseExpiresBefore: _, ...row } = args;
      await ctx.db.insert("relayDeliveryAttempts", row);
      return "claimed";
    }
    if (
      existing.apnsStatus !== null ||
      existing.apnsReason !== null ||
      existing.apnsId !== null ||
      existing.transportError !== null
    )
      return "completed";
    if (existing.createdAt > args.leaseExpiresBefore) return "in_flight";
    await ctx.db.patch(existing._id, { createdAt: args.createdAt });
    return "claimed";
  },
});
export const completeDeliverySourceJob = mutation({
  args: {
    sourceJobId: v.string(),
    completedAt: v.string(),
    apnsStatus: nullableNumber,
    apnsReason: nullableString,
    apnsId: nullableString,
    transportError: nullableString,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("relayDeliveryAttempts")
      .withIndex("by_source_job", (q) => q.eq("sourceJobId", args.sourceJobId))
      .unique();
    if (row)
      await ctx.db.patch(row._id, {
        createdAt: args.completedAt,
        apnsStatus: args.apnsStatus,
        apnsReason: args.apnsReason,
        apnsId: args.apnsId,
        transportError: args.transportError,
      });
    return null;
  },
});

// DPoP replay ledger -------------------------------------------------------------

export const consumeDpopProof = mutation({
  args: {
    thumbprint: v.string(),
    jti: v.string(),
    iat: v.number(),
    expiresAt: v.string(),
    createdAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const replay = await ctx.db
      .query("relayDpopProofs")
      .withIndex("by_thumbprint_and_jti", (q) =>
        q.eq("thumbprint", args.thumbprint).eq("jti", args.jti),
      )
      .first();
    if (replay) return false;
    await ctx.db.insert("relayDpopProofs", args);
    return true;
  },
});
export const pruneExpiredDpopProofs = mutation({
  args: { expiresBefore: v.string(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const rows = await ctx.db
      .query("relayDpopProofs")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", args.expiresBefore))
      .take(Math.min(args.limit ?? 500, 1000));
    await deleteIds(
      ctx,
      rows.map((row) => row._id),
    );
    return rows.length;
  },
});
