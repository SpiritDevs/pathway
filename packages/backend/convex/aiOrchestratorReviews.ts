// @effect-diagnostics globalDate:off -- Convex transaction time schedules responsibility reviews.
/** A bounded cloud clock wakes configured contacts through the same durable chat queue. */
import { internalMutation } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { appendChatMessage } from "./aiOrchestrators.ts";
import { mintDomainId } from "./lib/domainIds.ts";

export function nextResponsibilityReview(
  contact: {
    proactive: boolean;
    responsibilities: string;
    capabilities: readonly string[];
    reviewIntervalMinutes?: number;
    status?: string;
  },
  now: number,
) {
  return contact.capabilities.includes("schedules.manage") &&
    contact.proactive &&
    contact.responsibilities.trim() &&
    (contact.reviewIntervalMinutes ?? 0) > 0 &&
    (!contact.status || contact.status === "active")
    ? now + contact.reviewIntervalMinutes! * 60000
    : undefined;
}
export function canReviewResponsibilities(
  contact: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
) {
  return (
    nextResponsibilityReview(contact, 0) !== undefined &&
    !chat.archived &&
    chat.kind === "dm" &&
    chat.leadId === contact.id &&
    chat.ownerSubject === contact.ownerSubject &&
    chat.orchestratorIds.length === 1 &&
    chat.participantSubjects.length === 1 &&
    chat.participantSubjects[0] === contact.ownerSubject
  );
}
export const wakeDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const contacts = await ctx.db
      .query("aiOrchestrators")
      .withIndex("by_review_due", (q) => q.gt("nextReviewAt", 0).lte("nextReviewAt", now))
      .take(100);
    for (const contact of contacts) {
      await ctx.db.patch(contact._id, { nextReviewAt: nextResponsibilityReview(contact, now) });
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
      if (chat && !canReviewResponsibilities(contact, chat)) continue;
      if (!chat) continue;
      const pending = await Promise.all(
        (["queued", "running"] as const).map((status) =>
          ctx.db
            .query("aiOrchestratorJobs")
            .withIndex("by_orchestrator_status", (q) =>
              q.eq("orchestratorId", contact.id).eq("status", status),
            )
            .first(),
        ),
      );
      if (pending.some(Boolean)) continue;
      const id = `responsibility-review:${contact.id}:${contact.nextReviewAt}`;
      await appendChatMessage(ctx, chat, {
        id,
        senderKind: "system",
        senderId: "responsibility-review",
        senderName: "Pathway",
        text: "Scheduled responsibility review. Check the current work and environments, follow your standing instructions, and report only useful changes or blockers. Do not duplicate accepted work or treat this review as a new allowance allocation.",
        status: "queued",
        replyToId: null,
      });
      await ctx.db.insert("aiOrchestratorJobs", {
        id: mintDomainId(now),
        orchestratorId: contact.id,
        chatId: chat.id,
        messageId: id,
        companyId: contact.companyId ?? chat.companyIds[0] ?? "",
        responsibilityReview: true,
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
  },
});
