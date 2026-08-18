// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Transactional automation-job scheduling helpers shared by issue and Slack mutations. */
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS } from "../../src/environmentRegistrations.ts";
import { mintDomainId } from "./domainIds.ts";

type ModelSelection = { readonly instanceId: string; readonly model: string };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function selection(value: unknown): ModelSelection | null {
  const source = object(value);
  return source !== null &&
    typeof source["instanceId"] === "string" &&
    typeof source["model"] === "string"
    ? { instanceId: source["instanceId"], model: source["model"] }
    : null;
}

export async function automationReadiness(
  ctx: MutationCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string | null,
  model: ModelSelection | null,
  targetKind: "project" | "thread",
) {
  if (environmentId === null) {
    return {
      state: "blocked" as const,
      code:
        targetKind === "project"
          ? ("project-binding-missing" as const)
          : ("thread-environment-offline" as const),
      diagnostic:
        targetKind === "project"
          ? "The selected project has no preferred active environment binding."
          : "The issue has no linked start-work thread.",
    };
  }
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  if (
    registration === null ||
    registration.state !== "active" ||
    registration.lastSeenAt === null ||
    Date.now() - registration.lastSeenAt > ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS
  ) {
    return {
      state: "blocked" as const,
      code:
        targetKind === "project"
          ? ("environment-offline" as const)
          : ("thread-environment-offline" as const),
      diagnostic: "The target environment is offline.",
    };
  }
  if (model === null) {
    return {
      state: "blocked" as const,
      code: "provider-instance-missing" as const,
      diagnostic: "The audit has no provider selection.",
    };
  }
  const capabilities = await ctx.db
    .query("environmentProviderCapabilities")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  if (
    capabilities === null ||
    !capabilities.supportsAutomationJobs ||
    Date.now() - capabilities.publishedAt > ENVIRONMENT_REGISTRATION_OFFLINE_AFTER_MS
  ) {
    return {
      state: "blocked" as const,
      code: "environment-offline" as const,
      diagnostic: "The target environment has not published fresh automation capabilities.",
    };
  }
  const provider = capabilities?.providers.find((item) => item.instanceId === model.instanceId);
  if (provider === undefined) {
    return {
      state: "blocked" as const,
      code: "provider-instance-missing" as const,
      diagnostic: `Provider instance ${model.instanceId} is not installed on the target environment.`,
    };
  }
  if (!provider.enabled || !provider.available) {
    return {
      state: "blocked" as const,
      code: "provider-disabled" as const,
      diagnostic: `Provider instance ${model.instanceId} is disabled or unavailable.`,
    };
  }
  if (!provider.modelIds.includes(model.model)) {
    return {
      state: "blocked" as const,
      code: "model-unavailable" as const,
      diagnostic: `Model ${model.model} is unavailable on ${model.instanceId}.`,
    };
  }
  return { state: "pending" as const, code: null, diagnostic: null };
}

export async function scheduleReviewAuditsForTransition(
  ctx: MutationCtx,
  company: Doc<"companies">,
  issue: Doc<"issues">,
  previousStatusId: string,
  triggerIdentity: string,
  now: number,
): Promise<void> {
  if (previousStatusId === issue.statusId) return;
  const automation = await ctx.db
    .query("issueAutomationSettings")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .unique();
  if (automation === null || !automation.enabled) return;
  const settings = object(automation.settings);
  if (settings === null) return;
  const transitions = object(settings["statusTransitions"]);
  const configuredReview = transitions?.["workFinishedStatusId"];
  if (typeof configuredReview === "string") {
    if (configuredReview !== issue.statusId) return;
  } else {
    const status = await ctx.db
      .query("issueStatuses")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", company._id).eq("id", issue.statusId),
      )
      .unique();
    if (status?.category !== "review") return;
  }

  const links = await ctx.db
    .query("issueThreadLinks")
    .withIndex("by_company_and_issue", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id),
    )
    .collect();
  const link = links
    .filter((item) => item.deletedAt === null && item.origin === "start-work")
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  const rules = Array.isArray(settings["auditRules"])
    ? (settings["auditRules"] as readonly unknown[])
    : [];
  for (const [ruleIndex, rawRule] of rules.entries()) {
    const rule = object(rawRule);
    if (rule === null || !Array.isArray(rule["auditors"])) continue;
    const ruleId = typeof rule["id"] === "string" ? rule["id"] : `rule-${ruleIndex}`;
    for (const [auditorIndex, rawAuditor] of rule["auditors"].entries()) {
      const auditor = object(rawAuditor);
      const model = selection(auditor?.["modelSelection"]);
      const triggerKey = `${triggerIdentity}:audit:${ruleId}:${auditorIndex}`;
      const existing = await ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_trigger", (q) =>
          q.eq("companyId", company._id).eq("triggerKey", triggerKey),
        )
        .unique();
      if (existing !== null) continue;
      const ready = await automationReadiness(
        ctx,
        company._id,
        link?.environmentId ?? null,
        model,
        "thread",
      );
      await ctx.db.insert("issueAutomationJobs", {
        id: mintDomainId(now),
        companyId: company._id,
        issueId: issue.id,
        kind: "audit-execution",
        triggerKey,
        settingsRevision: automation.revision,
        modelSelection: auditor?.["modelSelection"] ?? null,
        ruleId,
        ruleSnapshot: JSON.stringify(rawRule).slice(0, 16_000),
        targetKind: "thread",
        cloudProjectId: null,
        threadId: link?.threadId ?? null,
        targetEnvironmentId: link?.environmentId ?? null,
        requiredProviderInstanceId: model?.instanceId ?? null,
        requiredModel: model?.model ?? null,
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
    }
  }
}
