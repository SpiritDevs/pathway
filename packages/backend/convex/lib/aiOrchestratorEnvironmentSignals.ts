// @effect-diagnostics globalDate:off -- Presence transitions use the cloud transaction clock.
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import {
  orchestratorOwnerScope,
  eligibleOrchestratorEnvironment,
} from "./aiOrchestratorAuthority.ts";
import { appendChatMessage } from "../aiOrchestrators.ts";
import { mintDomainId } from "./domainIds.ts";

export async function readableOrchestratorEnvironment(
  ctx: QueryCtx,
  contact: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  companyId: string,
  environmentId: string,
) {
  if (
    !contact.proactive ||
    !contact.capabilities.includes("environments.read") ||
    chat.archived ||
    chat.kind !== "dm" ||
    chat.leadId !== contact.id ||
    chat.ownerSubject !== contact.ownerSubject ||
    chat.orchestratorIds.length !== 1 ||
    chat.participantSubjects.length !== 1 ||
    chat.participantSubjects[0] !== contact.ownerSubject
  )
    return null;
  const scope = await orchestratorOwnerScope(ctx, contact, companyId);
  if (!scope) return null;
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", scope.company._id).eq("environmentId", environmentId),
    )
    .unique();
  if (!registration || !(await eligibleOrchestratorEnvironment(ctx, contact, registration)))
    return null;
  return {
    environmentId,
    online: (registration.lastSeenAt ?? 0) > Date.now() - 90000,
    lastSeenAt: registration.lastSeenAt,
    source: "environment-presence",
  };
}
export async function notifyOrchestratorEnvironmentChange(
  ctx: MutationCtx,
  registration: Doc<"environmentRegistrations">,
) {
  const company = await ctx.db.get(registration.companyId);
  if (!company || company.lifecycleState !== "active") return;
  const work = (
    await Promise.all(
      (["queued", "working", "unknown"] as const).map((status) =>
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
    )
  ).flat();
  const ids = new Set(work.map((w) => w.orchestratorId));
  const member = registration.registeredByMembershipId
    ? await ctx.db.get(registration.registeredByMembershipId)
    : null;
  const owner = member ? await ctx.db.get(member.userId) : null;
  const chief = owner
    ? await ctx.db
        .query("aiOrchestrators")
        .withIndex("by_owner_kind", (q) =>
          q.eq("ownerSubject", owner.clerkSubject).eq("kind", "personal"),
        )
        .first()
    : null;
  if (chief) ids.add(chief.id);
  for (const id of ids) {
    const contact = await ctx.db
      .query("aiOrchestrators")
      .withIndex("by_domain_id", (q) => q.eq("id", id))
      .unique();
    if (!contact || contact.status !== "active") continue;
    const chat = await ctx.db
      .query("aiOrchestratorChats")
      .withIndex("by_direct_contact", (q) =>
        q
          .eq("leadId", contact.id)
          .eq("ownerSubject", contact.ownerSubject)
          .eq("kind", "dm")
          .eq("archived", false),
      )
      .first();
    if (
      !chat ||
      !(await readableOrchestratorEnvironment(
        ctx,
        contact,
        chat,
        company.id,
        registration.environmentId,
      ))
    )
      continue;
    const queued = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_orchestrator_status", (q) =>
        q.eq("orchestratorId", contact.id).eq("status", "queued"),
      )
      .take(100);
    if (
      queued.some(
        (job) => job.environmentSignalId === registration.environmentId && job.chatId === chat.id,
      )
    )
      continue;
    const now = Date.now(),
      messageId = mintDomainId(now);
    await appendChatMessage(ctx, chat, {
      id: messageId,
      senderKind: "system",
      senderId: "environment-presence",
      senderName: "Pathway",
      text: "Environment availability changed. Review its current state and affected assignments. Redirect only provably unaccepted work. Accepted work may still be running offline; do not duplicate it. Report what needs the user's attention.",
      status: "queued",
      replyToId: null,
    });
    await ctx.db.insert("aiOrchestratorJobs", {
      id: mintDomainId(now),
      orchestratorId: contact.id,
      chatId: chat.id,
      messageId,
      environmentSignalId: registration.environmentId,
      companyId: company.id,
      status: "queued",
      environmentId: null,
      generation: 0,
      leaseExpiresAt: 0,
      modelIndex: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    });
  }
}
