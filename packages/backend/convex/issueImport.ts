// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock directly.
/**
 * Full-fidelity, empty-company issue import.
 *
 * Normal sync operations deliberately apply current-domain behavior: they stamp the mutation
 * clock, attribute writes to the caller, and synthesize audit events. Migration needs the inverse:
 * source rows are authoritative history. This surface therefore writes those rows directly, while
 * still using the ordinary encoders and feed writer so bootstrap and incremental replicas receive
 * exactly the same bytes.
 *
 * Abandonment is intentionally non-destructive. Partial rows and provenance remain in place; the
 * non-empty restart/cleanup policy belongs to the later migration slice.
 *
 * @module issueImport
 */
import { v, type Infer } from "convex/values";
import { isDefaultIssueStatusSet } from "@spiritdevs/contracts";

import { normalizeIssueKeyPrefix } from "../src/companies.ts";
import { measureSerializedBytes } from "../src/sync/changeFeed.ts";
import { SYNC_MAX_ID_CHARS } from "../src/sync/operations.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { action, internalQuery, mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import {
  appendCompanyChanges,
  encodeCloudProject,
  encodeEnvironmentBinding,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission, type EnvironmentActor } from "./lib/identity.ts";
import {
  encodeIssue,
  encodeIssueAttachment,
  encodeIssueAuditEvent,
  encodeIssueComment,
  encodeIssueCycle,
  encodeIssueLabel,
  encodeIssueMilestone,
  encodeIssueRelation,
  encodeIssueStatus,
  encodeIssueThreadLink,
  encodeIssueTodo,
  encodeIssueView,
} from "./lib/issueApply.ts";
import { domainIdArg, syncActorArg } from "./lib/validators.ts";

const IMPORT_MAX_ENTITIES_PER_BATCH = 25;
const IMPORT_MAX_BATCH_BYTES = 512 * 1024;
const IMPORT_LIST_DEFAULT_LIMIT = 50;
const IMPORT_LIST_MAX_LIMIT = 100;

const issuePriority = v.union(
  v.literal("none"),
  v.literal("urgent"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);
const issueAssignee = v.union(
  v.object({ kind: v.literal("user") }),
  v.object({ kind: v.literal("member"), membershipId: domainIdArg }),
  v.object({ kind: v.literal("agent"), provider: v.string() }),
);
const workflowOwner = v.union(
  v.object({ kind: v.literal("company") }),
  v.object({ kind: v.literal("team"), teamId: domainIdArg }),
);
const deletedAt = v.optional(v.union(v.number(), v.null()));

const cloudProjectEntity = v.object({
  entityKind: v.literal("cloudProject"),
  id: domainIdArg,
  name: v.string(),
  description: v.optional(v.string()),
  teamIds: v.optional(v.array(domainIdArg)),
  defaultWorkflowOwner: v.optional(v.union(workflowOwner, v.null())),
  preferredBindingId: v.optional(v.union(domainIdArg, v.null())),
  archivedAt: v.optional(v.union(v.number(), v.null())),
  createdAt: v.number(),
  updatedAt: v.number(),
  binding: v.object({
    id: domainIdArg,
    localProjectId: v.string(),
    localWorkspaceRoot: v.string(),
    lastSeenAt: v.optional(v.union(v.number(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
});

const issueEntity = v.object({
  entityKind: v.literal("issue"),
  id: domainIdArg,
  key: v.string(),
  keyNumber: v.number(),
  title: v.string(),
  description: v.string(),
  statusId: domainIdArg,
  priority: issuePriority,
  assignee: v.union(issueAssignee, v.null()),
  projectId: v.union(domainIdArg, v.null()),
  milestoneId: v.union(domainIdArg, v.null()),
  cycleId: v.union(domainIdArg, v.null()),
  parentId: v.union(domainIdArg, v.null()),
  sortOrder: v.string(),
  labelIds: v.array(domainIdArg),
  dueDate: v.union(v.string(), v.null()),
  triage: v.boolean(),
  slackSource: v.union(v.any(), v.null()),
  teamIds: v.array(domainIdArg),
  workflowOwner,
  workModelSelection: v.union(v.any(), v.null()),
  automationAssignment: v.union(v.any(), v.null()),
  pullRequest: v.union(v.any(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueStatusEntity = v.object({
  entityKind: v.literal("issueStatus"),
  id: domainIdArg,
  scope: v.union(v.literal("company"), v.literal("team")),
  teamId: v.union(domainIdArg, v.null()),
  baseStatusId: v.union(domainIdArg, v.null()),
  name: v.union(v.string(), v.null()),
  color: v.union(v.string(), v.null()),
  category: v.union(
    v.literal("backlog"),
    v.literal("unstarted"),
    v.literal("started"),
    v.literal("review"),
    v.literal("completed"),
    v.literal("canceled"),
    v.null(),
  ),
  position: v.union(v.number(), v.null()),
  hidden: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueLabelEntity = v.object({
  entityKind: v.literal("issueLabel"),
  id: domainIdArg,
  teamId: v.union(domainIdArg, v.null()),
  name: v.string(),
  color: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueMilestoneEntity = v.object({
  entityKind: v.literal("issueMilestone"),
  id: domainIdArg,
  cloudProjectId: domainIdArg,
  name: v.string(),
  description: v.union(v.string(), v.null()),
  startDate: v.union(v.string(), v.null()),
  targetDate: v.union(v.string(), v.null()),
  position: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueCycleEntity = v.object({
  entityKind: v.literal("issueCycle"),
  id: domainIdArg,
  teamId: v.union(domainIdArg, v.null()),
  name: v.string(),
  startDate: v.string(),
  endDate: v.string(),
  completedAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueTodoEntity = v.object({
  entityKind: v.literal("issueTodo"),
  id: domainIdArg,
  issueId: domainIdArg,
  text: v.string(),
  done: v.boolean(),
  sortOrder: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueRelationEntity = v.object({
  entityKind: v.literal("issueRelation"),
  id: domainIdArg,
  issueId: domainIdArg,
  relatedIssueId: domainIdArg,
  kind: v.union(v.literal("blocks"), v.literal("relates"), v.literal("duplicate")),
  createdAt: v.number(),
  deletedAt,
});

const issueCommentEntity = v.object({
  entityKind: v.literal("issueComment"),
  id: domainIdArg,
  issueId: domainIdArg,
  body: v.string(),
  author: v.union(syncActorArg, v.null()),
  attachmentIds: v.array(domainIdArg),
  mentions: v.array(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueAttachmentEntity = v.object({
  entityKind: v.literal("issueAttachment"),
  id: domainIdArg,
  issueId: domainIdArg,
  commentId: v.union(domainIdArg, v.null()),
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  checksum: v.string(),
  uploadedByMembershipId: v.union(domainIdArg, v.null()),
  state: v.union(v.literal("pending"), v.literal("finalized")),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueViewEntity = v.object({
  entityKind: v.literal("issueView"),
  id: domainIdArg,
  ownerMembershipId: v.union(domainIdArg, v.null()),
  visibility: v.union(v.literal("private"), v.literal("teams"), v.literal("company")),
  teamIds: v.array(domainIdArg),
  name: v.string(),
  config: v.any(),
  position: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt,
});

const issueAuditEventEntity = v.object({
  entityKind: v.literal("issueAuditEvent"),
  id: domainIdArg,
  issueId: domainIdArg,
  kind: v.string(),
  actor: syncActorArg,
  payload: v.any(),
  operationId: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

const issueThreadLinkEntity = v.object({
  entityKind: v.literal("issueThreadLink"),
  id: domainIdArg,
  issueId: domainIdArg,
  environmentId: v.string(),
  threadId: v.string(),
  origin: v.union(v.literal("start-work"), v.literal("manual"), v.literal("mention")),
  createdByMembershipId: v.union(domainIdArg, v.null()),
  createdAt: v.number(),
  deletedAt,
});

const importEntityArg = v.union(
  cloudProjectEntity,
  issueEntity,
  issueStatusEntity,
  issueLabelEntity,
  issueMilestoneEntity,
  issueCycleEntity,
  issueTodoEntity,
  issueRelationEntity,
  issueCommentEntity,
  issueAttachmentEntity,
  issueViewEntity,
  issueAuditEventEntity,
  issueThreadLinkEntity,
);
type ImportEntity = Infer<typeof importEntityArg>;
type ImportEntityKind = ImportEntity["entityKind"];

const progressResult = v.object({
  cloudProject: v.number(),
  issue: v.number(),
  issueStatus: v.number(),
  issueLabel: v.number(),
  issueMilestone: v.number(),
  issueCycle: v.number(),
  issueTodo: v.number(),
  issueRelation: v.number(),
  issueComment: v.number(),
  issueAttachment: v.number(),
  issueView: v.number(),
  issueAuditEvent: v.number(),
  issueThreadLink: v.number(),
});

const importRunResult = v.object({
  id: domainIdArg,
  companyId: domainIdArg,
  sourceEnvironmentId: v.string(),
  createdByMembershipId: domainIdArg,
  importingMembershipId: domainIdArg,
  selectedIssueKeyPrefix: v.string(),
  mode: v.literal("empty-company"),
  state: v.union(
    v.literal("created"),
    v.literal("applying"),
    v.literal("completed"),
    v.literal("abandoned"),
    v.literal("failed"),
  ),
  progress: progressResult,
  trackerApplied: v.boolean(),
  trackerNextIssueNumber: v.union(v.number(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.union(v.number(), v.null()),
  abandonedAt: v.union(v.number(), v.null()),
});

const entityOutcomeResult = v.union(
  v.object({
    entityKind: v.string(),
    entityId: domainIdArg,
    status: v.literal("applied"),
  }),
  v.object({
    entityKind: v.string(),
    entityId: domainIdArg,
    status: v.literal("alreadyApplied"),
  }),
  v.object({
    entityKind: v.string(),
    entityId: domainIdArg,
    status: v.literal("rejected"),
    code: v.string(),
    message: v.string(),
  }),
);
type EntityOutcome = Infer<typeof entityOutcomeResult>;

const applyBatchResult = v.object({
  outcomes: v.array(entityOutcomeResult),
  progress: progressResult,
  version: v.number(),
});

const expectedCountsArg = v.object({
  cloudProject: v.optional(v.number()),
  issue: v.number(),
  issueStatus: v.number(),
  issueLabel: v.number(),
  issueMilestone: v.number(),
  issueCycle: v.number(),
  issueTodo: v.number(),
  issueRelation: v.number(),
  issueComment: v.number(),
  issueAttachment: v.number(),
  issueView: v.number(),
  issueAuditEvent: v.number(),
  issueThreadLink: v.number(),
});

const EMPTY_PROGRESS: Doc<"issueImportRuns">["progress"] = {
  cloudProject: 0,
  issue: 0,
  issueStatus: 0,
  issueLabel: 0,
  issueMilestone: 0,
  issueCycle: 0,
  issueTodo: 0,
  issueRelation: 0,
  issueComment: 0,
  issueAttachment: 0,
  issueView: 0,
  issueAuditEvent: 0,
  issueThreadLink: 0,
};

const ISSUE_TABLES = [
  "issues",
  "issueStatuses",
  "issueLabels",
  "issueMilestones",
  "issueCycles",
  "issueTodos",
  "issueRelations",
  "issueComments",
  "issueAttachments",
  "issueViews",
  "issueAuditEvents",
  "issueThreadLinks",
] as const;

function nonEmptyTrimmed(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw backendError("invalid-arguments", `${label} must be a trimmed, non-empty string.`);
  }
  return value;
}

function isDomainId(value: string): boolean {
  return value.length > 0 && value.length <= SYNC_MAX_ID_CHARS && value.trim() === value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw backendError("invalid-arguments", `${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw backendError("invalid-arguments", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function boundedListLimit(value: number | undefined): number {
  const limit = value ?? IMPORT_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw backendError("invalid-arguments", "A list limit must be a positive integer.");
  }
  return Math.min(limit, IMPORT_LIST_MAX_LIMIT);
}

async function byDomain<
  TableName extends
    | (typeof ISSUE_TABLES)[number]
    | "cloudProjects"
    | "environmentBindings"
    | "memberships"
    | "teams",
>(
  ctx: QueryCtx,
  table: TableName,
  companyId: Id<"companies">,
  id: string,
): Promise<Doc<TableName> | null> {
  return ctx.db
    .query(table as unknown as "issues")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", id))
    .unique() as Promise<Doc<TableName> | null>;
}

async function liveByDomain<
  TableName extends (typeof ISSUE_TABLES)[number] | "cloudProjects" | "teams",
>(
  ctx: QueryCtx,
  table: TableName,
  companyId: Id<"companies">,
  id: string,
): Promise<Doc<TableName> | null> {
  const row = await byDomain(ctx, table, companyId, id);
  if (row === null) return null;
  return ((row as { deletedAt?: number | null }).deletedAt ?? null) === null ? row : null;
}

async function membershipByDomainId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  id: string | null,
): Promise<Id<"memberships"> | null> {
  if (id === null) return null;
  const row = await byDomain(ctx, "memberships", companyId, id);
  if (row === null) throw backendError("entity-not-found", `No membership ${id}.`);
  return row._id;
}

async function runById(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  runId: string,
): Promise<Doc<"issueImportRuns"> | null> {
  return await ctx.db
    .query("issueImportRuns")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", runId))
    .unique();
}

function isLiveRun(run: Doc<"issueImportRuns">): boolean {
  return run.state === "created" || run.state === "applying";
}

async function requireExecutingRun(
  ctx: QueryCtx,
  companyId: string,
  runId: string,
): Promise<{ actor: EnvironmentActor; run: Doc<"issueImportRuns"> }> {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "environment") {
    throw backendError("permission-denied", "Only the source environment may execute an import.");
  }
  const run = await runById(ctx, actor.company._id, runId);
  if (run === null) throw backendError("entity-not-found", `No issue import run ${runId}.`);
  if (run.sourceEnvironmentId !== actor.registration.environmentId) {
    throw backendError("permission-denied", "This import belongs to another environment.");
  }
  if (run.sourceRegistrationId !== actor.registration._id) {
    throw backendError("permission-denied", "This import belongs to another registration.");
  }
  if (!isLiveRun(run)) {
    throw backendError("invalid-import-state", `Import ${run.id} is ${run.state}.`);
  }
  return { actor, run };
}

async function readableRun(
  ctx: QueryCtx,
  companyId: string,
  runId: string,
): Promise<Doc<"issueImportRuns"> | null> {
  const actor = await requireCompanyActor(ctx, companyId);
  const run = await runById(ctx, actor.company._id, runId);
  if (run === null) return null;
  if (
    actor.kind === "environment" &&
    run.sourceEnvironmentId !== actor.registration.environmentId
  ) {
    throw backendError("permission-denied", "This import belongs to another environment.");
  }
  return run;
}

async function runResult(ctx: QueryCtx, run: Doc<"issueImportRuns">) {
  const creator = await ctx.db.get(run.createdByMembershipId);
  const importer = await ctx.db.get(run.importingMembershipId);
  if (creator === null || importer === null) {
    throw backendError("entity-not-found", "An import membership is missing.");
  }
  return {
    id: run.id,
    companyId: (await ctx.db.get(run.companyId))?.id ?? "",
    sourceEnvironmentId: run.sourceEnvironmentId,
    createdByMembershipId: creator.id,
    importingMembershipId: importer.id,
    selectedIssueKeyPrefix: run.selectedIssueKeyPrefix,
    mode: run.mode,
    state: run.state,
    progress: run.progress,
    trackerApplied: run.trackerApplied,
    trackerNextIssueNumber: run.trackerNextIssueNumber,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    abandonedAt: run.abandonedAt,
  };
}

async function replaceableDefaultStatuses(
  ctx: QueryCtx,
  companyId: Id<"companies">,
): Promise<readonly Doc<"issueStatuses">[] | null> {
  for (const table of ISSUE_TABLES) {
    if (table === "issueStatuses") continue;
    const row = await ctx.db
      .query(table as unknown as "issues")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId))
      .first();
    if (row !== null) return null;
  }
  const statuses = await ctx.db
    .query("issueStatuses")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId))
    .collect();
  if (statuses.length === 0) return [];
  return isDefaultIssueStatusSet(statuses) ? statuses : null;
}

async function provenance(
  ctx: QueryCtx,
  runId: Id<"issueImportRuns">,
  kind: string,
  entityId: string,
): Promise<Doc<"issueImportEntities"> | null> {
  return await ctx.db
    .query("issueImportEntities")
    .withIndex("by_run_kind_and_entity", (q) =>
      q.eq("runId", runId).eq("entityKind", kind).eq("entityId", entityId),
    )
    .unique();
}

interface AppliedEntity {
  readonly status: "applied";
  readonly change: CompanyChange;
  readonly extraLedgerEntityId?: string;
}
interface RejectedEntity {
  readonly status: "rejected";
  readonly code: string;
  readonly message: string;
}
type ApplyOneResult = AppliedEntity | RejectedEntity;

function reject(code: string, message: string): RejectedEntity {
  return { status: "rejected", code, message };
}

function withoutEntityKind<T extends { readonly entityKind: string }>(
  entity: T,
): Omit<T, "entityKind"> {
  const { entityKind: _entityKind, ...row } = entity;
  return row;
}

async function requireReferences(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  entity: ImportEntity,
): Promise<RejectedEntity | null> {
  const missing = (kind: string, id: string) =>
    reject("missing-reference", `Missing ${kind} ${id}.`);
  const team = async (id: string | null) =>
    id === null || (await liveByDomain(ctx, "teams", companyId, id)) !== null
      ? null
      : missing("team", id);
  const issue = async (id: string) =>
    (await byDomain(ctx, "issues", companyId, id)) === null ? missing("issue", id) : null;

  switch (entity.entityKind) {
    case "cloudProject": {
      for (const teamId of entity.teamIds ?? []) {
        const result = await team(teamId);
        if (result !== null) return result;
      }
      if (entity.defaultWorkflowOwner?.kind === "team")
        return await team(entity.defaultWorkflowOwner.teamId);
      return null;
    }
    case "issueStatus": {
      const teamResult = await team(entity.teamId);
      if (teamResult !== null) return teamResult;
      if (
        entity.baseStatusId !== null &&
        (await liveByDomain(ctx, "issueStatuses", companyId, entity.baseStatusId)) === null
      )
        return missing("base status", entity.baseStatusId);
      return null;
    }
    case "issueLabel":
    case "issueCycle":
      return await team(entity.teamId);
    case "issueMilestone":
      return (await liveByDomain(ctx, "cloudProjects", companyId, entity.cloudProjectId)) === null
        ? missing("cloud project", entity.cloudProjectId)
        : null;
    case "issue": {
      if (
        entity.statusId !== "" &&
        (await liveByDomain(ctx, "issueStatuses", companyId, entity.statusId)) === null
      )
        return missing("status", entity.statusId);
      if (
        entity.projectId !== null &&
        (await liveByDomain(ctx, "cloudProjects", companyId, entity.projectId)) === null
      )
        return missing("cloud project", entity.projectId);
      if (
        entity.milestoneId !== null &&
        (await liveByDomain(ctx, "issueMilestones", companyId, entity.milestoneId)) === null
      )
        return missing("milestone", entity.milestoneId);
      if (
        entity.cycleId !== null &&
        (await liveByDomain(ctx, "issueCycles", companyId, entity.cycleId)) === null
      )
        return missing("cycle", entity.cycleId);
      if (
        entity.parentId !== null &&
        (await byDomain(ctx, "issues", companyId, entity.parentId)) === null
      )
        return missing("parent issue", entity.parentId);
      for (const labelId of entity.labelIds) {
        if ((await liveByDomain(ctx, "issueLabels", companyId, labelId)) === null)
          return missing("label", labelId);
      }
      for (const teamId of entity.teamIds) {
        const result = await team(teamId);
        if (result !== null) return result;
      }
      if (entity.workflowOwner.kind === "team") {
        const result = await team(entity.workflowOwner.teamId);
        if (result !== null) return result;
        if (!entity.teamIds.includes(entity.workflowOwner.teamId)) {
          return reject(
            "invalid-arguments",
            "A team workflow owner must be attached to the issue.",
          );
        }
      }
      return null;
    }
    case "issueTodo":
    case "issueComment":
    case "issueAttachment":
    case "issueAuditEvent":
    case "issueThreadLink":
      return await issue(entity.issueId);
    case "issueRelation": {
      const left = await issue(entity.issueId);
      return left ?? (await issue(entity.relatedIssueId));
    }
    case "issueView": {
      for (const teamId of entity.teamIds) {
        const result = await team(teamId);
        if (result !== null) return result;
      }
      return null;
    }
  }
}

async function issueTeams(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  issueId: string,
): Promise<readonly string[]> {
  return (await byDomain(ctx, "issues", companyId, issueId))?.teamIds ?? [];
}

function unionIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

async function applyOne(
  ctx: MutationCtx,
  company: Doc<"companies">,
  run: Doc<"issueImportRuns">,
  entity: ImportEntity,
): Promise<ApplyOneResult> {
  const references = await requireReferences(ctx, company._id, entity);
  if (references !== null) return references;
  const deleted = "deletedAt" in entity ? (entity.deletedAt ?? null) : null;
  const upsertOrTombstone = (
    input: Omit<CompanyChange, "changeKind" | "payload"> & { payload: unknown },
  ): CompanyChange => ({
    ...input,
    changeKind: deleted === null ? "upsert" : "tombstone",
    payload: deleted === null ? input.payload : null,
  });

  switch (entity.entityKind) {
    case "cloudProject": {
      if (!isDomainId(entity.binding.id)) {
        return reject("invalid-arguments", "A binding id must be a valid domain id.");
      }
      const project = await byDomain(ctx, "cloudProjects", company._id, entity.id);
      const binding = await byDomain(ctx, "environmentBindings", company._id, entity.binding.id);
      if (project !== null || binding !== null)
        return reject(
          "foreign-id-conflict",
          `Cloud project or binding ${entity.id} already exists.`,
        );
      const projectDocId = await ctx.db.insert("cloudProjects", {
        id: entity.id,
        companyId: company._id,
        name: nonEmptyTrimmed(entity.name, "A project name"),
        description: entity.description ?? "",
        teamIds: [...(entity.teamIds ?? [])],
        defaultWorkflowOwner: entity.defaultWorkflowOwner ?? null,
        preferredBindingId: entity.preferredBindingId ?? entity.binding.id,
        archivedAt: entity.archivedAt ?? null,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: null,
      });
      const projectRow = await ctx.db.get(projectDocId);
      if (projectRow === null) throw new Error("An imported project vanished.");
      await ctx.db.insert("environmentBindings", {
        id: entity.binding.id,
        companyId: company._id,
        cloudProjectId: projectDocId,
        environmentId: run.sourceEnvironmentId,
        localProjectId: nonEmptyTrimmed(entity.binding.localProjectId, "A local project id"),
        localWorkspaceRoot: nonEmptyTrimmed(entity.binding.localWorkspaceRoot, "A workspace root"),
        status: "pending",
        lastSeenAt: entity.binding.lastSeenAt ?? null,
        createdAt: entity.binding.createdAt,
        updatedAt: entity.binding.updatedAt,
      });
      return {
        status: "applied",
        extraLedgerEntityId: entity.binding.id,
        change: {
          entityKind: "cloudProject",
          entityId: entity.id,
          changeKind: "upsert",
          teamIds: projectRow.teamIds,
          versionDocId: projectDocId,
          payload: encodeCloudProject(projectRow),
        },
      };
    }
    case "issueStatus": {
      const docId = await ctx.db.insert("issueStatuses", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported status vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueStatus",
          entityId: row.id,
          teamIds: row.teamId === null ? [] : [row.teamId],
          versionDocId: docId,
          payload: encodeIssueStatus(company, row),
        }),
      };
    }
    case "issueLabel": {
      const docId = await ctx.db.insert("issueLabels", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported label vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueLabel",
          entityId: row.id,
          teamIds: row.teamId === null ? [] : [row.teamId],
          versionDocId: docId,
          payload: encodeIssueLabel(company, row),
        }),
      };
    }
    case "issueMilestone": {
      const docId = await ctx.db.insert("issueMilestones", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      const project = await byDomain(ctx, "cloudProjects", company._id, entity.cloudProjectId);
      if (row === null || project === null)
        throw new Error("An imported milestone dependency vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueMilestone",
          entityId: row.id,
          teamIds: project.teamIds,
          versionDocId: docId,
          payload: encodeIssueMilestone(company, row),
        }),
      };
    }
    case "issueCycle": {
      const docId = await ctx.db.insert("issueCycles", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported cycle vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueCycle",
          entityId: row.id,
          teamIds: row.teamId === null ? [] : [row.teamId],
          versionDocId: docId,
          payload: encodeIssueCycle(company, row),
        }),
      };
    }
    case "issue": {
      if (!Number.isSafeInteger(entity.keyNumber) || entity.keyNumber < 1) {
        return reject("invalid-arguments", "An issue key number must be a positive safe integer.");
      }
      if (entity.key !== `${run.selectedIssueKeyPrefix}-${entity.keyNumber}`) {
        return reject(
          "invalid-arguments",
          `Issue key ${entity.key} does not match selected prefix ${run.selectedIssueKeyPrefix} and key number ${entity.keyNumber}.`,
        );
      }
      const keyOwner = await ctx.db
        .query("issues")
        .withIndex("by_company_and_key", (q) =>
          q.eq("companyId", company._id).eq("key", entity.key),
        )
        .first();
      if (keyOwner !== null) {
        return reject("foreign-key-conflict", `Issue key ${entity.key} already exists.`);
      }
      const docId = await ctx.db.insert("issues", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        issueImportRunId: run._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported issue vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issue",
          entityId: row.id,
          teamIds: row.teamIds,
          versionDocId: docId,
          payload: encodeIssue(company, row),
        }),
      };
    }
    case "issueTodo": {
      const docId = await ctx.db.insert("issueTodos", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported todo vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueTodo",
          entityId: row.id,
          teamIds: await issueTeams(ctx, company._id, row.issueId),
          versionDocId: docId,
          payload: encodeIssueTodo(company, row),
        }),
      };
    }
    case "issueRelation": {
      const docId = await ctx.db.insert("issueRelations", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported relation vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueRelation",
          entityId: row.id,
          teamIds: unionIds(
            await issueTeams(ctx, company._id, row.issueId),
            await issueTeams(ctx, company._id, row.relatedIssueId),
          ),
          versionDocId: docId,
          payload: encodeIssueRelation(company, row),
        }),
      };
    }
    case "issueComment": {
      if (entity.author === null)
        return reject("invalid-arguments", "An imported comment needs its mapped author.");
      for (const attachmentId of entity.attachmentIds) {
        if ((await byDomain(ctx, "issueAttachments", company._id, attachmentId)) === null)
          return reject("missing-reference", `Missing attachment ${attachmentId}.`);
      }
      const docId = await ctx.db.insert("issueComments", {
        ...withoutEntityKind(entity),
        author: entity.author,
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported comment vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueComment",
          entityId: row.id,
          teamIds: await issueTeams(ctx, company._id, row.issueId),
          versionDocId: docId,
          payload: encodeIssueComment(company, row),
        }),
      };
    }
    case "issueAttachment": {
      if (entity.state !== "pending")
        return reject("invalid-arguments", "Imported attachment metadata must start pending.");
      if (!Number.isSafeInteger(entity.byteSize) || entity.byteSize < 0) {
        return reject(
          "invalid-arguments",
          "An imported attachment byte size must be a non-negative safe integer.",
        );
      }
      const uploader = await membershipByDomainId(ctx, company._id, entity.uploadedByMembershipId);
      const docId = await ctx.db.insert("issueAttachments", {
        ...withoutEntityKind(entity),
        uploadedByMembershipId: uploader,
        companyId: company._id,
        storageId: null,
        state: "pending",
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported attachment vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueAttachment",
          entityId: row.id,
          teamIds: await issueTeams(ctx, company._id, row.issueId),
          versionDocId: docId,
          payload: await encodeIssueAttachment(ctx, company, row),
        }),
      };
    }
    case "issueView": {
      if (entity.ownerMembershipId === null)
        return reject("invalid-arguments", "An imported view needs its mapped owner.");
      const owner = await membershipByDomainId(ctx, company._id, entity.ownerMembershipId);
      if (owner === null) throw new Error("A mapped view owner resolved to null.");
      const docId = await ctx.db.insert("issueViews", {
        ...withoutEntityKind(entity),
        ownerMembershipId: owner,
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported view vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueView",
          entityId: row.id,
          teamIds: row.visibility === "teams" ? row.teamIds : [],
          versionDocId: docId,
          payload: await encodeIssueView(ctx, company, row),
        }),
      };
    }
    case "issueAuditEvent": {
      const docId = await ctx.db.insert("issueAuditEvents", {
        ...withoutEntityKind(entity),
        companyId: company._id,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported audit event vanished.");
      return {
        status: "applied",
        change: {
          entityKind: "issueAuditEvent",
          entityId: row.id,
          changeKind: "upsert",
          teamIds: await issueTeams(ctx, company._id, row.issueId),
          versionDocId: docId,
          payload: encodeIssueAuditEvent(company, row),
        },
      };
    }
    case "issueThreadLink": {
      if (entity.environmentId !== run.sourceEnvironmentId)
        return reject("invalid-arguments", "A thread link must name the source environment.");
      const creator = await membershipByDomainId(ctx, company._id, entity.createdByMembershipId);
      const docId = await ctx.db.insert("issueThreadLinks", {
        ...withoutEntityKind(entity),
        createdByMembershipId: creator,
        companyId: company._id,
        deletedAt: entity.deletedAt ?? null,
        version: 0,
      });
      const row = await ctx.db.get(docId);
      if (row === null) throw new Error("An imported thread link vanished.");
      return {
        status: "applied",
        change: upsertOrTombstone({
          entityKind: "issueThreadLink",
          entityId: row.id,
          teamIds: await issueTeams(ctx, company._id, row.issueId),
          versionDocId: docId,
          payload: await encodeIssueThreadLink(ctx, company, row),
        }),
      };
    }
  }
}

async function existingEntity(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  entity: ImportEntity,
): Promise<boolean> {
  const table = {
    cloudProject: "cloudProjects",
    issue: "issues",
    issueStatus: "issueStatuses",
    issueLabel: "issueLabels",
    issueMilestone: "issueMilestones",
    issueCycle: "issueCycles",
    issueTodo: "issueTodos",
    issueRelation: "issueRelations",
    issueComment: "issueComments",
    issueAttachment: "issueAttachments",
    issueView: "issueViews",
    issueAuditEvent: "issueAuditEvents",
    issueThreadLink: "issueThreadLinks",
  } as const;
  return (await byDomain(ctx, table[entity.entityKind], companyId, entity.id)) !== null;
}

async function applyBatch(
  ctx: MutationCtx,
  args: { companyId: string; runId: string; entities: readonly ImportEntity[] },
) {
  const { actor, run } = await requireExecutingRun(ctx, args.companyId, args.runId);
  if (args.entities.length === 0)
    throw backendError("batch-empty", "An import batch must not be empty.");
  if (args.entities.length > IMPORT_MAX_ENTITIES_PER_BATCH)
    throw backendError(
      "batch-too-large",
      `At most ${IMPORT_MAX_ENTITIES_PER_BATCH} import entities may be sent at once.`,
    );
  if (measureSerializedBytes(args.entities) > IMPORT_MAX_BATCH_BYTES)
    throw backendError(
      "batch-args-too-large",
      `Import entities exceed ${IMPORT_MAX_BATCH_BYTES} bytes.`,
    );

  const outcomes: EntityOutcome[] = [];
  const changes: CompanyChange[] = [];
  const progress = { ...run.progress };
  const seen = new Set<string>();
  const now = Date.now();

  for (const entity of args.entities) {
    const key = `${entity.entityKind}\u0000${entity.id}`;
    if (!isDomainId(entity.id)) {
      outcomes.push({
        entityKind: entity.entityKind,
        entityId: entity.id,
        status: "rejected",
        code: "invalid-arguments",
        message: `An entity id must be trimmed, non-empty, and at most ${SYNC_MAX_ID_CHARS} characters.`,
      });
      continue;
    }
    if (seen.has(key)) {
      outcomes.push({
        entityKind: entity.entityKind,
        entityId: entity.id,
        status: "rejected",
        code: "batch-duplicate-entity",
        message: "The entity appears twice in this batch.",
      });
      continue;
    }
    seen.add(key);
    const appliedBefore = await provenance(ctx, run._id, entity.entityKind, entity.id);
    if (appliedBefore !== null) {
      outcomes.push({
        entityKind: entity.entityKind,
        entityId: entity.id,
        status: "alreadyApplied",
      });
      continue;
    }
    if (await existingEntity(ctx, actor.company._id, entity)) {
      outcomes.push({
        entityKind: entity.entityKind,
        entityId: entity.id,
        status: "rejected",
        code: "foreign-id-conflict",
        message: `Entity ${entity.id} already exists outside this run.`,
      });
      continue;
    }
    const result = await applyOne(ctx, actor.company, run, entity);
    if (result.status === "rejected") {
      outcomes.push({ entityKind: entity.entityKind, entityId: entity.id, ...result });
      continue;
    }
    await ctx.db.insert("issueImportEntities", {
      companyId: actor.company._id,
      runId: run._id,
      entityKind: entity.entityKind,
      entityId: entity.id,
      appliedAt: now,
    });
    if (result.extraLedgerEntityId !== undefined) {
      await ctx.db.insert("issueImportEntities", {
        companyId: actor.company._id,
        runId: run._id,
        entityKind: "environmentBinding",
        entityId: result.extraLedgerEntityId,
        appliedAt: now,
      });
    }
    progress[entity.entityKind] += 1;
    changes.push(result.change);
    outcomes.push({ entityKind: entity.entityKind, entityId: entity.id, status: "applied" });
  }

  if (changes.length > 0) {
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: { kind: "system", source: "import" },
      changes,
    });
  }
  await ctx.db.patch(run._id, {
    state: run.state === "created" ? "applying" : run.state,
    progress,
    updatedAt: now,
  });
  const company = await ctx.db.get(actor.company._id);
  if (company === null) throw new Error("The import company vanished.");
  return { outcomes, progress, version: company.syncVersion };
}

export const start = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    sourceEnvironmentId: v.string(),
    selectedIssueKeyPrefix: v.string(),
  },
  returns: importRunResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      throw backendError("permission-denied", "Only a company member may start an import.");
    requirePermission(actor, "company.manage");
    if (!isDomainId(args.id)) {
      throw backendError(
        "invalid-arguments",
        `An import run id must be trimmed, non-empty, and at most ${SYNC_MAX_ID_CHARS} characters.`,
      );
    }
    const sourceEnvironmentId = nonEmptyTrimmed(
      args.sourceEnvironmentId,
      "A source environment id",
    );
    const selectedIssueKeyPrefix = normalizeIssueKeyPrefix(args.selectedIssueKeyPrefix);
    if (selectedIssueKeyPrefix.length === 0)
      throw backendError("invalid-arguments", "An issue key prefix needs at least one character.");

    const existing = await runById(ctx, actor.company._id, args.id);
    if (existing !== null) {
      if (
        existing.sourceEnvironmentId !== sourceEnvironmentId ||
        existing.selectedIssueKeyPrefix !== selectedIssueKeyPrefix
      )
        throw backendError(
          "import-run-conflict",
          "That import run id already names a different import.",
        );
      return await runResult(ctx, existing);
    }
    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", sourceEnvironmentId),
      )
      .unique();
    if (registration === null || registration.state !== "active")
      throw backendError(
        "environment-not-registered",
        "The source environment needs an active company registration.",
      );
    for (const state of ["created", "applying"] as const) {
      const live = await ctx.db
        .query("issueImportRuns")
        .withIndex("by_company_and_state", (q) =>
          q.eq("companyId", actor.company._id).eq("state", state),
        )
        .first();
      if (live !== null)
        throw backendError(
          "import-already-running",
          `Import ${live.id} is already live for this company.`,
        );
    }
    const defaultStatuses = await replaceableDefaultStatuses(ctx, actor.company._id);
    if (defaultStatuses === null)
      throw backendError(
        "company-not-empty",
        "Empty-company import requires no issue data or workflow edits.",
      );
    if (defaultStatuses.length > 0) {
      for (const status of defaultStatuses) await ctx.db.delete(status._id);
      await appendCompanyChanges(ctx, {
        companyId: actor.company._id,
        actor: { kind: "member", membershipId: actor.membership.id },
        changes: defaultStatuses.map((status) => ({
          entityKind: "issueStatus" as const,
          entityId: status.id,
          changeKind: "tombstone" as const,
          versionDocId: null,
          payload: null,
        })),
      });
    }
    const now = Date.now();
    const id = await ctx.db.insert("issueImportRuns", {
      id: args.id,
      companyId: actor.company._id,
      sourceEnvironmentId,
      sourceRegistrationId: registration._id,
      createdByMembershipId: actor.membership._id,
      importingMembershipId: actor.membership._id,
      selectedIssueKeyPrefix,
      mode: "empty-company",
      state: "created",
      progress: EMPTY_PROGRESS,
      trackerApplied: false,
      trackerNextIssueNumber: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      abandonedAt: null,
    });
    const run = await ctx.db.get(id);
    if (run === null) throw new Error("The import run vanished.");
    return await runResult(ctx, run);
  },
});

export const get = query({
  args: { companyId: domainIdArg, runId: domainIdArg },
  returns: v.union(importRunResult, v.null()),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const run = await readableRun(ctx, args.companyId, args.runId);
    return run === null ? null : await runResult(ctx, run);
  },
});

export const list = query({
  args: { companyId: domainIdArg, limit: v.optional(v.number()) },
  returns: v.array(importRunResult),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    const rows = await ctx.db
      .query("issueImportRuns")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .order("desc")
      .take(boundedListLimit(args.limit));
    const visible =
      actor.kind === "member"
        ? rows
        : rows.filter((row) => row.sourceEnvironmentId === actor.registration.environmentId);
    return await Promise.all(visible.map((row) => runResult(ctx, row)));
  },
});

export const applyEntities = mutation({
  args: { companyId: domainIdArg, runId: domainIdArg, entities: v.array(importEntityArg) },
  returns: applyBatchResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    return await applyBatch(ctx, args);
  },
});

/** Convenience alias for the server executor's project/config stage. */
export const applyProjects = mutation({
  args: { companyId: domainIdArg, runId: domainIdArg, projects: v.array(cloudProjectEntity) },
  returns: applyBatchResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    return await applyBatch(ctx, {
      companyId: args.companyId,
      runId: args.runId,
      entities: args.projects,
    });
  },
});

export const applyTrackerConfig = mutation({
  args: {
    companyId: domainIdArg,
    runId: domainIdArg,
    issueKeyPrefix: v.string(),
    nextIssueNumber: v.number(),
  },
  returns: v.object({
    status: v.union(v.literal("applied"), v.literal("alreadyApplied")),
    issueKeyPrefix: v.string(),
    nextIssueNumber: v.number(),
  }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const { actor, run } = await requireExecutingRun(ctx, args.companyId, args.runId);
    const prefix = normalizeIssueKeyPrefix(args.issueKeyPrefix);
    if (prefix !== run.selectedIssueKeyPrefix)
      throw backendError("invalid-arguments", "Tracker config must use the run's selected prefix.");
    const next = positiveInteger(args.nextIssueNumber, "The next issue number");
    const company = await ctx.db.get(actor.company._id);
    if (company === null) throw new Error("The import company vanished.");
    if (run.trackerApplied) {
      if (run.trackerNextIssueNumber !== next || company.issueKeyPrefix !== prefix)
        throw backendError(
          "tracker-config-conflict",
          "Tracker config was already applied with different values.",
        );
      return {
        status: "alreadyApplied" as const,
        issueKeyPrefix: company.issueKeyPrefix,
        nextIssueNumber: company.nextIssueNumber,
      };
    }
    if (next < company.nextIssueNumber)
      throw backendError("counter-regression", "The issue counter may never move backwards.");
    const highestImportedIssue = await ctx.db
      .query("issues")
      .withIndex("by_company_import_run_and_key_number", (q) =>
        q.eq("companyId", company._id).eq("issueImportRunId", run._id),
      )
      .order("desc")
      .first();
    if (highestImportedIssue !== null && next <= highestImportedIssue.keyNumber) {
      throw backendError(
        "counter-regression",
        `The next issue number must be greater than preserved key ${highestImportedIssue.key}.`,
      );
    }
    if (company.issueKeyPrefix !== prefix) {
      const foreignIssue = await ctx.db
        .query("issues")
        .withIndex("by_company_and_import_run", (q) =>
          q.eq("companyId", company._id).eq("issueImportRunId", undefined),
        )
        .first();
      if (foreignIssue !== null)
        throw backendError(
          "prefix-change-blocked",
          "The issue key prefix cannot change while an issue outside this run exists.",
        );
    }
    const now = Date.now();
    await ctx.db.patch(company._id, {
      issueKeyPrefix: prefix,
      nextIssueNumber: next,
      updatedAt: now,
    });
    await ctx.db.patch(run._id, {
      trackerApplied: true,
      trackerNextIssueNumber: next,
      state: run.state === "created" ? "applying" : run.state,
      updatedAt: now,
    });
    await appendCompanyChanges(ctx, {
      companyId: company._id,
      actor: { kind: "system", source: "import" },
      changes: [],
      companyUpsert: true,
    });
    return { status: "applied" as const, issueKeyPrefix: prefix, nextIssueNumber: next };
  },
});

export const verifyAttachmentUpload = internalQuery({
  args: { companyId: domainIdArg, runId: domainIdArg, attachmentId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const { actor, run } = await requireExecutingRun(ctx, args.companyId, args.runId);
    if ((await provenance(ctx, run._id, "issueAttachment", args.attachmentId)) === null)
      throw backendError("entity-not-found", "The attachment is not part of this run.");
    const row = await byDomain(ctx, "issueAttachments", actor.company._id, args.attachmentId);
    if (row === null) throw backendError("entity-not-found", "The attachment row is missing.");
    return null;
  },
});

export const generateAttachmentUploadUrl = action({
  args: { companyId: domainIdArg, runId: domainIdArg, attachmentId: domainIdArg },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    await ctx.runQuery(internal.issueImport.verifyAttachmentUpload, args);
    return await ctx.storage.generateUploadUrl();
  },
});

export const finalizeAttachment = mutation({
  args: {
    companyId: domainIdArg,
    runId: domainIdArg,
    attachmentId: domainIdArg,
    storageId: v.id("_storage"),
    checksum: v.string(),
    byteSize: v.number(),
  },
  returns: v.object({ status: v.union(v.literal("finalized"), v.literal("alreadyFinalized")) }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const { actor, run } = await requireExecutingRun(ctx, args.companyId, args.runId);
    if ((await provenance(ctx, run._id, "issueAttachment", args.attachmentId)) === null)
      throw backendError("entity-not-found", "The attachment is not part of this run.");
    const row = await byDomain(ctx, "issueAttachments", actor.company._id, args.attachmentId);
    if (row === null) throw backendError("entity-not-found", "The attachment row is missing.");
    const checksum = nonEmptyTrimmed(args.checksum, "An attachment checksum");
    const byteSize = nonNegativeInteger(args.byteSize, "An attachment byte size");
    if (row.state === "finalized") {
      if (
        row.storageId !== args.storageId ||
        row.checksum !== checksum ||
        row.byteSize !== byteSize
      )
        throw backendError(
          "attachment-finalize-conflict",
          "The attachment was finalized with different storage metadata.",
        );
      return { status: "alreadyFinalized" as const };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      storageId: args.storageId,
      checksum,
      byteSize,
      state: "finalized",
    });
    const finalized = await ctx.db.get(row._id);
    if (finalized === null) throw new Error("The finalized attachment vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: { kind: "system", source: "import" },
      changes: [
        {
          entityKind: "issueAttachment",
          entityId: finalized.id,
          changeKind: "upsert",
          teamIds: await issueTeams(ctx, actor.company._id, finalized.issueId),
          versionDocId: finalized._id,
          payload: await encodeIssueAttachment(ctx, actor.company, finalized),
        },
      ],
    });
    await ctx.db.patch(run._id, {
      state: run.state === "created" ? "applying" : run.state,
      updatedAt: now,
    });
    return { status: "finalized" as const };
  },
});

export const complete = mutation({
  args: { companyId: domainIdArg, runId: domainIdArg, expectedCounts: expectedCountsArg },
  returns: importRunResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      throw backendError(
        "permission-denied",
        "Only the source environment may complete an import.",
      );
    const run = await runById(ctx, actor.company._id, args.runId);
    if (run === null) throw backendError("entity-not-found", `No issue import run ${args.runId}.`);
    if (
      run.sourceEnvironmentId !== actor.registration.environmentId ||
      run.sourceRegistrationId !== actor.registration._id
    )
      throw backendError("permission-denied", "This import belongs to another environment.");
    if (run.state === "completed") return await runResult(ctx, run);
    if (!isLiveRun(run))
      throw backendError("invalid-import-state", `Import ${run.id} is ${run.state}.`);
    for (const [kind, expected] of Object.entries(args.expectedCounts)) {
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
        throw backendError(
          "invalid-arguments",
          `Expected ${kind} count must be a non-negative safe integer.`,
        );
      }
      if (expected !== undefined && run.progress[kind as keyof typeof run.progress] !== expected)
        throw backendError(
          "import-count-mismatch",
          `Expected ${expected} ${kind} rows, applied ${run.progress[kind as keyof typeof run.progress]}.`,
        );
    }
    if (!run.trackerApplied)
      throw backendError(
        "tracker-config-missing",
        "Tracker config must be applied before completion.",
      );
    const pendingAttachment = await ctx.db
      .query("issueAttachments")
      .withIndex("by_company_and_state", (q) =>
        q.eq("companyId", actor.company._id).eq("state", "pending"),
      )
      .first();
    if (pendingAttachment !== null)
      throw backendError(
        "attachments-pending",
        `Attachment ${pendingAttachment.id} is not finalized.`,
      );
    const ledger = await ctx.db
      .query("issueImportEntities")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    const changes: CompanyChange[] = [];
    const now = Date.now();
    for (const entry of ledger) {
      if (entry.entityKind !== "environmentBinding") continue;
      const binding = await byDomain(ctx, "environmentBindings", actor.company._id, entry.entityId);
      if (binding === null)
        throw backendError("entity-not-found", `Import binding ${entry.entityId} is missing.`);
      if (binding.status === "pending")
        await ctx.db.patch(binding._id, { status: "active", updatedAt: now });
      const active = await ctx.db.get(binding._id);
      if (active === null || active.status !== "active")
        throw backendError("invalid-import-state", `Binding ${entry.entityId} did not activate.`);
      changes.push({
        entityKind: "environmentBinding",
        entityId: active.id,
        changeKind: "upsert",
        versionDocId: active._id,
        payload: await encodeEnvironmentBinding(ctx, active),
      });
    }
    if (changes.length > 0)
      await appendCompanyChanges(ctx, {
        companyId: actor.company._id,
        actor: { kind: "system", source: "import" },
        changes,
      });
    await ctx.db.patch(run._id, { state: "completed", updatedAt: now, completedAt: now });
    const completed = await ctx.db.get(run._id);
    if (completed === null) throw new Error("The completed import vanished.");
    return await runResult(ctx, completed);
  },
});

export const abandon = mutation({
  args: { companyId: domainIdArg, runId: domainIdArg },
  returns: importRunResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    const run = await runById(ctx, actor.company._id, args.runId);
    if (run === null) throw backendError("entity-not-found", `No issue import run ${args.runId}.`);
    if (
      actor.kind === "environment" &&
      (run.sourceEnvironmentId !== actor.registration.environmentId ||
        run.sourceRegistrationId !== actor.registration._id)
    )
      throw backendError("permission-denied", "This import belongs to another environment.");
    if (actor.kind === "member") requirePermission(actor, "company.manage");
    if (run.state === "abandoned") return await runResult(ctx, run);
    if (run.state === "completed")
      throw backendError("invalid-import-state", "A completed import cannot be abandoned.");
    const now = Date.now();
    await ctx.db.patch(run._id, { state: "abandoned", updatedAt: now, abandonedAt: now });
    const abandoned = await ctx.db.get(run._id);
    if (abandoned === null) throw new Error("The abandoned import vanished.");
    return await runResult(ctx, abandoned);
  },
});

export { IMPORT_MAX_BATCH_BYTES, IMPORT_MAX_ENTITIES_PER_BATCH };
