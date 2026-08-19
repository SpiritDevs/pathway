// @effect-diagnostics globalDate:off -- Convex functions use the transaction clock directly.
/** Shared Slack watches, cursors, origin dedupe, and fenced intake/delivery mutations. */
import { v } from "convex/values";

import {
  SLACK_ROUTING_MAX_NODES_PER_RULE,
  SLACK_ROUTING_MAX_NODES_PER_WATCH,
  SLACK_ROUTING_MAX_PREFIX_CHARS,
  SLACK_ROUTING_MAX_PREFIXES_PER_LEAF,
  SLACK_ROUTING_MAX_RULES_PER_CHANNEL,
  SLACK_ROUTING_MAX_SERIALIZED_BYTES,
  type CompanySlackRoutingCondition,
  type CompanySlackRoutingRule,
} from "@spiritdevs/contracts";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { automationReadiness } from "./lib/automationJobs.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { applyDirectIssueOperation } from "./lib/directIssueApply.ts";
import { backendError } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission, type EnvironmentActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const DELIVERY_CLAIM_TTL_MS = 90_000;
const MAX_REACTION_ROUTES = 25;

type RoutingRule = CompanySlackRoutingRule;

const watchRecordV1 = v.object({
  id: domainIdArg,
  integrationId: domainIdArg,
  channelId: v.string(),
  channelName: v.string(),
  cloudProjectId: v.union(domainIdArg, v.null()),
  cycleId: v.union(domainIdArg, v.null()),
  autoInvestigate: v.boolean(),
  autoAssign: v.boolean(),
  trigger: v.any(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const watchRecordV2 = v.object({
  id: domainIdArg,
  integrationId: domainIdArg,
  channelId: v.string(),
  channelName: v.string(),
  configurationVersion: v.literal(2),
  rules: v.any(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const watchRecord = v.union(watchRecordV1, watchRecordV2);

const deliveryRecord = v.object({
  deliveryId: domainIdArg,
  state: v.union(v.literal("pending"), v.literal("claimed"), v.literal("succeeded")),
  claimGeneration: v.number(),
  claimExpiresAt: v.union(v.number(), v.null()),
  slackMessageTs: v.union(v.string(), v.null()),
});

function trimmed(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value) {
    throw backendError("invalid-arguments", `${label} must be a non-empty, trimmed string.`);
  }
  return normalized;
}

function validateTrigger(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw backendError("invalid-arguments", "A Slack trigger must be an object.");
  }
  const trigger = value as Record<string, unknown>;
  if (typeof trigger["everyMessage"] !== "boolean" || typeof trigger["botMention"] !== "boolean") {
    throw backendError("invalid-arguments", "Slack trigger switches must be booleans.");
  }
  if (
    !Array.isArray(trigger["reactionRoutes"]) ||
    trigger["reactionRoutes"].length > MAX_REACTION_ROUTES
  ) {
    throw backendError("invalid-arguments", "Slack reaction routes exceed the supported bound.");
  }
  const seen = new Set<string>();
  for (const item of trigger["reactionRoutes"]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw backendError("invalid-arguments", "Each Slack reaction route must be an object.");
    }
    const route = item as Record<string, unknown>;
    if (typeof route["emoji"] !== "string" || !/^[a-z0-9_+-]+$/u.test(route["emoji"])) {
      throw backendError("invalid-arguments", "A Slack reaction route has an invalid emoji name.");
    }
    if (seen.has(route["emoji"])) {
      throw backendError("invalid-arguments", "Slack reaction routes must be unique.");
    }
    seen.add(route["emoji"]);
    if (route["cloudProjectId"] !== null && typeof route["cloudProjectId"] !== "string") {
      throw backendError(
        "invalid-arguments",
        "A reaction project must be a cloud project id or null.",
      );
    }
    if (route["autoInvestigate"] !== null && typeof route["autoInvestigate"] !== "boolean") {
      throw backendError(
        "invalid-arguments",
        "A reaction investigation override must be boolean or null.",
      );
    }
  }
  return value;
}

function validateCondition(value: unknown): {
  condition: CompanySlackRoutingCondition;
  nodes: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw backendError("invalid-arguments", "A Slack routing condition must be an object.");
  }
  const condition = value as Record<string, unknown>;
  const kind = condition["kind"];
  if (kind === "all" || kind === "any") {
    if (!Array.isArray(condition["conditions"]) || condition["conditions"].length === 0) {
      throw backendError("invalid-arguments", `A Slack ${kind} condition cannot be empty.`);
    }
    let nodes = 1;
    for (const child of condition["conditions"]) nodes += validateCondition(child).nodes;
    if (nodes > SLACK_ROUTING_MAX_NODES_PER_RULE) {
      throw backendError("invalid-arguments", "A Slack routing rule has too many condition nodes.");
    }
    return { condition: value as CompanySlackRoutingCondition, nodes };
  }
  if (kind === "text-prefix") {
    if (
      !Array.isArray(condition["prefixes"]) ||
      condition["prefixes"].length === 0 ||
      condition["prefixes"].length > SLACK_ROUTING_MAX_PREFIXES_PER_LEAF
    ) {
      throw backendError("invalid-arguments", "A text-prefix condition has invalid prefixes.");
    }
    const normalized = new Set<string>();
    for (const prefix of condition["prefixes"]) {
      if (
        typeof prefix !== "string" ||
        prefix.trim() !== prefix ||
        prefix.length === 0 ||
        prefix.length > SLACK_ROUTING_MAX_PREFIX_CHARS
      ) {
        throw backendError("invalid-arguments", "Slack prefixes must be short, trimmed strings.");
      }
      const key = prefix.toLocaleLowerCase();
      if (normalized.has(key)) {
        throw backendError("invalid-arguments", "Slack prefixes must be unique ignoring case.");
      }
      normalized.add(key);
    }
    return { condition: value as CompanySlackRoutingCondition, nodes: 1 };
  }
  if (kind === "reaction") {
    if (typeof condition["emoji"] !== "string" || !/^[a-z0-9_+-]+$/u.test(condition["emoji"])) {
      throw backendError("invalid-arguments", "A Slack reaction condition has an invalid emoji.");
    }
    return { condition: value as CompanySlackRoutingCondition, nodes: 1 };
  }
  if (kind === "bot-mention" || kind === "every-message") {
    return { condition: value as CompanySlackRoutingCondition, nodes: 1 };
  }
  throw backendError("invalid-arguments", "A Slack routing condition has an unknown kind.");
}

async function liveStatus(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  statusId: string | null,
  teamId: string | null,
) {
  if (statusId === null) return null;
  const status = await ctx.db
    .query("issueStatuses")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", statusId))
    .unique();
  if (
    status === null ||
    status.deletedAt !== null ||
    (status.scope === "team" && status.teamId !== teamId)
  ) {
    throw backendError("invalid-arguments", `Status ${statusId} is unavailable for this rule.`);
  }
  return status;
}

async function validateRoutingRules(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  value: unknown,
): Promise<readonly RoutingRule[]> {
  if (!Array.isArray(value) || value.length > SLACK_ROUTING_MAX_RULES_PER_CHANNEL) {
    throw backendError("invalid-arguments", "Slack routing rules exceed the supported bound.");
  }
  const serialized = new TextEncoder().encode(
    JSON.stringify({ configurationVersion: 2, rules: value }),
  ).byteLength;
  if (serialized > SLACK_ROUTING_MAX_SERIALIZED_BYTES) {
    throw backendError("invalid-arguments", "Slack routing configuration is too large.");
  }
  const ids = new Set<string>();
  let totalNodes = 0;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw backendError("invalid-arguments", "Each Slack routing rule must be an object.");
    }
    const rule = raw as Record<string, unknown>;
    const id = typeof rule["id"] === "string" ? trimmed(rule["id"], "Routing rule id") : null;
    if (id === null || ids.has(id)) {
      throw backendError("invalid-arguments", "Slack routing rule ids must be present and unique.");
    }
    ids.add(id);
    if (typeof rule["name"] !== "string") {
      throw backendError("invalid-arguments", "A Slack routing rule needs a name.");
    }
    trimmed(rule["name"], "Routing rule name");
    totalNodes += validateCondition(rule["condition"]).nodes;
    const teamId = rule["teamId"];
    if (teamId !== null && typeof teamId !== "string") {
      throw backendError("invalid-arguments", "A routing team must be a team id or null.");
    }
    if (typeof teamId === "string") {
      const team = await ctx.db
        .query("teams")
        .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", teamId))
        .unique();
      if (team === null || team.archivedAt !== null) {
        throw backendError("invalid-arguments", `Team ${teamId} is unavailable.`);
      }
    }
    const projectId = rule["cloudProjectId"];
    if (projectId !== null && typeof projectId !== "string") {
      throw backendError("invalid-arguments", "A routing project must be a project id or null.");
    }
    const project = await projectForWatch(ctx, companyId, projectId as string | null);
    if (typeof teamId === "string" && project !== null && !project.teamIds.includes(teamId)) {
      throw backendError("invalid-arguments", "The routing project belongs to a different team.");
    }
    const cycleId = rule["cycleId"];
    if (cycleId !== null && typeof cycleId !== "string") {
      throw backendError("invalid-arguments", "A routing cycle must be a cycle id or null.");
    }
    if (typeof cycleId === "string") {
      const cycle = await ctx.db
        .query("issueCycles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", companyId).eq("id", cycleId),
        )
        .unique();
      if (
        cycle === null ||
        cycle.deletedAt !== null ||
        (cycle.teamId !== null && cycle.teamId !== teamId) ||
        (cycle.teamId !== null && project !== null && !project.teamIds.includes(cycle.teamId))
      ) {
        throw backendError("invalid-arguments", "The routing cycle belongs to a different team.");
      }
    }
    for (const key of ["initialStatusId"] as const) {
      const statusId = rule[key];
      if (statusId !== null && typeof statusId !== "string") {
        throw backendError("invalid-arguments", "A routing status must be a status id or null.");
      }
      await liveStatus(ctx, companyId, statusId as string | null, teamId as string | null);
    }
    const investigation = rule["investigation"];
    if (
      typeof investigation !== "object" ||
      investigation === null ||
      Array.isArray(investigation)
    ) {
      throw backendError("invalid-arguments", "A routing rule needs an investigation policy.");
    }
    const policy = investigation as Record<string, unknown>;
    if (!new Set(["off", "immediate", "on-status"]).has(policy["timing"] as string)) {
      throw backendError("invalid-arguments", "A routing investigation timing is invalid.");
    }
    for (const key of ["triggerStatusId", "successStatusId"] as const) {
      const statusId = policy[key];
      if (statusId !== null && typeof statusId !== "string") {
        throw backendError(
          "invalid-arguments",
          "An investigation status must be a status id or null.",
        );
      }
      await liveStatus(ctx, companyId, statusId as string | null, teamId as string | null);
    }
    if (policy["timing"] === "on-status" && policy["triggerStatusId"] === null) {
      throw backendError(
        "invalid-arguments",
        "Status-triggered investigation needs a trigger status.",
      );
    }
    if (policy["timing"] !== "on-status" && policy["triggerStatusId"] !== null) {
      throw backendError(
        "invalid-arguments",
        "Only status-triggered investigation may set a trigger status.",
      );
    }
    if (
      !new Set(["off", "immediate", "after-investigation"]).has(rule["assignmentTiming"] as string)
    ) {
      throw backendError("invalid-arguments", "A routing assignment timing is invalid.");
    }
    if (rule["assignmentTiming"] === "after-investigation" && policy["timing"] === "off") {
      throw backendError(
        "invalid-arguments",
        "Assignment cannot wait for a disabled investigation.",
      );
    }
  }
  if (totalNodes > SLACK_ROUTING_MAX_NODES_PER_WATCH) {
    throw backendError(
      "invalid-arguments",
      "Slack routing configuration has too many condition nodes.",
    );
  }
  return value as readonly RoutingRule[];
}

async function integration(
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

async function watchResult(ctx: QueryCtx, row: Doc<"slackChannelWatches">) {
  const owner = await ctx.db.get(row.integrationId);
  if (row.configurationVersion === 2) {
    return {
      id: row.id,
      integrationId: owner?.id ?? "missing",
      channelId: row.channelId,
      channelName: row.channelName,
      configurationVersion: 2 as const,
      rules: Array.isArray(row.rules) ? row.rules : [],
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
  return {
    id: row.id,
    integrationId: owner?.id ?? "missing",
    channelId: row.channelId,
    channelName: row.channelName,
    cloudProjectId: project?.id ?? null,
    cycleId: row.cycleId,
    autoInvestigate: row.autoInvestigate,
    autoAssign: row.autoAssign,
    trigger: row.trigger,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function projectForWatch(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  projectId: string | null,
) {
  if (projectId === null) return null;
  const project = await ctx.db
    .query("cloudProjects")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", projectId))
    .unique();
  if (project === null || project.deletedAt !== null || project.archivedAt !== null) {
    throw backendError("invalid-arguments", "The watched channel project is unavailable.");
  }
  return project;
}

async function validateCycle(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  cycleId: string | null,
  project: Doc<"cloudProjects"> | null,
) {
  if (cycleId === null) return;
  const cycle = await ctx.db
    .query("issueCycles")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", cycleId))
    .unique();
  if (
    cycle === null ||
    cycle.deletedAt !== null ||
    (cycle.teamId !== null && (project === null || !project.teamIds.includes(cycle.teamId)))
  ) {
    throw backendError("invalid-arguments", "The watched channel cycle is unavailable.");
  }
}

async function liveController(
  ctx: QueryCtx,
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
  integrationId: string,
  generation: number,
): Promise<{ integration: Doc<"slackIntegrations">; actor: EnvironmentActor }> {
  if (actor.kind !== "environment") {
    throw backendError(
      "permission-denied",
      "Only a registered environment may execute Slack intake.",
    );
  }
  const row = await integration(ctx, actor.company._id, integrationId);
  if (row === null || row.state !== "active") {
    throw backendError("entity-not-found", "The active Slack integration is missing.");
  }
  const lease = await ctx.db
    .query("slackCoordinatorLeases")
    .withIndex("by_integration", (q) => q.eq("integrationId", row._id))
    .unique();
  if (
    lease === null ||
    lease.holderEnvironmentId !== actor.registration.environmentId ||
    lease.generation !== generation ||
    lease.expiresAt === null ||
    lease.expiresAt <= Date.now()
  ) {
    throw backendError("stale-controller-lease", "The Slack controller lease is stale.");
  }
  return { integration: row, actor };
}

export const listWatches = query({
  args: { companyId: domainIdArg, integrationId: domainIdArg },
  returns: v.array(watchRecord),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const owner = await integration(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const rows = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_integration", (q) => q.eq("integrationId", owner._id))
      .collect();
    return await Promise.all(rows.map((row) => watchResult(ctx, row)));
  },
});

/** Creates or atomically replaces one complete V2 channel workflow. */
export const saveWatchV2 = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    id: domainIdArg,
    channelId: v.string(),
    channelName: v.string(),
    rules: v.any(),
    expectedRevision: v.union(v.number(), v.null()),
  },
  returns: watchRecordV2,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const owner = await integration(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const channelId = trimmed(args.channelId, "Slack channel id");
    const channelName = trimmed(args.channelName, "Slack channel name");
    const rules = await validateRoutingRules(ctx, actor.company._id, args.rules);
    const existing = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (args.expectedRevision === null) {
      if (existing !== null) {
        throw backendError("entity-conflict", "The Slack channel watch already exists.");
      }
      const duplicate = await ctx.db
        .query("slackChannelWatches")
        .withIndex("by_integration_and_channel", (q) =>
          q.eq("integrationId", owner._id).eq("channelId", channelId),
        )
        .unique();
      if (duplicate !== null) {
        throw backendError("entity-conflict", "This channel is already watched.");
      }
    } else if (
      existing === null ||
      existing.integrationId !== owner._id ||
      existing.revision !== args.expectedRevision
    ) {
      throw backendError("entity-conflict", "The Slack watch changed; reload it before saving.");
    }
    if (existing !== null && existing.channelId !== channelId) {
      throw backendError("invalid-arguments", "A saved Slack watch cannot change channels.");
    }
    if (owner.state === "active") {
      for (const environmentId of [
        ...(owner.preferredEnvironmentId === null ? [] : [owner.preferredEnvironmentId]),
        ...owner.backupEnvironmentIds,
      ]) {
        const capabilities = await ctx.db
          .query("environmentProviderCapabilities")
          .withIndex("by_company_and_environment", (q) =>
            q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
          )
          .unique();
        if ((capabilities?.slackProtocolVersion ?? 1) < 2) {
          throw backendError(
            "activation-unsafe",
            `Environment ${environmentId} does not support Slack workflow protocol V2.`,
          );
        }
      }
    }
    const now = Date.now();
    const revision = (existing?.revision ?? 0) + 1;
    const values = {
      channelName,
      configurationVersion: 2 as const,
      rules,
      // V1 columns remain populated so old documents and indexes remain migration-safe.
      cloudProjectId: null,
      cycleId: null,
      autoInvestigate: false,
      autoAssign: false,
      trigger: { everyMessage: false, botMention: false, reactionRoutes: [] },
      revision,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("slackChannelWatches", {
        id: args.id,
        companyId: actor.company._id,
        integrationId: owner._id,
        channelId,
        ...values,
        createdAt: now,
      });
      await ctx.db.insert("slackChannelCursors", {
        companyId: actor.company._id,
        integrationId: owner._id,
        channelId,
        messageCursor: (now / 1_000).toFixed(6),
        reactionCursor: (now / 1_000).toFixed(6),
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, values);
    }
    await ctx.db.patch(owner._id, {
      watchCount: existing === null ? owner.watchCount + 1 : owner.watchCount,
      configurationRevision: owner.configurationRevision + 1,
      updatedAt: now,
    });
    return {
      id: args.id,
      integrationId: owner.id,
      channelId,
      channelName,
      configurationVersion: 2 as const,
      rules,
      revision,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  },
});

export const createWatch = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    id: domainIdArg,
    channelId: v.string(),
    channelName: v.string(),
    cloudProjectId: v.union(domainIdArg, v.null()),
    cycleId: v.union(domainIdArg, v.null()),
    autoInvestigate: v.boolean(),
    autoAssign: v.boolean(),
    trigger: v.any(),
  },
  returns: watchRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const owner = await integration(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const channelId = trimmed(args.channelId, "Slack channel id");
    const duplicate = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId),
      )
      .unique();
    if (duplicate !== null)
      throw backendError("entity-conflict", "This channel is already watched.");
    const project = await projectForWatch(ctx, actor.company._id, args.cloudProjectId);
    await validateCycle(ctx, actor.company._id, args.cycleId, project);
    const now = Date.now();
    const rowId = await ctx.db.insert("slackChannelWatches", {
      id: args.id,
      companyId: actor.company._id,
      integrationId: owner._id,
      channelId,
      channelName: trimmed(args.channelName, "Slack channel name"),
      cloudProjectId: project?._id ?? null,
      cycleId: args.cycleId,
      autoInvestigate: args.autoInvestigate,
      autoAssign: args.autoAssign,
      trigger: validateTrigger(args.trigger),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("slackChannelCursors", {
      companyId: actor.company._id,
      integrationId: owner._id,
      channelId,
      messageCursor: (now / 1_000).toFixed(6),
      reactionCursor: (now / 1_000).toFixed(6),
      updatedAt: now,
    });
    await ctx.db.patch(owner._id, {
      watchCount: owner.watchCount + 1,
      configurationRevision: owner.configurationRevision + 1,
      updatedAt: now,
    });
    const row = await ctx.db.get(rowId);
    if (row === null) throw new Error("The Slack watch vanished.");
    return await watchResult(ctx, row);
  },
});

export const updateWatch = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    watchId: domainIdArg,
    channelName: v.string(),
    cloudProjectId: v.union(domainIdArg, v.null()),
    cycleId: v.union(domainIdArg, v.null()),
    autoInvestigate: v.boolean(),
    autoAssign: v.boolean(),
    trigger: v.any(),
    expectedRevision: v.number(),
  },
  returns: watchRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const owner = await integration(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const row = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.watchId),
      )
      .unique();
    if (row === null || row.integrationId !== owner._id) {
      throw backendError("entity-not-found", "The Slack watch is missing.");
    }
    if (row.revision !== args.expectedRevision) {
      throw backendError("entity-conflict", "The Slack watch changed; reload it before saving.");
    }
    const project = await projectForWatch(ctx, actor.company._id, args.cloudProjectId);
    await validateCycle(ctx, actor.company._id, args.cycleId, project);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      channelName: trimmed(args.channelName, "Slack channel name"),
      cloudProjectId: project?._id ?? null,
      cycleId: args.cycleId,
      autoInvestigate: args.autoInvestigate,
      autoAssign: args.autoAssign,
      trigger: validateTrigger(args.trigger),
      revision: row.revision + 1,
      updatedAt: now,
    });
    await ctx.db.patch(owner._id, {
      configurationRevision: owner.configurationRevision + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get(row._id);
    if (updated === null) throw new Error("The Slack watch vanished.");
    return await watchResult(ctx, updated);
  },
});

export const deleteWatch = mutation({
  args: { companyId: domainIdArg, integrationId: domainIdArg, watchId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const owner = await integration(ctx, actor.company._id, args.integrationId);
    if (owner === null) throw backendError("entity-not-found", "The Slack integration is missing.");
    const row = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.watchId),
      )
      .unique();
    if (row === null || row.integrationId !== owner._id) return null;
    const cursor = await ctx.db
      .query("slackChannelCursors")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", row.channelId),
      )
      .unique();
    if (cursor !== null) await ctx.db.delete(cursor._id);
    const pending = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration", (q) => q.eq("integrationId", owner._id))
      .collect();
    for (const item of pending) {
      if (item.channelId === row.channelId) await ctx.db.delete(item._id);
    }
    await ctx.db.delete(row._id);
    await ctx.db.patch(owner._id, {
      watchCount: Math.max(0, owner.watchCount - 1),
      configurationRevision: owner.configurationRevision + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const runtimeConfiguration = query({
  args: { companyId: domainIdArg, integrationId: domainIdArg, generation: v.number() },
  returns: v.object({ workspaceId: v.string(), watches: v.array(watchRecord) }),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const rows = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_integration", (q) => q.eq("integrationId", owner._id))
      .collect();
    return {
      workspaceId: owner.workspaceId,
      watches: await Promise.all(rows.map((row) => watchResult(ctx, row))),
    };
  },
});

const deferredMessageRecord = v.object({
  channelId: v.string(),
  messageTs: v.string(),
  watchRevision: v.number(),
  candidateRuleId: domainIdArg,
  eligibleAt: v.number(),
});

/** Stores only identity and eligibility; Slack message content is fetched again when due. */
export const deferMessage = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    messageTs: v.string(),
    watchRevision: v.number(),
    candidateRuleId: domainIdArg,
    eligibleAt: v.number(),
  },
  returns: deferredMessageRecord,
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const channelId = trimmed(args.channelId, "Slack channel id");
    const messageTs = trimmed(args.messageTs, "Slack message timestamp");
    const watch = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId),
      )
      .unique();
    if (
      watch?.configurationVersion !== 2 ||
      watch.revision !== args.watchRevision ||
      !Array.isArray(watch.rules) ||
      !(watch.rules as readonly unknown[]).some(
        (raw) =>
          typeof raw === "object" &&
          raw !== null &&
          !Array.isArray(raw) &&
          (raw as Record<string, unknown>)["id"] === args.candidateRuleId,
      )
    ) {
      throw backendError("configuration-changed", "The deferred Slack routing rule changed.");
    }
    const existingDecision = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId).eq("messageTs", messageTs),
      )
      .unique();
    if (existingDecision !== null) {
      throw backendError("invalid-command-state", "This Slack message already has a decision.");
    }
    const existing = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration_channel_and_message", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId).eq("messageTs", messageTs),
      )
      .unique();
    const now = Date.now();
    const values = {
      watchRevision: args.watchRevision,
      candidateRuleId: args.candidateRuleId,
      eligibleAt: Math.max(now, args.eligibleAt),
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("slackPendingIntake", {
        companyId: owner.companyId,
        integrationId: owner._id,
        channelId,
        messageTs,
        ...values,
        createdAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, values);
    }
    return {
      channelId,
      messageTs,
      watchRevision: values.watchRevision,
      candidateRuleId: values.candidateRuleId,
      eligibleAt: values.eligibleAt,
    };
  },
});

export const listDueMessages = query({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(deferredMessageRecord),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const rows = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration_and_due", (q) =>
        q.eq("integrationId", owner._id).lte("eligibleAt", Date.now()),
      )
      .take(limit);
    return rows.map((row) => ({
      channelId: row.channelId,
      messageTs: row.messageTs,
      watchRevision: row.watchRevision,
      candidateRuleId: row.candidateRuleId,
      eligibleAt: row.eligibleAt,
    }));
  },
});

export const clearDeferredMessage = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    messageTs: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const row = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.messageTs),
      )
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});

export const readCursor = query({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
  },
  returns: v.object({
    messageCursor: v.union(v.string(), v.null()),
    reactionCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const cursor = await ctx.db
      .query("slackChannelCursors")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", args.channelId),
      )
      .unique();
    if (cursor === null)
      throw backendError("entity-not-found", "The Slack channel cursor is missing.");
    return { messageCursor: cursor.messageCursor, reactionCursor: cursor.reactionCursor };
  },
});

export const updateCursor = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    messageCursor: v.union(v.string(), v.null()),
    reactionCursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const cursor = await ctx.db
      .query("slackChannelCursors")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", args.channelId),
      )
      .unique();
    if (cursor === null)
      throw backendError("entity-not-found", "The Slack channel cursor is missing.");
    await ctx.db.patch(cursor._id, {
      messageCursor: args.messageCursor,
      reactionCursor: args.reactionCursor,
      updatedAt: Date.now(),
    });
    return null;
  },
});

async function preferredProjectEnvironment(
  ctx: QueryCtx,
  project: Doc<"cloudProjects"> | null,
): Promise<string | null> {
  if (project?.preferredBindingId === null || project === null) return null;
  const bindings = await ctx.db
    .query("environmentBindings")
    .withIndex("by_company_and_project", (q) =>
      q.eq("companyId", project.companyId).eq("cloudProjectId", project._id),
    )
    .collect();
  return (
    bindings.find(
      (binding) => binding.id === project.preferredBindingId && binding.status === "active",
    )?.environmentId ?? null
  );
}

async function enqueueSlackJobs(
  ctx: MutationCtx,
  company: Doc<"companies">,
  issueId: string,
  originKey: string,
  watch: Doc<"slackChannelWatches">,
  project: Doc<"cloudProjects"> | null,
  autoInvestigate: boolean,
  autoAssign: boolean,
  now: number,
) {
  const automation = await ctx.db
    .query("issueAutomationSettings")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .unique();
  if (automation === null || !automation.enabled) return;
  const targetEnvironmentId = await preferredProjectEnvironment(ctx, project);
  const insert = async (kind: "slack-investigation" | "automatic-assignment") => {
    const triggerKey = `${originKey}:${kind}`;
    const existing = await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_company_and_trigger", (q) =>
        q.eq("companyId", company._id).eq("triggerKey", triggerKey),
      )
      .unique();
    if (existing !== null) return;
    const modelSelection =
      kind === "automatic-assignment"
        ? ((automation.settings as Record<string, unknown>)["routingModelSelection"] ?? null)
        : ((automation.settings as Record<string, unknown>)["fallbackModelSelection"] ??
          (automation.settings as Record<string, unknown>)["routingModelSelection"] ??
          null);
    const selection =
      typeof modelSelection === "object" && modelSelection !== null
        ? (modelSelection as Record<string, unknown>)
        : null;
    const requiredSelection =
      typeof selection?.["instanceId"] === "string" && typeof selection["model"] === "string"
        ? { instanceId: selection["instanceId"], model: selection["model"] }
        : null;
    const ready = await automationReadiness(
      ctx,
      company._id,
      targetEnvironmentId,
      requiredSelection,
      "project",
    );
    await ctx.db.insert("issueAutomationJobs", {
      id: mintDomainId(now),
      companyId: company._id,
      issueId,
      kind,
      triggerKey,
      settingsRevision: automation.revision,
      modelSelection,
      ruleId: null,
      ruleSnapshot: JSON.stringify(automation.settings).slice(0, 16_000),
      targetKind: "project",
      cloudProjectId: project?._id ?? null,
      threadId: null,
      targetEnvironmentId,
      requiredProviderInstanceId:
        typeof selection?.["instanceId"] === "string" ? selection["instanceId"] : null,
      requiredModel: typeof selection?.["model"] === "string" ? selection["model"] : null,
      state: ready.state,
      blockCode: ready.code,
      diagnostic: ready.diagnostic,
      claimHolderEnvironmentId: null,
      claimGeneration: 0,
      claimExpiresAt: null,
      attempts: 0,
      nextRetryAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
  };
  if (autoInvestigate) await insert("slack-investigation");
  if (autoAssign) await insert("automatic-assignment");
}

export const createIssue = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    messageTs: v.string(),
    routeEmoji: v.union(v.string(), v.null()),
    ruleId: v.optional(domainIdArg),
    watchRevision: v.optional(v.number()),
    title: v.string(),
    description: v.string(),
    permalink: v.union(v.string(), v.null()),
    authorName: v.union(v.string(), v.null()),
  },
  returns: v.object({ created: v.boolean(), issueId: domainIdArg, issueKey: v.string() }),
  handler: async (ctx, args) => {
    const { integration: owner, actor } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const channelId = trimmed(args.channelId, "Slack channel id");
    const messageTs = trimmed(args.messageTs, "Slack message timestamp");
    const existing = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId).eq("messageTs", messageTs),
      )
      .unique();
    if (existing !== null) {
      // A root that was deliberately ignored can become actionable later when somebody adds a
      // configured reaction. The ignored row is still useful while polling, but it must not turn
      // that later human action into a permanent tombstone.
      if (existing.issueId === null) {
        const existingWatch = await ctx.db
          .query("slackChannelWatches")
          .withIndex("by_integration_and_channel", (q) =>
            q.eq("integrationId", owner._id).eq("channelId", channelId),
          )
          .unique();
        if (existingWatch?.configurationVersion === 2) {
          throw backendError(
            "invalid-command-state",
            "This Slack message already has a terminal routing decision.",
          );
        }
        await ctx.db.delete(existing._id);
      } else {
        const issue = await ctx.db
          .query("issues")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", actor.company._id).eq("id", existing.issueId as string),
          )
          .unique();
        if (issue === null)
          throw backendError("entity-not-found", "The canonical Slack issue is missing.");
        return { created: false, issueId: issue.id, issueKey: issue.key };
      }
    }
    const watch = await ctx.db
      .query("slackChannelWatches")
      .withIndex("by_integration_and_channel", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId),
      )
      .unique();
    if (watch === null) throw backendError("entity-not-found", "The Slack channel is not watched.");
    const isV2 = watch.configurationVersion === 2;
    let v2Rule: RoutingRule | null = null;
    if (isV2) {
      if (args.ruleId === undefined || args.watchRevision !== watch.revision) {
        throw backendError(
          "configuration-changed",
          "The selected Slack workflow changed before the issue was created.",
        );
      }
      v2Rule = Array.isArray(watch.rules)
        ? ((watch.rules as readonly RoutingRule[]).find((rule) => rule.id === args.ruleId) ?? null)
        : null;
      if (v2Rule === null) {
        throw backendError("configuration-changed", "The selected Slack workflow rule is missing.");
      }
    } else if (args.ruleId !== undefined || args.watchRevision !== undefined) {
      throw backendError("invalid-arguments", "V1 Slack intake cannot name a V2 routing rule.");
    }
    const trigger = watch.trigger as {
      readonly reactionRoutes?: ReadonlyArray<{
        readonly emoji?: unknown;
        readonly cloudProjectId?: unknown;
        readonly autoInvestigate?: unknown;
      }>;
    };
    const route =
      isV2 || args.routeEmoji === null
        ? null
        : (trigger.reactionRoutes?.find((item) => item.emoji === args.routeEmoji) ?? null);
    if (!isV2 && args.routeEmoji !== null && route === null) {
      throw backendError(
        "configuration-changed",
        "The selected Slack reaction route no longer exists.",
      );
    }
    const routeProjectId =
      route !== null && typeof route.cloudProjectId === "string" ? route.cloudProjectId : null;
    const projectDomainId = v2Rule?.cloudProjectId ?? routeProjectId ?? null;
    const configuredProject =
      projectDomainId === null
        ? isV2
          ? null
          : watch.cloudProjectId
        : ((
            await ctx.db
              .query("cloudProjects")
              .withIndex("by_company_and_domain_id", (q) =>
                q.eq("companyId", actor.company._id).eq("id", projectDomainId),
              )
              .unique()
          )?._id ?? null);
    const project = configuredProject === null ? null : await ctx.db.get(configuredProject);
    if (projectDomainId !== null && project === null) {
      throw backendError("configuration-changed", "The watched channel project is missing.");
    }
    if (project !== null && (project.deletedAt !== null || project.archivedAt !== null)) {
      throw backendError("configuration-changed", "The watched channel project is unavailable.");
    }
    const issueId = mintDomainId(Date.now());
    const operationId = `slack/${owner.id}/${channelId}/${messageTs}`.slice(0, 128);
    await applyDirectIssueOperation(ctx, actor, {
      operationId,
      kind: "issue.create",
      entityId: issueId,
      args: {
        title: trimmed(args.title, "Issue title"),
        description: args.description,
        projectId: project?.id,
        cycleId: v2Rule?.cycleId ?? watch.cycleId ?? undefined,
        ...(v2Rule?.initialStatusId === null || v2Rule === null
          ? { triage: true }
          : { triage: false, statusId: v2Rule.initialStatusId }),
        teamIds:
          project?.teamIds ?? (v2Rule?.teamId === null || v2Rule === null ? [] : [v2Rule.teamId]),
        workflowOwner:
          v2Rule === null
            ? (project?.defaultWorkflowOwner ?? { kind: "company" })
            : v2Rule.teamId === null
              ? { kind: "company" }
              : { kind: "team", teamId: v2Rule.teamId },
        slackSource: {
          issueId,
          integrationId: owner.id,
          workspaceId: owner.workspaceId,
          ...(owner.workspaceDomain === null ? {} : { workspaceDomain: owner.workspaceDomain }),
          channelId,
          messageTs,
          permalink: args.permalink,
          authorName: args.authorName,
        },
      },
    });
    const now = Date.now();
    await ctx.db.insert("slackProcessedMessages", {
      companyId: actor.company._id,
      integrationId: owner._id,
      workspaceId: owner.workspaceId,
      channelId,
      messageTs,
      rootMessageTs: messageTs,
      disposition: "created",
      issueId,
      commentId: null,
      reason: null,
      lastReplyScanAt: 0,
      processedAt: now,
    });
    const pending = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration_channel_and_message", (q) =>
        q.eq("integrationId", owner._id).eq("channelId", channelId).eq("messageTs", messageTs),
      )
      .unique();
    if (pending !== null) await ctx.db.delete(pending._id);
    if (v2Rule === null) {
      await enqueueSlackJobs(
        ctx,
        actor.company,
        issueId,
        operationId,
        watch,
        project,
        route !== null && typeof route.autoInvestigate === "boolean"
          ? route.autoInvestigate
          : watch.autoInvestigate,
        watch.autoAssign,
        now,
      );
    } else {
      const ruleSnapshot = JSON.stringify(v2Rule).slice(0, 16_000);
      const investigationNow =
        v2Rule.investigation.timing === "immediate" ||
        (v2Rule.investigation.timing === "on-status" &&
          v2Rule.initialStatusId !== null &&
          v2Rule.initialStatusId === v2Rule.investigation.triggerStatusId);
      const assignmentNow = v2Rule.assignmentTiming === "immediate";
      await ctx.db.insert("slackIssueAutomationIntents", {
        companyId: actor.company._id,
        issueId,
        integrationId: owner._id,
        watchId: watch.id,
        watchRevision: watch.revision,
        ruleId: v2Rule.id,
        ruleSnapshot,
        cloudProjectId: project?._id ?? null,
        investigationTiming: v2Rule.investigation.timing,
        investigationTriggerStatusId: v2Rule.investigation.triggerStatusId,
        investigationSuccessStatusId: v2Rule.investigation.successStatusId,
        investigationState:
          v2Rule.investigation.timing === "off"
            ? "off"
            : investigationNow
              ? "scheduled"
              : "waiting",
        assignmentTiming: v2Rule.assignmentTiming,
        assignmentState:
          v2Rule.assignmentTiming === "off" ? "off" : assignmentNow ? "scheduled" : "waiting",
        createdAt: now,
        updatedAt: now,
      });
      await enqueueSlackJobs(
        ctx,
        actor.company,
        issueId,
        operationId,
        watch,
        project,
        investigationNow,
        assignmentNow,
        now,
      );
    }
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", issueId),
      )
      .unique();
    if (issue === null) throw new Error("The Slack issue vanished.");
    return { created: true, issueId, issueKey: issue.key };
  },
});

export const addReply = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    rootMessageTs: v.string(),
    messageTs: v.string(),
    authorName: v.union(v.string(), v.null()),
    body: v.string(),
  },
  returns: v.object({ created: v.boolean(), issueId: domainIdArg }),
  handler: async (ctx, args) => {
    const { integration: owner, actor } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const existing = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.messageTs),
      )
      .unique();
    if (existing !== null) {
      if (existing.issueId === null)
        throw backendError("entity-not-found", "The Slack reply has no issue.");
      return { created: false, issueId: existing.issueId };
    }
    const root = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.rootMessageTs),
      )
      .unique();
    if (root?.issueId === null || root === null) {
      throw backendError("entity-not-found", "The Slack thread is not linked to an issue.");
    }
    const commentId = mintDomainId(Date.now());
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `slack-reply/${owner.id}/${args.channelId}/${args.messageTs}`.slice(0, 128),
      kind: "issueComment.create",
      entityId: commentId,
      args: {
        issueId: root.issueId,
        body:
          args.authorName === null
            ? args.body
            : `**Slack reply from ${args.authorName}:**\n\n${args.body}`,
        attachmentIds: [],
      },
    });
    await ctx.db.insert("slackProcessedMessages", {
      companyId: actor.company._id,
      integrationId: owner._id,
      workspaceId: owner.workspaceId,
      channelId: args.channelId,
      messageTs: args.messageTs,
      rootMessageTs: args.rootMessageTs,
      disposition: "commented",
      issueId: root.issueId,
      commentId,
      reason: null,
      processedAt: Date.now(),
    });
    return { created: true, issueId: root.issueId };
  },
});

/** Canonical issue threads due for a bounded round-robin reply scan. */
export const threadsForReplyScan = query({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({ threadTs: v.string() })),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const limit = Math.max(1, Math.min(args.limit ?? 10, 25));
    const rows = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_disposition_and_reply_scan", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("disposition", "created"),
      )
      .order("asc")
      .take(limit);
    return rows.map((row) => ({ threadTs: row.messageTs }));
  },
});

export const markThreadReplyScanned = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    threadTs: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { integration: owner } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const root = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.threadTs),
      )
      .unique();
    if (root === null || root.disposition !== "created" || root.issueId === null) {
      throw backendError("entity-not-found", "The canonical Slack issue thread is missing.");
    }
    await ctx.db.patch(root._id, { lastReplyScanAt: Date.now() });
    return null;
  },
});

export const recordIgnored = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    channelId: v.string(),
    messageTs: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { integration: owner, actor } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const existing = await ctx.db
      .query("slackProcessedMessages")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.messageTs),
      )
      .unique();
    if (existing !== null) return null;
    await ctx.db.insert("slackProcessedMessages", {
      companyId: actor.company._id,
      integrationId: owner._id,
      workspaceId: owner.workspaceId,
      channelId: args.channelId,
      messageTs: args.messageTs,
      rootMessageTs: args.messageTs,
      disposition: "ignored",
      issueId: null,
      commentId: null,
      reason: args.reason.trim().slice(0, 500) || "no-trigger",
      processedAt: Date.now(),
    });
    const pending = await ctx.db
      .query("slackPendingIntake")
      .withIndex("by_integration_channel_and_message", (q) =>
        q
          .eq("integrationId", owner._id)
          .eq("channelId", args.channelId)
          .eq("messageTs", args.messageTs),
      )
      .unique();
    if (pending !== null) await ctx.db.delete(pending._id);
    return null;
  },
});

export const pendingDeliveries = query({
  args: { companyId: domainIdArg, integrationId: domainIdArg, generation: v.number() },
  returns: v.array(
    v.object({
      deliveryId: domainIdArg,
      channelId: v.string(),
      threadTs: v.string(),
      kind: v.union(v.literal("confirmation"), v.literal("comment"), v.literal("status")),
      text: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const { integration } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const now = Date.now();
    const rows = await ctx.db
      .query("slackOutboundDeliveries")
      .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
      .collect();
    return rows
      .filter(
        (row) =>
          row.text !== undefined &&
          (row.state === "pending" ||
            (row.state === "claimed" &&
              (row.claimExpiresAt === null || row.claimExpiresAt <= now))),
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, 100)
      .map((row) => ({
        deliveryId: row.deliveryId,
        channelId: row.channelId,
        threadTs: row.threadTs,
        kind: row.kind,
        text: row.text!,
      }));
  },
});

export const claimDelivery = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    deliveryId: domainIdArg,
    channelId: v.string(),
    threadTs: v.string(),
    kind: v.union(v.literal("confirmation"), v.literal("comment"), v.literal("status")),
    text: v.optional(v.string()),
  },
  returns: deliveryRecord,
  handler: async (ctx, args) => {
    const { integration: owner, actor } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const existing = await ctx.db
      .query("slackOutboundDeliveries")
      .withIndex("by_integration_and_delivery", (q) =>
        q.eq("integrationId", owner._id).eq("deliveryId", args.deliveryId),
      )
      .unique();
    const now = Date.now();
    if (existing !== null && existing.state === "succeeded") {
      return {
        deliveryId: existing.deliveryId,
        state: existing.state,
        claimGeneration: existing.claimGeneration,
        claimExpiresAt: existing.claimExpiresAt,
        slackMessageTs: existing.slackMessageTs,
      };
    }
    if (
      existing !== null &&
      existing.state === "claimed" &&
      existing.claimedByEnvironmentId !== actor.registration.environmentId &&
      existing.claimExpiresAt !== null &&
      existing.claimExpiresAt > now
    ) {
      throw backendError("delivery-claimed", "Another controller still owns this delivery.");
    }
    const claimGeneration = (existing?.claimGeneration ?? 0) + 1;
    const values = {
      state: "claimed" as const,
      claimedByEnvironmentId: actor.registration.environmentId,
      claimGeneration,
      claimExpiresAt: now + DELIVERY_CLAIM_TTL_MS,
      updatedAt: now,
      ...(args.text === undefined ? {} : { text: args.text.trim().slice(0, 20_000) }),
    };
    if (existing === null) {
      await ctx.db.insert("slackOutboundDeliveries", {
        companyId: actor.company._id,
        integrationId: owner._id,
        deliveryId: args.deliveryId,
        channelId: trimmed(args.channelId, "Slack channel id"),
        threadTs: trimmed(args.threadTs, "Slack thread timestamp"),
        kind: args.kind,
        ...values,
        slackMessageTs: null,
        createdAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, values);
    }
    return {
      deliveryId: args.deliveryId,
      state: "claimed" as const,
      claimGeneration,
      claimExpiresAt: now + DELIVERY_CLAIM_TTL_MS,
      slackMessageTs: existing?.slackMessageTs ?? null,
    };
  },
});

export const completeDelivery = mutation({
  args: {
    companyId: domainIdArg,
    integrationId: domainIdArg,
    generation: v.number(),
    deliveryId: domainIdArg,
    claimGeneration: v.number(),
    slackMessageTs: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { integration: owner, actor } = await liveController(
      ctx,
      await requireCompanyActor(ctx, args.companyId),
      args.integrationId,
      args.generation,
    );
    const delivery = await ctx.db
      .query("slackOutboundDeliveries")
      .withIndex("by_integration_and_delivery", (q) =>
        q.eq("integrationId", owner._id).eq("deliveryId", args.deliveryId),
      )
      .unique();
    if (
      delivery === null ||
      delivery.state !== "claimed" ||
      delivery.claimedByEnvironmentId !== actor.registration.environmentId ||
      delivery.claimGeneration !== args.claimGeneration ||
      delivery.claimExpiresAt === null ||
      delivery.claimExpiresAt <= Date.now()
    ) {
      throw backendError("stale-delivery-claim", "The Slack delivery claim is stale.");
    }
    await ctx.db.patch(delivery._id, {
      state: "succeeded",
      slackMessageTs: trimmed(args.slackMessageTs, "Slack message timestamp"),
      claimExpiresAt: null,
      updatedAt: Date.now(),
    });
    return null;
  },
});
