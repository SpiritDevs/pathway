import { readEnvironmentPresence } from "./environmentRuntime.ts";
import { queueOrchestratorSignal } from "./aiOrchestratorRouting.ts";
// @effect-diagnostics globalDate:off -- Presence transitions use the cloud transaction clock.
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import {
  orchestratorOwnerScope,
  eligibleOrchestratorEnvironment,
} from "./aiOrchestratorAuthority.ts";

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
  const presence = await readEnvironmentPresence(ctx, registration);
  return {
    environmentId,
    online: (presence.lastSeenAt ?? 0) > Date.now() - 90000,
    lastSeenAt: presence.lastSeenAt,
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
  const candidates = [];
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
    candidates.push({ contact, chat });
  }
  const presence = await readEnvironmentPresence(ctx, registration);
  await queueOrchestratorSignal(ctx, candidates, {
    key: `environment:${company.id}:${registration.environmentId}:${presence.orchestratorPresence}:${presence.lastSeenAt}`,
    companyId: company.id,
    environmentSignalId: registration.environmentId,
    topic: `Environment ${registration.environmentId} is ${presence.orchestratorPresence}.`,
    text: "Environment availability changed. You are the selected responder. Review affected assignments; accepted work may still be running offline. Never duplicate accepted work. Report only what needs attention and has not already been reported.",
  });
}
