import { assignmentForExecution } from "./lib/aiOrchestratorAuthority.ts";
import { reconcileConversationLifecycle } from "./lib/conversationLifecycle.ts";
import { resolveWorkAssignments } from "./lib/aiOrchestratorContext.ts";
import { OrchestratorWorkerAction } from "@spiritdevs/contracts/aiOrchestrator";
import { applyWorkerAction, workerConversationContext } from "./aiOrchestratorControls.ts";
import { OrchestratorDelegationCatalog } from "@spiritdevs/contracts/aiOrchestrator";
import { normalizeAvatarExpression } from "@spiritdevs/contracts/orchestratorAvatar";
import {
  readableOrchestratorEnvironment,
  notifyOrchestratorEnvironmentChange,
} from "./lib/aiOrchestratorEnvironmentSignals.ts";
import { readableOrchestratorIssue } from "./lib/aiOrchestratorIssueSignals.ts";
import { canReviewResponsibilities } from "./aiOrchestratorReviews.ts";
// @effect-diagnostics globalDate:off -- Convex supplies the transaction clock.
/** Renewable reasoning claims. All effects commit here, after checking the live identity and grants. */
import { v } from "convex/values";
import { budgetAdmission } from "@spiritdevs/contracts/providerAllowanceBudget";
import { budgetsForScopes, allocateFromInstruction } from "./providerAllowanceBudgets.ts";
import {
  readableOrchestratorMail,
  readableOrchestratorThread,
} from "./lib/aiOrchestratorSignals.ts";
import {
  ModelSelection,
  CloudAgentThreadShell,
  ExecutionEnvironmentDescriptor,
  HostResourcesSnapshot,
} from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import {
  OrchestratorDecision,
  DEFAULT_ORCHESTRATOR_MODEL,
  COORDINATOR_DRIVERS,
} from "@spiritdevs/contracts/aiOrchestrator";
import type { OrchestratorRun } from "@spiritdevs/contracts/aiOrchestrator";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { requireCompanyActor } from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import {
  eligibleOrchestratorEnvironment,
  orchestratorCanReadWork,
  orchestratorCommandAllowed,
  orchestratorOwnerScope,
} from "./lib/aiOrchestratorAuthority.ts";
import {
  humanRecipients,
  appendChatMessage,
  canDirectOrchestrator,
  findOrchestrator,
} from "./aiOrchestrators.ts";
import { hasRecordPermission } from "../src/permissions.ts";
import { collaborationDirectory, startCollaboration } from "./lib/aiOrchestratorCollaboration.ts";
import {
  queueOrchestratorWork,
  refreshOrchestratorWork,
  controlOrchestratorWork,
  continueOrchestratorThread,
} from "./lib/aiOrchestratorWork.ts";
import { ORCHESTRATOR_REPORT_LIMIT } from "@spiritdevs/contracts/orchestratorInspection";
import {
  queueInspection,
  inspectionTarget,
  inspectionContext,
  INSPECTION_TIMEOUT_MS,
} from "./lib/aiOrchestratorInspections.ts";
import { finishSignalRouting, signalCandidate } from "./lib/aiOrchestratorRouting.ts";
import { DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@spiritdevs/contracts";
import {
  boundedConversationMessages,
  conversationReasoningAttachments,
  memoryVisibilityForConversation,
  audienceProjectPermissions,
  workVisibilityForConversation,
  sharedHistoryBoundary,
  discoverConversations,
  conversationRetrievalBoundary,
  withoutForgottenSources,
} from "./lib/aiOrchestratorContext.ts";

const LEASE_MS = 90_000;
const identityArgs = { companyId: v.string(), jobId: v.string(), generation: v.number() };
const decodeWorkerAction = Schema.decodeUnknownSync(OrchestratorWorkerAction);
const decodeDecision = Schema.decodeUnknownSync(OrchestratorDecision);
const decodeSelection = Schema.decodeUnknownSync(ModelSelection);
const inspectResources = Schema.decodeUnknownExit(HostResourcesSnapshot);
const decodeResources = Schema.decodeUnknownSync(HostResourcesSnapshot);
const decodeDelegationCatalog = Schema.decodeUnknownSync(OrchestratorDelegationCatalog);
const decodeDescriptor = Schema.decodeUnknownExit(ExecutionEnvironmentDescriptor);
const inspectThreadShell = Schema.decodeUnknownExit(CloudAgentThreadShell);
const decodeThreadShell = Schema.decodeUnknownSync(CloudAgentThreadShell);
const terminalWorkStates = ["completed", "failed", "cancelled"] as const;
const fail = (message: string): never => {
  throw backendError("orchestrator-action", message);
};
async function environmentActor(ctx: QueryCtx, companyId: string) {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "environment")
    return fail("An authorized environment must run coordinator reasoning.");
  return actor;
}
async function findChat(ctx: QueryCtx, id: string) {
  return await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
}
export async function currentClaim(
  ctx: QueryCtx,
  args: { companyId: string; jobId: string; generation: number },
) {
  const actor = await environmentActor(ctx, args.companyId);
  const job = await ctx.db
    .query("aiOrchestratorJobs")
    .withIndex("by_domain_id", (q) => q.eq("id", args.jobId))
    .unique();
  if (
    !job ||
    job.companyId !== args.companyId ||
    job.status !== "running" ||
    job.environmentId !== actor.registration.environmentId ||
    job.generation !== args.generation ||
    job.leaseExpiresAt <= Date.now()
  )
    return null;
  const orchestrator = await findOrchestrator(ctx, job.orchestratorId);
  if (
    !orchestrator ||
    orchestrator.status !== "active" ||
    job.configRevision !== orchestrator.revision ||
    !(await eligibleOrchestratorEnvironment(ctx, orchestrator, actor.registration))
  )
    return null;
  const chat = await findChat(ctx, job.chatId);
  if (!chat || chat.archived || !chat.orchestratorIds.includes(orchestrator.id)) return null;
  if (job.responsibilityReview && !canReviewResponsibilities(orchestrator, chat)) return null;
  if ((job.chatRevision ?? 0) !== (chat.revision ?? 0)) return null;
  if (
    job.mailMessageId &&
    !(await readableOrchestratorMail(ctx, orchestrator, chat, args.companyId, job.mailMessageId))
  )
    return null;
  if (
    job.threadSignalId &&
    !(await readableOrchestratorThread(ctx, orchestrator, chat, args.companyId, job.threadSignalId))
  )
    return null;
  if (
    job.issueSignalId &&
    !(await readableOrchestratorIssue(ctx, orchestrator, chat, args.companyId, job.issueSignalId))
  )
    return null;
  if (
    job.environmentSignalId &&
    !(await readableOrchestratorEnvironment(
      ctx,
      orchestrator,
      chat,
      args.companyId,
      job.environmentSignalId,
    ))
  )
    return null;
  const message = await ctx.db
    .query("aiOrchestratorMessages")
    .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
    .unique();
  if (!message || message.status === "cancelled") return null;
  const historyStart =
    chat.orchestratorHistory?.find((entry) => entry.orchestratorId === orchestrator.id)
      ?.fromSequence ?? 0;
  if (message.sequence < historyStart) return null;
  if (message.senderKind === "orchestrator") {
    const sender = await findOrchestrator(ctx, message.senderId);
    if (
      !sender ||
      sender.status === "deleted" ||
      !chat.orchestratorIds.includes(sender.id) ||
      !sender.capabilities.includes("orchestrators.message") ||
      !canDirectOrchestrator(orchestrator, chat.ownerSubject)
    )
      return null;
  }
  if (message.senderKind === "user") {
    const member = await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", message.senderId))
      .unique();
    if (!member || !canDirectOrchestrator(orchestrator, message.senderId)) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", message.senderId))
      .unique();
    if (!user) return null;
    for (const companyId of chat.companyIds) {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", companyId))
        .unique();
      if (!company || company.lifecycleState !== "active") return null;
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_user", (q) =>
          q.eq("companyId", company._id).eq("userId", user._id),
        )
        .unique();
      if (membership?.state !== "active") return null;
    }
  }
  return { actor, job, orchestrator, chat, message };
}

/** Persist only retrieval requests; recheck access and forgetting at delivery time. */
async function refreshedConversationResults(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  destination: Doc<"aiOrchestratorChats">,
  serialized?: string,
) {
  if (!serialized) return "";
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return "";
  const results = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    if (item.kind === "findConversations") {
      if (typeof item.detail?.query !== "string") continue;
      results.push({
        kind: item.kind,
        detail: await discoverConversations(
          ctx,
          orchestrator,
          destination,
          item.detail.query,
          typeof item.detail.cursor === "string" ? item.detail.cursor : undefined,
        ),
      });
    } else if (item.kind === "readConversation") {
      if (typeof item.detail?.chatId !== "string") continue;
      const source = await findChat(ctx, item.detail.chatId);
      const boundary = source
        ? await conversationRetrievalBoundary(ctx, orchestrator, source, destination)
        : null;
      if (!source || boundary === null) {
        results.push({ kind: item.kind, detail: { unavailable: true } });
        continue;
      }
      const messages = await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_chat_sequence", (q) =>
          q
            .eq("chatId", source.id)
            .gte("sequence", boundary)
            .lt(
              "sequence",
              typeof item.detail.beforeSequence === "number"
                ? item.detail.beforeSequence
                : Number.MAX_SAFE_INTEGER,
            ),
        )
        .order("desc")
        .take(20);
      const retained = await withoutForgottenSources(ctx, orchestrator, messages);
      const sourced = boundedConversationMessages(retained, undefined, 12000);
      results.push({
        kind: item.kind,
        detail: {
          chatId: source.id,
          nextBeforeSequence:
            messages.length === 20 || sourced.length < retained.length
              ? (sourced[0]?.sequence ?? messages[messages.length - 1]?.sequence ?? null)
              : null,
          messages: sourced,
        },
      });
    } else results.push(item);
  }
  return JSON.stringify(results);
}

async function contextFor(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  companyId: string,
  results: string,
  trigger: Doc<"aiOrchestratorMessages">,
  mailMessageId?: string,
  threadSignalId?: string,
  issueSignalId?: string,
  environmentSignalId?: string,
) {
  const historyStart = await sharedHistoryBoundary(ctx, chat, chat);
  if (historyStart === null)
    return fail("Conversation membership changed. Review its participants before continuing.");
  const messages = await ctx.db
    .query("aiOrchestratorMessages")
    .withIndex("by_chat_sequence", (q) => q.eq("chatId", chat.id).gte("sequence", historyStart))
    .order("desc")
    .take(40);
  const retainedMessages = await withoutForgottenSources(ctx, orchestrator, messages);
  const retainedTrigger = await withoutForgottenSources(ctx, orchestrator, [trigger]);
  const sourceTombstone = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_source_forgotten", (q) => q.eq("sourceChatId", chat.id).eq("forgotten", true))
    .first();
  const ownMemories = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_orchestrator_forgotten", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("forgotten", false),
    )
    .order("desc")
    .take(80);
  const personal = orchestrator.shared
    ? []
    : await ctx.db
        .query("aiOrchestratorMemory")
        .withIndex("by_owner_scope_forgotten", (q) =>
          q
            .eq("ownerSubject", orchestrator.ownerSubject)
            .eq("scope", "personal")
            .eq("forgotten", false),
        )
        .order("desc")
        .take(100);
  const projectMemories = orchestrator.projectId
    ? await ctx.db
        .query("aiOrchestratorMemory")
        .withIndex("by_owner_scope", (q) =>
          q.eq("ownerSubject", orchestrator.ownerSubject).eq("scope", "project"),
        )
        .take(100)
    : [];
  const candidates = [
    ...new Map(
      [
        ...ownMemories,
        ...personal,
        ...projectMemories.filter(
          (m) =>
            m.sharedProjectId === orchestrator.projectId &&
            m.sharedCompanyId === orchestrator.companyId,
        ),
      ].map((m) => [m.id, m]),
    ).values(),
  ]
    .filter((m) => !m.forgotten)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.updatedAt - a.updatedAt);
  const memories = [];
  const memoryVisible = memoryVisibilityForConversation(ctx, chat);
  let memoryBudget = 24000;
  for (const memory of candidates) {
    if (memory.text.length > memoryBudget || !(await memoryVisible(memory))) continue;
    if (memory.sourceChatId && memory.sourceSequence !== undefined) {
      const source = await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_chat_sequence", (q) =>
          q.eq("chatId", memory.sourceChatId!).eq("sequence", memory.sourceSequence!),
        )
        .unique();
      if (!source || !(await withoutForgottenSources(ctx, orchestrator, [source])).length) continue;
    }
    memories.push(memory);
    memoryBudget -= memory.text.length;
    if (memories.length >= 40) break;
  }
  const forgotten = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_orchestrator_forgotten", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("forgotten", true),
    )
    .order("desc")
    .take(20);
  const exclusions = [];
  for (const memory of forgotten) if (await memoryVisible(memory)) exclusions.push(memory);
  const scope = await orchestratorOwnerScope(ctx, orchestrator, companyId);
  const readers = scope ? await audienceProjectPermissions(ctx, chat, companyId) : null;
  const projects =
    scope && orchestrator.capabilities.includes("projects.read")
      ? (
          await ctx.db
            .query("cloudProjects")
            .withIndex("by_company", (q) => q.eq("companyId", scope.company._id))
            .take(200)
        )
          .filter(
            (project) =>
              project.deletedAt === null &&
              project.archivedAt === null &&
              (!orchestrator.projectId || orchestrator.projectId === project.id) &&
              readers?.every((reader) =>
                hasRecordPermission(reader, "projects.read", project.teamIds),
              ) &&
              hasRecordPermission(scope.permissions, "projects.read", project.teamIds),
          )
          .map((project) => ({
            id: project.id,
            cloudId: project._id,
            name: project.name,
            companyId,
          }))
      : [];
  const registrations =
    scope && orchestrator.capabilities.includes("environments.read")
      ? await ctx.db
          .query("environmentRegistrations")
          .withIndex("by_company_and_state", (q) =>
            q.eq("companyId", scope.company._id).eq("state", "active"),
          )
          .take(50)
      : [];
  const environments = [];
  let catalogBudget = 64000;
  for (const registration of registrations) {
    const catalog =
      Date.now() - (registration.orchestratorDelegationCatalogAt ?? 0) <= 120000
        ? (registration.orchestratorDelegationCatalog ?? null)
        : null;
    const catalogSize = catalog ? JSON.stringify(catalog).length : 0;
    const includeCatalog = catalogSize <= catalogBudget;
    if (await eligibleOrchestratorEnvironment(ctx, orchestrator, registration)) {
      if (includeCatalog) catalogBudget -= catalogSize;
      environments.push({
        descriptor: (() => {
          const parsed = decodeDescriptor(registration.descriptor);
          return parsed._tag === "Success" ? parsed.value : null;
        })(),
        delegationCatalog: includeCatalog ? catalog : null,
        catalogNote: includeCatalog
          ? "Observed availability, rechecked at launch. No live pricing or tool inventory."
          : "Catalog omitted to bound context size. Do not invent model selections.",
        workerModels: (orchestrator.workerModels ?? []).filter(
          (choice) => choice.environmentId === registration.environmentId,
        ),
        id: registration.environmentId,
        online: (registration.lastSeenAt ?? 0) > Date.now() - LEASE_MS,
        lastSeenAt: registration.lastSeenAt,
        resources: (() => {
          const parsed = inspectResources(registration.orchestratorResources);
          return parsed._tag === "Success" && Date.now() - parsed.value.sampledAt <= 90000
            ? parsed.value
            : null;
        })(),
        resourceNote:
          "Resources are sampled when a coordinator runs here; null means no fresh observation, not an idle host.",
      });
    }
  }
  const contacts = [];
  for (const id of chat.orchestratorIds) {
    const contact = await findOrchestrator(ctx, id);
    if (contact && contact.status !== "deleted")
      contacts.push({
        id,
        name: contact.name,
        projectId: contact.projectId,
        companyId: contact.companyId,
        status: contact.status,
      });
  }
  const directory = orchestrator.capabilities.includes("orchestrators.message")
    ? await collaborationDirectory(ctx, chat, companyId)
    : [];
  const conversations = [];
  if (orchestrator.capabilities.includes("orchestrators.message")) {
    const candidates = await ctx.db
      .query("aiOrchestratorChats")
      .withIndex("by_owner", (q) => q.eq("ownerSubject", chat.ownerSubject))
      .take(100);
    for (const candidate of candidates) {
      if (
        !candidate.archived &&
        candidate.orchestratorIds.includes(orchestrator.id) &&
        (await conversationRetrievalBoundary(ctx, orchestrator, candidate, chat)) === 0
      )
        conversations.push({ id: candidate.id, title: candidate.title });
    }
  }
  const workRows = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_chat", (q) => q.eq("chatId", chat.id))
    .order("desc")
    .take(50);
  const canSeeWork = workVisibilityForConversation(ctx, chat);
  const work = [];
  for (const row of workRows) if (await canSeeWork(row)) work.push(row);
  const recentThreads = [];
  const recentIssues = [];
  if (scope && readers) {
    if (orchestrator.capabilities.includes("threads.read")) {
      const rows = await ctx.db
        .query("agentThreads")
        .withIndex("by_company_updated", (q) => q.eq("companyId", scope.company._id))
        .order("desc")
        .take(100);
      for (const row of rows) {
        const project = projects.find((p) => p.cloudId === row.cloudProjectId);
        if (!project || !environments.some((e) => e.id === row.environmentId)) continue;
        const parsed = inspectThreadShell(row.shell);
        if (parsed._tag !== "Success") continue;
        const shell = parsed.value;
        recentThreads.push({
          threadId: row.threadId,
          environmentId: row.environmentId,
          projectId: project.id,
          title: shell.title.slice(0, 300),
          status: shell.status,
          allowanceHold: shell.allowanceHold,
          updatedAt: row.updatedAt,
        });
        if (recentThreads.length >= 20) break;
      }
    }
    if (orchestrator.capabilities.includes("tasks.read")) {
      const rows = await ctx.db
        .query("issues")
        .withIndex("by_company_and_version", (q) => q.eq("companyId", scope.company._id))
        .order("desc")
        .take(100);
      for (const issue of rows) {
        if (
          issue.deletedAt !== null ||
          (issue.projectId
            ? !projects.some((p) => p.id === issue.projectId)
            : Boolean(orchestrator.projectId)) ||
          !hasRecordPermission(scope.permissions, "issues.read", issue.teamIds) ||
          !readers.every((reader) => hasRecordPermission(reader, "issues.read", issue.teamIds))
        )
          continue;
        recentIssues.push({
          id: issue.id,
          key: issue.key,
          title: issue.title.slice(0, 300),
          projectId: issue.projectId,
          statusId: issue.statusId,
          priority: issue.priority,
          dueDate: issue.dueDate,
          updatedAt: issue.updatedAt,
        });
        if (recentIssues.length >= 20) break;
      }
    }
  }
  const quoted = trigger.replyToId
    ? await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_domain_id", (q) => q.eq("id", trigger.replyToId!))
        .unique()
    : null;
  const quotedMessage =
    quoted &&
    quoted.chatId === chat.id &&
    quoted.sequence >= historyStart &&
    (await withoutForgottenSources(ctx, orchestrator, [quoted])).length
      ? { id: quoted.id, senderName: quoted.senderName, text: quoted.text.slice(0, 4000) }
      : null;
  const workerConversations = [];
  let controlBudget = 16000;
  for (const { assignment: row } of await resolveWorkAssignments(ctx, work)) {
    if ((row.sourceSequence ?? 0) < historyStart || !(await canSeeWork(row))) continue;
    if (controlBudget <= 0) break;
    const conversation = await workerConversationContext(ctx, row);
    const entry = {
      workId: row.id,
      messages: conversation.messages
        .slice(-12)
        .map((m) => ({ ...m, text: m.text.slice(0, 1000) })),
      questions: conversation.questions
        .filter((q) => ["open", "escalated", "answering"].includes(q.state))
        .slice(0, 10),
    };
    const size = JSON.stringify(entry).length;
    if (size <= controlBudget) {
      workerConversations.push(entry);
      controlBudget -= size;
    }
  }
  let workResultBudget = 64000;
  return JSON.stringify({
    humanMentionRecipients: await humanRecipients(ctx, chat),
    companyId,
    chat: { id: chat.id, title: chat.title, leadId: chat.leadId },
    capabilities: orchestrator.capabilities,
    workerConversations,
    quotedMessage,
    responsibilities: orchestrator.responsibilities,
    environmentUpdate: environmentSignalId
      ? await readableOrchestratorEnvironment(
          ctx,
          orchestrator,
          chat,
          companyId,
          environmentSignalId,
        )
      : null,
    issueUpdate: issueSignalId
      ? await readableOrchestratorIssue(ctx, orchestrator, chat, companyId, issueSignalId)
      : null,
    threadUpdate: threadSignalId
      ? await readableOrchestratorThread(ctx, orchestrator, chat, companyId, threadSignalId)
      : null,
    privateMail: mailMessageId
      ? await readableOrchestratorMail(ctx, orchestrator, chat, companyId, mailMessageId)
      : null,
    contacts,
    directory: directory.map(({ id, name, companyId, projectId, status }) => ({
      id,
      name,
      companyId,
      projectId,
      status,
    })),
    conversations,
    projects: projects.map(({ cloudId, ...project }) => {
      void cloudId;
      return project;
    }),
    environments,
    workspaceActivity: {
      scope:
        "Up to 20 permitted results from the 100 most recently updated records; not a complete inventory. Use inspect for thread transcripts and project files; delegate only substantial investigations.",
      recentThreads,
      recentIssues,
    },
    summary:
      sourceTombstone || chat.summaryThroughSequence < historyStart
        ? ""
        : chat.summary.slice(0, 8000),
    summaryThroughSequence: chat.summaryThroughSequence,
    messages: boundedConversationMessages(
      retainedMessages,
      trigger.sequence >= historyStart ? retainedTrigger[0] : undefined,
    ),
    respondingToMessageId: trigger.id,
    memories: memories.map(({ id, text, source, explicit }) => ({ id, text, source, explicit })),
    forgotten: exclusions.map(({ sourceChatId, sourceSequence, updatedAt }) => ({
      sourceChatId,
      sourceSequence,
      forgottenAt: updatedAt,
    })),
    work: work
      .filter((item) => (item.sourceSequence ?? 0) >= historyStart)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(
        ({
          id,
          title,
          status,
          environmentId,
          projectId,
          threadId,
          detail,
          resultText,
          selection,
          selectionReason,
          readResult,
        }) => {
          const result = resultText?.slice(0, workResultBudget);
          workResultBudget -= result?.length ?? 0;
          const conversation = readResult?.slice(0, workResultBudget);
          workResultBudget -= conversation?.length ?? 0;
          return {
            id,
            title,
            status,
            environmentId,
            projectId,
            threadId,
            detail,
            selection,
            selectionReason,
            result,
            resultTruncated: (result?.length ?? 0) < (resultText?.length ?? 0),
            conversation,
          };
        },
      ),
    actionResults: results.slice(0, 80000),
  });
}

async function notifyFinishedWork(ctx: MutationCtx, orchestrator: Doc<"aiOrchestrators">) {
  if (orchestrator.status !== "active") return;
  const batches = await Promise.all(
    terminalWorkStates.map((status) =>
      ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_orchestrator_notification", (q) =>
          q
            .eq("orchestratorId", orchestrator.id)
            .eq("completionNotified", false)
            .eq("status", status),
        )
        .take(32),
    ),
  );
  const groups = new Map<string, Array<Doc<"aiOrchestratorWork">>>();
  for (const work of batches.flat()) {
    if (
      !work.resultCollected &&
      (work.status === "completed" || (work.resultRequired && work.threadId))
    )
      continue;
    if (work.stopRequested) {
      await ctx.db.patch(work._id, { completionNotified: true });
      continue;
    }
    const key = orchestrator.batchCompletions ? work.chatId : work.id;
    groups.set(key, [...(groups.get(key) ?? []), work]);
  }
  for (const work of groups.values()) {
    const chat = await findChat(ctx, work[0]!.chatId);
    if (!chat || chat.archived || !chat.orchestratorIds.includes(orchestrator.id)) {
      for (const item of work) await ctx.db.patch(item._id, { completionNotified: true });
      continue;
    }
    const boundary = await sharedHistoryBoundary(ctx, chat, chat);
    const canSeeWork = workVisibilityForConversation(ctx, chat);
    const visibleWork = [];
    for (const item of work)
      if (boundary !== null && (item.sourceSequence ?? 0) >= boundary && (await canSeeWork(item)))
        visibleWork.push(item);
    if (!visibleWork.length) {
      for (const item of work) await ctx.db.patch(item._id, { completionNotified: true });
      continue;
    }
    const text = visibleWork
      .map((item) => `${item.title}: ${item.status}. ${item.detail}`)
      .join("\n");
    const now = Date.now(),
      messageId = mintDomainId(now);
    await appendChatMessage(ctx, chat, {
      id: messageId,
      senderKind: "system",
      senderId: "delegated-work",
      senderName: "Pathway",
      text,
      status: "queued",
      replyToId: null,
    });
    await ctx.db.insert("aiOrchestratorJobs", {
      id: mintDomainId(now),
      orchestratorId: orchestrator.id,
      chatId: chat.id,
      messageId,
      companyId: work[0]!.companyId ?? orchestrator.companyId ?? "",
      status: "queued",
      environmentId: null,
      generation: 0,
      leaseExpiresAt: 0,
      modelIndex: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    });
    for (const item of work) await ctx.db.patch(item._id, { completionNotified: true });
  }
}

export const claim = mutation({
  args: {
    companyId: v.string(),
    providers: v.array(v.object({ instanceId: v.string(), driver: v.string() })),
    delegationCatalog: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<OrchestratorRun | null> => {
    if (args.providers.length > 50) return fail("Too many provider instances.");
    const actor = await environmentActor(ctx, args.companyId);
    const now = Date.now();
    if (args.delegationCatalog !== undefined) {
      if (JSON.stringify(args.delegationCatalog).length > 100000)
        return fail("Worker catalog is too large.");
      const catalog = decodeDelegationCatalog(args.delegationCatalog);
      await ctx.db.patch(actor.registration._id, {
        orchestratorDelegationCatalog: catalog,
        orchestratorDelegationCatalogAt: now,
      });
    }
    if (
      (actor.registration.lastSeenAt ?? 0) < now - 30_000 ||
      actor.registration.orchestratorPresence !== "online"
    ) {
      await ctx.db.patch(actor.registration._id, {
        lastSeenAt: now,
        orchestratorPresence: "online",
      });
      if (actor.registration.orchestratorPresence === "offline")
        await notifyOrchestratorEnvironmentChange(ctx, {
          ...actor.registration,
          lastSeenAt: now,
          orchestratorPresence: "online",
        });
    }
    const tracked = await Promise.all(
      (["queued", "working", "unknown"] as const).map((status) =>
        ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_company_status", (q) =>
            q.eq("companyId", args.companyId).eq("status", status),
          )
          .take(32),
      ),
    );
    const finished = await Promise.all(
      terminalWorkStates.map((status) =>
        ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_company_notification", (q) =>
            q.eq("companyId", args.companyId).eq("completionNotified", false).eq("status", status),
          )
          .take(32),
      ),
    );
    for (const id of new Set(
      [...tracked.flat(), ...finished.flat()].map((work) => work.orchestratorId),
    )) {
      const orchestrator = await findOrchestrator(ctx, id);
      if (
        orchestrator &&
        (await eligibleOrchestratorEnvironment(ctx, orchestrator, actor.registration))
      ) {
        await refreshOrchestratorWork(ctx, orchestrator);
        await notifyFinishedWork(ctx, orchestrator);
      }
    }
    const groups = await Promise.all(
      [...new Set([args.companyId, ""])].flatMap((companyId) =>
        (["running", "queued"] as const).map((status) =>
          status === "queued"
            ? ctx.db
                .query("aiOrchestratorJobs")
                .withIndex("by_company_ready", (q) =>
                  q.eq("companyId", companyId).eq("status", status).lte("notBefore", now),
                )
                .take(32)
            : ctx.db
                .query("aiOrchestratorJobs")
                .withIndex("by_company_status", (q) =>
                  q.eq("companyId", companyId).eq("status", status),
                )
                .take(32),
        ),
      ),
    );
    for (const job of groups
      .flat()
      .sort(
        (a, b) =>
          a.updatedAt - b.updatedAt ||
          Number(Boolean(a.contextResults)) - Number(Boolean(b.contextResults)) ||
          a.createdAt - b.createdAt,
      )) {
      if ((job.notBefore ?? 0) > now) continue;
      if (job.status === "running" && job.leaseExpiresAt > now) continue;
      const inspections = await inspectionContext(ctx, job);
      if (inspections === null) continue;
      const orchestrator = await findOrchestrator(ctx, job.orchestratorId);
      if (
        !orchestrator ||
        orchestrator.status !== "active" ||
        !(await eligibleOrchestratorEnvironment(ctx, orchestrator, actor.registration))
      )
        continue;
      const chat = await findChat(ctx, job.chatId);
      if (!chat || chat.archived || !chat.orchestratorIds.includes(orchestrator.id)) continue;
      if (job.responsibilityReview && !canReviewResponsibilities(orchestrator, chat)) {
        await ctx.db.patch(job._id, { status: "cancelled", updatedAt: now });
        const trigger = await ctx.db
          .query("aiOrchestratorMessages")
          .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
          .unique();
        if (trigger) await ctx.db.patch(trigger._id, { status: "cancelled" });
        continue;
      }
      const running = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_orchestrator_status", (q) =>
          q.eq("orchestratorId", orchestrator.id).eq("status", "running"),
        )
        .take(20);
      if (running.some((other) => other.id !== job.id && other.leaseExpiresAt > now)) continue;
      const earlier = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_orchestrator_chat_status", (q) =>
          q.eq("orchestratorId", orchestrator.id).eq("chatId", chat.id).eq("status", "queued"),
        )
        .first();
      if (earlier && earlier.id !== job.id && earlier.createdAt < job.createdAt) continue;
      if ((job.attempts ?? 0) >= 12) {
        await ctx.db.patch(job._id, {
          status: "failed",
          error:
            "Coordinator reasoning was interrupted repeatedly. Retry when an environment is ready.",
          updatedAt: now,
        });
        const message = await ctx.db
          .query("aiOrchestratorMessages")
          .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
          .unique();
        if (message) await ctx.db.patch(message._id, { status: "failed" });
        continue;
      }
      if (job.failedEnvironmentIds?.includes(actor.registration.environmentId)) continue;
      const choice = orchestrator.models[job.modelIndex];
      const provider = args.providers.find(
        (provider) =>
          COORDINATOR_DRIVERS.some((driver) => driver === provider.driver) &&
          (choice
            ? provider.instanceId === choice.selection.instanceId
            : provider.driver === "codex"),
      );
      if (!provider || (orchestrator.models.length && !choice)) continue;
      if (
        choice &&
        choice.environmentId !== actor.registration.environmentId &&
        !job.failedEnvironmentIds?.includes(choice.environmentId)
      ) {
        const preferred = await ctx.db
          .query("environmentRegistrations")
          .withIndex("by_company_and_environment", (q) =>
            q.eq("companyId", actor.company._id).eq("environmentId", choice.environmentId),
          )
          .unique();
        if (
          preferred &&
          preferred.state === "active" &&
          (preferred.lastSeenAt ?? 0) > now - LEASE_MS &&
          job.updatedAt > now - LEASE_MS
        )
          continue;
      }
      const routingCandidates = [];
      for (const id of job.routingCandidateIds ?? []) {
        const candidate = await signalCandidate(ctx, job, id);
        if (candidate?.contact.ownerSubject === chat.ownerSubject)
          routingCandidates.push({
            id,
            name: candidate.contact.name,
            responsibilities: candidate.contact.responsibilities.slice(0, 800),
          });
      }
      const selection =
        job.routingCandidateIds?.length && ["codex", "claudeAgent"].includes(provider.driver)
          ? {
              instanceId: provider.instanceId,
              model:
                DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[
                  provider.driver as keyof typeof DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER
                ]!,
              options: [
                { id: provider.driver === "codex" ? "reasoningEffort" : "effort", value: "low" },
              ],
            }
          : (choice?.selection ?? {
              instanceId: provider.instanceId,
              model: DEFAULT_ORCHESTRATOR_MODEL,
              options: [{ id: "reasoningEffort", value: "high" }],
            });
      const generation = job.generation + 1;
      await ctx.db.patch(job._id, {
        status: "running",
        companyId: args.companyId,
        environmentId: actor.registration.environmentId,
        generation,
        configRevision: orchestrator.revision,
        chatRevision: chat.revision ?? 0,
        leaseExpiresAt: now + LEASE_MS,
        attempts: (job.attempts ?? 0) + 1,
        contextThroughSequence: chat.lastSequence,
        selection,
        updatedAt: now,
      });
      const claim = await currentClaim(ctx, {
        companyId: args.companyId,
        jobId: job.id,
        generation,
      });
      if (!claim) {
        await ctx.db.patch(job._id, {
          status: "cancelled",
          error: "Conversation access or direction permission changed.",
          leaseExpiresAt: 0,
          updatedAt: now,
        });
        const message = await ctx.db
          .query("aiOrchestratorMessages")
          .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
          .unique();
        if (message && (message.status === "queued" || message.status === "working"))
          await ctx.db.patch(message._id, { status: "cancelled" });
        continue;
      }
      await ctx.db.patch(claim.message._id, {
        status: "working",
        ...(!job.routingCandidateIds?.length
          ? {
              seenAt: claim.message.seenAt ?? now,
              seenBy: [...new Set([...(claim.message.seenBy ?? []), orchestrator.id])],
            }
          : {}),
      });
      return {
        ...(job.routingCandidateIds?.length
          ? {
              routing: {
                topic: job.routingTopic ?? "Activity changed",
                candidates: routingCandidates,
              },
            }
          : {}),
        environmentId: actor.registration.environmentId,
        id: job.id,
        generation,
        attachments: await conversationReasoningAttachments(ctx, chat, claim.message),
        selection: decodeSelection(selection),
        name: orchestrator.name,
        persona: orchestrator.persona,
        ...(orchestrator.personality ? { personality: orchestrator.personality } : {}),
        instructions: orchestrator.instructions,
        context: await contextFor(
          ctx,
          orchestrator,
          chat,
          args.companyId,
          job.chatRevision === (chat.revision ?? 0) && job.configRevision === orchestrator.revision
            ? JSON.stringify({
                actions: await refreshedConversationResults(
                  ctx,
                  orchestrator,
                  chat,
                  job.contextResults,
                ),
                inspections,
              })
            : "",
          claim.message,
          job.mailMessageId,
          job.threadSignalId,
          job.issueSignalId,
          job.environmentSignalId,
        ),
      };
    }
    return null;
  },
});
/** A quota hold yields the reasoning slot and preserves the original queued request. */
async function holdAllowanceClaim(
  ctx: MutationCtx,
  claim: NonNullable<Awaited<ReturnType<typeof currentClaim>>>,
  reason: string,
) {
  const detail = reason.slice(0, 500);
  await ctx.db.patch(claim.job._id, {
    status: "queued",
    environmentId: null,
    leaseExpiresAt: 0,
    notBefore: Date.now() + 30_000,
    allowanceHold: detail,
    attempts: Math.max(0, (claim.job.attempts ?? 1) - 1),
    updatedAt: Date.now(),
  });
  await ctx.db.patch(claim.message._id, { status: "queued" });
  if (claim.job.allowanceHold !== detail)
    await appendChatMessage(ctx, claim.chat, {
      id: mintDomainId(Date.now()),
      senderKind: "system",
      senderId: claim.orchestrator.id,
      senderName: "Pathway",
      text: detail + " Your request is retained. Review the allowance allocation to resume.",
      status: "sent",
      replyToId: claim.message.id,
    });
}
export const holdForAllowance = mutation({
  args: { ...identityArgs, detail: v.string() },
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    await holdAllowanceClaim(ctx, claim, args.detail);
    return true;
  },
});
export const renew = mutation({
  args: identityArgs,
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    await ctx.db.patch(claim.job._id, { leaseExpiresAt: Date.now() + LEASE_MS });
    return true;
  },
});

async function remember(
  ctx: MutationCtx,
  claim: NonNullable<Awaited<ReturnType<typeof currentClaim>>>,
  action: Extract<OrchestratorDecision["actions"][number], { kind: "remember" }>,
) {
  if (
    !claim.orchestrator.capabilities.includes("memory.manage") ||
    !claim.orchestrator.rememberAutomatically
  )
    return fail("Automatic memory is disabled for this orchestrator.");
  if (!action.text.trim() || action.text.length > 4000 || !action.sourceQuote.trim())
    return fail("A memory needs a short fact and a quoted source.");
  const source = await ctx.db
    .query("aiOrchestratorMessages")
    .withIndex("by_domain_id", (q) => q.eq("id", action.sourceMessageId))
    .unique();
  if (
    !source ||
    source.chatId !== claim.chat.id ||
    source.senderKind !== "user" ||
    !source.text.includes(action.sourceQuote)
  )
    return fail("A memory must cite a user message from this conversation.");
  if (!(await withoutForgottenSources(ctx, claim.orchestrator, [source])).length)
    return fail("Forgotten information cannot be learned again from old messages.");
  const memoryScope = action.scope ?? "orchestrator";
  if (
    memoryScope !== "orchestrator" &&
    (source.senderId !== claim.orchestrator.ownerSubject ||
      claim.chat.participantSubjects.length !== 1 ||
      claim.chat.participantSubjects[0] !== claim.orchestrator.ownerSubject)
  )
    return fail(
      "Only the owner can share a sourced preference beyond this orchestrator from their private conversation.",
    );
  if (memoryScope === "personal" && claim.orchestrator.shared)
    return fail("Save personal preferences through a private orchestrator.");
  if (memoryScope === "project" && (!claim.orchestrator.projectId || !claim.orchestrator.companyId))
    return fail("Project memory needs this orchestrator's assigned project.");
  const sharedForgotten = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_owner_scope_forgotten", (q) =>
      q
        .eq("ownerSubject", claim.orchestrator.ownerSubject)
        .eq("scope", "personal")
        .eq("forgotten", true),
    )
    .order("desc")
    .first();
  if (sharedForgotten && source.createdAt <= sharedForgotten.updatedAt)
    return fail("Forgotten shared information cannot be learned again from old messages.");
  const latestForgotten = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_orchestrator_forgotten", (q) =>
      q.eq("orchestratorId", claim.orchestrator.id).eq("forgotten", true),
    )
    .order("desc")
    .first();
  if (latestForgotten && source.createdAt <= latestForgotten.updatedAt)
    return fail("Forgotten information cannot be learned again from old messages.");
  const normalized = action.text.trim().toLocaleLowerCase();
  const existing = await ctx.db
    .query("aiOrchestratorMemory")
    .withIndex("by_orchestrator_forgotten", (q) =>
      q.eq("orchestratorId", claim.orchestrator.id).eq("forgotten", false),
    )
    .take(500);
  const duplicate = existing.find(
    (memory) => memory.text.trim().toLocaleLowerCase() === normalized,
  );
  if (duplicate && duplicate.scope === memoryScope) return;
  if (existing.length >= 500)
    return fail("This orchestrator's memory is full. Review its saved memories.");
  const fields = {
    id: duplicate?.id ?? mintDomainId(Date.now()),
    orchestratorId: claim.orchestrator.id,
    ownerSubject: claim.orchestrator.ownerSubject,
    text: action.text.trim(),
    scope: memoryScope,
    ...(memoryScope === "project"
      ? {
          sharedCompanyId: claim.orchestrator.companyId!,
          sharedProjectId: claim.orchestrator.projectId!,
        }
      : {}),
    source: `Message ${source.id}: ${action.sourceQuote.slice(0, 500)}`,
    explicit: false,
    forgotten: false,
    sourceChatId: source.chatId,
    sourceSequence: source.sequence,
    updatedAt: Date.now(),
  };
  if (duplicate)
    await ctx.db.patch(duplicate._id, {
      ...fields,
      sharedCompanyId: fields.sharedCompanyId,
      sharedProjectId: fields.sharedProjectId,
    });
  else await ctx.db.insert("aiOrchestratorMemory", fields);
}

export const complete = mutation({
  args: {
    ...identityArgs,
    result: v.any(),
    allowanceExecution: v.optional(
      v.object({
        provider: v.string(),
        accountKey: v.optional(v.string()),
        revisions: v.array(v.object({ id: v.string(), revision: v.number() })),
        snapshot: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    const budgets = await budgetsForScopes(ctx, args.companyId, [
      { kind: "chat", chatId: claim.chat.id },
    ]);
    for (const budget of budgets) {
      const proof = args.allowanceExecution;
      const state =
        proof &&
        proof.revisions.some(
          (revision) => revision.id === budget.id && revision.revision === budget.revision,
        )
          ? budgetAdmission(budget, proof, Date.now())
          : {
              canStart: false,
              detail: "The allowance allocation changed before this decision could be applied.",
            };
      if (!state.canStart) {
        await holdAllowanceClaim(ctx, claim, state.detail);
        return false;
      }
    }
    const result = decodeDecision(args.result);
    if (claim.job.routingCandidateIds?.length) {
      // Routing never executes proposed actions or publishes model text, including from older hosts.
      await finishSignalRouting(ctx, claim.job, claim.message, result.routeTo);
      return true;
    }
    if (result.routeTo) return fail("This request does not require recipient routing.");
    if (
      claim.job.mailMessageId &&
      result.actions.some(
        (action) =>
          action.kind !== "delegate" ||
          action.projectId !== null ||
          action.companyId !== claim.job.companyId,
      )
    )
      return fail(
        "Private inbox work must stay in this owner's conversation and workspace. Delegate a project-free PA assignment under your standing responsibilities.",
      );
    if (
      result.message.length > 16000 ||
      result.summary.length > 8000 ||
      result.actions.length > 12 ||
      (!result.message.trim() &&
        !result.actions.length &&
        (result.attention !== "none" || claim.message.senderKind === "user"))
    )
      return fail("The coordinator returned an invalid or oversized decision.");
    const results: Array<{ kind: string; detail: unknown }> = [];
    const inspectionIds = [...(claim.job.inspectionIds ?? [])];
    let queuedInspection = false;
    const sentMessages: Array<{ id: string; text: string }> = [];
    for (const action of result.actions) {
      if (action.kind === "inspect") {
        if (inspectionIds.length >= 12)
          return fail(
            "This request has reached its inspection limit. Answer from the findings or delegate substantial remaining research.",
          );
        inspectionIds.push(await queueInspection(ctx, claim.job, action));
        queuedInspection = true;
        continue;
      }
      if (
        [
          "sendWork",
          "editWorkMessage",
          "removeWorkMessage",
          "reorderWorkMessages",
          "answerWorkQuestion",
          "escalateWorkQuestion",
        ].includes(action.kind)
      ) {
        results.push({
          kind: action.kind,
          detail: await applyWorkerAction(
            ctx,
            claim.orchestrator,
            claim.chat,
            decodeWorkerAction(action),
          ),
        });
        continue;
      }
      if (action.kind === "allocateAllowance") {
        if (
          claim.message.senderKind !== "user" ||
          claim.message.senderId !== claim.chat.ownerSubject ||
          !claim.orchestrator.capabilities.includes("environments.read")
        )
          return fail(
            "Only a new instruction from this conversation's owner can allocate allowance.",
          );
        const budget = await allocateFromInstruction(ctx, {
          companyId: args.companyId,
          ownerSubject: claim.chat.ownerSubject,
          scope: { kind: "chat", chatId: claim.chat.id },
          messageId: claim.message.id,
          text: claim.message.text,
          quote: action.sourceQuote,
          title: action.title,
          snapshot: args.allowanceExecution?.snapshot,
          windowKey: action.windowKey,
          authorizedPercent: action.authorizedPercent,
        });
        results.push({ kind: action.kind, detail: budget });
        continue;
      }
      if (action.kind === "readWork") {
        const work = await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_domain_id", (q) => q.eq("id", action.workId))
          .unique();
        if (!work || work.orchestratorId !== claim.orchestrator.id || work.chatId !== claim.chat.id)
          return fail("Only this conversation's delegated work can be read.");
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
        const boundary = await sharedHistoryBoundary(ctx, claim.chat, claim.chat);
        if (
          !registration ||
          !work.threadId ||
          boundary === null ||
          (work.sourceSequence ?? 0) < boundary ||
          !(await orchestratorCanReadWork(ctx, claim.orchestrator, work, registration)) ||
          !(await workVisibilityForConversation(ctx, claim.chat)(work))
        )
          return fail("The delegated conversation is unavailable to this audience.");
        if (!work.readRequested)
          await ctx.db.patch(work._id, {
            readRequested: true,
            readRequestId: mintDomainId(Date.now()),
          });
        results.push({
          kind: action.kind,
          detail: {
            workId: work.id,
            status: "pending",
            message: "The assigned environment will return the thread conversation and wake you.",
          },
        });
        continue;
      }
      if (action.kind === "remember") {
        await remember(ctx, claim, action);
        continue;
      }
      if (action.kind === "stopWork" || action.kind === "redirectWork") {
        results.push({
          kind: action.kind,
          detail: await controlOrchestratorWork(ctx, claim.orchestrator, claim.chat, action),
        });
        continue;
      }
      if (action.kind === "delegate") {
        const work = await queueOrchestratorWork(ctx, claim.orchestrator, claim.chat, action);
        results.push({ kind: action.kind, detail: work });
        continue;
      }
      if (action.kind === "continueThread") {
        results.push({
          kind: action.kind,
          detail: await continueOrchestratorThread(ctx, claim.orchestrator, claim.chat, action),
        });
        continue;
      }
      if (action.kind === "collaborate") {
        const collaboration = await startCollaboration(ctx, {
          source: claim.chat,
          orchestrator: claim.orchestrator,
          companyId: claim.job.companyId,
          chainDepth: claim.job.chainDepth ?? 0,
          ...action,
        });
        results.push({ kind: action.kind, detail: collaboration });
        continue;
      }
      if (!claim.orchestrator.capabilities.includes("orchestrators.message"))
        return fail("This orchestrator cannot contact other orchestrators.");
      if (action.kind === "findConversations") {
        if (!action.query.trim() || action.query.length > 200)
          return fail("Use a search phrase of 1–200 characters.");
        if (results.some((result) => result.kind === "findConversations"))
          return fail("Use one conversation discovery page per decision.");
        results.push({ kind: action.kind, detail: { query: action.query, cursor: action.cursor } });
      } else if (action.kind === "readConversation") {
        const chat = await findChat(ctx, action.chatId);
        if (!chat || !chat.orchestratorIds.includes(claim.orchestrator.id))
          return fail("The orchestrator is not a member of that conversation.");
        const fromSequence = await conversationRetrievalBoundary(
          ctx,
          claim.orchestrator,
          chat,
          claim.chat,
        );
        if (fromSequence === null)
          return fail("Private conversation context cannot be shared with this audience.");
        if (
          action.beforeSequence !== undefined &&
          (!Number.isSafeInteger(action.beforeSequence) || action.beforeSequence < 0)
        )
          return fail("Choose a valid message sequence for pagination.");
        results.push({
          kind: action.kind,
          detail: { chatId: chat.id, beforeSequence: action.beforeSequence },
        });
      } else if (action.kind === "message") {
        if (
          action.targetId === claim.orchestrator.id ||
          !claim.chat.orchestratorIds.includes(action.targetId) ||
          !action.text.trim() ||
          action.text.length > 16000
        )
          return fail("Choose another orchestrator in this conversation and a short message.");
        if ((claim.job.chainDepth ?? 0) >= 8)
          return fail(
            "The orchestrators need a new user instruction before continuing this exchange.",
          );
        const target = await findOrchestrator(ctx, action.targetId);
        if (
          !target ||
          target.status === "deleted" ||
          !canDirectOrchestrator(target, claim.chat.ownerSubject)
        )
          return fail("This conversation no longer has permission to direct that orchestrator.");
        const messageId = mintDomainId(Date.now());
        const chat = await findChat(ctx, claim.chat.id);
        const queuedTarget = await ctx.db
          .query("aiOrchestratorJobs")
          .withIndex("by_orchestrator_chat_status", (q) =>
            q.eq("orchestratorId", target.id).eq("chatId", claim.chat.id).eq("status", "queued"),
          )
          .first();
        await appendChatMessage(
          ctx,
          chat!,
          {
            id: messageId,
            senderKind: "orchestrator",
            senderId: claim.orchestrator.id,
            senderName: claim.orchestrator.name,
            text: action.text,
            coordination: true,
            mentions: [...(result.mentions ?? [])],
            expression: normalizeAvatarExpression(result.expression),
            status: queuedTarget ? "sent" : "queued",
            replyToId: claim.message.id,
          },
          {
            urgent: result.attention === "urgent",
            enabled:
              result.attention !== "none" &&
              (result.attention !== "urgent" || claim.orchestrator.notifyUrgent),
          },
        );
        sentMessages.push({ id: messageId, text: action.text.trim() });
        if (queuedTarget) continue;
        await ctx.db.insert("aiOrchestratorJobs", {
          id: mintDomainId(Date.now()),
          orchestratorId: target.id,
          chatId: claim.chat.id,
          messageId,
          companyId: target.companyId ?? claim.job.companyId,
          status: "queued",
          environmentId: null,
          generation: 0,
          leaseExpiresAt: 0,
          modelIndex: 0,
          error: "",
          chainDepth: (claim.job.chainDepth ?? 0) + 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    if (result.message.trim()) {
      const chat = await findChat(ctx, claim.chat.id);
      const sameMessage = sentMessages.find((message) => message.text === result.message.trim());
      const replyId = sameMessage?.id ?? mintDomainId(Date.now());
      if (!sameMessage)
        await appendChatMessage(
          ctx,
          chat!,
          {
            id: replyId,
            senderKind: "orchestrator",
            senderId: claim.orchestrator.id,
            senderName: claim.orchestrator.name,
            text: result.message.trim(),
            mentions: [...(result.mentions ?? [])],
            expression: normalizeAvatarExpression(result.expression),
            status: "sent",
            replyToId: claim.message.id,
          },
          {
            urgent: result.attention === "urgent",
            enabled:
              result.attention !== "none" &&
              (result.attention !== "urgent" || claim.orchestrator.notifyUrgent),
          },
        );
    }
    if (result.summary.trim())
      await ctx.db.patch(claim.chat._id, {
        summary: result.summary,
        summaryThroughSequence: claim.job.contextThroughSequence ?? 0,
      });
    await refreshOrchestratorWork(ctx, claim.orchestrator);
    const continueReasoning =
      (queuedInspection ||
        results.some((result) =>
          [
            "readConversation",
            "findConversations",
            "collaborate",
            "allocateAllowance",
            "stopWork",
            "redirectWork",
          ].includes(result.kind),
        )) &&
      (claim.job.attempts ?? 0) < 12;
    await ctx.db.patch(claim.job._id, {
      status: continueReasoning ? "queued" : "completed",
      contextResults: JSON.stringify(results),
      inspectionIds,
      ...(queuedInspection ? { notBefore: Date.now() + INSPECTION_TIMEOUT_MS } : {}),
      leaseExpiresAt: 0,
      updatedAt: Date.now(),
    });
    const recipients = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_message", (q) => q.eq("messageId", claim.message.id))
      .take(20);
    await ctx.db.patch(claim.message._id, {
      status: recipients.some((job) => job.status === "running")
        ? "working"
        : recipients.some((job) => job.status === "queued")
          ? "queued"
          : "sent",
    });
    return true;
  },
});

export const pendingInspections = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const rows = await ctx.db
      .query("aiOrchestratorInspections")
      .withIndex("by_environment_status", (q) =>
        q
          .eq("companyId", args.companyId)
          .eq("environmentId", actor.registration.environmentId)
          .eq("status", "pending")
          .gt("createdAt", Date.now() - INSPECTION_TIMEOUT_MS),
      )
      .take(12);
    const results = [];
    for (const row of rows) {
      if (row.createdAt + INSPECTION_TIMEOUT_MS <= Date.now()) continue;
      const job = await ctx.db
        .query("aiOrchestratorJobs")
        .withIndex("by_domain_id", (q) => q.eq("id", row.jobId))
        .unique();
      if (!job || job.status !== "queued" || !job.selection) continue;
      try {
        const target = await inspectionTarget(ctx, job, row);
        results.push({
          id: row.id,
          chatId: job.chatId,
          localProjectId: target.localProjectId,
          request: target.request,
          selection: job.selection,
        });
      } catch {
        continue;
      }
    }
    return results;
  },
});

export const collectInspection = mutation({
  args: { companyId: v.string(), id: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const row = await ctx.db
      .query("aiOrchestratorInspections")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (
      !row ||
      row.companyId !== args.companyId ||
      row.environmentId !== actor.registration.environmentId ||
      row.status !== "pending"
    )
      return false;
    const job = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_domain_id", (q) => q.eq("id", row.jobId))
      .unique();
    if (!job || job.status !== "queued" || !job.inspectionIds?.includes(row.id)) return false;
    await inspectionTarget(ctx, job, row);
    if (!args.text.trim() || args.text.length > 16000)
      return fail("The inspection result must contain at most 16,000 characters.");
    await ctx.db.patch(row._id, { status: "completed", text: args.text });
    if (await inspectionContext(ctx, job))
      await ctx.db.patch(job._id, { notBefore: 0, updatedAt: Date.now() });
    return true;
  },
});

export const failRun = mutation({
  args: { ...identityArgs, error: v.string(), retryModel: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    const failedEnvironmentIds = [
      ...new Set([
        ...(claim.job.failedEnvironmentIds ?? []),
        claim.actor.registration.environmentId,
      ]),
    ];
    const registrations = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_state", (q) =>
        q.eq("companyId", claim.actor.company._id).eq("state", "active"),
      )
      .take(50);
    let anotherEnvironment = false;
    for (const registration of registrations)
      if (
        !failedEnvironmentIds.includes(registration.environmentId) &&
        (registration.lastSeenAt ?? 0) > Date.now() - LEASE_MS &&
        (await eligibleOrchestratorEnvironment(ctx, claim.orchestrator, registration))
      )
        anotherEnvironment = true;
    const nextModel = claim.job.modelIndex + 1;
    const retry =
      args.retryModel !== false &&
      (anotherEnvironment || nextModel < claim.orchestrator.models.length);
    await ctx.db.patch(claim.job._id, {
      status: retry ? "queued" : "failed",
      modelIndex: anotherEnvironment ? claim.job.modelIndex : nextModel,
      failedEnvironmentIds: anotherEnvironment ? failedEnvironmentIds : [],
      error: args.error.slice(0, 1000),
      leaseExpiresAt: 0,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(claim.message._id, { status: retry ? "queued" : "failed" });
    return true;
  },
});

export const pendingWorkResults = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const rows = await Promise.all(
      [false, undefined].flatMap((collected) =>
        terminalWorkStates.map((status) =>
          ctx.db
            .query("aiOrchestratorWork")
            .withIndex("by_environment_result", (q) =>
              q
                .eq("companyId", args.companyId)
                .eq("environmentId", actor.registration.environmentId)
                .eq("resultCollected", collected)
                .eq("status", status),
            )
            .take(32),
        ),
      ),
    );
    const reads = await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_environment_read", (q) =>
        q
          .eq("companyId", args.companyId)
          .eq("environmentId", actor.registration.environmentId)
          .eq("readRequested", true),
      )
      .take(32);
    const continuations = (
      await Promise.all(
        (["working", "unknown"] as const).map((status) =>
          ctx.db
            .query("aiOrchestratorWork")
            .withIndex("by_company_environment_status", (q) =>
              q
                .eq("companyId", args.companyId)
                .eq("environmentId", actor.registration.environmentId)
                .eq("status", status),
            )
            .take(32),
        ),
      )
    )
      .flat()
      .filter((work) => (work.continuation || work.resultRunId) && work.commandId);
    const pending = [];
    for (const work of [...reads, ...rows.flat(), ...continuations]) {
      if (!work.threadId) continue;
      const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
      if (
        orchestrator &&
        (await orchestratorCanReadWork(ctx, orchestrator, work, actor.registration))
      )
        pending.push({
          workId: work.id,
          threadId: work.threadId,
          ...(reads.includes(work) && work.readRequestId
            ? { readRequestId: work.readRequestId }
            : {}),
          ...(work.resultRunId ? { runId: work.resultRunId } : {}),
          ...(work.continuation && !work.controlMessageId && !reads.includes(work)
            ? { messageId: `${work.commandId}:message` }
            : {}),
        });
    }
    return pending;
  },
});

export const collectWorkResult = mutation({
  args: {
    messageId: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    ),
    readRequestId: v.optional(v.string()),
    companyId: v.string(),
    workId: v.string(),
    threadId: v.string(),
    runId: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const work = await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_domain_id", (q) => q.eq("id", args.workId))
      .unique();
    if (
      !work ||
      work.companyId !== args.companyId ||
      work.environmentId !== actor.registration.environmentId ||
      work.threadId !== args.threadId ||
      (!args.readRequestId &&
        ((!["completed", "failed", "cancelled"].includes(work.status) &&
          !(
            (work.continuation || work.resultRunId) &&
            ["working", "unknown"].includes(work.status)
          )) ||
          work.resultCollected))
    )
      return false;
    const orchestrator = await findOrchestrator(ctx, work.orchestratorId);
    if (
      !orchestrator ||
      !(await orchestratorCanReadWork(ctx, orchestrator, work, actor.registration))
    )
      return false;
    if (args.readRequestId) {
      if (!work.readRequested || work.readRequestId !== args.readRequestId) return false;
      const chat = await findChat(ctx, work.chatId);
      if (!chat || chat.archived || !chat.orchestratorIds.includes(orchestrator.id)) return false;
      const boundary = await sharedHistoryBoundary(ctx, chat, chat);
      if (
        boundary === null ||
        (work.sourceSequence ?? 0) < boundary ||
        !(await workVisibilityForConversation(ctx, chat)(work))
      )
        return false;
      if (!args.text.trim() || args.text.length > 16000)
        return fail("The thread excerpt is empty or too large.");
      await ctx.db.patch(work._id, {
        readRequested: false,
        readResult: args.text,
        ...(work.status === "completed" && !work.resultCollected
          ? { detail: "The delegated conversation was retrieved for the orchestrator." }
          : {}),
        updatedAt: Date.now(),
      });
      const now = Date.now();
      const messageId = mintDomainId(now);
      await appendChatMessage(ctx, chat, {
        id: messageId,
        senderKind: "system",
        senderId: "delegated-work",
        senderName: "Pathway",
        text: `Thread read returned for ${work.title}. Use the retrieved conversation to answer the pending request.`,
        status: "queued",
        replyToId: null,
      });
      await ctx.db.insert("aiOrchestratorJobs", {
        id: mintDomainId(now),
        orchestratorId: orchestrator.id,
        chatId: chat.id,
        messageId,
        companyId: args.companyId,
        status: "queued",
        environmentId: null,
        generation: 0,
        leaseExpiresAt: 0,
        modelIndex: 0,
        error: "",
        configRevision: orchestrator.revision,
        chatRevision: chat.revision ?? 0,
        contextResults: JSON.stringify([
          {
            kind: "readWork",
            detail: { workId: work.id, threadId: work.threadId, text: args.text },
          },
        ]),
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_company_and_environment_and_thread", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("environmentId", work.environmentId)
          .eq("threadId", args.threadId),
      )
      .unique();
    if (!thread) return false;
    const shell = decodeThreadShell(thread.shell);
    if (work.controlWorkId && work.controlMessageId) {
      const delivery = await ctx.db
        .query("aiOrchestratorWorkerMessages")
        .withIndex("by_work_id", (q) =>
          q.eq("workId", work.controlWorkId!).eq("id", work.controlMessageId!),
        )
        .unique();
      if (delivery?.state !== "delivered" || work.resultRunId !== args.runId) return false;
    } else if (work.continuation) {
      const command = await ctx.db
        .query("environmentCommands")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", work.commandId!),
        )
        .unique();
      if (args.messageId !== `${work.commandId}:message` || command?.state !== "succeeded")
        return false;
    } else if (work.resultRunId) {
      if (work.resultRunId !== args.runId) return false;
    } else if (
      shell.activeRunId !== null ||
      shell.latestRunId !== args.runId ||
      !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(shell.status)
    ) {
      return false;
    }
    if (!args.text.trim()) return false;
    if (args.text.length > ORCHESTRATOR_REPORT_LIMIT)
      return fail("The worker result is too large.");
    await ctx.db.patch(work._id, {
      status: args.status ?? "completed",
      resultCollected: true,
      readResult: undefined,
      resultText: args.text,
      resultRunId: args.runId,
      detail: "The delegated run finished and returned its findings.",
      completionNotified: false,
      updatedAt: Date.now(),
    });
    await notifyFinishedWork(ctx, orchestrator);
    return true;
  },
});

/** Worker credentials carry this origin across provider changes and descendant threads. */
export const workerAccess = query({
  args: {
    companyId: v.string(),
    orchestratorId: v.string(),
    commandId: v.string(),
    execution: v.optional(
      v.object({ threadId: v.string(), runId: v.string(), messageId: v.string() }),
    ),
    localProjectId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const denied = { allowed: false, capabilities: [] as string[] };
    const work = await assignmentForExecution(ctx, args, actor.registration.environmentId);
    if (!work || work.stopRequested) return denied;
    const command = await ctx.db
      .query("environmentCommands")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.commandId),
      )
      .unique();
    if (
      !command ||
      command.kind !== "startThread" ||
      command.orchestratorId !== args.orchestratorId ||
      command.targetEnvironmentId !== actor.registration.environmentId ||
      !["claimed", "succeeded"].includes(command.state) ||
      !(await orchestratorCommandAllowed(ctx, command, work))
    )
      return denied;
    const binding = command.cloudProjectId
      ? await ctx.db
          .query("environmentBindings")
          .withIndex("by_company_and_project", (q) =>
            q.eq("companyId", actor.company._id).eq("cloudProjectId", command.cloudProjectId!),
          )
          .collect()
      : [];
    if (
      command.cloudProjectId
        ? !binding.some(
            (b) =>
              b.status === "active" &&
              b.environmentId === actor.registration.environmentId &&
              b.localProjectId === args.localProjectId,
          )
        : args.localProjectId !== null
    )
      return denied;
    const orchestrator = await findOrchestrator(ctx, args.orchestratorId);
    if (!orchestrator) return denied;
    const scope = await orchestratorOwnerScope(ctx, orchestrator, args.companyId);
    const project = command.cloudProjectId ? await ctx.db.get(command.cloudProjectId) : null;
    if (!scope || (command.cloudProjectId && !project)) return denied;
    return {
      allowed: true,
      capabilities: orchestrator.capabilities.filter((capability) => {
        if (capability === "tasks.read")
          return hasRecordPermission(scope.permissions, "issues.read", project?.teamIds ?? []);
        if (capability === "tasks.manage")
          return ["issues.create", "issues.update", "issues.delete", "comments.create"].every(
            (permission) =>
              hasRecordPermission(
                scope.permissions,
                permission as
                  | "issues.create"
                  | "issues.update"
                  | "issues.delete"
                  | "comments.create",
                project?.teamIds ?? [],
              ),
          );
        return true;
      }),
    };
  },
});

/** Observations are host-owned and sampled only when reasoning work is actually claimed. */
export const reportHostResources = mutation({
  args: { companyId: v.string(), resources: v.any() },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const resources = decodeResources(args.resources);
    const age = Date.now() - resources.sampledAt;
    if (age < -5000 || age > 90000) return fail("A fresh host resource observation is required.");
    await ctx.db.patch(actor.registration._id, { orchestratorResources: resources });
  },
});

/** A receipt from the claiming environment after the reasoning scope has ended. */
export const confirmStopped = mutation({
  args: identityArgs,
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const job = await ctx.db
      .query("aiOrchestratorJobs")
      .withIndex("by_domain_id", (q) => q.eq("id", args.jobId))
      .unique();
    if (
      !job ||
      job.companyId !== args.companyId ||
      job.environmentId !== actor.registration.environmentId ||
      job.generation !== args.generation ||
      !job.stopRequested
    )
      return false;
    await ctx.db.patch(job._id, { stopConfirmed: true });
    const chat = await findChat(ctx, job.chatId);
    if (chat) await reconcileConversationLifecycle(ctx, chat);
    return true;
  },
});
