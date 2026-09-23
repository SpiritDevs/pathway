import { reconcileConversationLifecycle } from "./lib/conversationLifecycle.ts";
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
import { scheduleOrchestratorWorkRefresh } from "./lib/aiOrchestratorWorkRefresh.ts";

const chatMessage = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorMessages")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
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
    .order("desc")
    .take(100);
const questionsFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("aiOrchestratorWorkerQuestions")
    .withIndex("by_work", (q) => q.eq("workId", id))
    .order("desc")
    .take(100);
const pendingMessagesFor = async (ctx: QueryCtx, workId: string) =>
  (
    await Promise.all(
      (["pending", "accepted"] as const).map((state) =>
        ctx.db
          .query("aiOrchestratorWorkerMessages")
          .withIndex("by_work_state", (q) => q.eq("workId", workId).eq("state", state))
          .take(101),
      ),
    )
  ).flat();
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

/** Reuse authorization reads only within this transaction; later calls always recheck live grants. */
function workerVisibility(ctx: QueryCtx) {
  const orchestrators = new Map<string, ReturnType<typeof findOrchestrator>>();
  const registrations = new Map<string, Promise<Doc<"environmentRegistrations"> | null>>();
  const boundaries = new Map<string, ReturnType<typeof sharedHistoryBoundary>>();
  const access = new Map<string, ReturnType<typeof orchestratorCanReadWork>>();
  const audiences = new Map<string, ReturnType<typeof workVisibilityForConversation>>();
  return async (work: Doc<"aiOrchestratorWork">, chat: Doc<"aiOrchestratorChats">) => {
    if (
      !work.companyId ||
      work.chatId !== chat.id ||
      !chat.orchestratorIds.includes(work.orchestratorId)
    )
      return false;
    if (!orchestrators.has(work.orchestratorId))
      orchestrators.set(work.orchestratorId, findOrchestrator(ctx, work.orchestratorId));
    const orchestrator = await orchestrators.get(work.orchestratorId)!;
    const registrationKey = JSON.stringify([work.companyId, work.environmentId]);
    if (!registrations.has(registrationKey))
      registrations.set(
        registrationKey,
        (async () => {
          const company = await ctx.db
            .query("companies")
            .withIndex("by_domain_id", (q) => q.eq("id", work.companyId!))
            .unique();
          return company
            ? ctx.db
                .query("environmentRegistrations")
                .withIndex("by_company_and_environment", (q) =>
                  q.eq("companyId", company._id).eq("environmentId", work.environmentId),
                )
                .unique()
            : null;
        })(),
      );
    const registration = await registrations.get(registrationKey)!;
    if (!orchestrator || !registration) return false;
    if (!boundaries.has(chat.id)) boundaries.set(chat.id, sharedHistoryBoundary(ctx, chat, chat));
    const boundary = await boundaries.get(chat.id)!;
    if (boundary === null || (work.sourceSequence ?? 0) < boundary) return false;
    const accessKey = JSON.stringify([
      work.orchestratorId,
      work.companyId,
      work.environmentId,
      work.projectId,
    ]);
    if (!access.has(accessKey))
      access.set(accessKey, orchestratorCanReadWork(ctx, orchestrator, work, registration));
    if (!(await access.get(accessKey)!)) return false;
    if (!audiences.has(chat.id)) audiences.set(chat.id, workVisibilityForConversation(ctx, chat));
    return audiences.get(chat.id)!(work);
  };
}

export async function visibleWorker(
  ctx: QueryCtx,
  work: Doc<"aiOrchestratorWork">,
  chat: Doc<"aiOrchestratorChats">,
) {
  return workerVisibility(ctx)(work, chat);
}

export async function workerConversationContext(ctx: QueryCtx, work: Doc<"aiOrchestratorWork">) {
  return {
    messages: [
      ...new Map(
        [...(await messagesFor(ctx, work.id)), ...(await pendingMessagesFor(ctx, work.id))].map(
          (message) => [message.id, message],
        ),
      ).values(),
    ]
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
  chatMessageId?: string,
) {
  const selectedWork = await workById(ctx, action.workId);
  const work = selectedWork?.controlWorkId
    ? await workById(ctx, selectedWork.controlWorkId)
    : selectedWork;
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
  if (work.stopRequested && action.kind !== "removeWorkMessage")
    return fail("This assignment has been stopped; a message cannot renew its authority.");
  if (action.kind === "escalateWorkQuestion") {
    const question = await questionById(ctx, work.id, action.questionId);
    if (!question || !["open", "escalated"].includes(question.state))
      return fail("This question is no longer open.");
    if (question.state === "open") {
      await ctx.db.patch(question._id, { state: "escalated" });
      for (const field of question.questions) {
        await appendChatMessage(ctx, chat, {
          id: `worker-question:${work.id}:${question.id}:${field.id}`,
          senderKind: "orchestrator",
          senderId: orchestrator.id,
          senderName: orchestrator.name,
          text: field.isSecret
            ? `${work.title} needs a private answer. Open its thread to respond securely.`
            : field.question,
          worker: {
            workId: work.id,
            questionId: question.id,
            fieldId: field.id,
            ...(field.isSecret ? { isSecret: true } : {}),
          },
          status: "sent",
          replyToId: null,
        });
      }
    }
    return { questionId: question.id, state: "escalated" };
  }
  const messages = await pendingMessagesFor(ctx, work.id);
  if (action.kind === "reorderWorkMessages") {
    const pending = messages.filter((m) => m.state === "pending");
    const ids = action.queue.map((item) => item.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== pending.length ||
      pending.some(
        (m) => !action.queue.some((item) => item.id === m.id && item.revision === m.revision),
      )
    )
      return fail("The pending queue changed; refresh it before reordering.");
    if (pending.toSorted((a, b) => a.position - b.position).every((m, i) => m.id === ids[i]))
      return { state: "reordered" };
    const positions = pending.map((m) => m.position).sort((a, b) => a - b);
    for (const [index, id] of ids.entries()) {
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
        : { text: action.text, ...(action.mode ? { mode: action.mode } : {}) }),
    });
    if (existing.chatMessageId) {
      const message = await chatMessage(ctx, existing.chatMessageId);
      if (message)
        await ctx.db.patch(
          message._id,
          action.kind === "removeWorkMessage" ? { status: "cancelled" } : { text: action.text },
        );
      if (message && action.kind === "editWorkMessage") {
        const chat = await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", message.chatId))
          .unique();
        if (chat?.lastVisibleSequence === message.sequence)
          await ctx.db.patch(chat._id, { lastMessage: action.text.slice(0, 160) });
      }
    }
    if (action.kind === "removeWorkMessage" && existing.questionId) {
      const question = await questionById(ctx, work.id, existing.questionId);
      if (question?.state === "answering") {
        const prompt = await chatMessage(
          ctx,
          `worker-question:${work.id}:${question.id}:${question.questions[0]?.id}`,
        );
        await ctx.db.patch(question._id, { state: prompt ? "escalated" : "open" });
      }
    }
    if (!work.stopRequested && (await pendingMessagesFor(ctx, work.id)).length === 0)
      await ctx.db.patch(work._id, { controlsPending: false });
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
    if (question.questions.some((q) => q.isSecret))
      return fail("Answer private questions in the original thread.");
    if (
      Object.keys(action.answers).length !== question.questions.length ||
      question.questions.some((q) => !action.answers[q.id]?.trim()) ||
      JSON.stringify(action.answers).length > 16000
    )
      return fail("Answer each question using its supplied id.");
    threadId = question.threadId;
    await ctx.db.patch(question._id, { state: "answering" });
  } else if (
    (!action.text.trim() &&
      !(chatMessageId && (await chatMessage(ctx, chatMessageId))?.attachments?.length)) ||
    action.text.length > 16000
  )
    return fail("A follow-up needs 1–16,000 characters.");
  const messageId = chatMessageId ?? `worker-instruction:${work.id}:${action.id}`;
  if (!chatMessageId) {
    await appendChatMessage(ctx, chat, {
      id: messageId,
      senderKind: "orchestrator",
      senderId: orchestrator.id,
      senderName: orchestrator.name,
      text: action.kind === "sendWork" ? action.text : Object.values(action.answers).join("\n"),
      worker: { workId: work.id },
      status: "queued",
      replyToId: null,
    });
  }
  const sourceMessage = await chatMessage(ctx, messageId);
  await ctx.db.insert("aiOrchestratorWorkerMessages", {
    chatMessageId: messageId,
    ...(sourceMessage?.attachments ? { attachments: sourceMessage.attachments } : {}),
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
  await ctx.db.patch(work._id, { controlsPending: true, updatedAt: Date.now() });
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
    const { chat, user, member } = await readableChat(ctx, args.chatId);
    const action = decodeAction(args.action);
    const work = await workById(ctx, action.workId);
    const orchestrator = work ? await findOrchestrator(ctx, work.orchestratorId) : null;
    if (
      !orchestrator ||
      !work ||
      (work.sourceSequence ?? 0) < member.fromSequence ||
      !canDirectOrchestrator(orchestrator, user.clerkSubject)
    )
      return fail("You cannot direct this worker.");
    return applyWorkerAction(ctx, orchestrator, chat, action);
  },
});
export const stop = mutation({
  args: { chatId: v.string(), workId: v.string() },
  handler: async (ctx, args) => {
    const { chat, user, member } = await readableChat(ctx, args.chatId);
    const work = await workById(ctx, args.workId);
    const orchestrator = work ? await findOrchestrator(ctx, work.orchestratorId) : null;
    if (
      !work ||
      (work.sourceSequence ?? 0) < member.fromSequence ||
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
  args: { companyId: v.string(), threadId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") return fail("An authenticated environment is required.");
    const active = args.threadId
      ? []
      : await Promise.all(
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
    const recent = args.threadId
      ? []
      : await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_company_environment_updated", (q) =>
            q.eq("companyId", args.companyId).eq("environmentId", actor.registration.environmentId),
          )
          .order("desc")
          .take(100);
    const pendingControls = (threadId?: string | null) =>
      ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_pending_controls", (q) => {
          const pending = q
            .eq("companyId", args.companyId)
            .eq("environmentId", actor.registration.environmentId)
            .eq("controlsPending", true);
          return threadId === undefined ? pending : pending.eq("threadId", threadId);
        })
        .collect();
    // Keep older pending controls beyond the recent-work limit, plus stops for pending launches.
    const pending = args.threadId
      ? (await Promise.all([pendingControls(args.threadId), pendingControls(null)])).flat()
      : await pendingControls();
    const matching = args.threadId
      ? await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_thread", (q) =>
            q
              .eq("companyId", args.companyId)
              .eq("environmentId", actor.registration.environmentId)
              .eq("threadId", args.threadId!),
          )
          .order("desc")
          .take(100)
      : [];
    const rows = [
      ...new Map(
        [...matching, ...pending, ...active.flat(), ...recent].map((work) => [work.id, work]),
      ).values(),
    ];
    const result = [];
    const visible = workerVisibility(ctx);
    const chats = new Map<string, Promise<Doc<"aiOrchestratorChats"> | null>>();
    const orchestrators = new Map<string, ReturnType<typeof findOrchestrator>>();
    const scopes = new Map<string, ReturnType<typeof orchestratorOwnerScope>>();
    for (const work of rows) {
      if (!work.commandId || ((!work.threadId || work.controlMessageId) && !work.stopRequested))
        continue;
      if (!chats.has(work.chatId))
        chats.set(
          work.chatId,
          ctx.db
            .query("aiOrchestratorChats")
            .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
            .unique(),
        );
      const chat = await chats.get(work.chatId)!;
      if (!chat || !(await visible(work, chat))) continue;
      if (!orchestrators.has(work.orchestratorId))
        orchestrators.set(work.orchestratorId, findOrchestrator(ctx, work.orchestratorId));
      const orchestrator = await orchestrators.get(work.orchestratorId)!;
      const messages = await pendingMessagesFor(ctx, work.id);
      if (orchestrator && work.companyId && !scopes.has(work.orchestratorId))
        scopes.set(work.orchestratorId, orchestratorOwnerScope(ctx, orchestrator, work.companyId));
      const scope = (await scopes.get(work.orchestratorId)) ?? null;
      const enabled =
        !!scope &&
        hasCompanyPermission(scope.permissions, "remoteAgents.control") &&
        !work.stopRequested &&
        !chat.archived &&
        orchestrator?.status === "active" &&
        orchestrator.capabilities.includes("threads.control");
      const head = messages
        .filter((m) => m.state === "accepted" || (enabled && m.state === "pending"))
        .sort(deliveryOrder)[0];
      const budgets = head
        ? await budgetsForScopes(ctx, args.companyId, [
            { kind: "chat", chatId: work.chatId },
            { kind: "thread", environmentId: work.environmentId, threadId: head.threadId },
          ])
        : [];
      result.push({
        allowanceRevision: budgets.map((b) => `${b.id}:${b.revision}:${b.status}`).join("|"),
        workId: work.id,
        threadId: work.threadId ?? "",
        commandId: work.commandId,
        orchestratorId: work.orchestratorId,
        stopped: !enabled,
        cancellationRequested: !!work.stopRequested && !work.stopConfirmed,
        stopRunId: work.resultRunId ?? null,
        stopMessageId: work.continuation
          ? (work.resultMessageId ?? work.commandId + ":message")
          : null,
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
  args: { ...fence, rootRunId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { work, chat } = await environmentWork(ctx, args.companyId, args.workId);
    const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
    const scope =
      work.companyId && orchestrator
        ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
        : null;
    const enabled =
      !!scope &&
      hasCompanyPermission(scope.permissions, "remoteAgents.control") &&
      !work.stopRequested &&
      !chat.archived &&
      orchestrator?.status === "active" &&
      orchestrator.capabilities.includes("threads.control");
    const alreadyAccepted = await messageById(ctx, work.id, args.id);
    if (alreadyAccepted?.state === "accepted" && alreadyAccepted.revision === args.revision) {
      const question = alreadyAccepted.questionId
        ? await questionById(ctx, work.id, alreadyAccepted.questionId)
        : null;
      return { ...alreadyAccepted, requestId: question?.requestId, recoveryOnly: !enabled };
    }
    if (!enabled) return null;
    const rows = await pendingMessagesFor(ctx, work.id);
    const head = rows
      .filter((m) => m.state === "pending" || m.state === "accepted")
      .sort(deliveryOrder)[0];
    if (!head || head.id !== args.id || head.revision !== args.revision) return null;
    if (args.rootRunId && !work.resultRunId)
      await ctx.db.patch(work._id, { resultRunId: args.rootRunId });
    await ctx.db.patch(head._id, {
      state: "accepted",
      detail: "Accepted; local delivery is not yet confirmed.",
    });
    const question = head.questionId ? await questionById(ctx, work.id, head.questionId) : null;
    return {
      ...head,
      state: "accepted" as const,
      requestId: question?.requestId,
      recoveryOnly: false,
    };
  },
});
export const acknowledge = mutation({
  args: {
    ...fence,
    detail: v.string(),
    failed: v.boolean(),
    runId: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { work } = await environmentWork(ctx, args.companyId, args.workId);
    const row = await messageById(ctx, args.workId, args.id);
    if (!row || row.revision !== args.revision || row.state !== "accepted") return false;
    await ctx.db.patch(row._id, {
      state: args.failed ? "failed" : "delivered",
      detail: args.detail.slice(0, 500),
    });
    if (row.chatMessageId) {
      const message = await chatMessage(ctx, row.chatMessageId);
      if (message) await ctx.db.patch(message._id, { status: args.failed ? "failed" : "sent" });
    }
    const reportOwner = args.runId
      ? await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_result_run", (q) =>
            q
              .eq("companyId", work.companyId)
              .eq("environmentId", work.environmentId)
              .eq("threadId", row.threadId)
              .eq("resultRunId", args.runId),
          )
          .first()
      : null;
    if (!args.failed && args.runId && !reportOwner) {
      const {
        _id,
        _creationTime,
        interruptCommandId,
        readResult,
        resultText,
        controlsPending,
        ...assignment
      } = work;
      void _id;
      void _creationTime;
      void interruptCommandId;
      void readResult;
      void resultText;
      void controlsPending;
      await ctx.db.insert("aiOrchestratorWork", {
        ...assignment,
        id: `worker-result:${work.id}:${row.id}`,
        threadId: row.threadId,
        commandId: `orchestrator-message:${work.id.length}:${work.id}:${row.id}`,
        controlWorkId: work.id,
        controlMessageId: row.id,
        continuation: true,
        ...(args.messageId ? { resultMessageId: args.messageId } : {}),
        title: work.title,
        prompt: row.text,
        status: work.stopRequested ? "unknown" : "working",
        resultRunId: args.runId,
        stopRequested: !!work.stopRequested,
        stopConfirmed: false,
        controlsPending: !!work.stopRequested,
        readRequested: false,
        completionNotified: false,
        resultCollected: false,
        detail: "Follow-up dispatched; waiting for its findings.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    if (!work.stopRequested && (await pendingMessagesFor(ctx, work.id)).length === 0)
      await ctx.db.patch(work._id, { controlsPending: false });
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
    questions: v.array(
      v.object({ id: v.string(), question: v.string(), isSecret: v.optional(v.boolean()) }),
    ),
    open: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { work, chat } = await environmentWork(ctx, args.companyId, args.workId);
    if (work.stopRequested) return false;
    const reported = await ctx.db
      .query("aiOrchestratorWorkerQuestions")
      .withIndex("by_request", (q) =>
        q.eq("threadId", args.threadId).eq("requestId", args.requestId),
      )
      .take(20);
    for (const question of reported) {
      const owner = await workById(ctx, question.workId);
      if (
        owner &&
        owner.companyId === work.companyId &&
        owner.environmentId === work.environmentId
      ) {
        if (!args.open && question.state !== "resolved")
          await ctx.db.patch(question._id, { state: "resolved" });
        return true;
      }
    }
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
      false
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

/** A quoted reply carries a durable target; no model guesses which worker or question it answers. */
export async function sendWorkerReply(
  ctx: MutationCtx,
  chat: Doc<"aiOrchestratorChats">,
  fromSequence: number,
  subject: string,
  id: string,
  text: string,
  reference: { workId: string; questionId?: string; fieldId?: string },
) {
  const work = await workById(ctx, reference.workId);
  const orchestrator = work ? await findOrchestrator(ctx, work.orchestratorId) : null;
  if (
    !work ||
    !orchestrator ||
    !canDirectOrchestrator(orchestrator, subject) ||
    (work.sourceSequence ?? 0) < fromSequence ||
    !(await visibleWorker(ctx, work, chat))
  )
    return fail("You cannot direct this worker.");
  if (reference.questionId) {
    const question = await questionById(ctx, work.id, reference.questionId);
    if (
      !question ||
      question.state !== "escalated" ||
      !reference.fieldId ||
      !question.questions.some((q) => q.id === reference.fieldId) ||
      question.questions.some((q) => q.isSecret)
    )
      return fail(
        "This question is no longer waiting for a reply. Open the thread for its latest state.",
      );
    const answers = { ...question.humanAnswers, [reference.fieldId]: text };
    if (JSON.stringify(answers).length > 16000)
      return fail("Keep the combined answers under 16,000 characters.");
    if (!text.trim()) return fail("Include an answer with your reply.");
    const source = await chatMessage(ctx, id);
    if (source?.attachments?.length)
      return fail(
        "Reply to this question with text. Share files with the worker in a separate message.",
      );
    await ctx.db.patch(question._id, { humanAnswers: answers });
    if (question.questions.every((q) => answers[q.id]?.trim())) {
      return applyWorkerAction(
        ctx,
        orchestrator,
        chat,
        { kind: "answerWorkQuestion", workId: work.id, id, questionId: question.id, answers },
        id,
      );
    }
    if (source) await ctx.db.patch(source._id, { status: "sent" });
    return { state: "waiting-for-remaining-answers" };
  }
  return applyWorkerAction(
    ctx,
    orchestrator,
    chat,
    { kind: "sendWork", workId: work.id, id, text, mode: "queue" },
    id,
  );
}

export type WorkerMessageQueues = Map<string, Promise<Doc<"aiOrchestratorWorkerMessages">[]>>;

/** Resolve quotes across pages without exposing history from before a participant joined. */
export async function decorateConversationMessage(
  ctx: QueryCtx,
  chat: Doc<"aiOrchestratorChats">,
  fromSequence: number,
  message: Doc<"aiOrchestratorMessages">,
  queues: WorkerMessageQueues,
) {
  const { _id, _creationTime, ...row } = message;
  void _id;
  void _creationTime;
  // Older messages recorded a read time without the recipient identity.
  const legacyJob =
    row.seenAt !== undefined && row.seenBy === undefined
      ? await ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_message", (q) => q.eq("messageId", row.id))
          .unique()
      : null;
  const seenBy =
    row.seenBy ??
    (legacyJob && !legacyJob.routingCandidateIds?.length ? [legacyJob.orchestratorId] : []);
  const source = row.replyToId ? await chatMessage(ctx, row.replyToId) : null;
  const delivery = row.worker
    ? await ctx.db
        .query("aiOrchestratorWorkerMessages")
        .withIndex("by_chat_message", (q) => q.eq("chatMessageId", row.id))
        .unique()
    : null;
  const work = row.worker ? await workById(ctx, row.worker.workId) : null;
  const readable =
    work && (work.sourceSequence ?? 0) >= fromSequence && (await visibleWorker(ctx, work, chat));
  let queuePosition: number | undefined;
  if (delivery && readable && ["pending", "accepted"].includes(delivery.state)) {
    if (!queues.has(delivery.workId))
      queues.set(delivery.workId, pendingMessagesFor(ctx, delivery.workId));
    const queue = (await queues.get(delivery.workId)!).toSorted(deliveryOrder);
    const position = queue.findIndex((item) => item.id === delivery.id);
    if (position >= 0) queuePosition = position + 1;
  }
  return {
    ...row,
    seenBy: seenBy.filter((id) => chat.orchestratorIds.includes(id)),
    worker: readable
      ? {
          ...row.worker!,
          orchestratorId: work.orchestratorId,
          ...(!row.worker?.questionId && row.id.startsWith(`worker-question:${work.id}:`)
            ? { isSecret: true }
            : {}),
        }
      : undefined,
    ...(source && source.chatId === chat.id && source.sequence >= fromSequence
      ? {
          reply: {
            id: source.id,
            senderName: source.senderName,
            text: source.text.slice(0, 300) || source.attachments?.[0]?.name || "Attachment",
          },
        }
      : {}),
    ...(delivery && readable
      ? {
          delivery: {
            id: delivery.id,
            workId: delivery.workId,
            revision: delivery.revision,
            ...(queuePosition ? { queuePosition } : {}),
            mode: delivery.mode,
            state: delivery.state,
            detail: delivery.detail,
          },
        }
      : {}),
  };
}

export const attachmentDownloads = query({
  args: fence,
  handler: async (ctx, args) => {
    const { work } = await environmentWork(ctx, args.companyId, args.workId);
    const message = await messageById(ctx, work.id, args.id);
    if (!message || message.state !== "accepted" || message.revision !== args.revision)
      return fail("This delivery is no longer available.");
    return Promise.all(
      (message.attachments ?? []).map(async (attachment) => {
        const row = await ctx.db
          .query("aiOrchestratorAttachments")
          .withIndex("by_domain_id", (q) => q.eq("id", attachment.id))
          .unique();
        if (
          !row?.storageId ||
          row.chatId !== work.chatId ||
          row.messageId !== message.chatMessageId
        )
          return fail("An attached file is no longer available.");
        const url = await ctx.storage.getUrl(row.storageId);
        if (!url) return fail("An attached file is no longer available.");
        return { attachment, url };
      }),
    );
  },
});

export const reportConversationStop = mutation({
  args: {
    companyId: v.string(),
    workId: v.string(),
    commandId: v.string(),
    threadId: v.string(),
    confirmed: v.boolean(),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      return fail("Only the assigned environment can confirm termination.");
    const work = await workById(ctx, args.workId);
    if (
      !work ||
      work.companyId !== args.companyId ||
      work.environmentId !== actor.registration.environmentId ||
      work.commandId !== args.commandId ||
      (work.threadId !== null && work.threadId !== args.threadId) ||
      !work.stopRequested
    )
      return fail("This termination receipt does not belong to this environment assignment.");
    const unresolved = await ctx.db
      .query("aiOrchestratorWorkerMessages")
      .withIndex("by_work_state", (q) => q.eq("workId", work.id).eq("state", "accepted"))
      .first();
    if (args.confirmed && unresolved) return false;
    if (!work.stopConfirmed)
      await ctx.db.patch(work._id, {
        threadId: args.threadId,
        stopConfirmed: args.confirmed,
        controlsPending: !args.confirmed,
        status: args.confirmed ? "cancelled" : "unknown",
        detail: args.detail.slice(0, 1000),
        updatedAt: Date.now(),
      });
    if (args.confirmed) await scheduleOrchestratorWorkRefresh(ctx, [work.orchestratorId]);
    const chat = await ctx.db
      .query("aiOrchestratorChats")
      .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
      .unique();
    if (chat) await reconcileConversationLifecycle(ctx, chat);
  },
});
