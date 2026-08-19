// @effect-diagnostics globalDate:off globalFetch:off -- Convex actions use platform fetch and mutations use the transaction clock.
/** Company-owned Slack configuration, encrypted credentials, and controller coordination. */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";

import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  integrationCredentialKeyringFromEnv,
} from "../src/integrationCredentials.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  requireCompanyActor,
  requirePermission,
  type CompanyActor,
  type EnvironmentActor,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_BACKUPS = 10;
const LEASE_TTL_MS = 90_000;
const CONTENDER_FRESH_MS = 90_000;
const FAILBACK_HEARTBEATS = 2;
const MAX_TOKEN_CHARS = 4_096;
const MAX_ERROR_CHARS = 500;
const MAX_PROVIDER_INSTANCES = 50;
const MAX_PROVIDER_MODELS = 500;
const MAX_DISCOVERED_CHANNELS = 1_000;
const SLACK_REQUEST_TIMEOUT_MS = 10_000;

const integrationState = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("disconnected"),
);

const integrationRecord = v.object({
  id: domainIdArg,
  workspaceId: v.string(),
  workspaceName: v.string(),
  workspaceDomain: v.union(v.string(), v.null()),
  botUserId: v.union(v.string(), v.null()),
  botId: v.union(v.string(), v.null()),
  state: integrationState,
  activatedAt: v.union(v.number(), v.null()),
  credentialPresent: v.boolean(),
  preferredEnvironmentId: v.union(v.string(), v.null()),
  backupEnvironmentIds: v.array(v.string()),
  configurationRevision: v.number(),
  controllerEnvironmentId: v.union(v.string(), v.null()),
  leaseGeneration: v.number(),
  leaseExpiresAt: v.union(v.number(), v.null()),
  lastPollAt: v.union(v.number(), v.null()),
  currentError: v.union(v.string(), v.null()),
  blockedReason: v.union(v.string(), v.null()),
  healthHistory: v.array(
    v.object({
      at: v.number(),
      state: v.union(v.literal("healthy"), v.literal("error")),
      error: v.union(v.string(), v.null()),
    }),
  ),
  watchCount: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const leaseRecord = v.object({
  integrationId: domainIdArg,
  holderEnvironmentId: v.union(v.string(), v.null()),
  generation: v.number(),
  expiresAt: v.union(v.number(), v.null()),
});

interface IntegrationOutput {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceDomain: string | null;
  readonly botUserId: string | null;
  readonly botId: string | null;
  readonly state: "draft" | "active" | "disconnected";
  readonly activatedAt: number | null;
  readonly credentialPresent: boolean;
  readonly preferredEnvironmentId: string | null;
  readonly backupEnvironmentIds: string[];
  readonly configurationRevision: number;
  readonly controllerEnvironmentId: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: number | null;
  readonly lastPollAt: number | null;
  readonly currentError: string | null;
  readonly blockedReason: string | null;
  readonly healthHistory: Array<{
    readonly at: number;
    readonly state: "healthy" | "error";
    readonly error: string | null;
  }>;
  readonly watchCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    throw backendError("invalid-arguments", `${label} must be a non-empty, trimmed string.`);
  }
  return trimmed;
}

function boundedDiagnostic(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_ERROR_CHARS);
}

async function integrationByDomainId(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  integrationId: string,
) {
  return await ctx.db
    .query("slackIntegrations")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", companyId).eq("id", integrationId),
    )
    .unique();
}

async function leaseForIntegration(ctx: QueryCtx, integrationId: Id<"slackIntegrations">) {
  return await ctx.db
    .query("slackCoordinatorLeases")
    .withIndex("by_integration", (q) => q.eq("integrationId", integrationId))
    .unique();
}

async function encodeIntegration(ctx: QueryCtx, row: Doc<"slackIntegrations">) {
  const lease = await leaseForIntegration(ctx, row._id);
  const now = Date.now();
  const live = lease !== null && lease.expiresAt !== null && lease.expiresAt > now;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceDomain: row.workspaceDomain,
    botUserId: row.botUserId,
    botId: row.botId,
    state: row.state,
    activatedAt: row.activatedAt ?? null,
    credentialPresent: row.credentialPresent,
    preferredEnvironmentId: row.preferredEnvironmentId,
    backupEnvironmentIds: row.backupEnvironmentIds,
    configurationRevision: row.configurationRevision,
    controllerEnvironmentId: live ? lease.holderEnvironmentId : null,
    leaseGeneration: lease?.generation ?? 0,
    leaseExpiresAt: live ? lease.expiresAt : null,
    lastPollAt: row.lastPollAt,
    currentError: row.currentError,
    blockedReason: row.blockedReason,
    healthHistory: row.healthHistory ?? [],
    watchCount: row.watchCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireEnvironment(actor: CompanyActor): EnvironmentActor {
  if (actor.kind !== "environment") {
    throw backendError("permission-denied", "Only a registered environment may coordinate Slack.");
  }
  return actor;
}

async function requireActiveRegistration(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string,
) {
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  if (registration === null || registration.state !== "active") {
    throw backendError("environment-not-registered", `Environment ${environmentId} is not active.`);
  }
  return registration;
}

async function fenceLease(
  ctx: MutationCtx,
  integration: Doc<"slackIntegrations">,
  now: number,
): Promise<void> {
  const lease = await leaseForIntegration(ctx, integration._id);
  if (lease === null) return;
  await ctx.db.patch(lease._id, {
    holderEnvironmentId: null,
    generation: lease.generation + 1,
    expiresAt: null,
    preferredHealthyHeartbeats: 0,
    updatedAt: now,
  });
}

async function v2WatchRequirements(ctx: QueryCtx, integrationId: Id<"slackIntegrations">) {
  const watches = await ctx.db
    .query("slackChannelWatches")
    .withIndex("by_integration", (q) => q.eq("integrationId", integrationId))
    .collect();
  const v2 = watches.filter((watch) => watch.configurationVersion === 2);
  const usesAutomation = v2.some((watch) => {
    const rules = Array.isArray(watch.rules) ? (watch.rules as readonly unknown[]) : [];
    return rules.some((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
      const rule = raw as Record<string, unknown>;
      const investigation =
        typeof rule["investigation"] === "object" &&
        rule["investigation"] !== null &&
        !Array.isArray(rule["investigation"])
          ? (rule["investigation"] as Record<string, unknown>)
          : null;
      return investigation?.["timing"] !== "off" || rule["assignmentTiming"] !== "off";
    });
  });
  return { requiresV2: v2.length > 0, usesAutomation };
}

async function requireControllerProtocol(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string,
  requiredVersion: number,
) {
  const capabilities = await ctx.db
    .query("environmentProviderCapabilities")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  if ((capabilities?.slackProtocolVersion ?? 1) < requiredVersion) {
    throw backendError(
      "activation-unsafe",
      `Environment ${environmentId} does not support Slack workflow protocol V${requiredVersion}.`,
    );
  }
  return capabilities;
}

async function controllerSupportsProtocol(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string,
  requiredVersion: number,
): Promise<boolean> {
  if (requiredVersion <= 1) return true;
  const capabilities = await ctx.db
    .query("environmentProviderCapabilities")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  return (capabilities?.slackProtocolVersion ?? 1) >= requiredVersion;
}

/** Redacted configuration and health for members with integrations.read. */
export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(integrationRecord),
  handler: async (ctx, args): Promise<IntegrationOutput[]> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const rows = await ctx.db
      .query("slackIntegrations")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    return await Promise.all(rows.map((row) => encodeIntegration(ctx, row)));
  },
});

/** Workspaces whose legacy local rows must remain inert, including removed integrations. */
export const ownedWorkspaceIds = query({
  args: { companyId: domainIdArg },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const [integrations, tombstones] = await Promise.all([
      ctx.db
        .query("slackIntegrations")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect(),
      ctx.db
        .query("slackIntegrationTombstones")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect(),
    ]);
    return [
      ...new Set([
        ...integrations.filter((item) => item.activatedAt != null).map((item) => item.workspaceId),
        ...tombstones.map((item) => item.workspaceId),
      ]),
    ];
  },
});

/** Performs authorization before an action sends a user-supplied token to Slack. */
export const authorizeManage = internalQuery({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    if (actor.kind !== "member") {
      throw backendError("permission-denied", "Only a company member may connect Slack.");
    }
    return null;
  },
});

interface SlackAuthIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceDomain: string | null;
  readonly botUserId: string | null;
  readonly botId: string | null;
}

async function slackAuthTest(token: string): Promise<SlackAuthIdentity> {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw backendError("integration-connection-failed", "Slack returned an invalid response.");
  }
  const record = body as Record<string, unknown>;
  if (record["ok"] !== true || typeof record["team_id"] !== "string") {
    throw backendError("integration-connection-failed", "Slack rejected this bot token.");
  }
  let workspaceDomain: string | null = null;
  if (typeof record["url"] === "string") {
    try {
      workspaceDomain = new URL(record["url"]).hostname.replace(/\.slack\.com$/u, "") || null;
    } catch {
      workspaceDomain = null;
    }
  }
  return {
    workspaceId: requireTrimmed(record["team_id"], "Slack workspace id"),
    workspaceName:
      typeof record["team"] === "string"
        ? requireTrimmed(record["team"], "Workspace name")
        : "Slack",
    workspaceDomain,
    botUserId: typeof record["user_id"] === "string" ? record["user_id"] : null,
    botId: typeof record["bot_id"] === "string" ? record["bot_id"] : null,
  };
}

/** Connects or replaces one workspace credential. The action returns metadata, never the token. */
const authorizeManageReference = makeFunctionReference<"query", { companyId: string }, null>(
  "slackIntegrations:authorizeManage",
);
const reserveConnectionReference = makeFunctionReference<
  "mutation",
  any,
  { integrationId: string }
>("slackIntegrations:reserveConnection");
const storeCredentialReference = makeFunctionReference<
  "mutation",
  {
    companyId: string;
    integrationId: string;
    workspaceId: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
  },
  IntegrationOutput
>("slackIntegrations:storeCredential");

export const connect = action({
  args: {
    companyId: domainIdArg,
    token: v.string(),
    expectedIntegrationId: v.optional(domainIdArg),
  },
  returns: integrationRecord,
  handler: async (ctx, args): Promise<IntegrationOutput> => {
    await ctx.runQuery(authorizeManageReference, { companyId: args.companyId });
    if (args.token.length === 0 || args.token.length > MAX_TOKEN_CHARS) {
      throw backendError("invalid-arguments", "A Slack bot token is required.");
    }
    const identity = await slackAuthTest(args.token);
    const reserved = await ctx.runMutation(reserveConnectionReference, {
      companyId: args.companyId,
      expectedIntegrationId: args.expectedIntegrationId ?? null,
      ...identity,
    });
    const sealed = await encryptIntegrationCredential(
      args.token,
      {
        companyId: args.companyId,
        integrationId: reserved.integrationId,
        workspaceId: identity.workspaceId,
      },
      integrationCredentialKeyringFromEnv(),
    );
    return await ctx.runMutation(storeCredentialReference, {
      companyId: args.companyId,
      integrationId: reserved.integrationId,
      workspaceId: identity.workspaceId,
      ...sealed,
    });
  },
});

export const channelCredentialRecord = internalQuery({
  args: { companyId: domainIdArg, integrationId: domainIdArg },
  returns: v.object({
    workspaceId: v.string(),
    keyId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    authenticationTag: v.string(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    if (actor.kind !== "member") {
      throw backendError("permission-denied", "Only a company member may browse Slack channels.");
    }
    const owner = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const credential = await ctx.db
      .query("slackIntegrationCredentials")
      .withIndex("by_integration", (q) => q.eq("integrationId", owner._id))
      .unique();
    if (credential === null) throw backendError("credential-missing", "Slack is disconnected.");
    return {
      workspaceId: credential.workspaceId,
      keyId: credential.keyId,
      iv: credential.iv,
      ciphertext: credential.ciphertext,
      authenticationTag: credential.authenticationTag,
    };
  },
});

const channelCredentialRecordReference = makeFunctionReference<
  "query",
  { companyId: string; integrationId: string },
  {
    workspaceId: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
  }
>("slackIntegrations:channelCredentialRecord");

const discoveredChannel = v.object({
  id: v.string(),
  name: v.string(),
  isPrivate: v.boolean(),
});

/** Manage-only channel discovery. Plaintext credentials remain inside this Convex action. */
export const listJoinedChannels = action({
  args: { companyId: domainIdArg, integrationId: domainIdArg },
  returns: v.array(discoveredChannel),
  handler: async (ctx, args) => {
    const credential = await ctx.runQuery(channelCredentialRecordReference, args);
    const token = await decryptIntegrationCredential(
      credential,
      {
        companyId: args.companyId,
        integrationId: args.integrationId,
        workspaceId: credential.workspaceId,
      },
      integrationCredentialKeyringFromEnv(),
    );
    const channels: Array<{ id: string; name: string; isPrivate: boolean }> = [];
    let cursor: string | null = null;
    do {
      const url = new URL("https://slack.com/api/conversations.list");
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", "200");
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw backendError(
          "integration-connection-failed",
          "Slack channel discovery could not be reached.",
        );
      }
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw backendError(
          "integration-connection-failed",
          "Slack returned an invalid channel response.",
        );
      }
      const record = body as Record<string, unknown>;
      if (record["ok"] !== true || !Array.isArray(record["channels"])) {
        throw backendError(
          "integration-connection-failed",
          "Slack could not list channels. Check the bot scopes and channel membership.",
        );
      }
      for (const raw of record["channels"]) {
        if (
          channels.length >= MAX_DISCOVERED_CHANNELS ||
          typeof raw !== "object" ||
          raw === null ||
          Array.isArray(raw)
        ) {
          continue;
        }
        const channel = raw as Record<string, unknown>;
        if (
          channel["is_member"] !== true ||
          channel["is_archived"] === true ||
          typeof channel["id"] !== "string" ||
          typeof channel["name"] !== "string"
        ) {
          continue;
        }
        channels.push({
          id: requireTrimmed(channel["id"], "Slack channel id"),
          name: requireTrimmed(channel["name"], "Slack channel name"),
          isPrivate: channel["is_private"] === true,
        });
      }
      const metadata =
        typeof record["response_metadata"] === "object" &&
        record["response_metadata"] !== null &&
        !Array.isArray(record["response_metadata"])
          ? (record["response_metadata"] as Record<string, unknown>)
          : null;
      const next = metadata?.["next_cursor"];
      cursor = typeof next === "string" && next.trim().length > 0 ? next : null;
    } while (cursor !== null && channels.length < MAX_DISCOVERED_CHANNELS);
    return channels.sort((left, right) => left.name.localeCompare(right.name));
  },
});

/** Reserves the canonical company/workspace identity atomically before encryption. */
export const reserveConnection = internalMutation({
  args: {
    companyId: domainIdArg,
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceDomain: v.union(v.string(), v.null()),
    botUserId: v.union(v.string(), v.null()),
    botId: v.union(v.string(), v.null()),
    expectedIntegrationId: v.union(domainIdArg, v.null()),
  },
  returns: v.object({ integrationId: domainIdArg }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    if (args.expectedIntegrationId !== null) {
      const expected = await integrationByDomainId(
        ctx,
        actor.company._id,
        args.expectedIntegrationId,
      );
      if (expected === null) {
        throw backendError("entity-not-found", "The Slack integration is missing.");
      }
      if (expected.workspaceId !== args.workspaceId) {
        throw backendError(
          "entity-conflict",
          "This token belongs to a different Slack workspace. Add it as a separate integration.",
        );
      }
    }
    const reservations = await ctx.db
      .query("slackIntegrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    if (reservations.some((row) => row.companyId !== actor.company._id)) {
      throw backendError(
        "entity-conflict",
        "This Slack workspace is already connected to another company.",
      );
    }
    const existing = await ctx.db
      .query("slackIntegrations")
      .withIndex("by_company_and_workspace", (q) =>
        q.eq("companyId", actor.company._id).eq("workspaceId", args.workspaceId),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (args.expectedIntegrationId !== null && existing.id !== args.expectedIntegrationId) {
        throw backendError(
          "entity-conflict",
          "This Slack workspace belongs to another integration.",
        );
      }
      await ctx.db.patch(existing._id, {
        workspaceName: args.workspaceName,
        workspaceDomain: args.workspaceDomain,
        botUserId: args.botUserId,
        botId: args.botId,
        updatedAt: now,
      });
      return { integrationId: existing.id };
    }
    const id = mintDomainId(now);
    await ctx.db.insert("slackIntegrations", {
      id,
      companyId: actor.company._id,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      workspaceDomain: args.workspaceDomain,
      botUserId: args.botUserId,
      botId: args.botId,
      state: "draft",
      activatedAt: null,
      credentialPresent: false,
      preferredEnvironmentId: null,
      backupEnvironmentIds: [],
      configurationRevision: 0,
      lastPollAt: null,
      currentError: null,
      blockedReason: "controller-not-configured",
      healthHistory: [],
      watchCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { integrationId: id };
  },
});

/** Stores only ciphertext and fences any process still holding the replaced credential. */
export const storeCredential = internalMutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    workspaceId: v.string(),
    keyId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    authenticationTag: v.string(),
  },
  returns: integrationRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null || integration.workspaceId !== args.workspaceId) {
      throw backendError("entity-conflict", "The Slack credential does not match this workspace.");
    }
    const existing = await ctx.db
      .query("slackIntegrationCredentials")
      .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
      .unique();
    const now = Date.now();
    const values = {
      companyId: actor.company._id,
      integrationId: integration._id,
      workspaceId: integration.workspaceId,
      keyId: args.keyId,
      iv: args.iv,
      ciphertext: args.ciphertext,
      authenticationTag: args.authenticationTag,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("slackIntegrationCredentials", { ...values, createdAt: now });
    } else {
      await ctx.db.patch(existing._id, values);
    }
    await ctx.db.patch(integration._id, {
      credentialPresent: true,
      state: integration.state === "disconnected" ? "draft" : integration.state,
      configurationRevision: integration.configurationRevision + 1,
      currentError: null,
      updatedAt: now,
    });
    await fenceLease(ctx, integration, now);
    const updated = await ctx.db.get(integration._id);
    if (updated === null) throw new Error("The Slack integration vanished.");
    return await encodeIntegration(ctx, updated);
  },
});

export const setControllerPool = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    preferredEnvironmentId: v.union(v.string(), v.null()),
    backupEnvironmentIds: v.array(v.string()),
  },
  returns: integrationRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null)
      throw backendError("entity-not-found", "The Slack integration is missing.");
    if (args.backupEnvironmentIds.length > MAX_BACKUPS) {
      throw backendError("invalid-arguments", `At most ${MAX_BACKUPS} backups may be configured.`);
    }
    const preferred =
      args.preferredEnvironmentId === null
        ? null
        : requireTrimmed(args.preferredEnvironmentId, "Preferred environment id");
    const backups = args.backupEnvironmentIds.map((id) =>
      requireTrimmed(id, "Backup environment id"),
    );
    if (
      new Set(backups).size !== backups.length ||
      (preferred !== null && backups.includes(preferred))
    ) {
      throw backendError("invalid-arguments", "Controller environments must be unique.");
    }
    for (const environmentId of preferred === null ? backups : [preferred, ...backups]) {
      await requireActiveRegistration(ctx, actor.company._id, environmentId);
    }
    if (integration.state === "active") {
      const { requiresV2 } = await v2WatchRequirements(ctx, integration._id);
      if (requiresV2) {
        for (const environmentId of preferred === null ? backups : [preferred, ...backups]) {
          await requireControllerProtocol(ctx, actor.company._id, environmentId, 2);
        }
      }
    }
    const now = Date.now();
    await ctx.db.patch(integration._id, {
      preferredEnvironmentId: preferred,
      backupEnvironmentIds: backups,
      configurationRevision: integration.configurationRevision + 1,
      blockedReason: preferred === null ? "controller-not-configured" : integration.blockedReason,
      updatedAt: now,
    });
    if (
      integration.preferredEnvironmentId !== preferred ||
      JSON.stringify(integration.backupEnvironmentIds) !== JSON.stringify(backups)
    ) {
      await fenceLease(ctx, integration, now);
    }
    const updated = await ctx.db.get(integration._id);
    if (updated === null) throw new Error("The Slack integration vanished.");
    return await encodeIntegration(ctx, updated);
  },
});

export const activate = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    legacyWatchersAcknowledged: v.boolean(),
    enableAutomation: v.optional(v.boolean()),
  },
  returns: integrationRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null)
      throw backendError("entity-not-found", "The Slack integration is missing.");
    if (!args.legacyWatchersAcknowledged) {
      throw backendError(
        "activation-unsafe",
        "Acknowledge or rotate older local Slack watchers first.",
      );
    }
    if (!integration.credentialPresent || integration.preferredEnvironmentId === null) {
      throw backendError(
        "activation-unsafe",
        "A credential and preferred controller are required.",
      );
    }
    const selected = [integration.preferredEnvironmentId, ...integration.backupEnvironmentIds];
    const requirements = await v2WatchRequirements(ctx, integration._id);
    const now = Date.now();
    for (const environmentId of selected) {
      const registration = await requireActiveRegistration(ctx, actor.company._id, environmentId);
      const capabilities = await ctx.db
        .query("environmentProviderCapabilities")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
        )
        .unique();
      if (
        capabilities === null ||
        !capabilities.supportsSlackCoordination ||
        now - capabilities.publishedAt > CONTENDER_FRESH_MS ||
        registration.lastSeenAt === null ||
        now - registration.lastSeenAt > CONTENDER_FRESH_MS
      ) {
        throw backendError(
          "activation-unsafe",
          `Environment ${environmentId} is not Slack-capable and healthy.`,
        );
      }
      if (requirements.requiresV2 && (capabilities.slackProtocolVersion ?? 1) < 2) {
        throw backendError(
          "activation-unsafe",
          `Environment ${environmentId} does not support Slack workflow protocol V2.`,
        );
      }
      if (requirements.usesAutomation && !capabilities.supportsAutomationJobs) {
        throw backendError(
          "activation-unsafe",
          `Environment ${environmentId} cannot execute issue automation jobs.`,
        );
      }
    }
    if (requirements.usesAutomation) {
      const automation = await ctx.db
        .query("issueAutomationSettings")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .unique();
      if (automation === null) {
        throw backendError(
          "activation-unsafe",
          "Configure issue automation before activating Slack workflow automation.",
        );
      }
      if (!automation.enabled && args.enableAutomation !== true) {
        throw backendError(
          "activation-unsafe",
          "Confirm that issue automation may be enabled for this Slack workflow.",
        );
      }
      if (!automation.enabled) {
        await ctx.db.patch(automation._id, {
          enabled: true,
          activatedAt: automation.activatedAt ?? now,
          revision: automation.revision + 1,
          updatedAt: now,
        });
      }
    }
    await ctx.db.patch(integration._id, {
      state: "active",
      activatedAt: integration.activatedAt ?? now,
      blockedReason: null,
      configurationRevision: integration.configurationRevision + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get(integration._id);
    if (updated === null) throw new Error("The Slack integration vanished.");
    return await encodeIntegration(ctx, updated);
  },
});

export const disconnect = mutation({
  args: { companyId: domainIdArg, integrationId: domainIdArg },
  returns: integrationRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null)
      throw backendError("entity-not-found", "The Slack integration is missing.");
    const credential = await ctx.db
      .query("slackIntegrationCredentials")
      .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
      .unique();
    if (credential !== null) await ctx.db.delete(credential._id);
    const now = Date.now();
    await fenceLease(ctx, integration, now);
    await ctx.db.patch(integration._id, {
      state: "disconnected",
      credentialPresent: false,
      blockedReason: "credential-missing",
      configurationRevision: integration.configurationRevision + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get(integration._id);
    if (updated === null) throw new Error("The Slack integration vanished.");
    return await encodeIntegration(ctx, updated);
  },
});

/** Deletes an unactivated wizard draft without requiring the workspace-name danger confirmation. */
export const deleteDraft = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    expectedRevision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const row = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (row === null) return null;
    if (row.state !== "draft" || row.activatedAt != null) {
      throw backendError(
        "invalid-command-state",
        "Only an unactivated Slack draft can be deleted.",
      );
    }
    if (row.configurationRevision !== args.expectedRevision) {
      throw backendError("entity-conflict", "The Slack draft changed; reload it before deleting.");
    }
    const [credentials, watches, cursors, pending, leases, contenders] = await Promise.all([
      ctx.db
        .query("slackIntegrationCredentials")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackChannelWatches")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackChannelCursors")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackPendingIntake")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackCoordinatorLeases")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackCoordinatorContenders")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
    ]);
    for (const related of [credentials, watches, cursors, pending, leases, contenders]) {
      for (const item of related) await ctx.db.delete(item._id);
    }
    await ctx.db.delete(row._id);
    return null;
  },
});

export const remove = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    confirmWorkspaceName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const row = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (row === null) return null;
    if (args.confirmWorkspaceName !== row.workspaceName) {
      throw backendError(
        "invalid-arguments",
        "Type the Slack workspace name exactly to remove it.",
      );
    }
    const related = await Promise.all([
      ctx.db
        .query("slackIntegrationCredentials")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackChannelWatches")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackCoordinatorLeases")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackCoordinatorContenders")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackChannelCursors")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackProcessedMessages")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackOutboundDeliveries")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
      ctx.db
        .query("slackPendingIntake")
        .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
        .collect(),
    ]);
    for (const rows of related) for (const relatedRow of rows) await ctx.db.delete(relatedRow._id);
    const tombstone = await ctx.db
      .query("slackIntegrationTombstones")
      .withIndex("by_company_and_workspace", (q) =>
        q.eq("companyId", actor.company._id).eq("workspaceId", row.workspaceId),
      )
      .unique();
    if (tombstone === null && row.activatedAt != null) {
      await ctx.db.insert("slackIntegrationTombstones", {
        companyId: actor.company._id,
        workspaceId: row.workspaceId,
        removedAt: Date.now(),
      });
    }
    await ctx.db.delete(row._id);
    return null;
  },
});

/** Heartbeat plus acquire/renew. Lease-only writes intentionally create no company sync changes. */
export const heartbeat = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    healthy: v.boolean(),
    capabilityRevision: v.number(),
  },
  returns: leaseRecord,
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null)
      throw backendError("entity-not-found", "The Slack integration is missing.");
    const environmentId = actor.registration.environmentId;
    const pool =
      integration.preferredEnvironmentId === null
        ? integration.backupEnvironmentIds
        : [integration.preferredEnvironmentId, ...integration.backupEnvironmentIds];
    if (!pool.includes(environmentId)) {
      throw backendError("permission-denied", "This environment is not in the controller pool.");
    }
    const now = Date.now();
    const requirements = await v2WatchRequirements(ctx, integration._id);
    const requiredProtocol = requirements.requiresV2 ? 2 : 1;
    const protocolEligible = await controllerSupportsProtocol(
      ctx,
      actor.company._id,
      environmentId,
      requiredProtocol,
    );
    const effectiveHealthy = args.healthy && protocolEligible;
    const existingContender = await ctx.db
      .query("slackCoordinatorContenders")
      .withIndex("by_integration_and_environment", (q) =>
        q.eq("integrationId", integration._id).eq("environmentId", environmentId),
      )
      .unique();
    const contenderValues = {
      healthy: effectiveHealthy,
      capabilityRevision: args.capabilityRevision,
      lastHeartbeatAt: now,
    };
    if (existingContender === null) {
      await ctx.db.insert("slackCoordinatorContenders", {
        companyId: actor.company._id,
        integrationId: integration._id,
        environmentId,
        ...contenderValues,
      });
    } else {
      await ctx.db.patch(existingContender._id, contenderValues);
    }

    let lease = await leaseForIntegration(ctx, integration._id);
    if (lease === null) {
      const leaseId = await ctx.db.insert("slackCoordinatorLeases", {
        companyId: actor.company._id,
        integrationId: integration._id,
        holderEnvironmentId: null,
        generation: 0,
        expiresAt: null,
        preferredHealthyHeartbeats: 0,
        updatedAt: now,
      });
      lease = await ctx.db.get(leaseId);
      if (lease === null) throw new Error("The Slack lease vanished.");
    }

    const preferredHeartbeatCount =
      integration.preferredEnvironmentId === environmentId
        ? effectiveHealthy
          ? lease.preferredHealthyHeartbeats + 1
          : 0
        : lease.preferredHealthyHeartbeats;
    const holderProtocolEligible =
      lease.holderEnvironmentId !== null &&
      (await controllerSupportsProtocol(
        ctx,
        actor.company._id,
        lease.holderEnvironmentId,
        requiredProtocol,
      ));
    const holderStillEligible =
      integration.state === "active" &&
      lease.holderEnvironmentId !== null &&
      pool.includes(lease.holderEnvironmentId) &&
      holderProtocolEligible &&
      lease.expiresAt !== null &&
      lease.expiresAt > now;
    if (holderStillEligible) {
      const preferredReady =
        integration.preferredEnvironmentId !== null &&
        preferredHeartbeatCount >= FAILBACK_HEARTBEATS;
      const shouldYieldToPreferred =
        lease.holderEnvironmentId !== integration.preferredEnvironmentId && preferredReady;
      if (
        lease.holderEnvironmentId === environmentId &&
        !shouldYieldToPreferred &&
        effectiveHealthy
      ) {
        await ctx.db.patch(lease._id, {
          expiresAt: now + LEASE_TTL_MS,
          preferredHealthyHeartbeats: preferredHeartbeatCount,
          updatedAt: now,
        });
        return {
          integrationId: integration.id,
          holderEnvironmentId: environmentId,
          generation: lease.generation,
          expiresAt: now + LEASE_TTL_MS,
        };
      }
      await ctx.db.patch(lease._id, {
        preferredHealthyHeartbeats: preferredHeartbeatCount,
        updatedAt: now,
      });
      return {
        integrationId: integration.id,
        holderEnvironmentId: lease.holderEnvironmentId,
        generation: lease.generation,
        expiresAt: lease.expiresAt,
      };
    }

    const contenders = await ctx.db
      .query("slackCoordinatorContenders")
      .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
      .collect();
    const fresh = new Set<string>();
    for (const contender of contenders) {
      if (
        contender.healthy &&
        now - contender.lastHeartbeatAt <= CONTENDER_FRESH_MS &&
        (await controllerSupportsProtocol(
          ctx,
          actor.company._id,
          contender.environmentId,
          requiredProtocol,
        ))
      ) {
        fresh.add(contender.environmentId);
      }
    }
    const selected = pool.find(
      (candidate) =>
        fresh.has(candidate) &&
        (candidate !== integration.preferredEnvironmentId ||
          (lease!.holderEnvironmentId === null && lease!.generation === 0) ||
          preferredHeartbeatCount >= FAILBACK_HEARTBEATS),
    );
    if (integration.state === "active" && selected === environmentId && effectiveHealthy) {
      const generation = lease.generation + 1;
      await ctx.db.patch(lease._id, {
        holderEnvironmentId: environmentId,
        generation,
        expiresAt: now + LEASE_TTL_MS,
        preferredHealthyHeartbeats:
          environmentId === integration.preferredEnvironmentId ? preferredHeartbeatCount : 0,
        updatedAt: now,
      });
      return {
        integrationId: integration.id,
        holderEnvironmentId: environmentId,
        generation,
        expiresAt: now + LEASE_TTL_MS,
      };
    }
    if (lease.holderEnvironmentId !== null || lease.expiresAt !== null) {
      await ctx.db.patch(lease._id, {
        holderEnvironmentId: null,
        generation: lease.generation + 1,
        expiresAt: null,
        preferredHealthyHeartbeats: preferredHeartbeatCount,
        updatedAt: now,
      });
      return {
        integrationId: integration.id,
        holderEnvironmentId: null,
        generation: lease.generation + 1,
        expiresAt: null,
      };
    }
    return {
      integrationId: integration.id,
      holderEnvironmentId: null,
      generation: lease.generation,
      expiresAt: null,
    };
  },
});

/** Internal credential row gated by authenticated holder and exact live generation. */
export const runtimeCredentialRecord = internalQuery({
  args: { companyId: domainIdArg, integrationId: domainIdArg, generation: v.number() },
  returns: v.object({
    workspaceId: v.string(),
    keyId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    authenticationTag: v.string(),
  }),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null || integration.state !== "active") {
      throw backendError("entity-not-found", "The active Slack integration is missing.");
    }
    const requirements = await v2WatchRequirements(ctx, integration._id);
    const requiredProtocol = requirements.requiresV2 ? 2 : 1;
    if (
      !(await controllerSupportsProtocol(
        ctx,
        actor.company._id,
        actor.registration.environmentId,
        requiredProtocol,
      ))
    ) {
      throw backendError(
        "stale-controller-lease",
        `The Slack controller does not support workflow protocol V${requiredProtocol}.`,
      );
    }
    const lease = await leaseForIntegration(ctx, integration._id);
    const now = Date.now();
    if (
      lease === null ||
      lease.holderEnvironmentId !== actor.registration.environmentId ||
      lease.generation !== args.generation ||
      lease.expiresAt === null ||
      lease.expiresAt <= now
    ) {
      throw backendError("stale-controller-lease", "The Slack controller lease is stale.");
    }
    const credential = await ctx.db
      .query("slackIntegrationCredentials")
      .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
      .unique();
    if (credential === null) throw backendError("credential-missing", "Slack is disconnected.");
    return {
      workspaceId: credential.workspaceId,
      keyId: credential.keyId,
      iv: credential.iv,
      ciphertext: credential.ciphertext,
      authenticationTag: credential.authenticationTag,
    };
  },
});

/** The only plaintext credential response, available only to the current environment holder. */
const runtimeCredentialRecordReference = makeFunctionReference<
  "query",
  { companyId: string; integrationId: string; generation: number },
  {
    workspaceId: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
  }
>("slackIntegrations:runtimeCredentialRecord");

export const runtimeCredential = action({
  args: { companyId: domainIdArg, integrationId: domainIdArg, generation: v.number() },
  returns: v.object({ workspaceId: v.string(), token: v.string() }),
  handler: async (ctx, args): Promise<{ workspaceId: string; token: string }> => {
    const record: {
      workspaceId: string;
      keyId: string;
      iv: string;
      ciphertext: string;
      authenticationTag: string;
    } = await ctx.runQuery(runtimeCredentialRecordReference, args);
    const token = await decryptIntegrationCredential(
      record,
      {
        companyId: args.companyId,
        integrationId: args.integrationId,
        workspaceId: record.workspaceId,
      },
      integrationCredentialKeyringFromEnv(),
    );
    return { workspaceId: record.workspaceId, token };
  },
});

const credentialsForReEncryptionReference = makeFunctionReference<
  "query",
  Record<string, never>,
  Array<{
    credentialId: string;
    companyId: string;
    integrationId: string;
    workspaceId: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
  }>
>("slackIntegrations:credentialsForReEncryption");
const rewriteCredentialReference = makeFunctionReference<
  "mutation",
  {
    credentialId: string;
    expectedKeyId: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
  },
  boolean
>("slackIntegrations:rewriteCredential");

export const credentialsForReEncryption = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      credentialId: v.id("slackIntegrationCredentials"),
      companyId: v.string(),
      integrationId: v.string(),
      workspaceId: v.string(),
      keyId: v.string(),
      iv: v.string(),
      ciphertext: v.string(),
      authenticationTag: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("slackIntegrationCredentials").collect();
    const output = [];
    for (const row of rows) {
      const company = await ctx.db.get(row.companyId);
      const integration = await ctx.db.get(row.integrationId);
      if (company === null || integration === null) continue;
      output.push({
        credentialId: row._id,
        companyId: company.id,
        integrationId: integration.id,
        workspaceId: row.workspaceId,
        keyId: row.keyId,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authenticationTag: row.authenticationTag,
      });
    }
    return output;
  },
});

export const rewriteCredential = internalMutation({
  args: {
    credentialId: v.id("slackIntegrationCredentials"),
    expectedKeyId: v.string(),
    keyId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    authenticationTag: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.credentialId);
    if (row === null || row.keyId !== args.expectedKeyId) return false;
    await ctx.db.patch(row._id, {
      keyId: args.keyId,
      iv: args.iv,
      ciphertext: args.ciphertext,
      authenticationTag: args.authenticationTag,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Operator-only key rotation. Internal functions are not callable by application clients. */
export const reEncryptCredentials = internalAction({
  args: {},
  returns: v.object({ scanned: v.number(), rewritten: v.number(), activeKeyId: v.string() }),
  handler: async (ctx) => {
    const keyring = integrationCredentialKeyringFromEnv();
    const rows = await ctx.runQuery(credentialsForReEncryptionReference, {});
    let rewritten = 0;
    for (const row of rows) {
      if (row.keyId === keyring.activeKeyId) continue;
      const aad = {
        companyId: row.companyId,
        integrationId: row.integrationId,
        workspaceId: row.workspaceId,
      };
      const token = await decryptIntegrationCredential(row, aad, keyring);
      const sealed = await encryptIntegrationCredential(token, aad, keyring);
      if (
        await ctx.runMutation(rewriteCredentialReference, {
          credentialId: row.credentialId,
          expectedKeyId: row.keyId,
          ...sealed,
        })
      )
        rewritten += 1;
    }
    return { scanned: rows.length, rewritten, activeKeyId: keyring.activeKeyId };
  },
});

export const updateHealth = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    lastPollAt: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const integration = await integrationByDomainId(ctx, actor.company._id, args.integrationId);
    if (integration === null)
      throw backendError("entity-not-found", "The Slack integration is missing.");
    const lease = await leaseForIntegration(ctx, integration._id);
    const now = Date.now();
    if (
      lease === null ||
      lease.holderEnvironmentId !== actor.registration.environmentId ||
      lease.generation !== args.generation ||
      lease.expiresAt === null ||
      lease.expiresAt <= now
    ) {
      throw backendError("stale-controller-lease", "The Slack controller lease is stale.");
    }
    const error = boundedDiagnostic(args.error);
    const previousError = integration.currentError;
    const shouldRecord = (integration.healthHistory ?? []).length === 0 || error !== previousError;
    const healthHistory = shouldRecord
      ? [
          ...(integration.healthHistory ?? []),
          { at: now, state: error === null ? ("healthy" as const) : ("error" as const), error },
        ].slice(-20)
      : (integration.healthHistory ?? []);
    await ctx.db.patch(integration._id, {
      lastPollAt: args.lastPollAt ?? integration.lastPollAt,
      currentError: error,
      healthHistory,
      updatedAt: now,
    });
    return null;
  },
});

/** Publishes the non-secret provider/model surface used by activation and job readiness. */
export const publishCapabilities = mutation({
  args: {
    companyId: domainIdArg,
    revision: v.number(),
    supportsSlackCoordination: v.boolean(),
    supportsAutomationJobs: v.boolean(),
    slackProtocolVersion: v.optional(v.number()),
    providers: v.array(
      v.object({
        instanceId: v.string(),
        driverKind: v.string(),
        enabled: v.boolean(),
        available: v.boolean(),
        modelIds: v.array(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    if (
      args.providers.length > MAX_PROVIDER_INSTANCES ||
      args.providers.some(
        (provider) =>
          provider.instanceId.length > 256 ||
          provider.driverKind.length > 128 ||
          provider.modelIds.length > MAX_PROVIDER_MODELS ||
          provider.modelIds.some((model) => model.length === 0 || model.length > 256),
      ) ||
      new Set(args.providers.map((provider) => provider.instanceId)).size !== args.providers.length
    ) {
      throw backendError("invalid-arguments", "The provider capability snapshot is too large.");
    }
    const environmentId = actor.registration.environmentId;
    const existing = await ctx.db
      .query("environmentProviderCapabilities")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
      )
      .unique();
    const slackProtocolVersion = args.slackProtocolVersion ?? 1;
    if (!Number.isInteger(slackProtocolVersion) || slackProtocolVersion <= 0) {
      throw backendError("invalid-arguments", "Slack protocol version must be a positive integer.");
    }
    const values = {
      revision: args.revision,
      supportsSlackCoordination: args.supportsSlackCoordination,
      supportsAutomationJobs: args.supportsAutomationJobs,
      slackProtocolVersion,
      providers: args.providers.map((provider) => ({
        ...provider,
        instanceId: requireTrimmed(provider.instanceId, "Provider instance id"),
        modelIds: provider.modelIds.map((model) => requireTrimmed(model, "Model id")),
      })),
      publishedAt: Date.now(),
    };
    if (existing === null) {
      await ctx.db.insert("environmentProviderCapabilities", {
        companyId: actor.company._id,
        environmentId,
        ...values,
      });
    } else {
      await ctx.db.patch(existing._id, values);
    }
    return null;
  },
});
