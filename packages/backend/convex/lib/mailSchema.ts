/** Private connected mail storage. Kept outside company change feeds. */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const mailBucket = v.union(v.literal("priority"), v.literal("noise"));
export const mailSelection = v.object({
  instanceId: v.string(),
  model: v.string(),
  options: v.optional(
    v.array(v.object({ id: v.string(), value: v.union(v.string(), v.boolean()) })),
  ),
});
export const mailBrain = v.object({
  primaryEnvironmentId: v.string(),
  backupEnvironmentId: v.optional(v.string()),
  selection: mailSelection,
  backupSelection: v.optional(mailSelection),
});
export const mailAttachment = v.object({
  partId: v.string(),
  filename: v.string(),
  mimeType: v.string(),
  size: v.number(),
  blobKey: v.optional(v.string()),
});
export const mailIntakeMessage = v.object({
  providerMessageId: v.string(),
  providerThreadId: v.string(),
  historyId: v.optional(v.string()),
  from: v.object({ email: v.string(), name: v.optional(v.string()) }),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  subject: v.string(),
  snippet: v.string(),
  receivedAt: v.number(),
  labels: v.array(v.string()),
  textBody: v.optional(v.string()),
  bodyTruncated: v.optional(v.boolean()),
  htmlBody: v.optional(v.string()),
  rawBlobKey: v.optional(v.string()),
  bodyBlobKey: v.optional(v.string()),
  attachments: v.array(mailAttachment),
  deleted: v.optional(v.boolean()),
});
const scope = {
  companyId: v.id("companies"),
  ownerMembershipId: v.id("memberships"),
  ownerSubject: v.string(),
};
export const mailTables = {
  mailBlobCleanup: defineTable({
    id: v.string(),
    blobKey: v.string(),
    dueAt: v.number(),
    generation: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_domain_id", ["id"])
    .index("by_blob", ["blobKey"])
    .index("by_due", ["dueAt"]),
  mailAccountCleanup: defineTable({
    id: v.string(),
    accountId: v.string(),
    encryptedCredentials: v.string(),
    dueAt: v.number(),
    generation: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_domain_id", ["id"])
    .index("by_account", ["accountId"])
    .index("by_due", ["dueAt"]),
  mailLabelUpdates: defineTable({
    id: v.string(),
    accountId: v.string(),
    messageId: v.string(),
    providerMessageId: v.string(),
    read: v.boolean(),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("awaiting_sync")),
    generation: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_message", ["messageId"])
    .index("by_account", ["accountId"])
    .index("by_account_status", ["accountId", "status", "updatedAt"]),
  mailAccounts: defineTable({
    ...scope,
    id: v.string(),
    email: v.string(),
    credentialSource: v.union(v.literal("byo"), v.literal("hosted")),
    status: v.union(v.literal("active"), v.literal("reauth_required"), v.literal("disconnected")),
    brain: v.optional(mailBrain),
    primaryEnvironmentId: v.optional(v.string()),
    backupEnvironmentId: v.optional(v.string()),
    lastClaimAt: v.number(),
    lastAuthCheckAt: v.number(),
    cursor: v.optional(v.string()),
    continuation: v.optional(
      v.object({
        mode: v.union(v.literal("backfill"), v.literal("history")),
        pageToken: v.string(),
        baselineCursor: v.string(),
        messageOffset: v.optional(v.number()),
        deletedOffset: v.optional(v.number()),
      }),
    ),
    watchExpiresAt: v.optional(v.number()),
    nextSyncAt: v.number(),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    generation: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_owner", ["companyId", "ownerMembershipId"])
    .index("by_owner_email", ["companyId", "ownerMembershipId", "email"])
    .index("by_owner_status", ["companyId", "ownerMembershipId", "status"])
    .index("by_due", ["status", "nextSyncAt"])
    .index("by_email", ["email"])
    .index("by_auth_check", ["lastAuthCheckAt"])
    .index("by_primary", ["companyId", "primaryEnvironmentId", "lastClaimAt"])
    .index("by_backup", ["companyId", "backupEnvironmentId", "lastClaimAt"]),
  mailCredentials: defineTable({ accountId: v.string(), encryptedCredentials: v.string() }).index(
    "by_account",
    ["accountId"],
  ),
  mailOAuthStates: defineTable({
    stateHash: v.string(),
    encryptedState: v.string(),
    expiresAt: v.number(),
  })
    .index("by_hash", ["stateHash"])
    .index("by_expiry", ["expiresAt"]),
  mailMessages: defineTable({
    ...scope,
    id: v.string(),
    accountId: v.string(),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    historyId: v.optional(v.string()),
    from: v.object({ email: v.string(), name: v.optional(v.string()) }),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    subject: v.string(),
    snippet: v.string(),
    receivedAt: v.number(),
    labels: v.array(v.string()),
    attachments: v.array(mailAttachment),
    read: v.boolean(),
    bucket: mailBucket,
    reason: v.string(),
    analysisStatus: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    briefing: v.optional(v.string()),
    classificationRevision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_provider", ["accountId", "providerMessageId"])
    .index("by_owner_date", ["companyId", "ownerMembershipId", "receivedAt", "id"])
    .index("by_account_date", ["accountId", "receivedAt", "id"])
    .index("by_owner_bucket", ["companyId", "ownerMembershipId", "bucket", "receivedAt", "id"])
    .index("by_account_bucket", ["accountId", "bucket", "receivedAt", "id"])
    .index("by_thread", ["accountId", "providerThreadId", "receivedAt", "id"]),
  mailBodies: defineTable({
    accountId: v.string(),
    messageId: v.string(),
    textBody: v.optional(v.string()),
    bodyTruncated: v.optional(v.boolean()),
    htmlBody: v.optional(v.string()),
    rawBlobKey: v.optional(v.string()),
    bodyBlobKey: v.optional(v.string()),
  })
    .index("by_message", ["messageId"])
    .index("by_account", ["accountId"]),
  mailSenderRules: defineTable({
    ...scope,
    accountId: v.string(),
    email: v.string(),
    bucket: mailBucket,
    updatedAt: v.number(),
  })
    .index("by_sender", ["accountId", "email"])
    .index("by_account", ["accountId"]),
  mailSenderKnowledge: defineTable({
    ...scope,
    accountId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    summary: v.string(),
    messageCount: v.number(),
    lastMessageAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sender", ["accountId", "email"])
    .index("by_account", ["accountId"]),
  mailJobs: defineTable({
    ...scope,
    id: v.string(),
    accountId: v.string(),
    messageId: v.string(),
    kind: v.union(v.literal("analyze"), v.literal("brief"), v.literal("draft")),
    instructions: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    generation: v.number(),
    classificationRevision: v.number(),
    claimedByEnvironmentId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_company_status", ["companyId", "status", "createdAt"])
    .index("by_account", ["accountId"])
    .index("by_message", ["messageId"])
    .index("by_account_status", ["accountId", "status", "createdAt"])
    .index("by_account_status_kind", ["accountId", "status", "kind", "createdAt"])
    .index("by_claimant", ["companyId", "claimedByEnvironmentId", "status"]),
  mailDrafts: defineTable({
    ...scope,
    id: v.string(),
    accountId: v.string(),
    replyToMessageId: v.optional(v.string()),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("queued"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("unknown"),
    ),
    generation: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    providerMessageId: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_domain_id", ["id"])
    .index("by_account", ["accountId", "createdAt"])
    .index("by_outbox", ["accountId", "status", "createdAt"]),
};
