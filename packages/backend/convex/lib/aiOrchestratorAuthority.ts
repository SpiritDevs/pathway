import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { membershipAuthorization } from "./identity.ts";
import { hasCompanyPermission, hasRecordPermission } from "../../src/permissions.ts";

/** Action grants belong to the orchestrator; the directing human does not lend its own grants. */
export async function orchestratorOwnerScope(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  companyId: string,
) {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyId))
    .unique();
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", orchestrator.ownerSubject))
    .unique();
  if (!company || company.lifecycleState !== "active" || !user) return null;
  if (orchestrator.companyId && orchestrator.companyId !== company.id) return null;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", company._id).eq("userId", user._id))
    .unique();
  if (membership?.state !== "active") return null;
  const ownership = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", company._id).eq("membershipId", membership._id),
    )
    .unique();
  const { permissions } = await membershipAuthorization(ctx, membership, ownership !== null);
  return { company, membership, user, permissions };
}

export async function eligibleOrchestratorEnvironment(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  registration: Doc<"environmentRegistrations">,
) {
  if (registration.state !== "active") return false;
  if (
    !orchestrator.allEnvironments &&
    !orchestrator.environmentIds.includes(registration.environmentId)
  )
    return false;
  const company = await ctx.db.get(registration.companyId);
  if (!company) return false;
  const scope = await orchestratorOwnerScope(ctx, orchestrator, company.id);
  if (!scope) return false;
  // Private conversation and memory may only run on environments the owner explicitly selected,
  // or environments registered by that owner. A company service cannot claim every private PA.
  if (
    !orchestrator.shared &&
    registration.registeredByMembershipId !== scope.membership._id &&
    !orchestrator.environmentIds.includes(registration.environmentId) &&
    !orchestrator.models.some((model) => model.environmentId === registration.environmentId)
  )
    return false;
  if (orchestrator.projectId) {
    const project = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", company._id).eq("id", orchestrator.projectId!),
      )
      .unique();
    if (
      !project ||
      project.archivedAt !== null ||
      project.deletedAt !== null ||
      !hasRecordPermission(scope.permissions, "projects.read", project.teamIds)
    )
      return false;
    if (
      registration.teamIds.length &&
      !project.teamIds.some((id) => registration.teamIds.includes(id))
    )
      return false;
  }
  return true;
}

export async function orchestratorCommandAllowed(
  ctx: QueryCtx,
  command: Doc<"environmentCommands">,
) {
  if (!command.orchestratorId) return true;
  const orchestrator = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", command.orchestratorId!))
    .unique();
  const company = await ctx.db.get(command.companyId);
  if (!orchestrator || !company || orchestrator.status === "deleted") return false;
  // A finished root can still have detached children. Resuming the contact never renews stopped assignments.
  if (command.kind === "startThread" && command.createdAt <= (orchestrator.workStoppedBefore ?? -1))
    return false;
  const capability =
    command.kind === "startThread"
      ? "threads.delegate"
      : command.kind === "statusQuery"
        ? "threads.read"
        : "threads.control";
  if (!orchestrator.capabilities.includes(capability)) return false;
  const scope = await orchestratorOwnerScope(ctx, orchestrator, company.id);
  if (
    !scope ||
    !hasCompanyPermission(scope.permissions, "remoteAgents.dispatch") ||
    !hasCompanyPermission(scope.permissions, "remoteAgents.control")
  )
    return false;
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", company._id).eq("environmentId", command.targetEnvironmentId),
    )
    .unique();
  if (!registration || !(await eligibleOrchestratorEnvironment(ctx, orchestrator, registration)))
    return false;
  if (!command.cloudProjectId && orchestrator.projectId) return false;
  if (command.cloudProjectId) {
    const project = await ctx.db.get(command.cloudProjectId);
    if (
      !project ||
      project.deletedAt !== null ||
      project.archivedAt !== null ||
      (orchestrator.projectId && project.id !== orchestrator.projectId) ||
      !hasRecordPermission(scope.permissions, "projects.read", project.teamIds)
    )
      return false;
  }
  return true;
}

export async function orchestratorCommandPaused(
  ctx: QueryCtx,
  command: Doc<"environmentCommands">,
) {
  if (!command.orchestratorId || command.kind !== "startThread" || command.state !== "pending")
    return false;
  const orchestrator = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", command.orchestratorId!))
    .unique();
  return orchestrator?.status === "paused" || orchestrator?.status === "archived";
}

/** Results remain tied to the assigned project after settings or workspace permissions change. */
export async function orchestratorCanReadWork(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  work: Doc<"aiOrchestratorWork">,
  registration: Doc<"environmentRegistrations">,
) {
  if (
    orchestrator.status === "deleted" ||
    !orchestrator.capabilities.includes("threads.read") ||
    !(await eligibleOrchestratorEnvironment(ctx, orchestrator, registration)) ||
    !work.companyId
  )
    return false;
  const scope = await orchestratorOwnerScope(ctx, orchestrator, work.companyId);
  if (!scope) return false;
  if (work.projectId === null)
    return orchestrator.projectId === null && work.orchestratorId === orchestrator.id;
  const project = await ctx.db
    .query("cloudProjects")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", scope.company._id).eq("id", work.projectId!),
    )
    .unique();
  return (
    project !== null &&
    project.deletedAt === null &&
    project.archivedAt === null &&
    (!orchestrator.projectId || orchestrator.projectId === project.id) &&
    hasRecordPermission(scope.permissions, "projects.read", project.teamIds)
  );
}
