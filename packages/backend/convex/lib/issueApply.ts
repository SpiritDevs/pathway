// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * The issue-domain apply handlers behind `sync.applyOperations`, plus the row readers and payload
 * encoders `sync.bootstrap` shares with them.
 *
 * Every handler follows the same contract: decode the operation's arguments against the
 * hand-mirrored `src/sync/issueOps` shapes, check the acting permission against the record's team
 * scope, verify the domain invariants, write the authoritative rows, and return the change-feed
 * rows the batch should carry. Versions are assigned once for the whole batch by the caller, so a
 * handler never touches `syncChanges`, `syncOperationReceipts`, or the company head.
 *
 * Rejections are returned, never thrown: a refused operation receipts as refused while the rest of
 * its batch keeps going, which is what lets two independent offline edits fail independently.
 *
 * @module lib/issueApply
 */
import type { PermissionKey } from "../../src/permissions.ts";
import { hasRecordPermission } from "../../src/permissions.ts";
import type { BootstrapEntityKind } from "../../src/sync/bootstrap.ts";
import {
  auditEventDomainId,
  defaultIssueSortOrder,
  issueKeyNumber,
  orderKeyAfter,
  parseIssueCommentCreateArgs,
  parseIssueCommentPatchArgs,
  parseIssueCreateArgs,
  parseIssueCycleCreateArgs,
  parseIssueCyclePatchArgs,
  parseIssueLabelCreateArgs,
  parseIssueLabelPatchArgs,
  parseIssueMilestoneCreateArgs,
  parseIssueMilestonePatchArgs,
  parseIssuePatchArgs,
  parseIssueRelationCreateArgs,
  parseIssueSetSortOrderArgs,
  parseIssueSetTeamsArgs,
  parseIssueSetWorkflowOwnerArgs,
  parseIssueStatusCreateArgs,
  parseIssueStatusDeleteArgs,
  parseIssueStatusesReorderArgs,
  parseIssueStatusPatchArgs,
  parseIssueThreadLinkCreateArgs,
  parseIssueTodoCreateArgs,
  parseIssueTodoPatchArgs,
  parseIssueViewCreateArgs,
  parseIssueViewPatchArgs,
  parseNoArgs,
  type ArgsResult,
  type IssueWorkflowOwner,
} from "../../src/sync/issueOps.ts";
import type { SyncOperationEnvelope } from "../../src/sync/operations.ts";
import type { SyncOperationKind } from "../../src/sync/protocol.ts";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { DomainApply, DomainChange, DomainOutcome } from "../sync.ts";
import { actorRecord, type CompanyActor } from "./identity.ts";

type FeedActor = ReturnType<typeof actorRecord>;

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function rejected(
  code: "invalid-arguments" | "permission-denied" | "entity-not-found" | "entity-deleted",
  message: string,
): DomainOutcome {
  return { status: "rejected", code, message };
}

function applied(...changes: readonly DomainChange[]): DomainOutcome {
  return { status: "applied", changes };
}

function can(actor: CompanyActor, permission: PermissionKey, teamIds: readonly string[]): boolean {
  return hasRecordPermission(actor.permissions, permission, teamIds);
}

function denied(permission: PermissionKey): DomainOutcome {
  return rejected("permission-denied", `Missing permission ${permission}.`);
}

// ---------------------------------------------------------------------------
// Row lookup by domain id
// ---------------------------------------------------------------------------

function byDomain<TableName extends "teams" | "cloudProjects" | IssueDomainTable>(
  ctx: QueryCtx,
  table: TableName,
  companyId: Id<"companies">,
  domainId: string,
): Promise<Doc<TableName> | null> {
  // Cast through one representative table: every table this generic admits declares the same
  // `by_company_and_domain_id` index over the same field types, but `withIndex` cannot distribute
  // over a union of table names, so the builder is typed against `issues` and the result restored.
  return ctx.db
    .query(table as unknown as "issues")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", domainId))
    .unique() as Promise<Doc<TableName> | null>;
}

type IssueDomainTable =
  | "issues"
  | "issueStatuses"
  | "issueLabels"
  | "issueMilestones"
  | "issueCycles"
  | "issueTodos"
  | "issueRelations"
  | "issueComments"
  | "issueAttachments"
  | "issueViews"
  | "issueAuditEvents"
  | "issueThreadLinks";

/** The row, or `null` when it is missing *or tombstoned* — most references may only target live rows. */
async function liveRow<TableName extends "teams" | "cloudProjects" | IssueDomainTable>(
  ctx: QueryCtx,
  table: TableName,
  companyId: Id<"companies">,
  domainId: string,
): Promise<Doc<TableName> | null> {
  const row = await byDomain(ctx, table, companyId, domainId);
  if (row === null) return null;
  const deletedAt = (row as { deletedAt?: number | null }).deletedAt ?? null;
  return deletedAt === null ? row : null;
}

/** A write we just made; Convex reads-after-writes make this the committed row shape. */
async function mustGet<TableName extends IssueDomainTable>(
  ctx: MutationCtx,
  id: Id<TableName>,
): Promise<Doc<TableName>> {
  const doc = await ctx.db.get(id);
  if (doc === null) throw new Error("A row written in this transaction has vanished.");
  return doc;
}

async function membershipDomainId(
  ctx: QueryCtx,
  id: Id<"memberships"> | null,
): Promise<string | null> {
  if (id === null) return null;
  const doc = await ctx.db.get(id);
  return doc?.id ?? null;
}

// ---------------------------------------------------------------------------
// Payload encoders — the wire shape of one entity, shared by apply and bootstrap
// ---------------------------------------------------------------------------

// Payloads carry domain identifiers only: the Convex `_id`, `_creationTime`, storage references,
// and the row `version` (which rides the envelope) stay server-side. `deletedAt` is omitted
// because an upsert is by construction live and a tombstone carries no payload at all.

function encodeIssue(company: Doc<"companies">, doc: Doc<"issues">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    key: doc.key,
    keyNumber: doc.keyNumber,
    title: doc.title,
    description: doc.description,
    statusId: doc.statusId,
    priority: doc.priority,
    assignee: doc.assignee,
    projectId: doc.projectId,
    milestoneId: doc.milestoneId,
    cycleId: doc.cycleId,
    parentId: doc.parentId,
    sortOrder: doc.sortOrder,
    labelIds: doc.labelIds,
    dueDate: doc.dueDate,
    triage: doc.triage,
    slackSource: doc.slackSource,
    teamIds: doc.teamIds,
    workflowOwner: doc.workflowOwner,
    workModelSelection: doc.workModelSelection,
    automationAssignment: doc.automationAssignment,
    pullRequest: doc.pullRequest,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueStatus(company: Doc<"companies">, doc: Doc<"issueStatuses">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    scope: doc.scope,
    teamId: doc.teamId,
    baseStatusId: doc.baseStatusId,
    name: doc.name,
    color: doc.color,
    category: doc.category,
    position: doc.position,
    hidden: doc.hidden,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueLabel(company: Doc<"companies">, doc: Doc<"issueLabels">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    teamId: doc.teamId,
    name: doc.name,
    color: doc.color,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueMilestone(company: Doc<"companies">, doc: Doc<"issueMilestones">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    cloudProjectId: doc.cloudProjectId,
    name: doc.name,
    description: doc.description,
    startDate: doc.startDate,
    targetDate: doc.targetDate,
    position: doc.position,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueCycle(company: Doc<"companies">, doc: Doc<"issueCycles">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    teamId: doc.teamId,
    name: doc.name,
    startDate: doc.startDate,
    endDate: doc.endDate,
    completedAt: doc.completedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueTodo(company: Doc<"companies">, doc: Doc<"issueTodos">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    text: doc.text,
    done: doc.done,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueRelation(company: Doc<"companies">, doc: Doc<"issueRelations">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    relatedIssueId: doc.relatedIssueId,
    kind: doc.kind,
    createdAt: doc.createdAt,
  };
}

function encodeIssueComment(company: Doc<"companies">, doc: Doc<"issueComments">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    body: doc.body,
    author: doc.author,
    attachmentIds: doc.attachmentIds,
    mentions: doc.mentions,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function encodeIssueAttachment(
  ctx: QueryCtx,
  company: Doc<"companies">,
  doc: Doc<"issueAttachments">,
): Promise<unknown> {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    commentId: doc.commentId,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    checksum: doc.checksum,
    uploadedByMembershipId: await membershipDomainId(ctx, doc.uploadedByMembershipId),
    state: doc.state,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function encodeIssueView(
  ctx: QueryCtx,
  company: Doc<"companies">,
  doc: Doc<"issueViews">,
): Promise<unknown> {
  return {
    id: doc.id,
    companyId: company.id,
    ownerMembershipId: await membershipDomainId(ctx, doc.ownerMembershipId),
    visibility: doc.visibility,
    teamIds: doc.teamIds,
    name: doc.name,
    config: doc.config,
    position: doc.position,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function encodeIssueAuditEvent(company: Doc<"companies">, doc: Doc<"issueAuditEvents">): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    kind: doc.kind,
    actor: doc.actor,
    payload: doc.payload,
    operationId: doc.operationId,
    createdAt: doc.createdAt,
  };
}

async function encodeIssueThreadLink(
  ctx: QueryCtx,
  company: Doc<"companies">,
  doc: Doc<"issueThreadLinks">,
): Promise<unknown> {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    environmentId: doc.environmentId,
    threadId: doc.threadId,
    origin: doc.origin,
    createdByMembershipId: await membershipDomainId(ctx, doc.createdByMembershipId),
    createdAt: doc.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Change construction
// ---------------------------------------------------------------------------

function upsert(
  entityKind: DomainChange["entityKind"],
  entityId: string,
  teamIds: readonly string[],
  versionDocId: DomainChange["versionDocId"],
  payload: unknown,
): DomainChange {
  return { entityKind, entityId, changeKind: "upsert", teamIds, versionDocId, payload };
}

function tombstone(
  entityKind: DomainChange["entityKind"],
  entityId: string,
  teamIds: readonly string[],
  versionDocId: DomainChange["versionDocId"],
): DomainChange {
  return { entityKind, entityId, changeKind: "tombstone", teamIds, versionDocId, payload: null };
}

/**
 * Writes one issue audit event and returns its feed row. The event's domain id is derived from the
 * operation id, so an OCC retry of the transaction re-creates the same identity rather than a
 * sibling. Audit rows are retained until company deletion, unlike the 90-day feed.
 */
async function appendAuditEvent(
  ctx: MutationCtx,
  company: Doc<"companies">,
  feedActor: FeedActor,
  operation: SyncOperationEnvelope,
  eventIndex: number,
  issue: { readonly id: string; readonly teamIds: readonly string[] },
  kind: "created" | "field_changed" | "deleted" | "restored",
  payload: unknown,
  now: number,
): Promise<DomainChange> {
  const id = auditEventDomainId(operation.operationId, eventIndex);
  const docId = await ctx.db.insert("issueAuditEvents", {
    id,
    companyId: company._id,
    issueId: issue.id,
    kind,
    actor: feedActor,
    payload,
    operationId: operation.operationId,
    createdAt: now,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return upsert("issueAuditEvent", id, issue.teamIds, docId, encodeIssueAuditEvent(company, doc));
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/** Sorting rule the workflow catalog uses everywhere: position ascending, nulls last, id tie-break. */
function firstStatus(rows: readonly Doc<"issueStatuses">[]): Doc<"issueStatuses"> | null {
  const live = rows.filter((row) => row.deletedAt === null && !row.hidden);
  live.sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return live[0] ?? null;
}

/**
 * The status a new issue lands in when its create named none: the first visible status of the
 * owner's workflow. A team owner prefers its own rows and falls back to the inherited company
 * chain; full hidden-override merging is deliberately not modelled yet.
 */
async function defaultStatusId(
  ctx: QueryCtx,
  company: Doc<"companies">,
  owner: IssueWorkflowOwner,
): Promise<string | null> {
  if (owner.kind === "team") {
    const teamRows = await ctx.db
      .query("issueStatuses")
      .withIndex("by_company_and_team", (q) =>
        q.eq("companyId", company._id).eq("teamId", owner.teamId),
      )
      .collect();
    const teamFirst = firstStatus(teamRows);
    if (teamFirst !== null) return teamFirst.id;
  }
  const companyRows = await ctx.db
    .query("issueStatuses")
    .withIndex("by_company_and_scope", (q) => q.eq("companyId", company._id).eq("scope", "company"))
    .collect();
  return firstStatus(companyRows)?.id ?? null;
}

/** Whether `status` belongs to `owner`'s workflow. A team workflow inherits every company status. */
function statusMatchesOwner(status: Doc<"issueStatuses">, owner: IssueWorkflowOwner): boolean {
  if (status.scope === "company") return true;
  return owner.kind === "team" && status.teamId === owner.teamId;
}

/** All named teams must exist and be live; returns the offending id otherwise. */
async function missingTeam(
  ctx: QueryCtx,
  company: Doc<"companies">,
  teamIds: readonly string[],
): Promise<string | null> {
  for (const teamId of teamIds) {
    const team = await byDomain(ctx, "teams", company._id, teamId);
    if (team === null || team.archivedAt !== null) return teamId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler plumbing
// ---------------------------------------------------------------------------

/** Narrows one parse result or short-circuits the handler with `invalid-arguments`. */
function decoded<T>(result: ArgsResult<T>): { args: T } | { outcome: DomainOutcome } {
  if (result.ok) return { args: result.args };
  return { outcome: rejected("invalid-arguments", result.message) };
}

interface ApplyEnv {
  readonly ctx: MutationCtx;
  readonly actor: CompanyActor;
  readonly company: Doc<"companies">;
  readonly feedActor: FeedActor;
  readonly operation: SyncOperationEnvelope;
  readonly now: number;
}

type EnvApply = (env: ApplyEnv) => Promise<DomainOutcome>;

function handler(apply: EnvApply): DomainApply {
  return (ctx, actor, operation) =>
    apply({
      ctx,
      actor,
      company: actor.company,
      feedActor: actorRecord(actor),
      operation,
      now: Date.now(),
    });
}

// ---------------------------------------------------------------------------
// issue.*
// ---------------------------------------------------------------------------

const issueCreate: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssueCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `An issue ${operation.entityId} already exists.`);
  }

  const teamIds = args.teamIds ?? [];
  const badTeam = await missingTeam(ctx, company, teamIds);
  if (badTeam !== null) return rejected("invalid-arguments", `No team ${badTeam}.`);
  if (!can(actor, "issues.create", teamIds)) return denied("issues.create");

  // Workflow owner: explicit, else the project's default, else the company chain. A team owner
  // must be one of the issue's teams — otherwise nobody who can see the issue could manage its
  // workflow.
  let project: Doc<"cloudProjects"> | null = null;
  if (args.projectId !== undefined) {
    project = await liveRow(ctx, "cloudProjects", company._id, args.projectId);
    if (project === null || project.archivedAt !== null) {
      return rejected("invalid-arguments", `No project ${args.projectId}.`);
    }
  }
  const owner: IssueWorkflowOwner = args.workflowOwner ??
    project?.defaultWorkflowOwner ?? { kind: "company" };
  if (owner.kind === "team" && !teamIds.includes(owner.teamId)) {
    return rejected("invalid-arguments", "The workflow owner must be one of the issue's teams.");
  }

  const triage = args.triage ?? false;
  let statusId: string;
  if (args.statusId !== undefined) {
    const status = await liveRow(ctx, "issueStatuses", company._id, args.statusId);
    if (status === null) return rejected("invalid-arguments", `No status ${args.statusId}.`);
    if (!statusMatchesOwner(status, owner)) {
      return rejected("invalid-arguments", "The status belongs to a different workflow.");
    }
    statusId = status.id;
  } else if (triage) {
    // A triage item may sit outside the workflow; the empty sentinel is "no status yet".
    statusId = "";
  } else {
    const fallback = await defaultStatusId(ctx, company, owner);
    if (fallback === null) {
      return rejected("invalid-arguments", "This workflow has no status to place the issue in.");
    }
    statusId = fallback;
  }

  for (const labelId of args.labelIds ?? []) {
    const label = await liveRow(ctx, "issueLabels", company._id, labelId);
    if (label === null) return rejected("invalid-arguments", `No label ${labelId}.`);
  }
  let milestone: Doc<"issueMilestones"> | null = null;
  if (args.milestoneId !== undefined) {
    milestone = await liveRow(ctx, "issueMilestones", company._id, args.milestoneId);
    if (milestone === null)
      return rejected("invalid-arguments", `No milestone ${args.milestoneId}.`);
    if (args.projectId === undefined || milestone.cloudProjectId !== args.projectId) {
      return rejected("invalid-arguments", "The milestone belongs to a different project.");
    }
  }
  if (args.cycleId !== undefined) {
    const cycle = await liveRow(ctx, "issueCycles", company._id, args.cycleId);
    if (cycle === null) return rejected("invalid-arguments", `No cycle ${args.cycleId}.`);
  }
  if (args.parentId !== undefined) {
    const parent = await liveRow(ctx, "issues", company._id, args.parentId);
    if (parent === null) return rejected("invalid-arguments", `No issue ${args.parentId}.`);
  }

  // Key assignment. A leased key arrives in `args.key`; a client that ran its block dry sends none
  // and the company counter assigns one here. The counter is re-read because an earlier create in
  // this same batch may have advanced it past the snapshot `actor.company` carries.
  const freshCompany = await ctx.db.get(company._id);
  if (freshCompany === null) return rejected("invalid-arguments", "The company has vanished.");
  let key: string;
  let keyNumber: number;
  if (args.key !== undefined) {
    const prefix = args.key.slice(0, args.key.lastIndexOf("-"));
    if (prefix !== freshCompany.issueKeyPrefix) {
      return rejected(
        "invalid-arguments",
        `Issue keys here start with ${freshCompany.issueKeyPrefix}-.`,
      );
    }
    const collision = await ctx.db
      .query("issues")
      .withIndex("by_company_and_key", (q) =>
        q.eq("companyId", company._id).eq("key", args.key ?? ""),
      )
      .unique();
    if (collision !== null) return rejected("invalid-arguments", `The key ${args.key} is taken.`);
    key = args.key;
    keyNumber = issueKeyNumber(args.key);
    // Defensive: a key at or past the counter would collide with a future lease.
    if (keyNumber >= freshCompany.nextIssueNumber) {
      await ctx.db.patch(company._id, { nextIssueNumber: keyNumber + 1, updatedAt: now });
    }
  } else {
    keyNumber = freshCompany.nextIssueNumber;
    key = `${freshCompany.issueKeyPrefix}-${keyNumber}`;
    await ctx.db.patch(company._id, { nextIssueNumber: keyNumber + 1, updatedAt: now });
  }

  const docId = await ctx.db.insert("issues", {
    id: operation.entityId,
    companyId: company._id,
    key,
    keyNumber,
    title: args.title,
    description: args.description ?? "",
    statusId,
    priority: args.priority ?? "none",
    assignee: args.assignee ?? null,
    projectId: args.projectId ?? null,
    milestoneId: args.milestoneId ?? null,
    cycleId: args.cycleId ?? null,
    parentId: args.parentId ?? null,
    sortOrder: args.sortOrder ?? defaultIssueSortOrder(keyNumber),
    labelIds: [...(args.labelIds ?? [])],
    dueDate: args.dueDate ?? null,
    triage,
    slackSource: null,
    teamIds: [...teamIds],
    workflowOwner: owner,
    workModelSelection: args.workModelSelection ?? null,
    automationAssignment: null,
    pullRequest: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);

  return applied(
    upsert("issue", doc.id, doc.teamIds, docId, encodeIssue(company, doc)),
    await appendAuditEvent(ctx, company, feedActor, operation, 0, doc, "created", { key }, now),
  );
};

const issueUpdate: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssuePatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (issue.deletedAt !== null) {
    return rejected("entity-deleted", "This issue is deleted; restore it before editing.");
  }
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  if (args.statusId !== undefined) {
    const status = await liveRow(ctx, "issueStatuses", company._id, args.statusId);
    if (status === null) return rejected("invalid-arguments", `No status ${args.statusId}.`);
    if (!statusMatchesOwner(status, issue.workflowOwner)) {
      return rejected("invalid-arguments", "The status belongs to a different workflow.");
    }
  }
  if (args.projectId != null) {
    const project = await liveRow(ctx, "cloudProjects", company._id, args.projectId);
    if (project === null || project.archivedAt !== null) {
      return rejected("invalid-arguments", `No project ${args.projectId}.`);
    }
  }
  if (args.milestoneId != null) {
    const milestone = await liveRow(ctx, "issueMilestones", company._id, args.milestoneId);
    if (milestone === null) {
      return rejected("invalid-arguments", `No milestone ${args.milestoneId}.`);
    }
    const effectiveProject = args.projectId !== undefined ? args.projectId : issue.projectId;
    if (milestone.cloudProjectId !== effectiveProject) {
      return rejected("invalid-arguments", "The milestone belongs to a different project.");
    }
  }
  if (args.cycleId != null) {
    const cycle = await liveRow(ctx, "issueCycles", company._id, args.cycleId);
    if (cycle === null) return rejected("invalid-arguments", `No cycle ${args.cycleId}.`);
  }
  if (args.parentId != null) {
    if (args.parentId === issue.id) {
      return rejected("invalid-arguments", "An issue cannot be its own parent.");
    }
    const parent = await liveRow(ctx, "issues", company._id, args.parentId);
    if (parent === null) return rejected("invalid-arguments", `No issue ${args.parentId}.`);
  }
  for (const labelId of args.labelIds ?? []) {
    const label = await liveRow(ctx, "issueLabels", company._id, labelId);
    if (label === null) return rejected("invalid-arguments", `No label ${labelId}.`);
  }

  // Absent leaves the field alone; explicit null clears. Collect before/after for the audit trail
  // so a stale-base overwrite stays recoverable from the event log.
  const patch: Record<string, unknown> = {};
  const audit: Record<string, { readonly before: unknown; readonly after: unknown }> = {};
  const set = (field: keyof Doc<"issues"> & string, value: unknown) => {
    if (value === undefined) return;
    const before = issue[field as keyof Doc<"issues">];
    if (JSON.stringify(before ?? null) === JSON.stringify(value ?? null)) return;
    patch[field] = value;
    audit[field] = { before: before ?? null, after: value };
  };
  set("title", args.title);
  set("description", args.description);
  set("statusId", args.statusId);
  set("priority", args.priority);
  set("assignee", args.assignee);
  set("workModelSelection", args.workModelSelection);
  set("projectId", args.projectId);
  set("milestoneId", args.milestoneId);
  set("cycleId", args.cycleId);
  set("parentId", args.parentId);
  set("labelIds", args.labelIds === undefined ? undefined : [...args.labelIds]);
  set("dueDate", args.dueDate);
  set("triage", args.triage);

  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(issue._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, issue._id);
  return applied(
    upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)),
    await appendAuditEvent(
      ctx,
      company,
      feedActor,
      operation,
      0,
      doc,
      "field_changed",
      { changes: audit, baseVersion: operation.baseVersion },
      now,
    ),
  );
};

const issueDelete: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (!can(actor, "issues.delete", issue.teamIds)) return denied("issues.delete");
  // Deleting a deleted issue converged already; accept without changes so the receipt lands at the
  // unchanged head.
  if (issue.deletedAt !== null) return applied();

  await ctx.db.patch(issue._id, { deletedAt: now, updatedAt: now });
  return applied(
    tombstone("issue", issue.id, issue.teamIds, issue._id),
    await appendAuditEvent(ctx, company, feedActor, operation, 0, issue, "deleted", {}, now),
  );
};

const issueRestore: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");
  if (issue.deletedAt === null) return applied();

  await ctx.db.patch(issue._id, { deletedAt: null, updatedAt: now });
  const doc = await mustGet(ctx, issue._id);
  return applied(
    upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)),
    await appendAuditEvent(ctx, company, feedActor, operation, 0, doc, "restored", {}, now),
  );
};

const issueSetSortOrder: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssueSetSortOrderArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (issue.deletedAt !== null) return rejected("entity-deleted", "This issue is deleted.");
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  const patch: { sortOrder: string; statusId?: string; updatedAt: number } = {
    sortOrder: args.sortOrder,
    updatedAt: now,
  };
  const statusChanged = args.statusId !== undefined && args.statusId !== issue.statusId;
  if (args.statusId !== undefined) {
    const status = await liveRow(ctx, "issueStatuses", company._id, args.statusId);
    if (status === null) return rejected("invalid-arguments", `No status ${args.statusId}.`);
    if (!statusMatchesOwner(status, issue.workflowOwner)) {
      return rejected("invalid-arguments", "The status belongs to a different workflow.");
    }
    patch.statusId = args.statusId;
  }

  await ctx.db.patch(issue._id, patch);
  const doc = await mustGet(ctx, issue._id);
  const changes: DomainChange[] = [
    upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)),
  ];
  // A drag within a column is not audit-worthy; a drag across columns is a status change.
  if (statusChanged) {
    changes.push(
      await appendAuditEvent(
        ctx,
        company,
        feedActor,
        operation,
        0,
        doc,
        "field_changed",
        { changes: { statusId: { before: issue.statusId, after: doc.statusId } } },
        now,
      ),
    );
  }
  return applied(...changes);
};

const issueSetWorkflowOwner: EnvApply = async ({
  ctx,
  actor,
  company,
  feedActor,
  operation,
  now,
}) => {
  const parsed = decoded(parseIssueSetWorkflowOwnerArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (issue.deletedAt !== null) return rejected("entity-deleted", "This issue is deleted.");
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  const owner = args.workflowOwner;
  if (owner.kind === "team" && !issue.teamIds.includes(owner.teamId)) {
    return rejected("invalid-arguments", "The workflow owner must be one of the issue's teams.");
  }

  // Status carryover: keep the current status when the target workflow still contains it, else use
  // the explicit one, else land in the target's default.
  let statusId = issue.statusId;
  const current =
    issue.statusId === "" ? null : await liveRow(ctx, "issueStatuses", company._id, issue.statusId);
  const keepCurrent = current !== null && statusMatchesOwner(current, owner);
  if (!keepCurrent) {
    if (args.statusId !== undefined) {
      const status = await liveRow(ctx, "issueStatuses", company._id, args.statusId);
      if (status === null) return rejected("invalid-arguments", `No status ${args.statusId}.`);
      if (!statusMatchesOwner(status, owner)) {
        return rejected("invalid-arguments", "The status belongs to a different workflow.");
      }
      statusId = status.id;
    } else if (issue.triage && issue.statusId === "") {
      statusId = "";
    } else {
      const fallback = await defaultStatusId(ctx, company, owner);
      if (fallback === null) {
        return rejected("invalid-arguments", "The target workflow has no status to land in.");
      }
      statusId = fallback;
    }
  }

  await ctx.db.patch(issue._id, { workflowOwner: owner, statusId, updatedAt: now });
  const doc = await mustGet(ctx, issue._id);
  return applied(
    upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)),
    await appendAuditEvent(
      ctx,
      company,
      feedActor,
      operation,
      0,
      doc,
      "field_changed",
      {
        changes: {
          workflowOwner: { before: issue.workflowOwner, after: owner },
          statusId: { before: issue.statusId, after: statusId },
        },
      },
      now,
    ),
  );
};

const issueSetTeams: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssueSetTeamsArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const teamIds = parsed.args.teamIds;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (issue.deletedAt !== null) return rejected("entity-deleted", "This issue is deleted.");
  // Judged against the record as it stands: detaching a team is an act on that team's record.
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  const badTeam = await missingTeam(ctx, company, teamIds);
  if (badTeam !== null) return rejected("invalid-arguments", `No team ${badTeam}.`);

  const nextTeams = new Set(teamIds);

  // Removing a team invalidates whatever was scoped to it: labels, the cycle, and the workflow
  // owner. Each is cleared or reassigned atomically with the team change so no client ever sees a
  // team-scoped reference the issue's teams cannot justify.
  const keptLabelIds: string[] = [];
  for (const labelId of issue.labelIds) {
    const label = await liveRow(ctx, "issueLabels", company._id, labelId);
    if (label === null) continue;
    if (label.teamId === null || nextTeams.has(label.teamId)) keptLabelIds.push(labelId);
  }
  let cycleId = issue.cycleId;
  if (cycleId !== null) {
    const cycle = await liveRow(ctx, "issueCycles", company._id, cycleId);
    if (cycle === null || (cycle.teamId !== null && !nextTeams.has(cycle.teamId))) cycleId = null;
  }
  let owner = issue.workflowOwner;
  let statusId = issue.statusId;
  if (owner.kind === "team" && !nextTeams.has(owner.teamId)) {
    owner = { kind: "company" };
    const current =
      statusId === "" ? null : await liveRow(ctx, "issueStatuses", company._id, statusId);
    if (current === null || !statusMatchesOwner(current, owner)) {
      const fallback = await defaultStatusId(ctx, company, owner);
      if (fallback === null) {
        return rejected("invalid-arguments", "The company workflow has no status to land in.");
      }
      statusId = fallback;
    }
  }

  await ctx.db.patch(issue._id, {
    teamIds: [...teamIds],
    labelIds: keptLabelIds,
    cycleId,
    workflowOwner: owner,
    statusId,
    updatedAt: now,
  });
  const doc = await mustGet(ctx, issue._id);
  return applied(
    // The feed row carries the *new* teams: members of a removed team stop seeing updates, and the
    // newly attached teams get the complete entity.
    upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)),
    await appendAuditEvent(
      ctx,
      company,
      feedActor,
      operation,
      0,
      doc,
      "field_changed",
      { changes: { teamIds: { before: issue.teamIds, after: teamIds } } },
      now,
    ),
  );
};

// ---------------------------------------------------------------------------
// issueStatus.*
// ---------------------------------------------------------------------------

function statusScopeTeamIds(status: {
  readonly scope: "company" | "team";
  readonly teamId: string | null;
}): readonly string[] {
  return status.scope === "team" && status.teamId !== null ? [status.teamId] : [];
}

const issueStatusCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueStatuses", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A status ${operation.entityId} already exists.`);
  }

  const teamId = args.teamId ?? null;
  if (args.scope === "team") {
    if (teamId === null) return rejected("invalid-arguments", "A team status names its team.");
    const team = await byDomain(ctx, "teams", company._id, teamId);
    if (team === null || team.archivedAt !== null) {
      return rejected("invalid-arguments", `No team ${teamId}.`);
    }
  } else if (teamId !== null) {
    return rejected("invalid-arguments", "A company status carries no team.");
  }

  const scopeTeams = args.scope === "team" && teamId !== null ? [teamId] : [];
  if (!can(actor, "workflow.manage", scopeTeams)) return denied("workflow.manage");

  const baseStatusId = args.baseStatusId ?? null;
  if (baseStatusId !== null) {
    const base = await liveRow(ctx, "issueStatuses", company._id, baseStatusId);
    if (base === null || base.scope !== "company") {
      return rejected("invalid-arguments", "An override names a live company status as its base.");
    }
  }

  let position = args.position;
  if (position === undefined) {
    // Append to the end of the same chain.
    const siblings =
      args.scope === "team"
        ? await ctx.db
            .query("issueStatuses")
            .withIndex("by_company_and_team", (q) =>
              q.eq("companyId", company._id).eq("teamId", teamId),
            )
            .collect()
        : await ctx.db
            .query("issueStatuses")
            .withIndex("by_company_and_scope", (q) =>
              q.eq("companyId", company._id).eq("scope", "company"),
            )
            .collect();
    position = siblings.reduce((max, row) => Math.max(max, (row.position ?? 0) + 1), 0);
  }

  const docId = await ctx.db.insert("issueStatuses", {
    id: operation.entityId,
    companyId: company._id,
    scope: args.scope,
    teamId,
    baseStatusId,
    name: args.name ?? null,
    color: args.color ?? null,
    category: args.category ?? null,
    position,
    hidden: args.hidden ?? false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueStatus", doc.id, statusScopeTeamIds(doc), docId, encodeIssueStatus(company, doc)),
  );
};

const issueStatusUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusPatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const status = await byDomain(ctx, "issueStatuses", company._id, operation.entityId);
  if (status === null) return rejected("entity-not-found", `No status ${operation.entityId}.`);
  if (status.deletedAt !== null) return rejected("entity-deleted", "This status is deleted.");
  if (!can(actor, "workflow.manage", statusScopeTeamIds(status))) return denied("workflow.manage");

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.color !== undefined) patch["color"] = args.color;
  if (args.category !== undefined) patch["category"] = args.category;
  if (args.position !== undefined) patch["position"] = args.position;
  if (args.hidden !== undefined) patch["hidden"] = args.hidden;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(status._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, status._id);
  return applied(
    upsert(
      "issueStatus",
      doc.id,
      statusScopeTeamIds(doc),
      status._id,
      encodeIssueStatus(company, doc),
    ),
  );
};

const issueStatusDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusDeleteArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const status = await byDomain(ctx, "issueStatuses", company._id, operation.entityId);
  if (status === null) return rejected("entity-not-found", `No status ${operation.entityId}.`);
  if (!can(actor, "workflow.manage", statusScopeTeamIds(status))) return denied("workflow.manage");
  if (status.deletedAt !== null) return applied();

  if (args.reassignToStatusId === status.id) {
    return rejected("invalid-arguments", "A status cannot absorb its own issues.");
  }
  const target = await liveRow(ctx, "issueStatuses", company._id, args.reassignToStatusId);
  if (target === null) {
    return rejected("invalid-arguments", `No status ${args.reassignToStatusId}.`);
  }

  const changes: DomainChange[] = [];

  // Issues sitting in the deleted status move to the named target, each as its own feed row so
  // every replica repaints the affected cards.
  const stranded = await ctx.db
    .query("issues")
    .withIndex("by_company_and_status", (q) =>
      q.eq("companyId", company._id).eq("statusId", status.id),
    )
    .collect();
  for (const issue of stranded) {
    if (issue.deletedAt !== null) continue;
    await ctx.db.patch(issue._id, { statusId: target.id, updatedAt: now });
    const doc = await mustGet(ctx, issue._id);
    changes.push(upsert("issue", doc.id, doc.teamIds, issue._id, encodeIssue(company, doc)));
  }

  // Team overrides of a deleted company status die with their base.
  if (status.scope === "company") {
    const overrides = await ctx.db
      .query("issueStatuses")
      .withIndex("by_company_and_base_status", (q) =>
        q.eq("companyId", company._id).eq("baseStatusId", status.id),
      )
      .collect();
    for (const override of overrides) {
      if (override.deletedAt !== null) continue;
      await ctx.db.patch(override._id, { deletedAt: now, updatedAt: now });
      changes.push(
        tombstone("issueStatus", override.id, statusScopeTeamIds(override), override._id),
      );
    }
  }

  await ctx.db.patch(status._id, { deletedAt: now, updatedAt: now });
  changes.push(tombstone("issueStatus", status.id, statusScopeTeamIds(status), status._id));
  return applied(...changes);
};

const issueStatusReorder: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusesReorderArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const rows: Doc<"issueStatuses">[] = [];
  for (const statusId of args.statusIds) {
    const status = await liveRow(ctx, "issueStatuses", company._id, statusId);
    if (status === null) return rejected("invalid-arguments", `No status ${statusId}.`);
    rows.push(status);
  }
  const first = rows[0];
  if (first === undefined) return rejected("invalid-arguments", "Nothing to reorder.");
  for (const row of rows) {
    if (row.scope !== first.scope || row.teamId !== first.teamId) {
      return rejected("invalid-arguments", "Reordered statuses must share one workflow.");
    }
  }
  if (!can(actor, "workflow.manage", statusScopeTeamIds(first))) return denied("workflow.manage");

  const changes: DomainChange[] = [];
  for (const [index, row] of rows.entries()) {
    await ctx.db.patch(row._id, { position: index, updatedAt: now });
    const doc = await mustGet(ctx, row._id);
    changes.push(
      upsert(
        "issueStatus",
        doc.id,
        statusScopeTeamIds(doc),
        row._id,
        encodeIssueStatus(company, doc),
      ),
    );
  }
  return applied(...changes);
};

// ---------------------------------------------------------------------------
// issueLabel.* / issueMilestone.* / issueCycle.*
// ---------------------------------------------------------------------------

const teamScope = (teamId: string | null): readonly string[] => (teamId === null ? [] : [teamId]);

const issueLabelCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueLabelCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueLabels", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A label ${operation.entityId} already exists.`);
  }
  const teamId = args.teamId ?? null;
  if (teamId !== null) {
    const team = await byDomain(ctx, "teams", company._id, teamId);
    if (team === null || team.archivedAt !== null) {
      return rejected("invalid-arguments", `No team ${teamId}.`);
    }
  }
  if (!can(actor, "workflow.manage", teamScope(teamId))) return denied("workflow.manage");

  const docId = await ctx.db.insert("issueLabels", {
    id: operation.entityId,
    companyId: company._id,
    teamId,
    name: args.name,
    color: args.color,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueLabel", doc.id, teamScope(doc.teamId), docId, encodeIssueLabel(company, doc)),
  );
};

const issueLabelUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueLabelPatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const label = await byDomain(ctx, "issueLabels", company._id, operation.entityId);
  if (label === null) return rejected("entity-not-found", `No label ${operation.entityId}.`);
  if (label.deletedAt !== null) return rejected("entity-deleted", "This label is deleted.");
  if (!can(actor, "workflow.manage", teamScope(label.teamId))) return denied("workflow.manage");

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.color !== undefined) patch["color"] = args.color;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(label._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, label._id);
  return applied(
    upsert("issueLabel", doc.id, teamScope(doc.teamId), label._id, encodeIssueLabel(company, doc)),
  );
};

const issueLabelDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const label = await byDomain(ctx, "issueLabels", company._id, operation.entityId);
  if (label === null) return rejected("entity-not-found", `No label ${operation.entityId}.`);
  if (!can(actor, "workflow.manage", teamScope(label.teamId))) return denied("workflow.manage");
  if (label.deletedAt !== null) return applied();

  await ctx.db.patch(label._id, { deletedAt: now, updatedAt: now });
  // Issues keep the dangling label id; clients drop unknown label ids on render, and sweeping every
  // issue here would turn one label delete into an unbounded batch.
  return applied(tombstone("issueLabel", label.id, teamScope(label.teamId), label._id));
};

const issueMilestoneCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueMilestoneCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueMilestones", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A milestone ${operation.entityId} already exists.`);
  }
  const project = await liveRow(ctx, "cloudProjects", company._id, args.cloudProjectId);
  if (project === null || project.archivedAt !== null) {
    return rejected("invalid-arguments", `No project ${args.cloudProjectId}.`);
  }
  if (!can(actor, "projects.manage", project.teamIds)) return denied("projects.manage");

  let position = args.position;
  if (position === undefined) {
    const siblings = await ctx.db
      .query("issueMilestones")
      .withIndex("by_company_and_project", (q) =>
        q.eq("companyId", company._id).eq("cloudProjectId", project.id),
      )
      .collect();
    position = siblings.reduce((max, row) => Math.max(max, row.position + 1), 0);
  }

  const docId = await ctx.db.insert("issueMilestones", {
    id: operation.entityId,
    companyId: company._id,
    cloudProjectId: project.id,
    name: args.name,
    description: args.description ?? null,
    startDate: args.startDate ?? null,
    targetDate: args.targetDate ?? null,
    position,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueMilestone", doc.id, project.teamIds, docId, encodeIssueMilestone(company, doc)),
  );
};

/** The team scope of a milestone is its project's; a milestone of a vanished project is company-wide. */
async function milestoneTeamIds(
  ctx: QueryCtx,
  company: Doc<"companies">,
  milestone: Doc<"issueMilestones">,
): Promise<readonly string[]> {
  const project = await byDomain(ctx, "cloudProjects", company._id, milestone.cloudProjectId);
  return project?.teamIds ?? [];
}

const issueMilestoneUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueMilestonePatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const milestone = await byDomain(ctx, "issueMilestones", company._id, operation.entityId);
  if (milestone === null) {
    return rejected("entity-not-found", `No milestone ${operation.entityId}.`);
  }
  if (milestone.deletedAt !== null) return rejected("entity-deleted", "This milestone is deleted.");
  const scopeTeams = await milestoneTeamIds(ctx, company, milestone);
  if (!can(actor, "projects.manage", scopeTeams)) return denied("projects.manage");

  if (args.cloudProjectId !== undefined) {
    const target = await liveRow(ctx, "cloudProjects", company._id, args.cloudProjectId);
    if (target === null || target.archivedAt !== null) {
      return rejected("invalid-arguments", `No project ${args.cloudProjectId}.`);
    }
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.description !== undefined) patch["description"] = args.description;
  if (args.startDate !== undefined) patch["startDate"] = args.startDate;
  if (args.targetDate !== undefined) patch["targetDate"] = args.targetDate;
  if (args.position !== undefined) patch["position"] = args.position;
  if (args.cloudProjectId !== undefined) patch["cloudProjectId"] = args.cloudProjectId;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(milestone._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, milestone._id);
  return applied(
    upsert(
      "issueMilestone",
      doc.id,
      await milestoneTeamIds(ctx, company, doc),
      milestone._id,
      encodeIssueMilestone(company, doc),
    ),
  );
};

const issueMilestoneDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const milestone = await byDomain(ctx, "issueMilestones", company._id, operation.entityId);
  if (milestone === null) {
    return rejected("entity-not-found", `No milestone ${operation.entityId}.`);
  }
  const scopeTeams = await milestoneTeamIds(ctx, company, milestone);
  if (!can(actor, "projects.manage", scopeTeams)) return denied("projects.manage");
  if (milestone.deletedAt !== null) return applied();

  await ctx.db.patch(milestone._id, { deletedAt: now, updatedAt: now });
  // Issues keep the dangling milestone id; clients treat an unknown milestone as none.
  return applied(tombstone("issueMilestone", milestone.id, scopeTeams, milestone._id));
};

const issueCycleCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueCycleCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueCycles", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A cycle ${operation.entityId} already exists.`);
  }
  const teamId = args.teamId ?? null;
  if (teamId !== null) {
    const team = await byDomain(ctx, "teams", company._id, teamId);
    if (team === null || team.archivedAt !== null) {
      return rejected("invalid-arguments", `No team ${teamId}.`);
    }
  }
  if (!can(actor, "workflow.manage", teamScope(teamId))) return denied("workflow.manage");

  const docId = await ctx.db.insert("issueCycles", {
    id: operation.entityId,
    companyId: company._id,
    teamId,
    name: args.name,
    startDate: args.startDate,
    endDate: args.endDate,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueCycle", doc.id, teamScope(doc.teamId), docId, encodeIssueCycle(company, doc)),
  );
};

const issueCycleUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueCyclePatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const cycle = await byDomain(ctx, "issueCycles", company._id, operation.entityId);
  if (cycle === null) return rejected("entity-not-found", `No cycle ${operation.entityId}.`);
  if (cycle.deletedAt !== null) return rejected("entity-deleted", "This cycle is deleted.");
  if (!can(actor, "workflow.manage", teamScope(cycle.teamId))) return denied("workflow.manage");

  const startDate = args.startDate ?? cycle.startDate;
  const endDate = args.endDate ?? cycle.endDate;
  if (endDate < startDate) {
    return rejected("invalid-arguments", "A cycle cannot end before it starts.");
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.startDate !== undefined) patch["startDate"] = args.startDate;
  if (args.endDate !== undefined) patch["endDate"] = args.endDate;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(cycle._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, cycle._id);
  return applied(
    upsert("issueCycle", doc.id, teamScope(doc.teamId), cycle._id, encodeIssueCycle(company, doc)),
  );
};

const issueCycleDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const cycle = await byDomain(ctx, "issueCycles", company._id, operation.entityId);
  if (cycle === null) return rejected("entity-not-found", `No cycle ${operation.entityId}.`);
  if (!can(actor, "workflow.manage", teamScope(cycle.teamId))) return denied("workflow.manage");
  if (cycle.deletedAt !== null) return applied();

  await ctx.db.patch(cycle._id, { deletedAt: now, updatedAt: now });
  return applied(tombstone("issueCycle", cycle.id, teamScope(cycle.teamId), cycle._id));
};

// ---------------------------------------------------------------------------
// issueTodo.* / issueRelation.*
// ---------------------------------------------------------------------------

/** Sub-entities inherit the parent issue's team scope; a vanished parent leaves company scope. */
async function issueTeamIds(
  ctx: QueryCtx,
  company: Doc<"companies">,
  issueId: string,
): Promise<readonly string[]> {
  const issue = await byDomain(ctx, "issues", company._id, issueId);
  return issue?.teamIds ?? [];
}

const issueTodoCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueTodoCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueTodos", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A todo ${operation.entityId} already exists.`);
  }
  const issue = await liveRow(ctx, "issues", company._id, args.issueId);
  if (issue === null) return rejected("invalid-arguments", `No issue ${args.issueId}.`);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  let sortOrder = args.sortOrder;
  if (sortOrder === undefined) {
    const siblings = await ctx.db
      .query("issueTodos")
      .withIndex("by_company_and_issue", (q) =>
        q.eq("companyId", company._id).eq("issueId", issue.id),
      )
      .collect();
    let last: string | null = null;
    for (const row of siblings) {
      if (row.deletedAt !== null) continue;
      if (last === null || row.sortOrder > last) last = row.sortOrder;
    }
    sortOrder = orderKeyAfter(last);
  }

  const docId = await ctx.db.insert("issueTodos", {
    id: operation.entityId,
    companyId: company._id,
    issueId: issue.id,
    text: args.text,
    done: false,
    sortOrder,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(upsert("issueTodo", doc.id, issue.teamIds, docId, encodeIssueTodo(company, doc)));
};

const issueTodoUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueTodoPatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const todo = await byDomain(ctx, "issueTodos", company._id, operation.entityId);
  if (todo === null) return rejected("entity-not-found", `No todo ${operation.entityId}.`);
  if (todo.deletedAt !== null) return rejected("entity-deleted", "This todo is deleted.");
  const teamIds = await issueTeamIds(ctx, company, todo.issueId);
  if (!can(actor, "issues.update", teamIds)) return denied("issues.update");

  const patch: Record<string, unknown> = {};
  if (args.text !== undefined) patch["text"] = args.text;
  if (args.done !== undefined) patch["done"] = args.done;
  if (args.sortOrder !== undefined) patch["sortOrder"] = args.sortOrder;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(todo._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, todo._id);
  return applied(upsert("issueTodo", doc.id, teamIds, todo._id, encodeIssueTodo(company, doc)));
};

const issueTodoDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const todo = await byDomain(ctx, "issueTodos", company._id, operation.entityId);
  if (todo === null) return rejected("entity-not-found", `No todo ${operation.entityId}.`);
  const teamIds = await issueTeamIds(ctx, company, todo.issueId);
  if (!can(actor, "issues.update", teamIds)) return denied("issues.update");
  if (todo.deletedAt !== null) return applied();

  await ctx.db.patch(todo._id, { deletedAt: now, updatedAt: now });
  return applied(tombstone("issueTodo", todo.id, teamIds, todo._id));
};

/** A relation is visible from either end, so its feed row carries both issues' teams. */
function unionTeamIds(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])];
}

const issueRelationCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueRelationCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueRelations", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A relation ${operation.entityId} already exists.`);
  }
  const issue = await liveRow(ctx, "issues", company._id, args.issueId);
  if (issue === null) return rejected("invalid-arguments", `No issue ${args.issueId}.`);
  const related = await liveRow(ctx, "issues", company._id, args.relatedIssueId);
  if (related === null) return rejected("invalid-arguments", `No issue ${args.relatedIssueId}.`);

  const teamIds = unionTeamIds(issue.teamIds, related.teamIds);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  // One live row per directed pair and kind; the inverse is this row read from the other end.
  const siblings = await ctx.db
    .query("issueRelations")
    .withIndex("by_company_and_issue", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id),
    )
    .collect();
  for (const row of siblings) {
    if (row.deletedAt !== null) continue;
    if (row.relatedIssueId === related.id && row.kind === args.kind) {
      return rejected("invalid-arguments", "This relation already exists.");
    }
  }

  const docId = await ctx.db.insert("issueRelations", {
    id: operation.entityId,
    companyId: company._id,
    issueId: issue.id,
    relatedIssueId: related.id,
    kind: args.kind,
    createdAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueRelation", doc.id, teamIds, docId, encodeIssueRelation(company, doc)),
  );
};

const issueRelationDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const relation = await byDomain(ctx, "issueRelations", company._id, operation.entityId);
  if (relation === null) return rejected("entity-not-found", `No relation ${operation.entityId}.`);
  const teamIds = unionTeamIds(
    await issueTeamIds(ctx, company, relation.issueId),
    await issueTeamIds(ctx, company, relation.relatedIssueId),
  );
  if (!can(actor, "issues.update", await issueTeamIds(ctx, company, relation.issueId))) {
    return denied("issues.update");
  }
  if (relation.deletedAt !== null) return applied();

  await ctx.db.patch(relation._id, { deletedAt: now });
  return applied(tombstone("issueRelation", relation.id, teamIds, relation._id));
};

// ---------------------------------------------------------------------------
// issueComment.*
// ---------------------------------------------------------------------------

function isOwnComment(author: Doc<"issueComments">["author"], feedActor: FeedActor): boolean {
  if (author.kind === "member" && feedActor.kind === "member") {
    return author.membershipId === feedActor.membershipId;
  }
  if (author.kind === "environment" && feedActor.kind === "environment") {
    return author.environmentId === feedActor.environmentId;
  }
  return false;
}

const issueCommentCreate: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssueCommentCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueComments", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A comment ${operation.entityId} already exists.`);
  }
  const issue = await liveRow(ctx, "issues", company._id, args.issueId);
  if (issue === null) return rejected("invalid-arguments", `No issue ${args.issueId}.`);
  if (!can(actor, "comments.create", issue.teamIds)) return denied("comments.create");

  const docId = await ctx.db.insert("issueComments", {
    id: operation.entityId,
    companyId: company._id,
    issueId: issue.id,
    body: args.body,
    author: feedActor,
    attachmentIds: [...(args.attachmentIds ?? [])],
    // Mention extraction is a contracts concern this package does not depend on; clients render
    // mentions from the body until the shared extractor moves somewhere both can import.
    mentions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert("issueComment", doc.id, issue.teamIds, docId, encodeIssueComment(company, doc)),
  );
};

const issueCommentUpdate: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseIssueCommentPatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const comment = await byDomain(ctx, "issueComments", company._id, operation.entityId);
  if (comment === null) return rejected("entity-not-found", `No comment ${operation.entityId}.`);
  if (comment.deletedAt !== null) return rejected("entity-deleted", "This comment is deleted.");
  const teamIds = await issueTeamIds(ctx, company, comment.issueId);
  const permission = isOwnComment(comment.author, feedActor)
    ? "comments.updateOwn"
    : "comments.moderate";
  if (!can(actor, permission, teamIds)) return denied(permission);

  const patch: Record<string, unknown> = {};
  if (args.body !== undefined) patch["body"] = args.body;
  if (args.attachmentIds !== undefined) patch["attachmentIds"] = [...args.attachmentIds];
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(comment._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, comment._id);
  return applied(
    upsert("issueComment", doc.id, teamIds, comment._id, encodeIssueComment(company, doc)),
  );
};

const issueCommentDelete: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const comment = await byDomain(ctx, "issueComments", company._id, operation.entityId);
  if (comment === null) return rejected("entity-not-found", `No comment ${operation.entityId}.`);
  const teamIds = await issueTeamIds(ctx, company, comment.issueId);
  const permission = isOwnComment(comment.author, feedActor)
    ? "comments.updateOwn"
    : "comments.moderate";
  if (!can(actor, permission, teamIds)) return denied(permission);
  if (comment.deletedAt !== null) return applied();

  await ctx.db.patch(comment._id, { deletedAt: now, updatedAt: now });
  return applied(tombstone("issueComment", comment.id, teamIds, comment._id));
};

// ---------------------------------------------------------------------------
// issueView.*
// ---------------------------------------------------------------------------

/**
 * A shared view's feed row carries its team scope; a company view is company-wide. A private view
 * also rides the feed — the change teamIds mechanism cannot express "owner only", so it is gated by
 * `issues.read` like the rest of the issue domain and clients hide other members' private views.
 */
function viewChangeTeamIds(view: {
  readonly visibility: "private" | "teams" | "company";
  readonly teamIds: readonly string[];
}): readonly string[] {
  return view.visibility === "teams" ? view.teamIds : [];
}

const issueViewCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueViewCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  if (actor.kind !== "member") {
    // Views hang off a membership; a service identity has none to own one with.
    return rejected("permission-denied", "Saved views belong to members.");
  }
  const existing = await byDomain(ctx, "issueViews", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A view ${operation.entityId} already exists.`);
  }

  const visibility = args.visibility ?? "private";
  const teamIds = visibility === "teams" ? (args.teamIds ?? []) : [];
  if (visibility === "teams" && teamIds.length === 0) {
    return rejected("invalid-arguments", "A team-shared view names the teams it is shared with.");
  }
  const badTeam = await missingTeam(ctx, company, teamIds);
  if (badTeam !== null) return rejected("invalid-arguments", `No team ${badTeam}.`);
  if (visibility !== "private" && !can(actor, "views.shared", teamIds)) {
    return denied("views.shared");
  }

  const docId = await ctx.db.insert("issueViews", {
    id: operation.entityId,
    companyId: company._id,
    ownerMembershipId: actor.membership._id,
    visibility,
    teamIds: [...teamIds],
    name: args.name,
    config: args.config,
    position: args.position ?? 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert(
      "issueView",
      doc.id,
      viewChangeTeamIds(doc),
      docId,
      await encodeIssueView(ctx, company, doc),
    ),
  );
};

/** Owner edits their own view; anyone else needs the shared-view switch, and never on a private one. */
function mayEditView(actor: CompanyActor, view: Doc<"issueViews">): boolean {
  if (actor.kind !== "member") return false;
  if (view.ownerMembershipId === actor.membership._id) return true;
  if (view.visibility === "private") return false;
  return can(actor, "views.shared", viewChangeTeamIds(view));
}

const issueViewUpdate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueViewPatchArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const view = await byDomain(ctx, "issueViews", company._id, operation.entityId);
  if (view === null) return rejected("entity-not-found", `No view ${operation.entityId}.`);
  if (view.deletedAt !== null) return rejected("entity-deleted", "This view is deleted.");
  if (!mayEditView(actor, view)) return denied("views.shared");

  const visibility = args.visibility ?? view.visibility;
  const teamIds =
    visibility === "teams" ? (args.teamIds ?? view.teamIds) : args.teamIds !== undefined ? [] : [];
  if (visibility === "teams" && teamIds.length === 0) {
    return rejected("invalid-arguments", "A team-shared view names the teams it is shared with.");
  }
  const badTeam = await missingTeam(ctx, company, teamIds);
  if (badTeam !== null) return rejected("invalid-arguments", `No team ${badTeam}.`);
  // Widening visibility is sharing; it needs the same switch creating a shared view does.
  if (
    visibility !== "private" &&
    visibility !== view.visibility &&
    !can(actor, "views.shared", teamIds)
  ) {
    return denied("views.shared");
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.config !== undefined) patch["config"] = args.config;
  if (args.visibility !== undefined) patch["visibility"] = args.visibility;
  if (args.visibility !== undefined || args.teamIds !== undefined) patch["teamIds"] = [...teamIds];
  if (args.position !== undefined) patch["position"] = args.position;
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(view._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, view._id);
  return applied(
    upsert(
      "issueView",
      doc.id,
      viewChangeTeamIds(doc),
      view._id,
      await encodeIssueView(ctx, company, doc),
    ),
  );
};

const issueViewDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const view = await byDomain(ctx, "issueViews", company._id, operation.entityId);
  if (view === null) return rejected("entity-not-found", `No view ${operation.entityId}.`);
  if (!mayEditView(actor, view)) return denied("views.shared");
  if (view.deletedAt !== null) return applied();

  await ctx.db.patch(view._id, { deletedAt: now, updatedAt: now });
  return applied(tombstone("issueView", view.id, viewChangeTeamIds(view), view._id));
};

// ---------------------------------------------------------------------------
// issueThreadLink.*
// ---------------------------------------------------------------------------

const issueThreadLinkCreate: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueThreadLinkCreateArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const existing = await byDomain(ctx, "issueThreadLinks", company._id, operation.entityId);
  if (existing !== null) {
    return rejected("invalid-arguments", `A thread link ${operation.entityId} already exists.`);
  }
  const issue = await liveRow(ctx, "issues", company._id, args.issueId);
  if (issue === null) return rejected("invalid-arguments", `No issue ${args.issueId}.`);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", company._id).eq("environmentId", args.environmentId),
    )
    .unique();
  if (registration === null) {
    return rejected("invalid-arguments", `No environment ${args.environmentId} here.`);
  }

  // The same thread may be linked to several issues, but linking one issue to one thread twice is
  // a duplicate rather than a second link.
  const links = await ctx.db
    .query("issueThreadLinks")
    .withIndex("by_company_and_thread", (q) =>
      q
        .eq("companyId", company._id)
        .eq("environmentId", args.environmentId)
        .eq("threadId", args.threadId),
    )
    .collect();
  for (const link of links) {
    if (link.deletedAt === null && link.issueId === issue.id) {
      return rejected("invalid-arguments", "This thread is already linked to the issue.");
    }
  }

  const docId = await ctx.db.insert("issueThreadLinks", {
    id: operation.entityId,
    companyId: company._id,
    issueId: issue.id,
    environmentId: args.environmentId,
    threadId: args.threadId,
    origin: args.origin,
    createdByMembershipId: actor.kind === "member" ? actor.membership._id : null,
    createdAt: now,
    deletedAt: null,
    version: 0,
  });
  const doc = await mustGet(ctx, docId);
  return applied(
    upsert(
      "issueThreadLink",
      doc.id,
      issue.teamIds,
      docId,
      await encodeIssueThreadLink(ctx, company, doc),
    ),
  );
};

const issueThreadLinkDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const link = await byDomain(ctx, "issueThreadLinks", company._id, operation.entityId);
  if (link === null) return rejected("entity-not-found", `No thread link ${operation.entityId}.`);
  const teamIds = await issueTeamIds(ctx, company, link.issueId);
  if (!can(actor, "issues.update", teamIds)) return denied("issues.update");
  if (link.deletedAt !== null) return applied();

  await ctx.db.patch(link._id, { deletedAt: now });
  return applied(tombstone("issueThreadLink", link.id, teamIds, link._id));
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * One handler per issue-domain operation kind — exactly the `SYNC_OPERATION_KINDS` list. There is
 * deliberately no `issueAttachment.*` or `issueAuditEvent.*` operation: attachments are created by
 * the upload flow and audit events only ever by the server.
 */
export const ISSUE_DOMAIN_APPLY: Partial<Record<SyncOperationKind, DomainApply>> = {
  "issue.create": handler(issueCreate),
  "issue.update": handler(issueUpdate),
  "issue.delete": handler(issueDelete),
  "issue.restore": handler(issueRestore),
  "issue.setSortOrder": handler(issueSetSortOrder),
  "issue.setWorkflowOwner": handler(issueSetWorkflowOwner),
  "issue.setTeams": handler(issueSetTeams),
  "issueStatus.create": handler(issueStatusCreate),
  "issueStatus.update": handler(issueStatusUpdate),
  "issueStatus.delete": handler(issueStatusDelete),
  "issueStatus.reorder": handler(issueStatusReorder),
  "issueLabel.create": handler(issueLabelCreate),
  "issueLabel.update": handler(issueLabelUpdate),
  "issueLabel.delete": handler(issueLabelDelete),
  "issueMilestone.create": handler(issueMilestoneCreate),
  "issueMilestone.update": handler(issueMilestoneUpdate),
  "issueMilestone.delete": handler(issueMilestoneDelete),
  "issueCycle.create": handler(issueCycleCreate),
  "issueCycle.update": handler(issueCycleUpdate),
  "issueCycle.delete": handler(issueCycleDelete),
  "issueTodo.create": handler(issueTodoCreate),
  "issueTodo.update": handler(issueTodoUpdate),
  "issueTodo.delete": handler(issueTodoDelete),
  "issueRelation.create": handler(issueRelationCreate),
  "issueRelation.delete": handler(issueRelationDelete),
  "issueComment.create": handler(issueCommentCreate),
  "issueComment.update": handler(issueCommentUpdate),
  "issueComment.delete": handler(issueCommentDelete),
  "issueView.create": handler(issueViewCreate),
  "issueView.update": handler(issueViewUpdate),
  "issueView.delete": handler(issueViewDelete),
  "issueThreadLink.create": handler(issueThreadLinkCreate),
  "issueThreadLink.delete": handler(issueThreadLinkDelete),
};

// ---------------------------------------------------------------------------
// Bootstrap readers
// ---------------------------------------------------------------------------

/** One raw table row, lifted to what the bootstrap pager needs to page, filter, and encode it. */
export interface BootstrapRow {
  /** Domain id — the walk position within the table. */
  readonly id: string;
  readonly version: number;
  readonly deleted: boolean;
  /** Team scope for visibility filtering, same rules the change feed applies. */
  readonly teamIds: readonly string[];
  /** Wire payload; `null` when `deleted` (a deleted row is only a cursor position). */
  readonly payload: unknown;
}

/** Per-call memo of parent-issue team scopes, so a page of todos costs one issue read per issue. */
export interface BootstrapCache {
  readonly issueTeams: Map<string, readonly string[]>;
  readonly projectTeams: Map<string, readonly string[]>;
}

export function emptyBootstrapCache(): BootstrapCache {
  return { issueTeams: new Map(), projectTeams: new Map() };
}

async function cachedIssueTeams(
  ctx: QueryCtx,
  company: Doc<"companies">,
  cache: BootstrapCache,
  issueId: string,
): Promise<readonly string[]> {
  const hit = cache.issueTeams.get(issueId);
  if (hit !== undefined) return hit;
  const teamIds = await issueTeamIds(ctx, company, issueId);
  cache.issueTeams.set(issueId, teamIds);
  return teamIds;
}

async function cachedProjectTeams(
  ctx: QueryCtx,
  company: Doc<"companies">,
  cache: BootstrapCache,
  projectId: string,
): Promise<readonly string[]> {
  const hit = cache.projectTeams.get(projectId);
  if (hit !== undefined) return hit;
  const project = await byDomain(ctx, "cloudProjects", company._id, projectId);
  const teamIds = project?.teamIds ?? [];
  cache.projectTeams.set(projectId, teamIds);
  return teamIds;
}

function pageOf<TableName extends IssueDomainTable>(
  ctx: QueryCtx,
  table: TableName,
  companyId: Id<"companies">,
  afterId: string,
  limit: number,
): Promise<Doc<TableName>[]> {
  // Same representative-table cast as `byDomain`, for the same reason.
  return ctx.db
    .query(table as unknown as "issues")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).gt("id", afterId))
    .order("asc")
    .take(limit) as unknown as Promise<Doc<TableName>[]>;
}

/**
 * Reads the next raw slice of one entity kind's table, ascending by domain id from `afterId`, and
 * lifts each row for the pager. Deleted rows come back too — with no payload — because the walk
 * has to advance its cursor over them; the pager skips them without delivering anything, exactly
 * like the change feed skips rows the caller cannot see.
 */
export async function readBootstrapRows(
  ctx: QueryCtx,
  company: Doc<"companies">,
  kind: BootstrapEntityKind,
  afterId: string,
  limit: number,
  cache: BootstrapCache,
): Promise<readonly BootstrapRow[]> {
  const lift = async <Row extends { id: string; version: number; deletedAt?: number | null }>(
    rows: readonly Row[],
    teamsOf: (row: Row) => Promise<readonly string[]> | readonly string[],
    encode: (row: Row) => Promise<unknown> | unknown,
  ): Promise<readonly BootstrapRow[]> => {
    const lifted: BootstrapRow[] = [];
    for (const row of rows) {
      const deleted = (row.deletedAt ?? null) !== null;
      lifted.push({
        id: row.id,
        version: row.version,
        deleted,
        teamIds: deleted ? [] : await teamsOf(row),
        payload: deleted ? null : await encode(row),
      });
    }
    return lifted;
  };

  switch (kind) {
    case "issueStatus":
      return lift(
        await pageOf(ctx, "issueStatuses", company._id, afterId, limit),
        (row) => statusScopeTeamIds(row),
        (row) => encodeIssueStatus(company, row),
      );
    case "issueLabel":
      return lift(
        await pageOf(ctx, "issueLabels", company._id, afterId, limit),
        (row) => teamScope(row.teamId),
        (row) => encodeIssueLabel(company, row),
      );
    case "issueMilestone":
      return lift(
        await pageOf(ctx, "issueMilestones", company._id, afterId, limit),
        (row) => cachedProjectTeams(ctx, company, cache, row.cloudProjectId),
        (row) => encodeIssueMilestone(company, row),
      );
    case "issueCycle":
      return lift(
        await pageOf(ctx, "issueCycles", company._id, afterId, limit),
        (row) => teamScope(row.teamId),
        (row) => encodeIssueCycle(company, row),
      );
    case "issue":
      return lift(
        await pageOf(ctx, "issues", company._id, afterId, limit),
        (row) => row.teamIds,
        (row) => encodeIssue(company, row),
      );
    case "issueTodo":
      return lift(
        await pageOf(ctx, "issueTodos", company._id, afterId, limit),
        (row) => cachedIssueTeams(ctx, company, cache, row.issueId),
        (row) => encodeIssueTodo(company, row),
      );
    case "issueRelation":
      return lift(
        await pageOf(ctx, "issueRelations", company._id, afterId, limit),
        async (row) =>
          unionTeamIds(
            await cachedIssueTeams(ctx, company, cache, row.issueId),
            await cachedIssueTeams(ctx, company, cache, row.relatedIssueId),
          ),
        (row) => encodeIssueRelation(company, row),
      );
    case "issueComment":
      return lift(
        await pageOf(ctx, "issueComments", company._id, afterId, limit),
        (row) => cachedIssueTeams(ctx, company, cache, row.issueId),
        (row) => encodeIssueComment(company, row),
      );
    case "issueAttachment":
      return lift(
        await pageOf(ctx, "issueAttachments", company._id, afterId, limit),
        (row) => cachedIssueTeams(ctx, company, cache, row.issueId),
        (row) => encodeIssueAttachment(ctx, company, row),
      );
    case "issueView":
      return lift(
        await pageOf(ctx, "issueViews", company._id, afterId, limit),
        (row) => viewChangeTeamIds(row),
        (row) => encodeIssueView(ctx, company, row),
      );
    case "issueThreadLink":
      return lift(
        await pageOf(ctx, "issueThreadLinks", company._id, afterId, limit),
        (row) => cachedIssueTeams(ctx, company, cache, row.issueId),
        (row) => encodeIssueThreadLink(ctx, company, row),
      );
    case "issueAuditEvent":
      return lift(
        await pageOf(ctx, "issueAuditEvents", company._id, afterId, limit),
        (row) => cachedIssueTeams(ctx, company, cache, row.issueId),
        (row) => encodeIssueAuditEvent(company, row),
      );
  }
}
