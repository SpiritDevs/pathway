// @effect-diagnostics globalDate:off -- Convex functions use the transaction clock directly.
/** Company automation settings and durable, generation-fenced execution jobs. */
import { v } from "convex/values";

import { ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS } from "../src/environmentRegistrations.ts";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server.js";
import { mintDomainId } from "./lib/domainIds.ts";
import { applyDirectIssueOperation } from "./lib/directIssueApply.ts";
import { backendError } from "./lib/errors.ts";
import { encodeIssue } from "./lib/issueApply.ts";
import { requireCompanyActor, requirePermission, type EnvironmentActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const CLAIM_TTL_MS = 90_000;
const MAX_SETTINGS_BYTES = 256 * 1_024;
const MAX_DIAGNOSTIC_CHARS = 1_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const COMPLETED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

const jobState = v.union(
  v.literal("pending"),
  v.literal("blocked"),
  v.literal("claimed"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

const blockCode = v.union(
  v.literal("environment-offline"),
  v.literal("project-binding-missing"),
  v.literal("thread-environment-offline"),
  v.literal("provider-instance-missing"),
  v.literal("provider-disabled"),
  v.literal("model-unavailable"),
  v.literal("configuration-changed"),
  v.literal("authorization-revoked"),
);

const jobResult = v.union(
  v.object({ kind: v.literal("investigation"), summary: v.string() }),
  v.object({
    kind: v.literal("assignment"),
    routingRuleId: v.union(v.string(), v.null()),
    auditRuleIds: v.array(v.string()),
    rationale: v.string(),
    modelSelection: v.any(),
    driverKind: v.string(),
  }),
  v.object({
    kind: v.literal("audit"),
    outcome: v.union(v.literal("passed"), v.literal("changes-requested")),
    summary: v.string(),
    findings: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("reduction"),
    outcome: v.union(v.literal("passed"), v.literal("changes-requested")),
  }),
  v.object({ kind: v.literal("remediation"), dispatched: v.boolean() }),
);

const settingsRecord = v.object({
  enabled: v.boolean(),
  activatedAt: v.union(v.number(), v.null()),
  revision: v.number(),
  settings: v.any(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const jobRecord = v.object({
  id: domainIdArg,
  issueId: domainIdArg,
  kind: v.string(),
  triggerKey: v.string(),
  settingsRevision: v.number(),
  modelSelection: v.union(v.any(), v.null()),
  ruleId: v.union(v.string(), v.null()),
  ruleSnapshot: v.union(v.string(), v.null()),
  targetKind: v.union(v.literal("project"), v.literal("thread")),
  cloudProjectId: v.union(domainIdArg, v.null()),
  threadId: v.union(v.string(), v.null()),
  targetEnvironmentId: v.union(v.string(), v.null()),
  requiredProviderInstanceId: v.union(v.string(), v.null()),
  requiredModel: v.union(v.string(), v.null()),
  state: jobState,
  blockCode: v.union(blockCode, v.null()),
  diagnostic: v.union(v.string(), v.null()),
  claimHolderEnvironmentId: v.union(v.string(), v.null()),
  claimGeneration: v.number(),
  claimExpiresAt: v.union(v.number(), v.null()),
  attempts: v.number(),
  nextRetryAt: v.union(v.number(), v.null()),
  result: v.union(jobResult, v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.union(v.number(), v.null()),
});

function validateSettings(value: unknown): unknown {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  if (
    bytes > MAX_SETTINGS_BYTES ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw backendError("invalid-arguments", "Issue automation settings are invalid or too large.");
  }
  const settings = value as Record<string, unknown>;
  if (settings["schemaVersion"] !== 1) {
    throw backendError("invalid-arguments", "Issue automation settings need schema version 1.");
  }
  for (const key of ["routingRules", "auditRules", "reviewWorkers"] as const) {
    if (!Array.isArray(settings[key])) {
      throw backendError("invalid-arguments", `Issue automation ${key} must be an array.`);
    }
  }
  const routingRules = settings["routingRules"] as readonly unknown[];
  const auditRules = settings["auditRules"] as readonly unknown[];
  const reviewWorkers = settings["reviewWorkers"] as readonly unknown[];
  if (routingRules.length > 25 || auditRules.length > 25 || reviewWorkers.length > 5) {
    throw backendError(
      "invalid-arguments",
      "Issue automation settings exceed their configured bounds.",
    );
  }
  return value;
}

function encodeJob(row: Doc<"issueAutomationJobs">) {
  return {
    id: row.id,
    issueId: row.issueId,
    kind: row.kind,
    triggerKey: row.triggerKey,
    settingsRevision: row.settingsRevision,
    modelSelection: row.modelSelection,
    ruleId: row.ruleId,
    ruleSnapshot: row.ruleSnapshot,
    targetKind: row.targetKind,
    cloudProjectId: row.cloudProjectId === null ? null : undefined,
    threadId: row.threadId,
    targetEnvironmentId: row.targetEnvironmentId,
    requiredProviderInstanceId: row.requiredProviderInstanceId,
    requiredModel: row.requiredModel,
    state: row.state,
    blockCode: row.blockCode,
    diagnostic: row.diagnostic,
    claimHolderEnvironmentId: row.claimHolderEnvironmentId,
    claimGeneration: row.claimGeneration,
    claimExpiresAt: row.claimExpiresAt,
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt,
    result: row.result,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

async function encodeJobWithProject(
  ctx: MutationCtx | Parameters<typeof query>[0],
  row: Doc<"issueAutomationJobs">,
) {
  const project =
    row.cloudProjectId === null ? null : await (ctx as MutationCtx).db.get(row.cloudProjectId);
  return { ...encodeJob(row), cloudProjectId: project?.id ?? null };
}

function requireEnvironment(
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
): EnvironmentActor {
  if (actor.kind !== "environment") {
    throw backendError(
      "permission-denied",
      "Only a registered environment may execute automation jobs.",
    );
  }
  return actor;
}

async function jobById(ctx: MutationCtx, companyId: Doc<"companies">["_id"], jobId: string) {
  return await ctx.db
    .query("issueAutomationJobs")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", jobId))
    .unique();
}

function requireClaim(
  row: Doc<"issueAutomationJobs">,
  actor: EnvironmentActor,
  generation: number,
  now: number,
) {
  if (
    (row.state !== "claimed" && row.state !== "running") ||
    row.claimHolderEnvironmentId !== actor.registration.environmentId ||
    row.claimGeneration !== generation ||
    row.claimExpiresAt === null ||
    row.claimExpiresAt <= now
  ) {
    throw backendError("stale-automation-claim", "The automation job claim is stale.");
  }
}

export const getSettings = query({
  args: { companyId: domainIdArg },
  returns: v.union(settingsRecord, v.null()),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const row = await ctx.db
      .query("issueAutomationSettings")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .unique();
    if (row === null) return null;
    return {
      enabled: row.enabled,
      activatedAt: row.activatedAt ?? null,
      revision: row.revision,
      settings: row.settings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

export const saveSettings = mutation({
  args: {
    companyId: domainIdArg,
    settings: v.any(),
    expectedRevision: v.union(v.number(), v.null()),
  },
  returns: settingsRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const existing = await ctx.db
      .query("issueAutomationSettings")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .unique();
    if ((existing?.revision ?? null) !== args.expectedRevision) {
      throw backendError(
        "entity-conflict",
        "Issue automation settings changed; reload before saving.",
      );
    }
    const now = Date.now();
    const values = {
      settings: validateSettings(args.settings),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("issueAutomationSettings", {
        companyId: actor.company._id,
        enabled: false,
        activatedAt: null,
        ...values,
        createdAt: now,
      });
      return { enabled: false, activatedAt: null, ...values, createdAt: now };
    }
    await ctx.db.patch(existing._id, values);
    return {
      enabled: existing.enabled,
      activatedAt: existing.activatedAt ?? null,
      ...values,
      createdAt: existing.createdAt,
    };
  },
});

export const setEnabled = mutation({
  args: { companyId: domainIdArg, enabled: v.boolean() },
  returns: settingsRecord,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const row = await ctx.db
      .query("issueAutomationSettings")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .unique();
    if (row === null)
      throw backendError("entity-not-found", "Configure issue automation before enabling it.");
    if (args.enabled) {
      const now = Date.now();
      const capabilities = await ctx.db
        .query("environmentProviderCapabilities")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect();
      if (
        !capabilities.some(
          (snapshot) =>
            snapshot.supportsAutomationJobs &&
            now - snapshot.publishedAt <= ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS,
        )
      ) {
        throw backendError(
          "activation-unsafe",
          "No registered environment can execute automation jobs.",
        );
      }
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      enabled: args.enabled,
      activatedAt: args.enabled ? (row.activatedAt ?? now) : (row.activatedAt ?? null),
      revision: row.revision + 1,
      updatedAt: now,
    });
    return {
      enabled: args.enabled,
      activatedAt: args.enabled ? (row.activatedAt ?? now) : (row.activatedAt ?? null),
      revision: row.revision + 1,
      settings: row.settings,
      createdAt: row.createdAt,
      updatedAt: now,
    };
  },
});

export const listJobs = query({
  args: { companyId: domainIdArg, state: v.optional(jobState), limit: v.optional(v.number()) },
  returns: v.array(jobRecord),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const limit = Math.max(1, Math.min(args.limit ?? 100, 250));
    const rows =
      args.state === undefined
        ? await ctx.db
            .query("issueAutomationJobs")
            .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("issueAutomationJobs")
            .withIndex("by_company_and_state", (q) =>
              q
                .eq("companyId", actor.company._id)
                .eq("state", args.state as Doc<"issueAutomationJobs">["state"]),
            )
            .order("desc")
            .take(limit);
    const results = [];
    for (const row of rows) {
      const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
      results.push({ ...encodeJob(row), cloudProjectId: project?.id ?? null });
    }
    return results;
  },
});

/** Compact sidebar signal; keeps job snapshots and integration history out of periodic polling. */
export const attentionCount = query({
  args: { companyId: domainIdArg },
  returns: v.number(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const [integrations, blocked, failed] = await Promise.all([
      ctx.db
        .query("slackIntegrations")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect(),
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_state", (q) =>
          q.eq("companyId", actor.company._id).eq("state", "blocked"),
        )
        .collect(),
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_state", (q) =>
          q.eq("companyId", actor.company._id).eq("state", "failed"),
        )
        .collect(),
    ]);
    const now = Date.now();
    let integrationAttention = 0;
    for (const integration of integrations) {
      if (integration.currentError !== null || integration.blockedReason !== null) {
        integrationAttention += 1;
        continue;
      }
      if (integration.state !== "active") continue;
      const lease = await ctx.db
        .query("slackCoordinatorLeases")
        .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
        .unique();
      if (
        lease === null ||
        lease.holderEnvironmentId === null ||
        lease.expiresAt === null ||
        lease.expiresAt <= now
      ) {
        integrationAttention += 1;
      }
    }
    return integrationAttention + blocked.length + failed.length;
  },
});

export const claim = mutation({
  args: { companyId: domainIdArg, limit: v.optional(v.number()) },
  returns: v.array(jobRecord),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const environmentId = actor.registration.environmentId;
    const limit = Math.max(1, Math.min(args.limit ?? 5, 20));
    const now = Date.now();
    const pending = await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_target_and_state", (q) =>
        q.eq("targetEnvironmentId", environmentId).eq("state", "pending"),
      )
      .filter((q) => q.eq(q.field("companyId"), actor.company._id))
      .take(limit);
    const claimed = await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_target_and_state", (q) =>
        q.eq("targetEnvironmentId", environmentId).eq("state", "claimed"),
      )
      .filter((q) => q.eq(q.field("companyId"), actor.company._id))
      .take(limit);
    const running = await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_target_and_state", (q) =>
        q.eq("targetEnvironmentId", environmentId).eq("state", "running"),
      )
      .filter((q) => q.eq(q.field("companyId"), actor.company._id))
      .take(limit);
    const selected = [...pending, ...claimed, ...running]
      .filter(
        (row) =>
          (row.nextRetryAt === null || row.nextRetryAt <= now) &&
          (row.state === "pending" || row.claimExpiresAt === null || row.claimExpiresAt <= now),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    const output = [];
    for (const row of selected) {
      const patch = {
        state: "claimed" as const,
        claimHolderEnvironmentId: environmentId,
        claimGeneration: row.claimGeneration + 1,
        claimExpiresAt: now + CLAIM_TTL_MS,
        attempts: row.attempts + 1,
        nextRetryAt: null,
        updatedAt: now,
      };
      await ctx.db.patch(row._id, patch);
      const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
      output.push({ ...encodeJob({ ...row, ...patch }), cloudProjectId: project?.id ?? null });
    }
    return output;
  },
});

export const renew = mutation({
  args: { companyId: domainIdArg, jobId: domainIdArg, claimGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const row = await jobById(ctx, actor.company._id, args.jobId);
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    const now = Date.now();
    requireClaim(row, actor, args.claimGeneration, now);
    await ctx.db.patch(row._id, { claimExpiresAt: now + CLAIM_TTL_MS, updatedAt: now });
    return null;
  },
});

export const markRunning = mutation({
  args: { companyId: domainIdArg, jobId: domainIdArg, claimGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const row = await jobById(ctx, actor.company._id, args.jobId);
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    const now = Date.now();
    requireClaim(row, actor, args.claimGeneration, now);
    await ctx.db.patch(row._id, { state: "running", updatedAt: now });
    return null;
  },
});

/** Immutable job inputs plus the current issue and local execution root for the live claimant. */
export const executionContext = query({
  args: { companyId: domainIdArg, jobId: domainIdArg, claimGeneration: v.number() },
  returns: v.object({
    issue: v.any(),
    localWorkspaceRoot: v.union(v.string(), v.null()),
    localProjectId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const row = await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.jobId),
      )
      .unique();
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    requireClaim(row, actor, args.claimGeneration, Date.now());
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", row.issueId),
      )
      .unique();
    if (issue === null || issue.deletedAt !== null) {
      throw backendError("entity-not-found", "The automation issue is missing.");
    }
    const binding =
      row.cloudProjectId === null
        ? null
        : ((
            await ctx.db
              .query("environmentBindings")
              .withIndex("by_company_and_project", (q) =>
                q.eq("companyId", actor.company._id).eq("cloudProjectId", row.cloudProjectId!),
              )
              .collect()
          ).find(
            (candidate) =>
              candidate.environmentId === actor.registration.environmentId &&
              candidate.status === "active",
          ) ?? null);
    return {
      issue: encodeIssue(actor.company, issue),
      localWorkspaceRoot: binding?.localWorkspaceRoot ?? null,
      localProjectId: binding?.localProjectId ?? null,
    };
  },
});

async function applySuccessfulResult(
  ctx: MutationCtx,
  actor: EnvironmentActor,
  row: Doc<"issueAutomationJobs">,
  result: unknown,
) {
  const value =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
  if (value === null) return;
  if (row.kind === "automatic-assignment") {
    const modelSelection = value["modelSelection"];
    const rationale =
      typeof value["rationale"] === "string" ? value["rationale"] : "Automatically assigned.";
    const driverKind = typeof value["driverKind"] === "string" ? value["driverKind"] : null;
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `automation-result/${row.id}/assignment`,
      kind: "issue.update",
      entityId: row.issueId,
      source: "automation",
      args: {
        workModelSelection: modelSelection,
        ...(driverKind === null ? {} : { assignee: { kind: "agent", provider: driverKind } }),
        automationAssignment: {
          routingRuleId: typeof value["routingRuleId"] === "string" ? value["routingRuleId"] : null,
          auditRuleIds: Array.isArray(value["auditRuleIds"])
            ? value["auditRuleIds"].filter((id): id is string => typeof id === "string")
            : [],
          rationale,
          assignedAt: new Date().toISOString(),
        },
      },
    });
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `automation-result/${row.id}/assignment-comment`,
      kind: "issueComment.create",
      entityId: mintDomainId(Date.now()),
      source: "automation",
      args: {
        issueId: row.issueId,
        body: `### Automatically assigned\n\n${rationale}`,
        attachmentIds: [],
      },
    });
    return;
  }
  if (row.kind === "slack-investigation" && typeof value["summary"] === "string") {
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `automation-result/${row.id}/investigation`,
      kind: "issueComment.create",
      entityId: mintDomainId(Date.now()),
      source: "automation",
      args: {
        issueId: row.issueId,
        body: `### Investigation\n\n${value["summary"]}`,
        attachmentIds: [],
      },
    });
    return;
  }
  if (row.kind === "audit-execution") {
    const summary = typeof value["summary"] === "string" ? value["summary"] : "Audit completed.";
    const findings = Array.isArray(value["findings"])
      ? value["findings"].filter((finding): finding is string => typeof finding === "string")
      : [];
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `automation-result/${row.id}/audit-comment`,
      kind: "issueComment.create",
      entityId: mintDomainId(Date.now()),
      source: "automation",
      args: {
        issueId: row.issueId,
        body: `### Audit — ${row.ruleId ?? "review"}\n\n${summary}${findings.length === 0 ? "" : `\n\n${findings.map((finding) => `- ${finding}`).join("\n")}`}`,
        attachmentIds: [],
      },
    });
  }
}

async function addTerminalFailureComment(
  ctx: MutationCtx,
  actor: EnvironmentActor,
  row: Doc<"issueAutomationJobs">,
  diagnostic: string,
) {
  await applyDirectIssueOperation(ctx, actor, {
    operationId: `automation-failure/${row.id}`,
    kind: "issueComment.create",
    entityId: mintDomainId(Date.now()),
    source: "automation",
    args: {
      issueId: row.issueId,
      body: `Automation failed (${row.kind}): ${diagnostic}`,
      attachmentIds: [],
    },
  });
}

async function reduceAudits(
  ctx: MutationCtx,
  actor: EnvironmentActor,
  completed: Doc<"issueAutomationJobs">,
  now: number,
) {
  if (completed.kind !== "audit-execution") return;
  const prefix = completed.triggerKey.slice(0, completed.triggerKey.indexOf(":audit:"));
  const all = (
    await ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_company_and_issue", (q) =>
        q.eq("companyId", actor.company._id).eq("issueId", completed.issueId),
      )
      .collect()
  ).filter(
    (job) => job.kind === "audit-execution" && job.triggerKey.startsWith(`${prefix}:audit:`),
  );
  if (all.some((job) => job.state !== "succeeded" && job.id !== completed.id)) return;
  const outcome = all.some((job) => {
    const result = job.id === completed.id ? completed.result : job.result;
    return (
      typeof result === "object" &&
      result !== null &&
      (result as Record<string, unknown>)["outcome"] === "changes-requested"
    );
  })
    ? "changes-requested"
    : "passed";
  const triggerKey = `${prefix}:audit-reduction`;
  const existing = await ctx.db
    .query("issueAutomationJobs")
    .withIndex("by_company_and_trigger", (q) =>
      q.eq("companyId", actor.company._id).eq("triggerKey", triggerKey),
    )
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("issueAutomationJobs", {
    id: mintDomainId(now),
    companyId: actor.company._id,
    issueId: completed.issueId,
    kind: "audit-outcome-reduction",
    triggerKey,
    settingsRevision: completed.settingsRevision,
    modelSelection: null,
    ruleId: null,
    ruleSnapshot: null,
    targetKind: completed.targetKind,
    cloudProjectId: completed.cloudProjectId,
    threadId: completed.threadId,
    targetEnvironmentId: completed.targetEnvironmentId,
    requiredProviderInstanceId: null,
    requiredModel: null,
    state: "succeeded",
    blockCode: null,
    diagnostic: null,
    claimHolderEnvironmentId: null,
    claimGeneration: 0,
    claimExpiresAt: null,
    attempts: 0,
    nextRetryAt: null,
    result: { kind: "reduction", outcome },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  const settings = await ctx.db
    .query("issueAutomationSettings")
    .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
    .unique();
  const config =
    typeof settings?.settings === "object" && settings.settings !== null
      ? (settings.settings as Record<string, unknown>)
      : null;
  const transitions =
    typeof config?.["statusTransitions"] === "object" && config["statusTransitions"] !== null
      ? (config["statusTransitions"] as Record<string, unknown>)
      : null;
  const statusId =
    outcome === "passed"
      ? transitions?.["auditPassedStatusId"]
      : transitions?.["auditChangesRequestedStatusId"];
  if (typeof statusId === "string") {
    await applyDirectIssueOperation(ctx, actor, {
      operationId: `${triggerKey}:status`,
      kind: "issue.update",
      entityId: completed.issueId,
      source: "automation",
      args: { statusId },
    });
  }
  if (outcome !== "changes-requested" || completed.targetEnvironmentId === null) return;
  const workers = Array.isArray(config?.["reviewWorkers"])
    ? (config["reviewWorkers"] as readonly unknown[])
    : [];
  const worker =
    typeof workers[0] === "object" && workers[0] !== null
      ? (workers[0] as Record<string, unknown>)
      : null;
  const model =
    typeof worker?.["modelSelection"] === "object" && worker["modelSelection"] !== null
      ? (worker["modelSelection"] as Record<string, unknown>)
      : null;
  await ctx.db.insert("issueAutomationJobs", {
    id: mintDomainId(now),
    companyId: actor.company._id,
    issueId: completed.issueId,
    kind: "remediation-dispatch",
    triggerKey: `${prefix}:remediation:0`,
    settingsRevision: settings?.revision ?? completed.settingsRevision,
    modelSelection: model,
    ruleId: typeof worker?.["id"] === "string" ? worker["id"] : null,
    ruleSnapshot:
      worker === null
        ? null
        : JSON.stringify({
            worker,
            findings: all.flatMap((job) => {
              const result = job.id === completed.id ? completed.result : job.result;
              return typeof result === "object" &&
                result !== null &&
                Array.isArray((result as Record<string, unknown>)["findings"])
                ? ((result as Record<string, unknown>)["findings"] as readonly unknown[]).filter(
                    (item): item is string => typeof item === "string",
                  )
                : [];
            }),
          }).slice(0, 16_000),
    targetKind: "thread",
    cloudProjectId: null,
    threadId: completed.threadId,
    targetEnvironmentId: completed.targetEnvironmentId,
    requiredProviderInstanceId:
      typeof model?.["instanceId"] === "string" ? model["instanceId"] : null,
    requiredModel: typeof model?.["model"] === "string" ? model["model"] : null,
    state: worker === null ? "blocked" : "pending",
    blockCode: worker === null ? "configuration-changed" : null,
    diagnostic: worker === null ? "No remediation worker is configured." : null,
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
}

export const report = mutation({
  args: {
    companyId: domainIdArg,
    jobId: domainIdArg,
    claimGeneration: v.number(),
    outcome: v.union(v.literal("succeeded"), v.literal("transient-failure"), v.literal("blocked")),
    result: v.union(jobResult, v.null()),
    blockCode: v.union(blockCode, v.null()),
    diagnostic: v.union(v.string(), v.null()),
  },
  returns: jobRecord,
  handler: async (ctx, args) => {
    const actor = requireEnvironment(await requireCompanyActor(ctx, args.companyId));
    const row = await jobById(ctx, actor.company._id, args.jobId);
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    const now = Date.now();
    requireClaim(row, actor, args.claimGeneration, now);
    const diagnostic = args.diagnostic?.trim().slice(0, MAX_DIAGNOSTIC_CHARS) || null;
    let patch: Partial<Doc<"issueAutomationJobs">>;
    if (args.outcome === "succeeded") {
      patch = {
        state: "succeeded",
        result: args.result,
        blockCode: null,
        diagnostic: null,
        claimHolderEnvironmentId: null,
        claimExpiresAt: null,
        updatedAt: now,
        completedAt: now,
      };
    } else if (args.outcome === "blocked") {
      if (args.blockCode === null)
        throw backendError("invalid-arguments", "A blocked job needs a block code.");
      patch = {
        state: "blocked",
        blockCode: args.blockCode,
        diagnostic,
        claimHolderEnvironmentId: null,
        claimExpiresAt: null,
        updatedAt: now,
      };
    } else {
      const retryIndex = row.attempts - 1;
      if (retryIndex < RETRY_DELAYS_MS.length) {
        patch = {
          state: "pending",
          diagnostic,
          claimHolderEnvironmentId: null,
          claimExpiresAt: null,
          nextRetryAt: now + (RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS[2]),
          updatedAt: now,
        };
      } else {
        patch = {
          state: "failed",
          diagnostic: diagnostic ?? "The automation executor failed repeatedly.",
          claimHolderEnvironmentId: null,
          claimExpiresAt: null,
          nextRetryAt: null,
          updatedAt: now,
          completedAt: now,
        };
      }
    }
    await ctx.db.patch(row._id, patch);
    const updated = { ...row, ...patch } as Doc<"issueAutomationJobs">;
    if (updated.state === "failed") {
      await addTerminalFailureComment(ctx, actor, updated, updated.diagnostic ?? "Unknown failure");
    }
    if (updated.state === "succeeded") {
      await applySuccessfulResult(ctx, actor, updated, args.result);
      await reduceAudits(ctx, actor, updated, now);
    }
    const project =
      updated.cloudProjectId === null ? null : await ctx.db.get(updated.cloudProjectId);
    return { ...encodeJob(updated), cloudProjectId: project?.id ?? null };
  },
});

export const retry = mutation({
  args: { companyId: domainIdArg, jobId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const row = await jobById(ctx, actor.company._id, args.jobId);
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    if (row.state !== "failed" && row.state !== "blocked") {
      throw backendError("invalid-command-state", "Only failed or blocked jobs can be retried.");
    }
    await ctx.db.patch(row._id, {
      state: "pending",
      blockCode: null,
      diagnostic: null,
      claimHolderEnvironmentId: null,
      claimExpiresAt: null,
      nextRetryAt: null,
      completedAt: null,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const cancel = mutation({
  args: { companyId: domainIdArg, jobId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.manage");
    const row = await jobById(ctx, actor.company._id, args.jobId);
    if (row === null) throw backendError("entity-not-found", "The automation job is missing.");
    if (["succeeded", "failed", "canceled"].includes(row.state)) return null;
    await ctx.db.patch(row._id, {
      state: "canceled",
      claimGeneration: row.claimGeneration + 1,
      claimHolderEnvironmentId: null,
      claimExpiresAt: null,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    return null;
  },
});

export const pruneCompleted = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - COMPLETED_RETENTION_MS;
    const terminal = ["succeeded", "failed", "canceled"] as const;
    let removed = 0;
    for (const state of terminal) {
      const rows = await ctx.db
        .query("issueAutomationJobs")
        .filter((q) => q.and(q.eq(q.field("state"), state), q.lt(q.field("completedAt"), cutoff)))
        .take(100 - removed);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
      if (removed >= 100) break;
    }
    return removed;
  },
});

/** Periodic prerequisite re-evaluation keeps unclaimed intent honest without client polling. */
export const recoverBlocked = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const [blocked, pending] = await Promise.all([
      ctx.db
        .query("issueAutomationJobs")
        .filter((q) => q.eq(q.field("state"), "blocked"))
        .take(100),
      ctx.db
        .query("issueAutomationJobs")
        .filter((q) => q.eq(q.field("state"), "pending"))
        .take(100),
    ]);
    let changed = 0;
    const rows = [...blocked, ...pending].slice(0, 150);
    for (const row of rows) {
      if (row.blockCode === "configuration-changed") continue;
      let targetEnvironmentId = row.targetKind === "project" ? null : row.targetEnvironmentId;
      if (row.targetKind === "project" && row.cloudProjectId !== null) {
        const project = await ctx.db.get(row.cloudProjectId);
        if (project?.preferredBindingId !== null && project !== null) {
          const bindings = await ctx.db
            .query("environmentBindings")
            .withIndex("by_company_and_project", (q) =>
              q.eq("companyId", row.companyId).eq("cloudProjectId", row.cloudProjectId!),
            )
            .collect();
          targetEnvironmentId =
            bindings.find(
              (binding) => binding.id === project.preferredBindingId && binding.status === "active",
            )?.environmentId ?? null;
        }
      }
      let block: {
        code: NonNullable<Doc<"issueAutomationJobs">["blockCode"]>;
        diagnostic: string;
      } | null = null;
      if (targetEnvironmentId === null) {
        block = {
          code:
            row.targetKind === "project" ? "project-binding-missing" : "thread-environment-offline",
          diagnostic:
            row.targetKind === "project"
              ? "The selected project has no preferred active environment binding."
              : "The linked thread environment is unavailable.",
        };
      } else {
        const registration = await ctx.db
          .query("environmentRegistrations")
          .withIndex("by_company_and_environment", (q) =>
            q.eq("companyId", row.companyId).eq("environmentId", targetEnvironmentId!),
          )
          .unique();
        if (
          registration === null ||
          registration.state !== "active" ||
          registration.lastSeenAt === null ||
          now - registration.lastSeenAt > ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS
        ) {
          block = {
            code:
              row.targetKind === "project" ? "environment-offline" : "thread-environment-offline",
            diagnostic: "The target environment is offline.",
          };
        } else {
          const capabilities = await ctx.db
            .query("environmentProviderCapabilities")
            .withIndex("by_company_and_environment", (q) =>
              q.eq("companyId", row.companyId).eq("environmentId", targetEnvironmentId!),
            )
            .unique();
          if (
            capabilities?.supportsAutomationJobs !== true ||
            now - capabilities.publishedAt > ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS
          ) {
            block = {
              code: "environment-offline",
              diagnostic: "The target environment has not published fresh automation capabilities.",
            };
          } else if (row.requiredProviderInstanceId !== null) {
            const provider = capabilities.providers.find(
              (candidate) => candidate.instanceId === row.requiredProviderInstanceId,
            );
            if (provider === undefined) {
              block = {
                code: "provider-instance-missing",
                diagnostic: `Provider instance ${row.requiredProviderInstanceId} is not installed on the target environment.`,
              };
            } else if (!provider.enabled || !provider.available) {
              block = {
                code: "provider-disabled",
                diagnostic: `Provider instance ${row.requiredProviderInstanceId} is disabled or unavailable.`,
              };
            } else if (
              row.requiredModel !== null &&
              !provider.modelIds.includes(row.requiredModel)
            ) {
              block = {
                code: "model-unavailable",
                diagnostic: `Model ${row.requiredModel} is unavailable on ${row.requiredProviderInstanceId}.`,
              };
            }
          }
        }
      }
      const patch = {
        targetEnvironmentId,
        state: block === null ? ("pending" as const) : ("blocked" as const),
        blockCode: block?.code ?? null,
        diagnostic: block?.diagnostic ?? null,
        updatedAt: now,
      };
      if (
        row.targetEnvironmentId !== patch.targetEnvironmentId ||
        row.state !== patch.state ||
        row.blockCode !== patch.blockCode ||
        row.diagnostic !== patch.diagnostic
      ) {
        await ctx.db.patch(row._id, patch);
        changed += 1;
      }
    }
    return changed;
  },
});
