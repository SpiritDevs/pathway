// @effect-diagnostics globalDate:off -- Convex functions use the transaction clock directly.
/** Shared Slack watches, cursors, origin dedupe, and fenced intake/delivery mutations. */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { automationReadiness } from "./lib/automationJobs.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { applyDirectIssueOperation } from "./lib/directIssueApply.ts";
import { backendError } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission, type EnvironmentActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const DELIVERY_CLAIM_TTL_MS = 90_000;
const MAX_REACTION_ROUTES = 25;

const watchRecord = v.object({
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
  const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
  return {
    id: row.id,
    integrationId: (await ctx.db.get(row.integrationId))?.id ?? "missing",
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
    const trigger = watch.trigger as {
      readonly reactionRoutes?: ReadonlyArray<{
        readonly emoji?: unknown;
        readonly cloudProjectId?: unknown;
        readonly autoInvestigate?: unknown;
      }>;
    };
    const route =
      args.routeEmoji === null
        ? null
        : (trigger.reactionRoutes?.find((item) => item.emoji === args.routeEmoji) ?? null);
    if (args.routeEmoji !== null && route === null) {
      throw backendError(
        "configuration-changed",
        "The selected Slack reaction route no longer exists.",
      );
    }
    const routeProjectId =
      route !== null && typeof route.cloudProjectId === "string" ? route.cloudProjectId : null;
    const projectDomainId = routeProjectId ?? null;
    const configuredProject =
      projectDomainId === null
        ? watch.cloudProjectId
        : ((
            await ctx.db
              .query("cloudProjects")
              .withIndex("by_company_and_domain_id", (q) =>
                q.eq("companyId", actor.company._id).eq("id", projectDomainId),
              )
              .unique()
          )?._id ?? null);
    const project = configuredProject === null ? null : await ctx.db.get(configuredProject);
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
        cycleId: watch.cycleId ?? undefined,
        triage: true,
        teamIds: project?.teamIds ?? [],
        workflowOwner: project?.defaultWorkflowOwner ?? { kind: "company" },
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
