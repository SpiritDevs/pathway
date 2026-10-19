import * as Schema from "effect/Schema";
import { CloudAgentThreadShell } from "@spiritdevs/contracts";
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import {
  eligibleOrchestratorEnvironment,
  orchestratorOwnerScope,
} from "./aiOrchestratorAuthority.ts";
import {
  audienceProjectPermissions,
  sharedHistoryBoundary,
  workVisibilityForConversation,
} from "./aiOrchestratorContext.ts";
import { hasRecordPermission } from "../../src/permissions.ts";
import { backendError } from "./errors.ts";

const decodeShell = Schema.decodeUnknownSync(CloudAgentThreadShell);
const denied = (): never => {
  throw backendError(
    "orchestrator-access",
    "This thread or project is unavailable to the orchestrator and this conversation's participants.",
  );
};

/** Rechecked at dispatch and delivery; project reads never expand a conversation's audience. */
export async function orchestratorReadTarget(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  target: {
    companyId: string;
    environmentId: string;
    projectId?: string | null;
    threadId?: string;
  },
) {
  const scope = await orchestratorOwnerScope(ctx, orchestrator, target.companyId);
  if (!scope || chat.archived || orchestrator.status === "deleted") return denied();
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", scope.company._id).eq("environmentId", target.environmentId),
    )
    .unique();
  if (!registration || !(await eligibleOrchestratorEnvironment(ctx, orchestrator, registration)))
    return denied();
  const thread = target.threadId
    ? await ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_environment_and_thread", (q) =>
          q
            .eq("companyId", scope.company._id)
            .eq("environmentId", target.environmentId)
            .eq("threadId", target.threadId!),
        )
        .unique()
    : null;
  if (target.threadId && !thread) return denied();
  const shell = thread ? decodeShell(thread.shell) : null;
  if (shell?.deletedAt || shell?.archivedAt) return denied();
  const project = thread
    ? thread.cloudProjectId
      ? await ctx.db.get(thread.cloudProjectId)
      : null
    : target.projectId
      ? await ctx.db
          .query("cloudProjects")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", scope.company._id).eq("id", target.projectId!),
          )
          .unique()
      : null;
  if (target.projectId && target.projectId !== project?.id) return denied();
  if (project) {
    const readers = await audienceProjectPermissions(ctx, chat, target.companyId);
    if (
      project.deletedAt !== null ||
      project.archivedAt !== null ||
      (orchestrator.projectId && orchestrator.projectId !== project.id) ||
      !hasRecordPermission(scope.permissions, "projects.read", project.teamIds) ||
      !readers?.every((reader) => hasRecordPermission(reader, "projects.read", project.teamIds))
    )
      return denied();
  } else if (thread) {
    const origin = shell?.orchestratorOrigin;
    const work = origin
      ? await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_command", (q) => q.eq("commandId", origin.commandId))
          .unique()
      : null;
    if (
      !work ||
      work.orchestratorId !== orchestrator.id ||
      work.chatId !== chat.id ||
      orchestrator.projectId ||
      !(await workVisibilityForConversation(ctx, chat)(work))
    )
      return denied();
    const boundary = await sharedHistoryBoundary(ctx, chat, chat);
    if (boundary === null || (work.sourceSequence ?? 0) < boundary) return denied();
  } else if (target.projectId) return denied();
  const bindings = project
    ? await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", scope.company._id).eq("cloudProjectId", project._id),
        )
        .collect()
    : [];
  const eligible = bindings.filter(
    (binding) => binding.status === "active" && binding.environmentId === target.environmentId,
  );
  if (
    project &&
    (thread
      ? !eligible.some((binding) => binding.localProjectId === thread.localProjectId)
      : eligible.length !== 1)
  )
    return denied();
  return {
    scope,
    registration,
    project,
    thread,
    shell,
    localProjectId: thread?.localProjectId ?? eligible[0]?.localProjectId ?? null,
  };
}
