// @effect-diagnostics globalDate:off -- Convex supplies transaction time.
import * as Schema from "effect/Schema";
import { OrchestratorInspection } from "@spiritdevs/contracts/orchestratorInspection";
import type { OrchestratorAction } from "@spiritdevs/contracts/aiOrchestrator";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { orchestratorReadTarget } from "./aiOrchestratorTargets.ts";
import { backendError } from "./errors.ts";
import { mintDomainId } from "./domainIds.ts";

const decodeRequest = Schema.decodeUnknownSync(OrchestratorInspection);
export const INSPECTION_TIMEOUT_MS = 180000;
const fail = (message: string): never => {
  throw backendError("orchestrator-inspection", message);
};

export async function inspectionTarget(
  ctx: QueryCtx,
  job: Doc<"aiOrchestratorJobs">,
  inspection: Pick<
    Doc<"aiOrchestratorInspections">,
    "companyId" | "environmentId" | "projectId" | "request"
  >,
) {
  const orchestrator = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", job.orchestratorId))
    .unique();
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", job.chatId))
    .unique();
  if (
    !orchestrator ||
    orchestrator.status !== "active" ||
    !chat ||
    job.status === "cancelled" ||
    job.configRevision !== orchestrator.revision ||
    (job.chatRevision ?? 0) !== (chat.revision ?? 0)
  )
    return fail("The inspection's conversation or permissions changed.");
  const request = decodeRequest(inspection.request);
  if (
    request.kind === "readThread" &&
    request.startCharacter !== undefined &&
    (!request.messageId ||
      !Number.isSafeInteger(request.startCharacter) ||
      request.startCharacter < 0)
  )
    return fail("Choose a message and a non-negative character offset.");
  const capability =
    request.kind === "readThread"
      ? "threads.read"
      : request.kind === "webSearch"
        ? null
        : "projects.read";
  if (capability && !orchestrator.capabilities.includes(capability))
    return fail("This inspection is not enabled for the orchestrator.");
  if ((request.kind === "readFile" || request.kind === "listFiles") && !inspection.projectId)
    return fail("Choose a project before reading files.");
  if (request.kind === "webSearch" && (!request.query.trim() || request.query.length > 2000))
    return fail("Use a short, specific public web search query.");
  if (
    request.kind === "readFile" &&
    request.startLine !== undefined &&
    (!Number.isSafeInteger(request.startLine) || request.startLine < 1)
  )
    return fail("The first line must be a positive integer.");
  const target = await orchestratorReadTarget(ctx, orchestrator, chat, {
    ...inspection,
    ...(request.kind === "readThread" ? { threadId: request.threadId } : {}),
  });
  return { ...target, request, chat };
}

export async function queueInspection(
  ctx: MutationCtx,
  job: Doc<"aiOrchestratorJobs">,
  action: Extract<OrchestratorAction, { kind: "inspect" }>,
) {
  await inspectionTarget(ctx, job, action);
  const id = mintDomainId(Date.now());
  await ctx.db.insert("aiOrchestratorInspections", {
    id,
    jobId: job.id,
    companyId: action.companyId,
    environmentId: action.environmentId,
    projectId: action.projectId,
    request: action.request,
    status: "pending",
    createdAt: Date.now(),
  });
  return id;
}

/** The original request resumes after its reads; no extra worker or user-facing completion message. */
export async function inspectionContext(ctx: MutationCtx, job: Doc<"aiOrchestratorJobs">) {
  const results = [];
  let remaining = 48000;
  for (const id of [...(job.inspectionIds ?? [])].toReversed()) {
    const inspection = await ctx.db
      .query("aiOrchestratorInspections")
      .withIndex("by_domain_id", (q) => q.eq("id", id))
      .unique();
    if (!inspection || inspection.jobId !== job.id) continue;
    let text =
      inspection.text ??
      "The environment did not return this inspection in time. Try an available environment or report that the result is unavailable.";
    if (
      inspection.status === "pending" &&
      inspection.createdAt + INSPECTION_TIMEOUT_MS > Date.now()
    )
      return null;
    try {
      await inspectionTarget(ctx, job, inspection);
    } catch {
      text = "Inspection unavailable: the conversation or access permissions changed.";
    }
    const excerpt = text.slice(0, Math.max(remaining, 0));
    remaining -= excerpt.length;
    results.push({
      kind: "inspect",
      detail: {
        request: inspection.request,
        environmentId: inspection.environmentId,
        projectId: inspection.projectId,
        text: excerpt,
        truncated: excerpt.length < text.length,
      },
    });
  }
  return results.toReversed();
}
