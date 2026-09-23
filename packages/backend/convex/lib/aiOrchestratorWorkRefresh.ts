/**
 * Delegated work refreshes when one of its inputs changes: the dispatch command, the worker thread,
 * the worker's presence, or the assignment itself. The refresh runs in its own transaction so the
 * triggering write never contends with orchestrator-wide reads. A bounded cron repairs misses.
 */
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { CloudAgentThreadShell } from "@spiritdevs/contracts/cloudProject";
import { internal } from "../_generated/api.js";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { canonicalJson } from "../../src/canonicalJson.ts";

const trackedStatuses = ["queued", "working", "unknown"] as const;
const decodeShell = Schema.decodeUnknownOption(CloudAgentThreadShell);

/** Redundant refreshes are harmless; concurrent ones serialize on the rows they both read. */
export async function scheduleOrchestratorWorkRefresh(
  ctx: MutationCtx,
  orchestratorIds: Iterable<string>,
) {
  for (const orchestratorId of new Set(orchestratorIds))
    await ctx.scheduler.runAfter(0, internal.aiOrchestratorJobs.refreshWork, { orchestratorId });
}

/** Presence crossed the offline boundary, so its tracked work may change status. */
export async function scheduleEnvironmentWorkRefresh(
  ctx: MutationCtx,
  registration: Doc<"environmentRegistrations">,
) {
  const company = await ctx.db.get(registration.companyId);
  if (!company) return;
  const work = await Promise.all(
    trackedStatuses.map((status) =>
      ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_company_environment_status", (q) =>
          q
            .eq("companyId", company.id)
            .eq("environmentId", registration.environmentId)
            .eq("status", status),
        )
        .take(100),
    ),
  );
  await scheduleOrchestratorWorkRefresh(
    ctx,
    work.flat().map((row) => row.orchestratorId),
  );
}

/** The shell fields `refreshOrchestratorWork` reads. Other publishes cannot change tracked work. */
function refreshInputs(shell: unknown) {
  const decoded = decodeShell(shell);
  if (Option.isNone(decoded)) return null;
  const { status, activeRunId, latestRunId, allowanceHold, modelSelection } = decoded.value;
  return canonicalJson([status, activeRunId, latestRunId, allowanceHold ?? null, modelSelection]);
}

export async function scheduleThreadWorkRefresh(
  ctx: MutationCtx,
  companyId: string,
  row: Doc<"agentThreads">,
  previousShell: unknown,
) {
  if (previousShell !== undefined && refreshInputs(previousShell) === refreshInputs(row.shell))
    return;
  const tracked = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_thread", (q) =>
      q
        .eq("companyId", companyId)
        .eq("environmentId", row.environmentId)
        .eq("threadId", row.threadId),
    )
    .take(100);
  await scheduleOrchestratorWorkRefresh(
    ctx,
    tracked
      .filter((work) => trackedStatuses.some((status) => status === work.status))
      .map((work) => work.orchestratorId),
  );
}
