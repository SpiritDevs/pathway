import { defineTable } from "convex/server";
import { v } from "convex/values";
export const assetContext = v.object({
  kind: v.union(v.literal("thread"), v.literal("task")),
  id: v.string(),
  environmentId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  title: v.optional(v.string()),
});
export const assetTables = {
  assetThreadCounts: defineTable({
    companyId: v.id("companies"),
    threadId: v.string(),
    environmentId: v.string(),
    count: v.number(),
  })
    .index("by_company", ["companyId"])
    .index("by_thread", ["companyId", "environmentId", "threadId"]),
  assetLegacyAliases: defineTable({
    companyId: v.id("companies"),
    source: v.union(v.literal("tasks"), v.literal("queue")),
    legacyId: v.string(),
    attachmentId: v.optional(v.string()),
    assetId: v.string(),
  })
    .index("by_source", ["companyId", "source", "legacyId"])
    .index("by_attachment", ["companyId", "source", "attachmentId"]),
  assets: defineTable({
    companyId: v.id("companies"),
    id: v.string(),
    requestId: v.string(),
    uploaderId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
    kind: v.string(),
    state: v.string(),
    previewState: v.string(),
    originalReady: v.boolean(),
    keepInLibrary: v.boolean(),
    contexts: v.array(assetContext),
    processingEnvironmentId: v.optional(v.string()),
    processingLease: v.optional(v.string()),
    processingExpiresAt: v.optional(v.number()),
    key: v.optional(v.string()),
    uploadUrl: v.optional(v.string()),
    uploadExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    trashedAt: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
  })
    .index("by_company", ["companyId"])
    .index("by_name", ["companyId", "name"])
    .index("by_size", ["companyId", "byteSize"])
    .index("by_identity", ["companyId", "id"])
    .index("by_request", ["companyId", "uploaderId", "requestId"])
    .index("by_state", ["state"])
    .index("by_processing", ["companyId", "state", "processingLease"]),
  assetRepresentations: defineTable({
    companyId: v.id("companies"),
    assetId: v.string(),
    kind: v.union(v.literal("preview"), v.literal("poster")),
    name: v.optional(v.string()),
    lease: v.string(),
    key: v.optional(v.string()),
    uploadUrl: v.optional(v.string()),
    byteSize: v.number(),
    checksum: v.string(),
    mimeType: v.string(),
    state: v.union(v.literal("uploading"), v.literal("ready"), v.literal("failed")),
    cleaned: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_asset", ["companyId", "assetId"]),
  assetQuotas: defineTable({
    companyId: v.id("companies"),
    usedBytes: v.number(),
    reservedBytes: v.number(),
    maxBytes: v.number(),
    maxFileBytes: v.number(),
  }).index("by_company", ["companyId"]),
  assetGrants: defineTable({
    companyId: v.id("companies"),
    assetId: v.string(),
    token: v.string(),
    kind: v.union(v.literal("read"), v.literal("share")),
    context: v.optional(assetContext),
    representationId: v.optional(v.id("assetRepresentations")),
    lease: v.optional(v.string()),
    membershipId: v.optional(v.id("memberships")),
    environmentId: v.optional(v.string()),
    expiresAt: v.number(),
    revokedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_asset", ["companyId", "assetId"]),
};
