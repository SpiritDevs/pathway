// @effect-diagnostics globalDate:off -- Convex transaction clock.
/** Conversation-private worker controls; never included in company change feeds. */
import { canonicalQueueJson } from "../src/threadQueue.ts";
import { budgetsForScopes } from "./providerAllowanceBudgets.ts";
import * as Schema from "effect/Schema";
import { v } from "convex/values";
import { OrchestratorWorkerAction } from "@spiritdevs/contracts/aiOrchestrator";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireCompanyActor } from "./lib/identity.ts";
import {
  readableChat,
  findOrchestrator,
  canDirectOrchestrator,
  appendChatMessage,
} from "./aiOrchestrators.ts";
import { hasCompanyPermission } from "../src/permissions.ts";
import { orchestratorOwnerScope, orchestratorCanReadWork } from "./lib/aiOrchestratorAuthority.ts";
import {
  sharedHistoryBoundary,
  workVisibilityForConversation,
} from "./lib/aiOrchestratorContext.ts";
import { controlOrchestratorWork } from "./lib/aiOrchestratorWork.ts";

const fail = (message: string): never => {
  throw backendError("worker-control", message);
};
const decodeAction = Schema.decodeUnknownSync(OrchestratorWorkerAction);
const workById = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
const messagesFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorWorkerMessages")
    .withIndex("by_work", (q) => q.eq("workId", id))
    .take(100);
const questionsFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorWorkerQuestions")
    .withIndex("by_work", (q) => q.eq("workId", id))
    .take(100);
const messageById = (ctx: QueryCtx, workId: string, id: string) =>
  ctx.db
    .query("aiOrchestratorWorkerMessages")
    .withIndex("by_work_id", (q) => q.eq("workId", workId).eq("id", id))
    .unique();
const deliveryOrder = (
  a: Doc<"aiOrchestratorWorkerMessages">,
  b: Doc<"aiOrchestratorWorkerMessages">,
) => {
  const priority = (row: Doc<"aiOrchestratorWorkerMessages">) =>
    row.state === "accepted" ? 0 : row.mode === "answer" ? 1 : row.mode === "steer" ? 2 : 3;
  return priority(a) - priority(b) || a.position - b.position;
};
const questionById = (ctx: QueryCtx, workId: string, id: string) =>
  ctx.db
    .query("aiOrchestratorWorkerQuestions")
    .withIndex("by_work_id", (q) => q.eq("workId", workId).eq("id", id))
    .unique();

export async function visibleWorker(
  ctx: QueryCtx,
  work: Doc<"aiOrchestratorWork">,
  chat: Doc<"aiOrchestratorChats">,
) {
  const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
  const company = work.companyId
    ? await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", work.companyId!))
        .unique()
    : null;
  const registration = company
    ? await ctx.db
        .query("environmentRegistrations")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", company._id).eq("environmentId", work.environmentId),
        )
        .unique()
    : null;
  const boundary = await sharedHistoryBoundary(ctx, chat, chat);
  return !!(
    orchestrator &&
    registration &&
    work.chatId === chat.id &&
    chat.orchestratorIds.includes(orchestrator.id) &&
    boundary !== null &&
    (work.sourceSequence ?? 0) >= boundary &&
    (await orchestratorCanReadWork(ctx, orchestrator, work, registration)) &&
    (await workVisibilityForConversation(ctx, chat)(work))
  );
}

export async function workerConversationContext(ctx: QueryCtx, work: Doc<"aiOrchestratorWork">) {
  return {
    messages: (await messagesFor(ctx, work.id))
      .map(({ fingerprint, _id, _creationTime, ...row }) => {
        void fingerprint;
        void _id;
        void _creationTime;
        return row;
      })
      .sort((a, b) => a.position - b.position),
    questions: (await questionsFor(ctx, work.id)).map(({ _id, _creationTime, ...row }) => {
      void _id;
      void _creationTime;
      return row;
    }),
  };
}

export async function applyWorkerAction(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  action: OrchestratorWorkerAction,
) {
  const work = await workById(ctx, action.workId);
  if (!work || work.orchestratorId !== orchestrator.id || !(await visibleWorker(ctx, work, chat)))
    return fail("This worker is unavailable to the current conversation audience.");
  if (
    !orchestrator.capabilities.includes("threads.control") ||
    chat.archived ||
    orchestrator.status !== "active"
  )
    return fail("Worker conversation control is not enabled.");
  const scope = work.companyId
    ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
    : null;
  if (!scope || !hasCompanyPermission(scope.permissions, "remoteAgents.control"))
    return fail("The owner no longer has worker control permission.");
  if (work.stopRequested)
    return fail("This assignment has been stopped; a message cannot renew its authority.");
  if (action.kind === "escalateWorkQuestion") {
    const question = await questionById(ctx, work.id, action.questionId);
    if (!question || !["open", "escalated"].includes(question.state))
      return fail("This question is no longer open.");
    if (question.state === "open") await ctx.db.patch(question._id, { state: "escalated" });
    return { questionId: question.id, state: "escalated" };
  }
  const messages = await messagesFor(ctx, work.id);
  if (action.kind === "reorderWorkMessages") {
    const pending = messages.filter((m) => m.state === "pending");
    if (
      new Set(action.ids).size !== action.ids.length ||
      action.ids.length !== pending.length ||
      pending.some((m) => !action.ids.includes(m.id))
    )
      return fail("The pending queue changed; refresh it before reordering.");
    if (pending.toSorted((a, b) => a.position - b.position).every((m, i) => m.id === action.ids[i]))
      return { state: "reordered" };
    const positions = pending.map((m) => m.position).sort((a, b) => a - b);
    for (const [index, id] of action.ids.entries()) {
      const row = pending.find((m) => m.id === id)!;
      await ctx.db.patch(row._id, { position: positions[index]!, revision: row.revision + 1 });
    }
    return { state: "reordered" };
  }
  const existing = await messageById(ctx, work.id, action.id);
  if (action.kind === "editWorkMessage" || action.kind === "removeWorkMessage") {
    if (!existing || existing.state !== "pending" || existing.revision !== action.revision)
      return fail("This message changed or delivery already accepted it. Refresh before editing.");
    if (
      action.kind === "editWorkMessage" &&
      (existing.mode === "answer" || !action.text.trim() || action.text.length > 16000)
    )
      return fail("Only a pending follow-up with 1–16,000 characters can be edited.");
    await ctx.db.patch(existing._id, {
      revision: existing.revision + 1,
      ...(action.kind === "removeWorkMessage"
        ? { state: "removed" as const, detail: "Removed before delivery." }
        : { text: action.text }),
    });
    if (action.kind === "removeWorkMessage" && existing.questionId) {
      const question = await questionById(ctx, work.id, existing.questionId);
      if (question?.state === "answering") await ctx.db.patch(question._id, { state: "open" });
    }
    return { id: action.id, state: action.kind === "removeWorkMessage" ? "removed" : "pending" };
  }
  const fingerprint = canonicalQueueJson(action);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      return fail("This message id is already used for different content.");
    return { id: existing.id, state: existing.state, detail: existing.detail };
  }
  if (!action.id.trim() || action.id.length > 200 || !work.threadId || messages.length >= 100)
    return fail("The worker needs an accepted thread and space in its conversation queue.");
  let threadId = work.threadId;
  if (action.kind === "answerWorkQuestion") {
    const question = await questionById(ctx, work.id, action.questionId);
    if (!question || !["open", "escalated"].includes(question.state))
      return fail("This question is no longer open.");
    if (
      Object.keys(action.answers).length !== question.questions.length ||
      question.questions.some((q) => !action.answers[q.id]?.trim()) ||
      JSON.stringify(action.answers).length > 16000
    )
      return fail("Answer each question using its supplied id.");
    threadId = question.threadId;
    await ctx.db.patch(question._id, { state: "answering" });
  } else if (!action.text.trim() || action.text.length > 16000)
    return fail("A follow-up needs 1–16,000 characters.");
  await ctx.db.insert("aiOrchestratorWorkerMessages", {
    id: action.id,
    workId: work.id,
    threadId,
    revision: 0,
    position: Math.max(0, ...messages.map((m) => m.position)) + 1,
    text: action.kind === "sendWork" ? action.text : "",
    mode: action.kind === "sendWork" ? action.mode : "answer",
    ...(action.kind === "answerWorkQuestion"
      ? { questionId: action.questionId, answers: action.answers }
      : {}),
    state: "pending",
    detail: "Queued; the environment has not accepted delivery.",
    fingerprint,
  });
  await ctx.db.patch(work._id, { updatedAt: Date.now() });
  return { id: action.id, state: "pending" };
}

export const conversation = query({
  args: { chatId: v.string(), workId: v.string() },
  handler: async (ctx, args) => {
    const { chat, member } = await readableChat(ctx, args.chatId);
    const work = await workById(ctx, args.workId);
    if (
      !work ||
      (work.sourceSequence ?? 0) < member.fromSequence ||
      !(await visibleWorker(ctx, work, chat))
    )
      return fail("Worker unavailable to this audience.");
    return workerConversationContext(ctx, work);
  },
});
export const control = mutation({
  args: { chatId: v.string(), action: v.any() },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    const action = decodeAction(args.action);
    const work = await workById(ctx, action.workId);
    const orchestrator = work ? await findOrchestrator(ctx, work.orchestratorId) : null;
    if (!orchestrator || !canDirectOrchestrator(orchestrator, user.clerkSubject))
      return fail("You cannot direct this worker.");
    return applyWorkerAction(ctx, orchestrator, chat, action);
  },
});
export const stop = mutation({
  args: { chatId: v.string(), workId: v.string() },
  handler: async (ctx, args) => {
    const { chat, user } = await readableChat(ctx, args.chatId);
    const work = await workById(ctx, args.workId);
    const orchestrator = work ? await findOrchestrator(ctx, work.orchestratorId) : null;
    if (
      !work ||
      !orchestrator ||
      !canDirectOrchestrator(orchestrator, user.clerkSubject) ||
      !(await visibleWorker(ctx, work, chat))
    )
      return fail("You cannot stop this worker.");
    return controlOrchestratorWork(ctx, orchestrator, chat, { kind: "stopWork", workId: work.id });
  },
});

async function environmentWork(ctx: QueryCtx, companyId: string, workId: string) {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "environment") return fail("An authenticated environment is required.");
  const work = await workById(ctx, workId);
  const chat = work
    ? await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
        .unique()
    : null;
  if (
    !work ||
    work.companyId !== companyId ||
    work.environmentId !== actor.registration.environmentId ||
    !chat ||
    !(await visibleWorker(ctx, work, chat))
  )
    return fail("This environment cannot access that worker conversation.");
  return { work, chat };
}
export const environmentInbox = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") return fail("An authenticated environment is required.");
    const active = await Promise.all(
      (["queued", "working", "unknown"] as const).map((status) =>
        ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_company_environment_status", (q) =>
            q
              .eq("companyId", args.companyId)
              .eq("environmentId", actor.registration.environmentId)
              .eq("status", status),
          )
          .take(100),
      ),
    );
    const recent = await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_company_environment_updated", (q) =>
        q.eq("companyId", args.companyId).eq("environmentId", actor.registration.environmentId),
      )
      .order("desc")
      .take(100);
    const rows = [
      ...new Map([...active.flat(), ...recent].map((work) => [work.id, work])).values(),
    ];
    const result = [];
    for (const work of rows) {
      if (!work.threadId || !work.commandId) continue;
      const chat = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
        .unique();
      if (!chat || !(await visibleWorker(ctx, work, chat))) continue;
      const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
      const messages = await messagesFor(ctx, work.id);
      const head =
        work.stopRequested ||
        orchestrator?.status !== "active" ||
        !orchestrator.capabilities.includes("threads.control")
          ? null
          : messages
              .filter((m) => m.state === "pending" || m.state === "accepted")
              .sort(deliveryOrder)[0];
      const budgets = await budgetsForScopes(ctx, args.companyId, [
        { kind: "chat", chatId: work.chatId },
        { kind: "thread", environmentId: work.environmentId, threadId: work.threadId },
      ]);
      result.push({
        allowanceRevision: budgets.map((b) => `${b.id}:${b.revision}:${b.status}`).join("|"),
        workId: work.id,
        threadId: work.threadId,
        commandId: work.commandId,
        orchestratorId: work.orchestratorId,
        stopped: work.stopRequested ?? false,
        message: head ? { id: head.id, revision: head.revision } : null,
      });
    }
    return result;
  },
});
const fence = { companyId: v.string(), workId: v.string(), id: v.string(), revision: v.number() };
export const deliveryPreview = query({
  args: fence,
  handler: async (ctx, args) => {
    await environmentWork(ctx, args.companyId, args.workId);
    const row = await messageById(ctx, args.workId, args.id);
    return row?.revision === args.revision ? { state: row.state, mode: row.mode } : null;
  },
});
export const accept = mutation({
  args: fence,
  handler: async (ctx, args) => {
    const { work } = await environmentWork(ctx, args.companyId, args.workId);
    const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
    const scope =
      work.companyId && orchestrator
        ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
        : null;
    if (!scope || !hasCompanyPermission(scope.permissions, "remoteAgents.control")) return null;
    if (
      work.stopRequested ||
      orchestrator?.status !== "active" ||
      !orchestrator.capabilities.includes("threads.control")
    )
      return null;
    const rows = await messagesFor(ctx, work.id);
    const head = rows
      .filter((m) => m.state === "pending" || m.state === "accepted")
      .sort(deliveryOrder)[0];
    if (!head || head.id !== args.id || head.revision !== args.revision) return null;
    await ctx.db.patch(head._id, {
      state: "accepted",
      detail: "Accepted; local delivery is not yet confirmed.",
    });
    const question = head.questionId ? await questionById(ctx, work.id, head.questionId) : null;
    return { ...head, state: "accepted" as const, requestId: question?.requestId };
  },
});
export const acknowledge = mutation({
  args: { ...fence, detail: v.string(), failed: v.boolean(), runId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { work } = await environmentWork(ctx, args.companyId, args.workId);
    const row = await messageById(ctx, args.workId, args.id);
    if (!row || row.revision !== args.revision || row.state !== "accepted") return false;
    await ctx.db.patch(row._id, {
      state: args.failed ? "failed" : "delivered",
      detail: args.detail.slice(0, 500),
    });
    if (!args.failed && args.runId && row.threadId === work.threadId && !work.stopRequested)
      await ctx.db.patch(work._id, {
        followedRunId: args.runId,
        status: "working",
        completionNotified: false,
        resultCollected: false,
        resultText: undefined,
        resultRunId: undefined,
        detail: "Follow-up dispatched; waiting for the worker result.",
        updatedAt: Date.now(),
      });
    if (row.questionId && args.failed) {
      const question = await questionById(ctx, args.workId, row.questionId);
      if (question?.state === "answering")
        await ctx.db.patch(question._id, { state: "unavailable" });
    }
    return true;
  },
});

/** Environment authenticates assignment origin and descendant ownership locally before reporting. */
export const reportQuestion = mutation({
  args: {
    companyId: v.string(),
    workId: v.string(),
    threadId: v.string(),
    requestId: v.string(),
    questions: v.array(v.object({ id: v.string(), question: v.string() })),
    open: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { work, chat } = await environmentWork(ctx, args.companyId, args.workId);
    if (work.stopRequested) return false;
    const id = JSON.stringify([args.threadId, args.requestId]);
    const existing = await questionById(ctx, work.id, id);
    if (existing) {
      if (!args.open && existing.state !== "resolved")
        await ctx.db.patch(existing._id, { state: "resolved" });
      return true;
    }
    if (!args.open) return false;
    if (
      !args.questions.length ||
      args.questions.length > 10 ||
      JSON.stringify(args.questions).length > 16000 ||
      (await questionsFor(ctx, work.id)).length >= 100
    )
      return fail("Worker question limit reached.");
    await ctx.db.insert("aiOrchestratorWorkerQuestions", {
      id,
      workId: work.id,
      threadId: args.threadId,
      requestId: args.requestId,
      questions: args.questions,
      state: "open",
    });
    const messageId = `worker-question:${work.id}:${id}`;
    await appendChatMessage(ctx, chat, {
      id: messageId,
      senderKind: "system",
      senderId: work.id,
      senderName: work.title,
      text: `Worker question: ${args.questions.map((q) => q.question).join("\n")}`,
      status: "queued",
      replyToId: null,
    });
    await ctx.db.insert("aiOrchestratorJobs", {
      id: messageId,
      orchestratorId: work.orchestratorId,
      chatId: chat.id,
      messageId,
      companyId: args.companyId,
      status: "queued",
      environmentId: null,
      generation: 0,
      leaseExpiresAt: 0,
      modelIndex: 0,
      error: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  },
});
