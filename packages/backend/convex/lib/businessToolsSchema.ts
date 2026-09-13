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
  title: v.optional(v.string()),
  description: v.string(),
  projectKey: v.string(),
  projectName: v.string(),
};
export const sessionWire = v.object({
  threadId: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  id: v.string(),
  ...sessionFields,
  startedAt: v.string(),
  stoppedAt: v.union(v.string(), v.null()),
  durationMs: v.number(),
  source: v.optional(v.union(v.literal("manual"), v.literal("agent"), v.literal("issue"))),
});
export const trackedInterval = v.object({ start: v.number(), end: v.number() });
export const trackedSource = v.union(v.literal("manual"), v.literal("agent"), v.literal("issue"));
export const trackedState = v.union(
  v.literal("running"),
  v.literal("paused"),
  v.literal("stopped"),
);
export const activitySessionWire = v.object({
  id: v.string(),
  ...sessionFields,
  startedAt: v.string(),
  stoppedAt: v.union(v.string(), v.null()),
  durationMs: v.number(),
  source: trackedSource,
  state: trackedState,
  threadId: v.union(v.string(), v.null()),
  issueId: v.union(v.string(), v.null()),
  intervals: v.array(trackedInterval),
  runningSince: v.union(v.number(), v.null()),
  observedAt: v.union(v.number(), v.null()),
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
    state: v.union(
      v.literal("running"),
      v.literal("paused"),
      v.literal("stopped"),
      v.literal("deleted"),
    ),
    source: v.optional(trackedSource),
    threadId: v.optional(v.string()),
    issueId: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),
    environmentId: v.optional(v.string()),
    localProjectId: v.optional(v.string()),
    intervals: v.optional(v.array(trackedInterval)),
    runningSince: v.optional(v.union(v.number(), v.null())),
    observedAt: v.optional(v.number()),
    revision: v.optional(v.number()),
    runStatus: v.optional(v.string()),
  })
    .index("by_user_and_id", ["userId", "id"])
    .index("by_company_environment_and_id", ["companyId", "environmentId", "id"])
    .index("by_user_and_state", ["userId", "state"])
    .index("by_user_state_source", ["userId", "state", "source"])
    .index("by_user_and_state_and_stopped_at", ["userId", "state", "stoppedAt"])
    .index("by_user_and_started_at", ["userId", "startedAt"]),
};
