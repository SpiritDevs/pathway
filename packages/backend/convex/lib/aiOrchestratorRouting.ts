// @effect-diagnostics globalDate:off -- Convex supplies transaction time.
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { appendChatMessage } from "../aiOrchestrators.ts";
import { mintDomainId } from "./domainIds.ts";
import { readableOrchestratorThread } from "./aiOrchestratorSignals.ts";
import { readableOrchestratorIssue } from "./aiOrchestratorIssueSignals.ts";
import { readableOrchestratorEnvironment } from "./aiOrchestratorEnvironmentSignals.ts";

type Candidate = { contact: Doc<"aiOrchestrators">; chat: Doc<"aiOrchestratorChats"> };
type Signal = {
  key: string;
  companyId: string;
  topic: string;
  text: string;
  threadSignalId?: string;
  issueSignalId?: string;
  environmentSignalId?: string;
};

/** One event owner per human audience. Clear project/Chief ownership costs no model call. */
export async function queueOrchestratorSignal(
  ctx: MutationCtx,
  candidates: Candidate[],
  signal: Signal,
) {
  const audiences = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const owner = candidate.contact.ownerSubject;
    audiences.set(owner, [...(audiences.get(owner) ?? []), candidate]);
  }
  for (const [owner, contacts] of audiences) {
    const specialists = signal.environmentSignalId
      ? contacts.filter((c) => c.contact.kind === "personal")
      : contacts.filter((c) => c.contact.projectId !== null);
    const eligible = (specialists.length ? specialists : contacts)
      .sort(
        (a, b) =>
          a.contact.createdAt - b.contact.createdAt || a.contact.id.localeCompare(b.contact.id),
      )
      .slice(0, 10);
    const first = eligible[0];
    if (!first) continue;
    const messageId = `orchestrator-signal:${owner}:${signal.key}`;
    if (
      await ctx.db
        .query("aiOrchestratorSignalDeliveries")
        .withIndex("by_domain_id", (q) => q.eq("id", messageId))
        .unique()
    )
      continue;
    await ctx.db.insert("aiOrchestratorSignalDeliveries", { id: messageId, createdAt: Date.now() });
    const queued = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_orchestrator_chat_status", (q) =>
        q.eq("orchestratorId", first.contact.id).eq("chatId", first.chat.id).eq("status", "queued"),
      )
      .take(100);
    const waiting = queued.find((job) =>
      signal.threadSignalId
        ? !!job.threadSignalId
        : signal.issueSignalId
          ? !!job.issueSignalId
          : job.environmentSignalId === signal.environmentSignalId,
    );
    const routing =
      eligible.length > 1
        ? {
            routingCandidateIds: eligible.map((c) => c.contact.id),
            routingTopic: signal.topic.slice(0, 2000),
          }
        : {};
    if (waiting) {
      await ctx.db.patch(waiting._id, {
        threadSignalId: signal.threadSignalId,
        issueSignalId: signal.issueSignalId,
        environmentSignalId: signal.environmentSignalId,
        routingCandidateIds: routing.routingCandidateIds,
        routingTopic: routing.routingTopic,
      });
      continue;
    }
    await appendChatMessage(ctx, first.chat, {
      id: messageId,
      senderKind: "system",
      senderId: "activity",
      senderName: "Pathway",
      text: signal.text,
      status: "queued",
      replyToId: null,
    });
    const now = Date.now();
    await ctx.db.insert("aiOrchestratorJobs", {
      id: mintDomainId(now),
      orchestratorId: first.contact.id,
      chatId: first.chat.id,
      messageId,
      companyId: signal.companyId,
      ...(signal.threadSignalId ? { threadSignalId: signal.threadSignalId } : {}),
      ...(signal.issueSignalId ? { issueSignalId: signal.issueSignalId } : {}),
      ...(signal.environmentSignalId ? { environmentSignalId: signal.environmentSignalId } : {}),
      ...routing,
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

export async function signalCandidate(ctx: QueryCtx, job: Doc<"aiOrchestratorJobs">, id: string) {
  const contact = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
  if (!contact || contact.status !== "active") return null;
  const chat = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_direct_contact", (q) =>
      q
        .eq("leadId", id)
        .eq("ownerSubject", contact.ownerSubject)
        .eq("kind", "dm")
        .eq("archived", false),
    )
    .first();
  if (!chat) return null;
  const readable = job.threadSignalId
    ? await readableOrchestratorThread(ctx, contact, chat, job.companyId, job.threadSignalId)
    : job.issueSignalId
      ? await readableOrchestratorIssue(ctx, contact, chat, job.companyId, job.issueSignalId)
      : job.environmentSignalId
        ? await readableOrchestratorEnvironment(
            ctx,
            contact,
            chat,
            job.companyId,
            job.environmentSignalId,
          )
        : null;
  return readable ? { contact, chat } : null;
}

/** Commit the election under the existing job lease; only the winner gets a reasoning job. */
export async function finishSignalRouting(
  ctx: MutationCtx,
  job: Doc<"aiOrchestratorJobs">,
  message: Doc<"aiOrchestratorMessages">,
  selected: string | undefined,
) {
  const ids = job.routingCandidateIds ?? [];
  const ordered =
    selected && ids.includes(selected) ? [selected, ...ids.filter((id) => id !== selected)] : ids;
  const source = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", job.chatId))
    .unique();
  let winner: Candidate | null = null;
  for (const id of ordered) {
    const candidate = await signalCandidate(ctx, job, id);
    if (candidate?.contact.ownerSubject === source?.ownerSubject) {
      winner = candidate;
      break;
    }
  }
  if (!winner) {
    await ctx.db.patch(job._id, { status: "cancelled", leaseExpiresAt: 0 });
    await ctx.db.patch(message._id, { status: "cancelled" });
    return;
  }
  const now = Date.now();
  if (winner.contact.id === job.orchestratorId) {
    await ctx.db.patch(job._id, {
      routingCandidateIds: undefined,
      routingTopic: undefined,
      status: "queued",
      leaseExpiresAt: 0,
      attempts: 0,
      modelIndex: 0,
      updatedAt: now,
    });
    await ctx.db.patch(message._id, { status: "queued" });
    return;
  }
  await ctx.db.patch(job._id, { status: "completed", leaseExpiresAt: 0, updatedAt: now });
  await ctx.db.patch(message._id, { status: "sent" });
  const messageId = `${message.id}:routed`;
  await appendChatMessage(ctx, winner.chat, {
    id: messageId,
    senderKind: "system",
    senderId: "activity",
    senderName: "Pathway",
    text: message.text,
    status: "queued",
    replyToId: null,
  });
  await ctx.db.insert("aiOrchestratorJobs", {
    id: `${job.id}:routed`,
    orchestratorId: winner.contact.id,
    chatId: winner.chat.id,
    messageId,
    companyId: job.companyId,
    ...(job.threadSignalId ? { threadSignalId: job.threadSignalId } : {}),
    ...(job.issueSignalId ? { issueSignalId: job.issueSignalId } : {}),
    ...(job.environmentSignalId ? { environmentSignalId: job.environmentSignalId } : {}),
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
