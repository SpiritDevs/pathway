/** Cloud-owned coordinator state; private data stays out of company change feeds. */
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { mailSelection } from "./mailSchema.ts";

export const orchestratorAttachment = v.object({
  id: v.string(),
  type: v.union(v.literal("image"), v.literal("file")),
  name: v.string(),
  mimeType: v.string(),
  sizeBytes: v.number(),
});

export const orchestratorConfig = {
  name: v.string(),
  color: v.string(),
  persona: v.string(),
  instructions: v.string(),
  responsibilities: v.string(),
  reviewIntervalMinutes: v.optional(v.number()),
  kind: v.union(v.literal("personal"), v.literal("project"), v.literal("custom")),
  companyId: v.union(v.string(), v.null()),
  projectId: v.union(v.string(), v.null()),
  shared: v.boolean(),
  models: v.array(
    v.object({ id: v.string(), environmentId: v.string(), selection: mailSelection }),
  ),
  workerModels: v.optional(
    v.array(
      v.object({
        id: v.string(),
        environmentId: v.string(),
        selection: mailSelection,
        name: v.string(),
        guidance: v.string(),
        cost: v.union(
          v.literal("unknown"),
          v.literal("lower"),
          v.literal("standard"),
          v.literal("higher"),
        ),
      }),
    ),
  ),
  environmentIds: v.array(v.string()),
  allEnvironments: v.boolean(),
  capabilities: v.array(v.string()),
  directorSubjects: v.array(v.string()),
  managerSubjects: v.array(v.string()),
  maxAssignments: v.number(),
  proactive: v.boolean(),
  rememberAutomatically: v.boolean(),
  notifyUrgent: v.boolean(),
  batchCompletions: v.boolean(),
};
export const orchestratorMemoryScope = v.union(
  v.literal("orchestrator"),
  v.literal("personal"),
  v.literal("project"),
);
export const aiOrchestratorTables = {
  aiOrchestratorPush: defineTable({
    chatId: v.string(),
    subject: v.string(),
    sequence: v.number(),
    generation: v.number(),
    dueAt: v.number(),
  })
    .index("by_chat_subject", ["chatId", "subject"])
    .index("by_due", ["dueAt"]),
  aiOrchestrators: defineTable({
    ...orchestratorConfig,
    id: v.string(),
    ownerSubject: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("archived"),
      v.literal("deleted"),
    ),
    revision: v.number(),
    nextReviewAt: v.optional(v.number()),
    workStoppedBefore: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_review_due", ["nextReviewAt"])
    .index("by_owner", ["ownerSubject"])
    .index("by_owner_kind", ["ownerSubject", "kind"])
    .index("by_company_project", ["companyId", "projectId"])
    .index("by_company", ["companyId", "shared"]),
  aiOrchestratorChats: defineTable({
    id: v.string(),
    title: v.string(),
    kind: v.union(v.literal("dm"), v.literal("group")),
    ownerSubject: v.string(),
    orchestratorIds: v.array(v.string()),
    orchestratorHistory: v.optional(
      v.array(v.object({ orchestratorId: v.string(), fromSequence: v.number() })),
    ),
    revision: v.optional(v.number()),
    leadId: v.string(),
    participantSubjects: v.array(v.string()),
    companyIds: v.array(v.string()),
    archived: v.boolean(),
    lastSequence: v.number(),
    lastMessage: v.string(),
    notification: v.optional(
      v.object({
        sequence: v.number(),
        senderName: v.string(),
        text: v.string(),
        urgent: v.boolean(),
        enabled: v.boolean(),
        createdAt: v.number(),
      }),
    ),
    summary: v.string(),
    summaryThroughSequence: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_owner", ["ownerSubject"])
    .index("by_direct_contact", ["leadId", "ownerSubject", "kind", "archived"]),
  aiOrchestratorChatMembers: defineTable({
    chatId: v.string(),
    subject: v.string(),
    fromSequence: v.number(),
    readSequence: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subject", ["subject", "updatedAt"])
    .index("by_chat_subject", ["chatId", "subject"]),
  aiOrchestratorAttachments: defineTable({
    id: v.string(),
    chatId: v.string(),
    ownerSubject: v.string(),
    attachment: orchestratorAttachment,
    storageId: v.optional(v.id("_storage")),
    messageId: v.optional(v.string()),
    sequence: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_storage", ["storageId"])
    .index("by_expiry", ["expiresAt"]),
  aiOrchestratorMessages: defineTable({
    attachments: v.optional(v.array(orchestratorAttachment)),
    id: v.string(),
    chatId: v.string(),
    sequence: v.number(),
    senderKind: v.union(v.literal("user"), v.literal("orchestrator"), v.literal("system")),
    senderId: v.string(),
    senderName: v.string(),
    text: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("working"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    seenAt: v.optional(v.number()),
    replyToId: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_chat_sequence", ["chatId", "sequence"]),
  aiOrchestratorMemory: defineTable({
    id: v.string(),
    orchestratorId: v.string(),
    ownerSubject: v.string(),
    text: v.string(),
    scope: orchestratorMemoryScope,
    source: v.string(),
    explicit: v.boolean(),
    forgotten: v.boolean(),
    sourceChatId: v.optional(v.string()),
    sourceSequence: v.optional(v.number()),
    sharedCompanyId: v.optional(v.string()),
    sharedProjectId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_orchestrator", ["orchestratorId"])
    .index("by_orchestrator_forgotten", ["orchestratorId", "forgotten", "updatedAt"])
    .index("by_owner_scope", ["ownerSubject", "scope"])
    .index("by_owner_scope_forgotten", ["ownerSubject", "scope", "forgotten", "updatedAt"]),
  aiOrchestratorJobs: defineTable({
    id: v.string(),
    orchestratorId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    companyId: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    environmentId: v.union(v.string(), v.null()),
    generation: v.number(),
    leaseExpiresAt: v.number(),
    modelIndex: v.number(),
    configRevision: v.optional(v.number()),
    chatRevision: v.optional(v.number()),
    contextResults: v.optional(v.string()),
    chainDepth: v.optional(v.number()),
    attempts: v.optional(v.number()),
    notBefore: v.optional(v.number()),
    allowanceHold: v.optional(v.string()),
    mailMessageId: v.optional(v.string()),
    threadSignalId: v.optional(v.string()),
    issueSignalId: v.optional(v.string()),
    environmentSignalId: v.optional(v.string()),
    responsibilityReview: v.optional(v.boolean()),
    failedEnvironmentIds: v.optional(v.array(v.string())),
    contextThroughSequence: v.optional(v.number()),
    error: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_company_status", ["companyId", "status", "createdAt"])
    .index("by_company_ready", ["companyId", "status", "notBefore"])
    .index("by_orchestrator_status", ["orchestratorId", "status"])
    .index("by_orchestrator_chat_status", ["orchestratorId", "chatId", "status", "createdAt"])
    .index("by_chat_status", ["chatId", "status"])
    .index("by_message", ["messageId"]),
  aiOrchestratorWork: defineTable({
    id: v.string(),
    chatId: v.string(),
    orchestratorId: v.string(),
    title: v.string(),
    environmentId: v.string(),
    projectId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
    status: v.union(
      v.literal("queued"),
      v.literal("working"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("unknown"),
    ),
    detail: v.string(),
    prompt: v.string(),
    commandId: v.optional(v.string()),
    selection: v.optional(v.union(mailSelection, v.null())),
    selectionReason: v.optional(v.string()),
    selectionExplicit: v.optional(v.boolean()),
    companyId: v.optional(v.string()),
    completionNotified: v.optional(v.boolean()),
    sourceSequence: v.optional(v.number()),
    readRequested: v.optional(v.boolean()),
    readRequestId: v.optional(v.string()),
    readResult: v.optional(v.string()),
    resultRequired: v.optional(v.boolean()),
    resultCollected: v.optional(v.boolean()),
    resultText: v.optional(v.string()),
    resultRunId: v.optional(v.string()),
    stopRequested: v.optional(v.boolean()),
    interruptCommandId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_company_environment_status", ["companyId", "environmentId", "status"])
    .index("by_chat", ["chatId"])
    .index("by_command", ["commandId"])
    .index("by_company_status", ["companyId", "status"])
    .index("by_environment_read", ["companyId", "environmentId", "readRequested"])
    .index("by_environment_result", ["companyId", "environmentId", "resultCollected", "status"])
    .index("by_company_notification", ["companyId", "completionNotified", "status"])
    .index("by_orchestrator_notification", ["orchestratorId", "completionNotified", "status"])
    .index("by_orchestrator_status", ["orchestratorId", "status"]),
};
