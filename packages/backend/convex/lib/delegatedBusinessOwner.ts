import { v } from "convex/values";
import type { QueryCtx } from "../_generated/server.js";
import type { OrchestratorAssignmentOrigin } from "@spiritdevs/contracts/aiOrchestrator";
import { requireCompanyActor } from "./identity.ts";
import { orchestratorCommandAllowed, orchestratorOwnerScope } from "./aiOrchestratorAuthority.ts";
import { backendError } from "./errors.ts";

export const delegatedBusinessOrigin = v.optional(
  v.object({ companyId: v.string(), orchestratorId: v.string(), commandId: v.string() }),
);
type BusinessCapability = "mail.read" | "mail.send" | "time.read" | "time.manage";

/** Rechecked by the authenticated mail relay before queued delivery, as well as at tool invocation. */
export async function activeDelegatedBusinessOwner(
  ctx: QueryCtx,
  origin: OrchestratorAssignmentOrigin,
  capability: BusinessCapability,
) {
  const work = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_command", (q) => q.eq("commandId", origin.commandId))
    .unique();
  if (
    !work ||
    work.companyId !== origin.companyId ||
    work.orchestratorId !== origin.orchestratorId ||
    work.projectId !== null ||
    work.stopRequested
  )
    return null;
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", origin.companyId))
    .unique();
  if (!company) return null;
  const command = await ctx.db
    .query("environmentCommands")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", company._id).eq("id", origin.commandId),
    )
    .unique();
  if (
    !command ||
    command.kind !== "startThread" ||
    command.orchestratorId !== origin.orchestratorId ||
    command.targetEnvironmentId !== work.environmentId ||
    !["claimed", "succeeded"].includes(command.state) ||
    !(await orchestratorCommandAllowed(ctx, command))
  )
    return null;
  const contact = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", origin.orchestratorId))
    .unique();
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
    .unique();
  if (
    !contact ||
    contact.projectId !== null ||
    !contact.capabilities.includes(capability) ||
    !chat ||
    chat.archived ||
    chat.ownerSubject !== contact.ownerSubject ||
    !chat.orchestratorIds.includes(contact.id) ||
    chat.participantSubjects.length !== 1 ||
    chat.participantSubjects[0] !== contact.ownerSubject
  )
    return null;
  return orchestratorOwnerScope(ctx, contact, origin.companyId);
}

/** Personal mailbox and timer actions retain the PA owner's private conversation audience. */
export async function delegatedBusinessOwner(
  ctx: QueryCtx,
  origin: OrchestratorAssignmentOrigin,
  capability: BusinessCapability,
) {
  const actor = await requireCompanyActor(ctx, origin.companyId);
  const denied = () =>
    backendError(
      "delegated-business-denied",
      "This PA assignment cannot use the owner's personal business tools. Check its permissions and conversation audience.",
    );
  if (actor.kind !== "environment") throw denied();
  const work = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_command", (q) => q.eq("commandId", origin.commandId))
    .unique();
  if (work?.environmentId !== actor.registration.environmentId) throw denied();
  const scope = await activeDelegatedBusinessOwner(ctx, origin, capability);
  if (!scope) throw denied();
  return scope;
}
