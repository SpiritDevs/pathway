// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Environment-published, cloud-safe Agent Thread discovery metadata. */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, type MutationCtx } from "./_generated/server.js";
import { appendCompanyChanges, encodeAgentThread } from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_RECONCILE_REMOVALS = 100;
/** Must cover every field of the contracts `CloudAgentThreadShell`; upserts with unknown fields are rejected. */
export const AGENT_THREAD_SHELL_FIELDS = new Set([
  "createdBy",
  "creationSource",
  "id",
  "projectId",
  "title",
  "providerInstanceId",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "branch",
  "worktreePath",
  "workspaceMove",
  "lineage",
  "forkKind",
  "locations",
  "forkedFrom",
  "activeProviderThreadId",
  "latestRunId",
  "latestRunRequestedAt",
  "latestRunStartedAt",
  "latestRunCompletedAt",
  "activeRunId",
  "activityRunStatus",
  "status",
  "lastError",
  "pendingRuntimeRequest",
  "latestVisibleMessage",
  "latestUserMessageAt",
  "attachedPullRequest",
  "hasActionableProposedPlan",
  "pendingBackgroundTasks",
  "itemCount",
  "visibleItemCount",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "settledOverride",
  "settledAt",
  "settleAfterCompletion",
  "snoozedUntil",
  "snoozedAt",
  "pinnedAt",
  "pinOrderKey",
  "lastVisitedAt",
  "titleRegeneration",
  "deletedAt",
]);
const LATEST_VISIBLE_MESSAGE_FIELDS = new Set(["id", "role", "updatedAt"]);

function agentThreadId(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    throw backendError("invalid-arguments", `${label} must be a non-empty, trimmed string.`);
  }
  return trimmed;
}

function requireEnvironmentActor(
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
  environmentId: string,
) {
  requirePermission(actor, "projects.manage");
  if (actor.kind !== "environment" || actor.registration.environmentId !== environmentId) {
    throw backendError(
      "permission-denied",
      "An environment may publish Agent Threads only for itself.",
    );
  }
}

async function activeBinding(
  ctx: MutationCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string,
  localProjectId: string,
) {
  return (
    await ctx.db
      .query("environmentBindings")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", companyId).eq("environmentId", environmentId),
      )
      .collect()
  ).find((binding) => binding.localProjectId === localProjectId && binding.status === "active");
}

/** Upserts one shell after proving that its local project has an active company binding. */
export const upsert = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    threadId: v.string(),
    localProjectId: v.string(),
    shell: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentId = requireTrimmed(args.environmentId, "Environment id");
    const threadId = requireTrimmed(args.threadId, "Thread id");
    const localProjectId = requireTrimmed(args.localProjectId, "Local project id");
    requireEnvironmentActor(actor, environmentId);

    if (typeof args.shell !== "object" || args.shell === null || Array.isArray(args.shell)) {
      throw backendError("invalid-arguments", "Agent Thread shell must be an object.");
    }
    const shell = args.shell as Record<string, unknown>;
    if (Object.keys(shell).some((key) => !AGENT_THREAD_SHELL_FIELDS.has(key))) {
      throw backendError("invalid-arguments", "Agent Thread metadata contains an unknown field.");
    }
    if (shell["id"] !== threadId || shell["projectId"] !== localProjectId) {
      throw backendError(
        "invalid-arguments",
        "Agent Thread shell identity must match its thread and local project.",
      );
    }
    const latestVisibleMessage = shell["latestVisibleMessage"];
    if (typeof latestVisibleMessage === "object" && latestVisibleMessage !== null) {
      if (
        Array.isArray(latestVisibleMessage) ||
        Object.keys(latestVisibleMessage).some((key) => !LATEST_VISIBLE_MESSAGE_FIELDS.has(key))
      ) {
        throw backendError(
          "invalid-arguments",
          "Agent Thread metadata may not contain message text.",
        );
      }
    }

    const id = agentThreadId(environmentId, threadId);
    const existing = await ctx.db
      .query("agentThreads")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", id),
      )
      .unique();
    const binding = await activeBinding(ctx, actor.company._id, environmentId, localProjectId);
    // Discovery of a NEW thread still requires an active binding. A thread
    // already in the index was published while its binding was active; its
    // shell must stay updatable after the binding is revoked (e.g. duplicate
    // project identities merged away), or one such thread wedges the
    // environment's reconcile loop forever.
    if (binding === undefined && existing === null) {
      throw backendError(
        "entity-not-found",
        "The Agent Thread project has no active binding on this environment.",
      );
    }
    const cloudProjectId = binding?.cloudProjectId ?? existing?.cloudProjectId;
    if (cloudProjectId === undefined) {
      throw backendError(
        "entity-not-found",
        "The Agent Thread project has no active binding on this environment.",
      );
    }
    if (
      existing !== null &&
      existing.cloudProjectId === cloudProjectId &&
      existing.localProjectId === localProjectId &&
      JSON.stringify(existing.shell) === JSON.stringify(args.shell)
    ) {
      return null;
    }
    const now = Date.now();
    let row: Doc<"agentThreads">;
    if (existing === null) {
      const rowId = await ctx.db.insert("agentThreads", {
        id,
        companyId: actor.company._id,
        environmentId,
        cloudProjectId,
        localProjectId,
        threadId,
        shell: args.shell,
        updatedAt: now,
      });
      const inserted = await ctx.db.get(rowId);
      if (inserted === null) throw backendError("entity-not-found", "The Agent Thread vanished.");
      row = inserted;
    } else {
      await ctx.db.patch(existing._id, {
        cloudProjectId,
        localProjectId,
        shell: args.shell,
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (updated === null) throw backendError("entity-not-found", "The Agent Thread vanished.");
      row = updated;
    }

    const project = await ctx.db.get(cloudProjectId);
    if (project === null) throw backendError("entity-not-found", "The cloud project is missing.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "agentThread",
          entityId: row.id,
          changeKind: "upsert",
          teamIds: project.teamIds,
          versionDocId: row._id,
          payload: await encodeAgentThread(ctx, row),
        },
      ],
    });
    return null;
  },
});

async function removeRows(
  ctx: MutationCtx,
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
  rows: readonly Doc<"agentThreads">[],
) {
  if (rows.length === 0) return;
  const changes = [];
  for (const row of rows) {
    const project = await ctx.db.get(row.cloudProjectId);
    await ctx.db.delete(row._id);
    changes.push({
      entityKind: "agentThread" as const,
      entityId: row.id,
      changeKind: "tombstone" as const,
      teamIds: project?.teamIds ?? [],
      versionDocId: null,
      payload: null,
    });
  }
  await appendCompanyChanges(ctx, {
    companyId: actor.company._id,
    actor: actorRecord(actor),
    changes,
  });
}

/** Removes one deleted local thread from the shared index. */
export const remove = mutation({
  args: { companyId: domainIdArg, environmentId: v.string(), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentId = requireTrimmed(args.environmentId, "Environment id");
    const threadId = requireTrimmed(args.threadId, "Thread id");
    requireEnvironmentActor(actor, environmentId);
    const row = await ctx.db
      .query("agentThreads")
      .withIndex("by_company_and_environment_and_thread", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("environmentId", environmentId)
          .eq("threadId", threadId),
      )
      .unique();
    await removeRows(ctx, actor, row === null ? [] : [row]);
    return null;
  },
});

/** Repairs missed delete events without replacing transcript content or issuing work. */
export const reconcile = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    currentThreadIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentId = requireTrimmed(args.environmentId, "Environment id");
    requireEnvironmentActor(actor, environmentId);
    const current = new Set(args.currentThreadIds.map((id) => requireTrimmed(id, "Thread id")));
    const stale = (
      await ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
        )
        .collect()
    )
      .filter((row) => !current.has(row.threadId))
      .slice(0, MAX_RECONCILE_REMOVALS);
    await removeRows(ctx, actor, stale);
    return null;
  },
});
