/** Convex storage mirror of contracts/businessTools; ownership and tombstones stay storage-only. */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const contactFields = {
  name: v.string(),
  role: v.string(),
  company: v.string(),
  email: v.string(),
  phone: v.string(),
  notes: v.string(),
  favorite: v.boolean(),
};
export const contactWire = v.object({
  id: v.string(),
  ...contactFields,
  createdAt: v.string(),
  revision: v.number(),
});
export const sessionFields = {
  description: v.string(),
  projectKey: v.string(),
  projectName: v.string(),
};
export const sessionWire = v.object({
  id: v.string(),
  ...sessionFields,
  startedAt: v.string(),
  stoppedAt: v.union(v.string(), v.null()),
  durationMs: v.number(),
});
export const businessToolsTables = {
  businessContacts: defineTable({
    id: v.string(),
    companyId: v.id("companies"),
    ...contactFields,
    createdAt: v.string(),
    revision: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    // The last request makes a lost-response update retry idempotent without replaying stale data.
    lastRequestId: v.string(),
    lastRequestUserId: v.id("users"),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_deleted", ["companyId", "deletedAt"])
    .index("by_company_and_id", ["companyId", "id"])
    .index("by_company_deleted_name", ["companyId", "deletedAt", "name"])
    .index("by_company_deleted_favorite_name", ["companyId", "deletedAt", "favorite", "name"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["companyId", "deletedAt", "favorite"],
    })
    .searchIndex("search_role", {
      searchField: "role",
      filterFields: ["companyId", "deletedAt", "favorite"],
    })
    .searchIndex("search_company", {
      searchField: "company",
      filterFields: ["companyId", "deletedAt", "favorite"],
    })
    .searchIndex("search_email", {
      searchField: "email",
      filterFields: ["companyId", "deletedAt", "favorite"],
    })
    .searchIndex("search_phone", {
      searchField: "phone",
      filterFields: ["companyId", "deletedAt", "favorite"],
    }),
  trackedSessions: defineTable({
    id: v.string(),
    userId: v.id("users"),
    ...sessionFields,
    startedAt: v.string(),
    stoppedAt: v.union(v.string(), v.null()),
    durationMs: v.number(),
    state: v.union(v.literal("running"), v.literal("stopped"), v.literal("deleted")),
  })
    .index("by_user_and_id", ["userId", "id"])
    .index("by_user_and_state", ["userId", "state"])
    .index("by_user_and_state_and_stopped_at", ["userId", "state", "stoppedAt"])
    .index("by_user_and_started_at", ["userId", "startedAt"]),
};
