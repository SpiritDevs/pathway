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
import { ISSUE_KEY_BLOCK_SIZE } from "../../src/issueKeys.ts";
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
import {
  carryOverStatusId,
  effectiveStatusFor,
  firstVisibleStatus,
  mergeEffectiveWorkflow,
  statusVariantViolation,
  type EffectiveStatus,
  type StatusIdentity,
} from "../../src/sync/workflow.ts";
import { internal } from "../_generated/api.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { DomainApply, DomainChange, DomainOutcome } from "../sync.ts";
// The company domain's encoders, used only by `readBootstrapRows` below: a seeded company record
// and the same record delivered by `lib/companyApply`'s feed writer must be byte-identical, which
// only holds if there is one encoder. The dependency is one-way — nothing in `companyApply` reaches
// back here.
import {
  companyRowVersion,
  companySettingsDomainId,
  encodeCompany,
  encodeCompanySettings,
  encodeCloudProject,
  encodeEnvironmentBinding,
  encodeEnvironmentCommand,
  encodeEnvironmentRegistration,
  encodeAgentThread,
  encodeMembership,
  encodeRole,
  encodeRoleAssignment,
  encodeTeam,
  encodeTeamMembership,
} from "./companyApply.ts";
import { syncOperationActorRecord, type CompanyActor } from "./identity.ts";

type FeedActor = ReturnType<typeof syncOperationActorRecord>;

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function rejected(
  code:
    | "invalid-arguments"
    | "permission-denied"
    | "entity-not-found"
    | "entity-deleted"
    // What a sweep past its ceiling answers: the operation is blocked by the volume of dependent
    // rows it would have to migrate, not by anything wrong with its arguments.
    | "dependency-blocked",
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

export function encodeIssue(company: Doc<"companies">, doc: Doc<"issues">): unknown {
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
    // Optional in storage so rows written before the column existed still validate; the wire shape
    // has always carried an explicit `null` for "no pull request".
    pullRequest: doc.pullRequest ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function encodeIssueStatus(company: Doc<"companies">, doc: Doc<"issueStatuses">): unknown {
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

export function encodeIssueLabel(company: Doc<"companies">, doc: Doc<"issueLabels">): unknown {
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

export function encodeIssueMilestone(
  company: Doc<"companies">,
  doc: Doc<"issueMilestones">,
): unknown {
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

export function encodeIssueCycle(company: Doc<"companies">, doc: Doc<"issueCycles">): unknown {
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

export function encodeIssueTodo(company: Doc<"companies">, doc: Doc<"issueTodos">): unknown {
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

export function encodeIssueRelation(
  company: Doc<"companies">,
  doc: Doc<"issueRelations">,
): unknown {
  return {
    id: doc.id,
    companyId: company.id,
    issueId: doc.issueId,
    relatedIssueId: doc.relatedIssueId,
    kind: doc.kind,
    createdAt: doc.createdAt,
  };
}

export function encodeIssueComment(company: Doc<"companies">, doc: Doc<"issueComments">): unknown {
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

export async function encodeIssueAttachment(
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

export async function encodeIssueView(
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

export function encodeIssueAuditEvent(
  company: Doc<"companies">,
  doc: Doc<"issueAuditEvents">,
): unknown {
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

export async function encodeIssueThreadLink(
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
 * A tombstone that tells `teamIds` the entity has left their audience, for the case where the
 * entity's new state hides it from them: a saved view that just turned private.
 *
 * The ordinary owner-private gate is derived from the view's *current* row, so an upsert announcing
 * the change is delivered to the new owner-only audience and to nobody else — which leaves every
 * replica that already holds the view believing it still has it. This row carries no payload and no
 * `versionDocId` (the accompanying upsert stamps the entity's version), and is filtered on team
 * scope alone. It discloses nothing: those replicas already hold the id.
 */
function departureTombstone(
  entityKind: DomainChange["entityKind"],
  entityId: string,
  teamIds: readonly string[],
): DomainChange {
  return {
    entityKind,
    entityId,
    changeKind: "tombstone",
    teamIds,
    versionDocId: null,
    departure: true,
    payload: null,
  };
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
  kind: "created" | "field_changed" | "deleted" | "restored" | "triage_rejected",
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

/**
 * How many stored status rows one chain may hold. A workflow is a board a human reads, so the
 * ceiling is generous rather than tight; what it buys is that resolving one — which every issue
 * placement does — is a bounded read instead of a `.collect()` that a pathological catalog could
 * push past Convex's transaction limits, wedging the operation permanently.
 */
const WORKFLOW_MAX_STATUSES = 200;

/**
 * Every live row of one status partition: the company base chain, or one team's own rows (its
 * overrides and its team-only statuses), which is the same partition `issueStatus.create` appends
 * to and `issueStatus.reorder` orders. `null` means the partition is past its ceiling — the caller
 * refuses rather than reading a truncated chain and calling it the workflow.
 */
async function liveStatusRows(
  ctx: QueryCtx,
  company: Doc<"companies">,
  of: { readonly scope: "company" | "team"; readonly teamId: string | null },
): Promise<readonly Doc<"issueStatuses">[] | null> {
  const teamId = of.teamId;
  const rows =
    of.scope === "team" && teamId !== null
      ? await ctx.db
          .query("issueStatuses")
          .withIndex("by_company_team_and_deleted", (q) =>
            q.eq("companyId", company._id).eq("teamId", teamId).eq("deletedAt", null),
          )
          .take(WORKFLOW_MAX_STATUSES + 1)
      : await ctx.db
          .query("issueStatuses")
          .withIndex("by_company_scope_and_deleted", (q) =>
            q.eq("companyId", company._id).eq("scope", "company").eq("deletedAt", null),
          )
          .take(WORKFLOW_MAX_STATUSES + 1);
  return rows.length > WORKFLOW_MAX_STATUSES ? null : rows;
}

function workflowTooLarge(): DomainOutcome {
  return rejected(
    "dependency-blocked",
    `A workflow may hold ${WORKFLOW_MAX_STATUSES} statuses; this one holds more.`,
  );
}

/**
 * The one answer to "what are the effective statuses of this owner": company bases with the owning
 * team's overrides applied, the team's own statuses merged in, ordered. Every path that places or
 * moves an issue reads the workflow through here, so a status a team hides is hidden for all of
 * them and an override is the same column as the base it overrides everywhere.
 */
async function effectiveWorkflow(
  ctx: QueryCtx,
  company: Doc<"companies">,
  owner: IssueWorkflowOwner,
): Promise<Resolved<readonly EffectiveStatus[]>> {
  const bases = await liveStatusRows(ctx, company, { scope: "company", teamId: null });
  if (bases === null) return { ok: false, outcome: workflowTooLarge() };
  let teamRows: readonly Doc<"issueStatuses">[] = [];
  if (owner.kind === "team") {
    const rows = await liveStatusRows(ctx, company, { scope: "team", teamId: owner.teamId });
    if (rows === null) return { ok: false, outcome: workflowTooLarge() };
    teamRows = rows;
  }
  return { ok: true, value: mergeEffectiveWorkflow(bases, teamRows) };
}

/**
 * The status a new issue lands in when its create named none, or a restore found its own gone: the
 * first visible column of the owner's effective workflow. `null` is a workflow with nowhere to land.
 */
async function defaultStatusId(
  ctx: QueryCtx,
  company: Doc<"companies">,
  owner: IssueWorkflowOwner,
): Promise<Resolved<string | null>> {
  const workflow = await effectiveWorkflow(ctx, company, owner);
  if (!workflow.ok) return workflow;
  return { ok: true, value: firstVisibleStatus(workflow.value)?.id ?? null };
}

/** Whether `status` belongs to `owner`'s workflow. A team workflow inherits every company status. */
function statusMatchesOwner(status: Doc<"issueStatuses">, owner: IssueWorkflowOwner): boolean {
  if (status.scope === "company") return true;
  return owner.kind === "team" && status.teamId === owner.teamId;
}

/**
 * What a status row means for a carry-over, independently of which row expresses it: an override
 * stands for its base and inherits the base's category when it sets none of its own.
 */
async function statusIdentity(
  ctx: QueryCtx,
  company: Doc<"companies">,
  status: Doc<"issueStatuses">,
): Promise<StatusIdentity> {
  const baseId = status.scope === "company" ? status.id : status.baseStatusId;
  if (status.category !== null || status.baseStatusId === null) {
    return { baseId, category: status.category };
  }
  const base = await liveRow(ctx, "issueStatuses", company._id, status.baseStatusId);
  return { baseId, category: base?.category ?? null };
}

/** A relation is visible from either end, so its feed row carries both issues' teams. */
function unionTeamIds(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])];
}

/**
 * The audience a team-scope change has to reach: everyone who could see the record before it moved
 * and everyone who can see it after. Scoping such a row to the new teams alone leaves a descoped
 * member's replica holding a copy it will never hear about again — bootstrap would omit the record
 * entirely, so the two disagree forever.
 *
 * An empty list is the *narrowest* audience there is, not the widest: `[]` reaches company-scoped
 * grants only, while `[A]` reaches company-scoped grants *and* team A. So the union of the two
 * audiences is the union of the lists — except when one side is empty, where it is the other list,
 * which already contains the company-scoped readers the empty side stood for.
 */
function scopeChangeTeamIds(
  before: readonly string[],
  after: readonly string[],
): readonly string[] {
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return unionTeamIds(before, after);
}

/**
 * Whether a team-scoped reference — a label, a cycle — is one the issue's teams can justify. A
 * company entry (`null` team) is usable everywhere; a team entry needs its team attached. This is
 * the invariant `issue.setTeams` maintains when a team is removed, enforced on the way in too so a
 * client never receives a reference it cannot resolve.
 */
function teamScopeJustified(teamId: string | null, issueTeamIds: readonly string[]): boolean {
  return teamId === null || issueTeamIds.includes(teamId);
}

/**
 * The same question for a project, which carries a set of teams rather than one: a company-wide
 * project is usable everywhere, a team-scoped one needs an overlap with the issue's teams. This is
 * exactly the predicate `issue.setTeams` applies when it decides whether a move strands the issue's
 * project reference, enforced on the way in so the two can never disagree.
 */
function projectScopeJustified(
  projectTeamIds: readonly string[],
  issueTeamIds: readonly string[],
): boolean {
  return (
    projectTeamIds.length === 0 || projectTeamIds.some((teamId) => issueTeamIds.includes(teamId))
  );
}

type Resolved<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly outcome: DomainOutcome };

/**
 * The project an issue may point at: live, unarchived, readable by the actor, and in a team scope
 * the issue's own teams justify. Existence alone is not enough — without the read check an actor
 * confined to one team could file its issues against another team's project, and the refusal is
 * worded like a missing project so it cannot double as an existence oracle for ids it may not see.
 */
async function resolveIssueProject(
  ctx: QueryCtx,
  actor: CompanyActor,
  company: Doc<"companies">,
  projectId: string,
  issueTeamIds: readonly string[],
): Promise<Resolved<Doc<"cloudProjects">>> {
  const project = await liveRow(ctx, "cloudProjects", company._id, projectId);
  if (
    project === null ||
    project.archivedAt !== null ||
    !can(actor, "projects.read", project.teamIds)
  ) {
    return { ok: false, outcome: rejected("invalid-arguments", `No project ${projectId}.`) };
  }
  if (!projectScopeJustified(project.teamIds, issueTeamIds)) {
    return {
      ok: false,
      outcome: rejected("invalid-arguments", `The project ${projectId} belongs to another team.`),
    };
  }
  return { ok: true, value: project };
}

/**
 * Whether a new assignment may name this membership. Departed members stay on the issues they
 * already hold — attribution survives a departure, which is why memberships are tombstoned rather
 * than deleted — but handing *new* work to a membership this company cannot resolve, or to one that
 * is locked or gone, writes authoritative issue data no replica can render.
 */
async function assignableMembership(
  ctx: QueryCtx,
  company: Doc<"companies">,
  membershipId: string,
): Promise<Doc<"memberships"> | null> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_domain_id", (q) => q.eq("id", membershipId))
    .unique();
  if (membership === null) return null;
  if (membership.companyId !== company._id || membership.state !== "active") return null;
  return membership;
}

/** Refusal for an assignee naming a membership {@link assignableMembership} will not accept. */
async function unassignableAssignee(
  ctx: QueryCtx,
  company: Doc<"companies">,
  assignee: { readonly kind: string; readonly membershipId?: string } | null | undefined,
): Promise<DomainOutcome | null> {
  if (assignee === null || assignee === undefined || assignee.kind !== "member") return null;
  const membershipId = assignee.membershipId ?? "";
  const membership = await assignableMembership(ctx, company, membershipId);
  return membership === null
    ? rejected("invalid-arguments", `No active member ${membershipId} here.`)
    : null;
}

/**
 * Whether the actor may point another record at `issue`. A missing issue and one in a team the
 * actor holds no `issues.read` on answer the same, so a cross-team pointer cannot be used to probe
 * which ids exist.
 */
function readableIssue(actor: CompanyActor, issue: Doc<"issues"> | null): issue is Doc<"issues"> {
  return issue !== null && can(actor, "issues.read", issue.teamIds);
}

/** How far a re-parent looks up the tree before giving up; a deeper chain is already broken. */
const ISSUE_PARENT_MAX_DEPTH = 100;

/**
 * Whether `issueId` is `start` or one of its ancestors. Re-parenting an issue under its own
 * descendant closes the tree into a cycle — every client that walks sub-issues for rollups or
 * breadcrumbs then recurses forever — and each end of the cycle is a separately valid operation, so
 * the check has to walk. The walk is bounded so a cycle that predates it cannot spin.
 */
async function hasAncestor(
  ctx: QueryCtx,
  company: Doc<"companies">,
  start: Doc<"issues">,
  issueId: string,
): Promise<boolean> {
  let current: Doc<"issues"> | null = start;
  for (let depth = 0; depth < ISSUE_PARENT_MAX_DEPTH && current !== null; depth += 1) {
    if (current.id === issueId) return true;
    const parentId: string | null = current.parentId;
    current = parentId === null ? null : await byDomain(ctx, "issues", company._id, parentId);
  }
  return false;
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
      feedActor: syncOperationActorRecord(actor, operation.actor, operation.environmentId),
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

  if (args.slackSource !== undefined) {
    if (
      actor.kind !== "environment" ||
      operation.actor.kind !== "system" ||
      operation.actor.source !== "slack" ||
      operation.environmentId !== actor.registration.environmentId
    ) {
      return rejected(
        "permission-denied",
        "Only an authenticated environment Slack intake service may set Slack source metadata.",
      );
    }
    if (args.slackSource.issueId !== operation.entityId) {
      return rejected("invalid-arguments", "The Slack source must name the issue being created.");
    }
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
    const resolved = await resolveIssueProject(ctx, actor, company, args.projectId, teamIds);
    if (!resolved.ok) return resolved.outcome;
    project = resolved.value;
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
    if (!fallback.ok) return fallback.outcome;
    if (fallback.value === null) {
      return rejected("invalid-arguments", "This workflow has no status to place the issue in.");
    }
    statusId = fallback.value;
  }

  for (const labelId of args.labelIds ?? []) {
    const label = await liveRow(ctx, "issueLabels", company._id, labelId);
    if (label === null) return rejected("invalid-arguments", `No label ${labelId}.`);
    if (!teamScopeJustified(label.teamId, teamIds)) {
      return rejected("invalid-arguments", `The label ${labelId} belongs to another team.`);
    }
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
    if (!teamScopeJustified(cycle.teamId, teamIds)) {
      return rejected("invalid-arguments", `The cycle ${args.cycleId} belongs to another team.`);
    }
  }
  if (args.parentId !== undefined) {
    const parent = await liveRow(ctx, "issues", company._id, args.parentId);
    if (!readableIssue(actor, parent)) {
      return rejected("invalid-arguments", `No issue ${args.parentId}.`);
    }
  }
  const badAssignee = await unassignableAssignee(ctx, company, args.assignee);
  if (badAssignee !== null) return badAssignee;

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
    keyNumber = issueKeyNumber(args.key);
    // A leased number is always below the counter, so anything more than one block above it was
    // never handed out. Accepting it would push the counter along with it: past the safe-integer
    // range `nextIssueNumber + 1` stops advancing, and every later create would mint the same key.
    if (
      !Number.isSafeInteger(keyNumber) ||
      keyNumber < 1 ||
      keyNumber > freshCompany.nextIssueNumber + ISSUE_KEY_BLOCK_SIZE
    ) {
      return rejected("invalid-arguments", `The key ${args.key} is outside this company's range.`);
    }
    key = args.key;
  } else {
    keyNumber = freshCompany.nextIssueNumber;
    key = `${freshCompany.issueKeyPrefix}-${keyNumber}`;
  }
  // Checked on both paths: a counter nudged forward by an earlier accepted key can hand out a
  // number an existing issue already carries, and two issues sharing a key is the one outcome the
  // leasing scheme exists to prevent.
  const collision = await ctx.db
    .query("issues")
    .withIndex("by_company_and_key", (q) => q.eq("companyId", company._id).eq("key", key))
    .unique();
  if (collision !== null) return rejected("invalid-arguments", `The key ${key} is taken.`);
  // A key at or past the counter would collide with a future lease.
  if (keyNumber >= freshCompany.nextIssueNumber) {
    await ctx.db.patch(company._id, { nextIssueNumber: keyNumber + 1 });
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
    slackSource: args.slackSource ?? null,
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
    const resolved = await resolveIssueProject(ctx, actor, company, args.projectId, issue.teamIds);
    if (!resolved.ok) return resolved.outcome;
  }
  // The pair is judged after the whole patch, not field by field: a milestone is project-owned, so
  // moving the project while saying nothing about the milestone would otherwise leave the issue
  // pointing at a milestone belonging to the project it just left. An explicitly named mismatch is
  // a client error and refused; an implicitly stranded one is cleared, the way `issueMilestone.
  // update` clears the issues a milestone leaves behind.
  const effectiveProjectId = args.projectId !== undefined ? args.projectId : issue.projectId;
  if (args.milestoneId != null) {
    const milestone = await liveRow(ctx, "issueMilestones", company._id, args.milestoneId);
    if (milestone === null) {
      return rejected("invalid-arguments", `No milestone ${args.milestoneId}.`);
    }
    if (milestone.cloudProjectId !== effectiveProjectId) {
      return rejected("invalid-arguments", "The milestone belongs to a different project.");
    }
  }
  const projectChanged = args.projectId !== undefined && args.projectId !== issue.projectId;
  let strandedMilestone = false;
  if (projectChanged && args.milestoneId === undefined && issue.milestoneId !== null) {
    const milestone = await liveRow(ctx, "issueMilestones", company._id, issue.milestoneId);
    strandedMilestone = milestone === null || milestone.cloudProjectId !== effectiveProjectId;
  }
  if (args.cycleId != null) {
    const cycle = await liveRow(ctx, "issueCycles", company._id, args.cycleId);
    if (cycle === null) return rejected("invalid-arguments", `No cycle ${args.cycleId}.`);
    if (!teamScopeJustified(cycle.teamId, issue.teamIds)) {
      return rejected("invalid-arguments", `The cycle ${args.cycleId} belongs to another team.`);
    }
  }
  if (args.parentId != null) {
    if (args.parentId === issue.id) {
      return rejected("invalid-arguments", "An issue cannot be its own parent.");
    }
    const parent = await liveRow(ctx, "issues", company._id, args.parentId);
    if (!readableIssue(actor, parent)) {
      return rejected("invalid-arguments", `No issue ${args.parentId}.`);
    }
    if (await hasAncestor(ctx, company, parent, issue.id)) {
      return rejected("invalid-arguments", "That parent is already below this issue.");
    }
  }
  for (const labelId of args.labelIds ?? []) {
    const label = await liveRow(ctx, "issueLabels", company._id, labelId);
    if (label === null) return rejected("invalid-arguments", `No label ${labelId}.`);
    if (!teamScopeJustified(label.teamId, issue.teamIds)) {
      return rejected("invalid-arguments", `The label ${labelId} belongs to another team.`);
    }
  }
  const badAssignee = await unassignableAssignee(ctx, company, args.assignee);
  if (badAssignee !== null) return badAssignee;

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
  set("milestoneId", strandedMilestone ? null : args.milestoneId);
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

const issueTriageReject: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (!can(actor, "issues.delete", issue.teamIds)) return denied("issues.delete");
  if (issue.deletedAt !== null) return applied();
  if (!issue.triage) return rejected("invalid-arguments", "Only a triage item can be rejected.");

  await ctx.db.patch(issue._id, { deletedAt: now, updatedAt: now });
  return applied(
    tombstone("issue", issue.id, issue.teamIds, issue._id),
    await appendAuditEvent(
      ctx,
      company,
      feedActor,
      operation,
      0,
      issue,
      "triage_rejected",
      {},
      now,
    ),
  );
};

const issueRestore: EnvApply = async ({ ctx, actor, company, feedActor, operation, now }) => {
  const parsed = decoded(parseNoArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;

  const issue = await byDomain(ctx, "issues", company._id, operation.entityId);
  if (issue === null) return rejected("entity-not-found", `No issue ${operation.entityId}.`);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");
  if (issue.deletedAt === null) return applied();

  // A deleted issue is skipped by every reference sweep there is — status deletion walks live rows
  // only, and so do project and parent moves — so the world it pointed at may be gone by the time
  // somebody restores it. Reviving the row untouched publishes a live issue referencing tombstones
  // no replica can resolve, so the references are repaired in the same write that revives it.
  const patch: Record<string, unknown> = { deletedAt: null, updatedAt: now };
  const normalized: Record<string, { readonly before: unknown; readonly after: unknown }> = {};
  const normalize = (field: keyof Doc<"issues"> & string, after: unknown) => {
    patch[field] = after;
    normalized[field] = { before: issue[field as keyof Doc<"issues">] ?? null, after };
  };

  // Status first: there is no unset status outside triage, so an unusable one is replaced with the
  // effective default of the issue's own workflow rather than cleared.
  const status =
    issue.statusId === "" ? null : await liveRow(ctx, "issueStatuses", company._id, issue.statusId);
  const statusUsable =
    issue.statusId === ""
      ? issue.triage
      : status !== null && statusMatchesOwner(status, issue.workflowOwner);
  if (!statusUsable) {
    const fallback = await defaultStatusId(ctx, company, issue.workflowOwner);
    if (!fallback.ok) return fallback.outcome;
    if (fallback.value === null) {
      return rejected(
        "invalid-arguments",
        "This workflow has no status to restore the issue into.",
      );
    }
    normalize("statusId", fallback.value);
  }

  if (issue.parentId !== null) {
    const parent = await liveRow(ctx, "issues", company._id, issue.parentId);
    if (parent === null) normalize("parentId", null);
  }

  // A project reference the issue's teams can no longer justify goes the way `issue.setTeams` sends
  // it, and its milestone with it: a milestone is project-owned, so a cleared project cannot leave
  // one behind.
  let projectId = issue.projectId;
  if (projectId !== null) {
    const project = await liveRow(ctx, "cloudProjects", company._id, projectId);
    if (
      project === null ||
      project.archivedAt !== null ||
      !projectScopeJustified(project.teamIds, issue.teamIds)
    ) {
      projectId = null;
      normalize("projectId", null);
    }
  }
  if (issue.milestoneId !== null) {
    const milestone = await liveRow(ctx, "issueMilestones", company._id, issue.milestoneId);
    if (milestone === null || milestone.cloudProjectId !== projectId)
      normalize("milestoneId", null);
  }

  await ctx.db.patch(issue._id, patch);
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
      "restored",
      Object.keys(normalized).length === 0 ? {} : { changes: normalized },
      now,
    ),
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

  // Status carryover, judged against the *effective* target workflow rather than against raw rows:
  // the column an issue occupies is a base plus whatever the owning team overrode on it, so "the
  // target still has this status" means the target resolves the same base — under the override's
  // id when the target team has one — and does not hide it.
  const resolvedTarget = await effectiveWorkflow(ctx, company, owner);
  if (!resolvedTarget.ok) return resolvedTarget.outcome;
  const target = resolvedTarget.value;

  const current =
    issue.statusId === "" ? null : await liveRow(ctx, "issueStatuses", company._id, issue.statusId);

  let statusId: string;
  if (args.statusId !== undefined) {
    // An explicitly named target is a decision, not a hint: it wins over the automatic carry-over,
    // and it has to be a column the target workflow actually shows.
    const explicit = effectiveStatusFor(target, args.statusId);
    if (explicit === null || explicit.hidden) {
      return rejected("invalid-arguments", "The status belongs to a different workflow.");
    }
    statusId = explicit.id;
  } else if (issue.triage && issue.statusId === "") {
    // A triage item sits outside the workflow entirely; moving its owner does not file it.
    statusId = "";
  } else {
    const carried =
      current === null
        ? null
        : carryOverStatusId(target, await statusIdentity(ctx, company, current));
    if (carried !== null) {
      statusId = carried;
    } else if (current !== null) {
      // The contract's own escalation: reuse the inherited base, else the first target column in
      // the same semantic category, else ask. Dropping the issue into the target's first column
      // instead would silently reopen finished work.
      return rejected(
        "invalid-arguments",
        "The target workflow has no matching status; name the one this issue should land in.",
      );
    } else {
      // No status to carry over at all — a row whose status died while it sat there. Landing in the
      // target's first visible column is the only answer that keeps the issue on a board.
      const fallback = firstVisibleStatus(target);
      if (fallback === null) {
        return rejected("invalid-arguments", "The target workflow has no status to land in.");
      }
      statusId = fallback.id;
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

/**
 * How many dependent rows one team-scope change may republish. The migration has to be atomic with
 * the move — a half-migrated issue is exactly the divergence it exists to prevent — so it has to fit
 * in one mutation, and an issue whose conversation outgrew that is refused loudly rather than
 * migrated silently short. The remedy for such an issue is a client reseed, which the refusal names.
 */
const ISSUE_SCOPE_MIGRATION_MAX_ROWS = 500;

function tooManyDependents(issue: Doc<"issues">): DomainOutcome {
  return rejected(
    "dependency-blocked",
    `Issue ${issue.key} carries more than ${ISSUE_SCOPE_MIGRATION_MAX_ROWS} dependent records; ` +
      "a team change cannot migrate them in one operation.",
  );
}

/**
 * Everything hanging off an issue, republished under the union of the audiences its move spans.
 *
 * Comments, todos, attachments, relations, and thread links carry no team scope of their own: they
 * inherit the parent issue's, both in the feed and in `bootstrap`. So moving the parent alone moves
 * *nothing* for a replica that already holds them or is about to need them — the teams gaining the
 * issue never hear the children exist, and the teams losing it keep theirs forever. Re-emitting each
 * child as an upsert at the union audience is what makes the gaining replicas acquire them and lets
 * the losing ones drop them alongside the parent.
 *
 * Audit history is deliberately not republished: it is append-only and unbounded, the one thing that
 * could not fit a bounded migration, and a replica that newly gains an issue seeds its history on
 * its next bootstrap rather than replaying years of it through the feed.
 */
async function issueScopeMigrationChanges(
  ctx: MutationCtx,
  company: Doc<"companies">,
  issue: Doc<"issues">,
  before: readonly string[],
  after: readonly string[],
): Promise<Resolved<readonly DomainChange[]>> {
  const audience = scopeChangeTeamIds(before, after);
  const cap = ISSUE_SCOPE_MIGRATION_MAX_ROWS + 1;
  const changes: DomainChange[] = [];
  const room = () => cap - changes.length;

  const todos = await ctx.db
    .query("issueTodos")
    .withIndex("by_company_issue_and_deleted", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id).eq("deletedAt", null),
    )
    .take(room());
  for (const row of todos) {
    changes.push(upsert("issueTodo", row.id, audience, row._id, encodeIssueTodo(company, row)));
  }
  if (room() <= 0) return { ok: false, outcome: tooManyDependents(issue) };

  const comments = await ctx.db
    .query("issueComments")
    .withIndex("by_company_issue_and_deleted", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id).eq("deletedAt", null),
    )
    .take(room());
  for (const row of comments) {
    changes.push(
      upsert("issueComment", row.id, audience, row._id, encodeIssueComment(company, row)),
    );
  }
  if (room() <= 0) return { ok: false, outcome: tooManyDependents(issue) };

  const attachments = await ctx.db
    .query("issueAttachments")
    .withIndex("by_company_issue_and_deleted", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id).eq("deletedAt", null),
    )
    .take(room());
  for (const row of attachments) {
    changes.push(
      upsert(
        "issueAttachment",
        row.id,
        audience,
        row._id,
        await encodeIssueAttachment(ctx, company, row),
      ),
    );
  }
  if (room() <= 0) return { ok: false, outcome: tooManyDependents(issue) };

  const links = await ctx.db
    .query("issueThreadLinks")
    .withIndex("by_company_issue_and_deleted", (q) =>
      q.eq("companyId", company._id).eq("issueId", issue.id).eq("deletedAt", null),
    )
    .take(room());
  for (const row of links) {
    changes.push(
      upsert(
        "issueThreadLink",
        row.id,
        audience,
        row._id,
        await encodeIssueThreadLink(ctx, company, row),
      ),
    );
  }
  if (room() <= 0) return { ok: false, outcome: tooManyDependents(issue) };

  // A relation is visible from either end, so its audience is this issue's move unioned with the
  // other issue's own teams — and both directions have to be walked, because the moved issue may be
  // either end of the pair.
  const seenRelations = new Set<string>();
  for (const direction of ["issueId", "relatedIssueId"] as const) {
    const rows =
      direction === "issueId"
        ? await ctx.db
            .query("issueRelations")
            .withIndex("by_company_issue_and_deleted", (q) =>
              q.eq("companyId", company._id).eq("issueId", issue.id).eq("deletedAt", null),
            )
            .take(room())
        : await ctx.db
            .query("issueRelations")
            .withIndex("by_company_related_issue_and_deleted", (q) =>
              q.eq("companyId", company._id).eq("relatedIssueId", issue.id).eq("deletedAt", null),
            )
            .take(room());
    for (const row of rows) {
      if (seenRelations.has(row.id)) continue;
      seenRelations.add(row.id);
      const otherId = direction === "issueId" ? row.relatedIssueId : row.issueId;
      const otherTeams = otherId === issue.id ? [] : await issueTeamIds(ctx, company, otherId);
      changes.push(
        upsert(
          "issueRelation",
          row.id,
          unionTeamIds(audience, otherTeams),
          row._id,
          encodeIssueRelation(company, row),
        ),
      );
    }
    if (room() <= 0) return { ok: false, outcome: tooManyDependents(issue) };
  }

  return { ok: true, value: changes };
}

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

  // Attaching is judged against the team being attached, the way creating an issue there is: a
  // grant on the issue's current teams says nothing about the team it is being moved into, and
  // making it company-wide needs the company-scoped grant. Without this, setTeams would be a
  // weaker path into another team's scope than `issue.create`.
  for (const teamId of teamIds) {
    if (issue.teamIds.includes(teamId)) continue;
    if (!can(actor, "issues.update", [teamId])) return denied("issues.update");
  }
  if (teamIds.length === 0 && !can(actor, "issues.update", [])) return denied("issues.update");

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
  // A team-visible project the issue's teams no longer reach goes the same way, and its milestone
  // with it: a milestone is project-owned, so a cleared project reference cannot leave one behind.
  let projectId = issue.projectId;
  let milestoneId = issue.milestoneId;
  if (projectId !== null) {
    const project = await liveRow(ctx, "cloudProjects", company._id, projectId);
    const justified =
      project !== null &&
      (project.teamIds.length === 0 || project.teamIds.some((teamId) => nextTeams.has(teamId)));
    if (!justified) {
      projectId = null;
      milestoneId = null;
    }
  }
  let owner = issue.workflowOwner;
  let statusId = issue.statusId;
  if (owner.kind === "team" && !nextTeams.has(owner.teamId)) {
    owner = { kind: "company" };
    const current =
      statusId === "" ? null : await liveRow(ctx, "issueStatuses", company._id, statusId);
    // The same carry-over `issue.setWorkflowOwner` performs — an issue sitting on a team override
    // belongs on that override's base once the company workflow takes over, not wherever the first
    // company column happens to be. Unlike the explicit move there is nobody to ask here, so a
    // carry-over with no match falls back to the first visible column rather than refusing.
    const resolvedTarget = await effectiveWorkflow(ctx, company, owner);
    if (!resolvedTarget.ok) return resolvedTarget.outcome;
    const target = resolvedTarget.value;
    const carried =
      current === null
        ? null
        : carryOverStatusId(target, await statusIdentity(ctx, company, current));
    if (carried !== null) {
      statusId = carried;
    } else if (statusId !== "" || !issue.triage) {
      const fallback = firstVisibleStatus(target);
      if (fallback === null) {
        return rejected("invalid-arguments", "The company workflow has no status to land in.");
      }
      statusId = fallback.id;
    }
  }

  // Everything hanging off the issue moves with it, and it has to be collected before the first
  // write: an issue too large to migrate is refused whole rather than half-moved.
  const scopeChanged =
    issue.teamIds.length !== teamIds.length ||
    issue.teamIds.some((teamId) => !nextTeams.has(teamId));
  let dependents: readonly DomainChange[] = [];
  if (scopeChanged) {
    const migrated = await issueScopeMigrationChanges(ctx, company, issue, issue.teamIds, teamIds);
    if (!migrated.ok) return migrated.outcome;
    dependents = migrated.value;
  }

  await ctx.db.patch(issue._id, {
    teamIds: [...teamIds],
    labelIds: keptLabelIds,
    cycleId,
    projectId,
    milestoneId,
    workflowOwner: owner,
    statusId,
    updatedAt: now,
  });
  const doc = await mustGet(ctx, issue._id);
  return applied(
    // The feed row carries the teams from *both* sides of the move: the newly attached teams get
    // the complete entity, and a removed team's members get one last upsert whose payload no longer
    // names them, which is what tells their replica to drop the issue. Scoping it to the new teams
    // alone would leave that replica holding a stale copy no later change could ever correct.
    upsert(
      "issue",
      doc.id,
      scopeChangeTeamIds(issue.teamIds, doc.teamIds),
      issue._id,
      encodeIssue(company, doc),
    ),
    ...dependents,
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

/**
 * Every live override of one company base, across teams. Bounded by the workflow ceiling: an
 * override chain wider than a company has teams is already past what one mutation may sweep.
 */
async function liveOverridesOfBase(
  ctx: QueryCtx,
  company: Doc<"companies">,
  baseStatusId: string,
): Promise<readonly Doc<"issueStatuses">[] | null> {
  const rows = await ctx.db
    .query("issueStatuses")
    .withIndex("by_company_base_and_deleted", (q) =>
      q.eq("companyId", company._id).eq("baseStatusId", baseStatusId).eq("deletedAt", null),
    )
    .take(WORKFLOW_MAX_STATUSES + 1);
  return rows.length > WORKFLOW_MAX_STATUSES ? null : rows;
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
  // The row has to be one of the three shapes a workflow resolves — a complete company base, a
  // team's override of one, or a complete team-only status. Anything else is a row no board can
  // render: a company status inheriting from another, or a standalone column with no name.
  const violation = statusVariantViolation({
    id: operation.entityId,
    scope: args.scope,
    teamId,
    baseStatusId,
    name: args.name ?? null,
    color: args.color ?? null,
    category: args.category ?? null,
    position: args.position ?? null,
    hidden: args.hidden ?? false,
  });
  if (violation !== null) return rejected("invalid-arguments", violation);

  if (baseStatusId !== null) {
    const base = await liveRow(ctx, "issueStatuses", company._id, baseStatusId);
    if (base === null || base.scope !== "company") {
      return rejected("invalid-arguments", "An override names a live company status as its base.");
    }
    // One override per team and base: a second one is a column whose name depends on which row the
    // merge happened to read, which is not a workflow.
    const overrides = await liveOverridesOfBase(ctx, company, baseStatusId);
    if (overrides === null) return workflowTooLarge();
    if (overrides.some((row) => row.teamId === teamId)) {
      return rejected("invalid-arguments", "This team already overrides that status.");
    }
  }

  let position = args.position;
  if (position === undefined) {
    // Append to the end of the same chain — one bounded read of its live rows, not the table.
    const siblings = await liveStatusRows(ctx, company, { scope: args.scope, teamId });
    if (siblings === null) return workflowTooLarge();
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

  // The same variant rule that gated the create has to survive every patch: nulling the name of a
  // base leaves an unrenderable column behind, and the rows that inherit from it inherit nothing.
  const violation = statusVariantViolation({
    id: status.id,
    scope: status.scope,
    teamId: status.teamId,
    baseStatusId: status.baseStatusId,
    name: args.name === undefined ? status.name : args.name,
    color: args.color === undefined ? status.color : args.color,
    category: args.category === undefined ? status.category : args.category,
    position: args.position === undefined ? status.position : args.position,
    hidden: args.hidden === undefined ? status.hidden : args.hidden,
  });
  if (violation !== null) return rejected("invalid-arguments", violation);

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

/**
 * How many live issues one status deletion may move. The reassignment is atomic with the tombstone —
 * an issue left pointing at a deleted status is exactly the dangling reference the sweep exists to
 * prevent — so it has to fit in one mutation. A workflow column holding more than this is refused
 * loudly rather than swept halfway; the honest remedy is to move the excess first.
 */
const STATUS_DELETE_MAX_ISSUES = 500;

const issueStatusDelete: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusDeleteArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const status = await byDomain(ctx, "issueStatuses", company._id, operation.entityId);
  if (status === null) return rejected("entity-not-found", `No status ${operation.entityId}.`);
  if (!can(actor, "workflow.manage", statusScopeTeamIds(status))) return denied("workflow.manage");
  if (status.deletedAt !== null) return applied();

  // Everything that dies in this transaction. A company base takes its team overrides with it, and
  // an issue in a team that overrode the base sits on the *override's* id — `defaultStatusId` hands
  // that id out — so sweeping the base id alone leaves precisely those issues stranded.
  const doomed: Doc<"issueStatuses">[] = [status];
  if (status.scope === "company") {
    const overrides = await liveOverridesOfBase(ctx, company, status.id);
    if (overrides === null) return workflowTooLarge();
    doomed.push(...overrides);
  }
  const doomedIds = new Set(doomed.map((row) => row.id));

  if (doomedIds.has(args.reassignToStatusId)) {
    return rejected("invalid-arguments", "A status cannot absorb its own issues.");
  }
  const target = await liveRow(ctx, "issueStatuses", company._id, args.reassignToStatusId);
  if (target === null) {
    return rejected("invalid-arguments", `No status ${args.reassignToStatusId}.`);
  }
  // Every stranded issue lands in the target, so the target has to belong to every workflow that
  // could hold one. A team status only ever holds its own team's issues; a company status is
  // inherited by every workflow, so absorbing its issues needs another company status.
  const strandedOwner: IssueWorkflowOwner =
    status.scope === "team" && status.teamId !== null
      ? { kind: "team", teamId: status.teamId }
      : { kind: "company" };
  if (!statusMatchesOwner(target, strandedOwner)) {
    return rejected("invalid-arguments", "The replacement status belongs to a different workflow.");
  }

  // The column an issue lands in is the target *as its own workflow resolves it*: a team that
  // overrides the target absorbs its issues under the override's id, and a team that hides the
  // target has nowhere to put them, which is a refusal rather than a silent disappearance.
  const landings = new Map<string, string>();
  const landingFor = async (owner: IssueWorkflowOwner): Promise<Resolved<string>> => {
    const key = owner.kind === "team" ? `team:${owner.teamId}` : "company";
    const held = landings.get(key);
    if (held !== undefined) return { ok: true, value: held };
    const workflow = await effectiveWorkflow(ctx, company, owner);
    if (!workflow.ok) return workflow;
    // The doomed rows are still live in this read; resolve against what survives the deletion.
    const surviving = workflow.value.filter(
      (column) =>
        !doomedIds.has(column.id) && (column.baseId === null || !doomedIds.has(column.baseId)),
    );
    const column = effectiveStatusFor(surviving, target.id);
    if (column === null || column.hidden) {
      return {
        ok: false,
        outcome: rejected(
          "invalid-arguments",
          "The replacement status is not a column every affected workflow shows.",
        ),
      };
    }
    landings.set(key, column.id);
    return { ok: true, value: column.id };
  };

  // Issues sitting in any doomed status move, each as its own feed row so every replica repaints
  // the affected cards. Deleted issues are left alone; `issue.restore` renormalizes their status.
  const stranded: Doc<"issues">[] = [];
  for (const row of doomed) {
    const room = STATUS_DELETE_MAX_ISSUES + 1 - stranded.length;
    if (room <= 0) break;
    const page = await ctx.db
      .query("issues")
      .withIndex("by_company_status_and_deleted", (q) =>
        q.eq("companyId", company._id).eq("statusId", row.id).eq("deletedAt", null),
      )
      .take(room);
    stranded.push(...page);
  }
  if (stranded.length > STATUS_DELETE_MAX_ISSUES) {
    return rejected(
      "dependency-blocked",
      `A status holding more than ${STATUS_DELETE_MAX_ISSUES} issues cannot be deleted in one ` +
        "operation; move the excess first.",
    );
  }

  // Every landing is resolved before a single write: a rejection does not roll the mutation back,
  // so refusing halfway would tombstone nothing but leave part of the sweep applied.
  const moves: { readonly issue: Doc<"issues">; readonly statusId: string }[] = [];
  for (const issue of stranded) {
    const landing = await landingFor(issue.workflowOwner);
    if (!landing.ok) return landing.outcome;
    moves.push({ issue, statusId: landing.value });
  }

  const changes: DomainChange[] = [];
  for (const move of moves) {
    await ctx.db.patch(move.issue._id, { statusId: move.statusId, updatedAt: now });
    const doc = await mustGet(ctx, move.issue._id);
    changes.push(upsert("issue", doc.id, doc.teamIds, move.issue._id, encodeIssue(company, doc)));
  }

  for (const row of doomed) {
    await ctx.db.patch(row._id, { deletedAt: now, updatedAt: now });
    changes.push(tombstone("issueStatus", row.id, statusScopeTeamIds(row), row._id));
  }
  return applied(...changes);
};

const issueStatusReorder: EnvApply = async ({ ctx, actor, company, operation, now }) => {
  const parsed = decoded(parseIssueStatusesReorderArgs(operation.args));
  if ("outcome" in parsed) return parsed.outcome;
  const args = parsed.args;

  const rows: Doc<"issueStatuses">[] = [];
  const listed = new Set<string>();
  for (const statusId of args.statusIds) {
    // A repeated id would be written twice and ship two feed rows for one status, and the second
    // write would silently decide the first one's position.
    if (listed.has(statusId)) {
      return rejected("invalid-arguments", `The status ${statusId} is listed twice.`);
    }
    listed.add(statusId);
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

  // The contract calls this "the complete order within one workflow, not a move": positions are
  // rewritten from the list, so a partial one leaves every omitted status on its old position and
  // produces ties rather than an order. Refusing is the only answer that keeps positions total —
  // guessing where the missing rows belong would reorder them without being asked.
  const chain = await liveStatusRows(ctx, company, first);
  if (chain === null) return workflowTooLarge();
  if (chain.length !== rows.length || chain.some((row) => !listed.has(row.id))) {
    return rejected(
      "invalid-arguments",
      "A reorder lists every live status of the workflow exactly once.",
    );
  }

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
    // Append after the project's last milestone — one indexed read of the highest position rather
    // than a scan of every milestone the project ever had. Tombstones count, so a deleted
    // milestone's position is never handed to a new one.
    const last = await ctx.db
      .query("issueMilestones")
      .withIndex("by_company_project_and_position", (q) =>
        q.eq("companyId", company._id).eq("cloudProjectId", project.id),
      )
      .order("desc")
      .first();
    position = last === null ? 0 : last.position + 1;
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

/**
 * How many issues one milestone move may unlink. Same reasoning as the status sweep: the unlink is
 * atomic with the move, so it has to fit one mutation, and a milestone past this is refused rather
 * than moved with some of its issues still pointing at it across projects.
 */
const MILESTONE_MOVE_MAX_ISSUES = 500;

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

  const moved =
    args.cloudProjectId !== undefined && args.cloudProjectId !== milestone.cloudProjectId;
  if (args.cloudProjectId !== undefined) {
    const target = await liveRow(ctx, "cloudProjects", company._id, args.cloudProjectId);
    if (target === null || target.archivedAt !== null) {
      return rejected("invalid-arguments", `No project ${args.cloudProjectId}.`);
    }
    // Moving a milestone puts it on the target project's boards, which is a write there —
    // `issueMilestone.create` demands the same grant, so a manager scoped to one team cannot use a
    // move to inject a milestone into another team's project.
    if (moved && !can(actor, "projects.manage", target.teamIds)) return denied("projects.manage");
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch["name"] = args.name;
  if (args.description !== undefined) patch["description"] = args.description;
  if (args.startDate !== undefined) patch["startDate"] = args.startDate;
  if (args.targetDate !== undefined) patch["targetDate"] = args.targetDate;
  if (args.position !== undefined) patch["position"] = args.position;
  if (args.cloudProjectId !== undefined) patch["cloudProjectId"] = args.cloudProjectId;
  if (Object.keys(patch).length === 0) return applied();

  // Read the issues the move strands *before* touching anything: a rejection does not roll the
  // mutation back, so a refusal issued halfway through would leave the milestone moved and its
  // issues still pointing at it from the old project.
  let stranded: readonly Doc<"issues">[] = [];
  if (moved) {
    // Straight at the issues holding this milestone, live ones only, instead of every issue of the
    // old project: a busy project is not what makes a milestone move expensive, its own issues are.
    const holders = await ctx.db
      .query("issues")
      .withIndex("by_company_milestone_and_deleted", (q) =>
        q.eq("companyId", company._id).eq("milestoneId", milestone.id).eq("deletedAt", null),
      )
      .take(MILESTONE_MOVE_MAX_ISSUES + 1);
    if (holders.length > MILESTONE_MOVE_MAX_ISSUES) {
      return rejected(
        "dependency-blocked",
        `A milestone holding more than ${MILESTONE_MOVE_MAX_ISSUES} issues cannot be moved to ` +
          "another project in one operation; move its issues first.",
      );
    }
    stranded = holders.filter((issue) => issue.projectId === milestone.cloudProjectId);
  }

  await ctx.db.patch(milestone._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, milestone._id);
  const changes: DomainChange[] = [
    upsert(
      "issueMilestone",
      doc.id,
      // Both sides of the move: the old project's teams need the upsert to learn the milestone
      // left, or their replicas keep a copy a fresh bootstrap would never seed.
      scopeChangeTeamIds(scopeTeams, await milestoneTeamIds(ctx, company, doc)),
      milestone._id,
      encodeIssueMilestone(company, doc),
    ),
  ];

  // A milestone is project-owned, so issues left behind in the old project can no longer point at
  // it — the very state `issue.update` refuses to write. They are cleared here, each as its own
  // feed row, rather than left as a cross-project reference every client would have to render.
  for (const issue of stranded) {
    await ctx.db.patch(issue._id, { milestoneId: null, updatedAt: now });
    const issueDoc = await mustGet(ctx, issue._id);
    changes.push(
      upsert("issue", issueDoc.id, issueDoc.teamIds, issue._id, encodeIssue(company, issueDoc)),
    );
  }

  return applied(...changes);
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
    // The highest sort key, read straight off the index rather than by scanning the checklist:
    // appending a todo is an ordinary keystroke and must not get slower as the list grows. Deleted
    // todos count towards the key, which only means a new one sorts after them — never a reused key.
    const last = await ctx.db
      .query("issueTodos")
      .withIndex("by_company_issue_and_sort_order", (q) =>
        q.eq("companyId", company._id).eq("issueId", issue.id),
      )
      .order("desc")
      .first();
    sortOrder = orderKeyAfter(last?.sortOrder ?? null);
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
  // The relation is visible from both ends, so an actor who can only reach one end would be
  // authoring an edge onto another team's issue. An unreadable related issue answers exactly like a
  // missing one, so the refusal does not double as an existence oracle for that team's ids.
  if (!readableIssue(actor, related)) {
    return rejected("invalid-arguments", `No issue ${args.relatedIssueId}.`);
  }

  const teamIds = unionTeamIds(issue.teamIds, related.teamIds);
  if (!can(actor, "issues.update", issue.teamIds)) return denied("issues.update");

  // One live row per directed pair and kind; the inverse is this row read from the other end. The
  // index answers that in a single point read, so a hub issue with thousands of edges costs the
  // same as one with two.
  const duplicate = await ctx.db
    .query("issueRelations")
    .withIndex("by_company_pair_kind_and_deleted", (q) =>
      q
        .eq("companyId", company._id)
        .eq("issueId", issue.id)
        .eq("relatedIssueId", related.id)
        .eq("kind", args.kind)
        .eq("deletedAt", null),
    )
    .first();
  if (duplicate !== null) {
    return rejected("invalid-arguments", "This relation already exists.");
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
  const issueTeams = await issueTeamIds(ctx, company, relation.issueId);
  const relatedTeams = await issueTeamIds(ctx, company, relation.relatedIssueId);
  const teamIds = unionTeamIds(issueTeams, relatedTeams);
  if (!can(actor, "issues.update", issueTeams)) return denied("issues.update");
  // Symmetric with create: removing the edge changes what the other end shows, so reaching only one
  // end is not enough.
  if (!can(actor, "issues.read", relatedTeams)) return denied("issues.read");
  if (relation.deletedAt !== null) return applied();

  await ctx.db.patch(relation._id, { deletedAt: now });
  return applied(tombstone("issueRelation", relation.id, teamIds, relation._id));
};

// ---------------------------------------------------------------------------
// issueComment.*
// ---------------------------------------------------------------------------

/**
 * The attachments a comment may carry. The upload flow finalizes metadata against a company and an
 * issue before the comment is ever submitted, so an id that does not resolve to a live finalized
 * upload *on this issue* is either a client bug or an attempt to graft somebody else's file onto a
 * comment — either way it must not become authoritative comment data. A file already spoken for by
 * another comment is refused for the same reason: `issueAttachments.commentId` is single-valued.
 */
async function resolveCommentAttachments(
  ctx: QueryCtx,
  actor: CompanyActor,
  company: Doc<"companies">,
  issueId: string,
  commentId: string,
  attachmentIds: readonly string[],
): Promise<Resolved<readonly Doc<"issueAttachments">[]>> {
  const rows: Doc<"issueAttachments">[] = [];
  const listed = new Set<string>();
  for (const attachmentId of attachmentIds) {
    if (listed.has(attachmentId)) {
      return {
        ok: false,
        outcome: rejected("invalid-arguments", `The attachment ${attachmentId} is listed twice.`),
      };
    }
    listed.add(attachmentId);
    const attachment = await liveRow(ctx, "issueAttachments", company._id, attachmentId);
    if (
      attachment === null ||
      attachment.issueId !== issueId ||
      attachment.state !== "ready" ||
      actor.kind !== "member" ||
      attachment.uploadedByMembershipId !== actor.membership._id
    ) {
      return {
        ok: false,
        outcome: rejected("invalid-arguments", `No attachment ${attachmentId} on this issue.`),
      };
    }
    if (attachment.commentId !== null && attachment.commentId !== commentId) {
      return {
        ok: false,
        outcome: rejected(
          "invalid-arguments",
          `The attachment ${attachmentId} belongs to another comment.`,
        ),
      };
    }
    rows.push(attachment);
  }
  return { ok: true, value: rows };
}

/**
 * Points the resolved attachments at the comment and releases the ones it no longer carries, in the
 * same transaction as the comment write. The back-reference is what makes an attachment's own row
 * self-describing — the garbage collector reads it to decide an upload is unattached — so leaving
 * it null while the comment claims the file would eventually collect a file somebody is looking at.
 */
async function bindCommentAttachments(
  ctx: MutationCtx,
  company: Doc<"companies">,
  issueTeams: readonly string[],
  commentId: string,
  attached: readonly Doc<"issueAttachments">[],
  previousIds: readonly string[],
  now: number,
): Promise<readonly DomainChange[]> {
  const changes: DomainChange[] = [];
  const publish = async (docId: Id<"issueAttachments">) => {
    const doc = await mustGet(ctx, docId);
    changes.push(
      upsert(
        "issueAttachment",
        doc.id,
        issueTeams,
        docId,
        await encodeIssueAttachment(ctx, company, doc),
      ),
    );
  };

  const keep = new Set(attached.map((row) => row.id));
  const deleted: Array<{ docId: Id<"issueAttachments">; key: string | null }> = [];
  for (const previousId of previousIds) {
    if (keep.has(previousId)) continue;
    const attachment = await liveRow(ctx, "issueAttachments", company._id, previousId);
    if (attachment === null || attachment.commentId !== commentId) continue;
    await ctx.db.patch(attachment._id, { deletedAt: now, updatedAt: now });
    if (attachment.storageId !== null) await ctx.storage.delete(attachment.storageId);
    changes.push(tombstone("issueAttachment", attachment.id, issueTeams, attachment._id));
    deleted.push({ docId: attachment._id, key: attachment.uploadthingFileKey ?? null });
  }
  for (const attachment of attached) {
    if (attachment.commentId === commentId) continue;
    await ctx.db.patch(attachment._id, { commentId, updatedAt: now });
    await publish(attachment._id);
  }
  if (deleted.length > 0) {
    await ctx.scheduler.runAfter(0, internal.issueAttachments.deleteUploadThingFiles, {
      targets: deleted,
    });
  }
  return changes;
}

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

  const attachmentIds = args.attachmentIds ?? [];
  const resolved = await resolveCommentAttachments(
    ctx,
    actor,
    company,
    issue.id,
    operation.entityId,
    attachmentIds,
  );
  if (!resolved.ok) return resolved.outcome;

  const docId = await ctx.db.insert("issueComments", {
    id: operation.entityId,
    companyId: company._id,
    issueId: issue.id,
    body: args.body,
    author: feedActor,
    attachmentIds: [...attachmentIds],
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
    ...(await bindCommentAttachments(ctx, company, issue.teamIds, doc.id, resolved.value, [], now)),
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

  let attached: readonly Doc<"issueAttachments">[] = [];
  if (args.attachmentIds !== undefined) {
    const resolved = await resolveCommentAttachments(
      ctx,
      actor,
      company,
      comment.issueId,
      comment.id,
      args.attachmentIds,
    );
    if (!resolved.ok) return resolved.outcome;
    attached = resolved.value;
  }

  const patch: Record<string, unknown> = {};
  if (args.body !== undefined) patch["body"] = args.body;
  if (args.attachmentIds !== undefined) patch["attachmentIds"] = [...args.attachmentIds];
  if (Object.keys(patch).length === 0) return applied();

  await ctx.db.patch(comment._id, { ...patch, updatedAt: now });
  const doc = await mustGet(ctx, comment._id);
  return applied(
    upsert("issueComment", doc.id, teamIds, comment._id, encodeIssueComment(company, doc)),
    // The edited list decides the bindings: files the comment dropped are released so the upload
    // collector can reclaim them, and newly named ones are claimed, atomically with the edit.
    ...(args.attachmentIds === undefined
      ? []
      : await bindCommentAttachments(
          ctx,
          company,
          teamIds,
          comment.id,
          attached,
          comment.attachmentIds,
          now,
        )),
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

  const attachments: Doc<"issueAttachments">[] = [];
  for (const attachmentId of comment.attachmentIds) {
    const attachment = await liveRow(ctx, "issueAttachments", company._id, attachmentId);
    if (attachment !== null && attachment.commentId === comment.id) attachments.push(attachment);
  }
  await ctx.db.patch(comment._id, { deletedAt: now, updatedAt: now });
  const targets: Array<{ docId: Id<"issueAttachments">; key: string | null }> = [];
  const changes: DomainChange[] = [tombstone("issueComment", comment.id, teamIds, comment._id)];
  for (const attachment of attachments) {
    await ctx.db.patch(attachment._id, { deletedAt: now, updatedAt: now });
    if (attachment.storageId !== null) await ctx.storage.delete(attachment.storageId);
    changes.push(tombstone("issueAttachment", attachment.id, teamIds, attachment._id));
    targets.push({ docId: attachment._id, key: attachment.uploadthingFileKey ?? null });
  }
  if (targets.length > 0) {
    await ctx.scheduler.runAfter(0, internal.issueAttachments.deleteUploadThingFiles, { targets });
  }
  return applied(...changes);
};

// ---------------------------------------------------------------------------
// issueView.*
// ---------------------------------------------------------------------------

/**
 * A shared view's feed row carries its team scope; a company view is company-wide. A private view's
 * team scope is meaningless — {@link viewOwnerBinding} is what decides its audience — so it stays
 * empty rather than pretending to name one.
 */
function viewChangeTeamIds(view: {
  readonly visibility: "private" | "teams" | "company";
  readonly teamIds: readonly string[];
}): readonly string[] {
  return view.visibility === "teams" ? view.teamIds : [];
}

/**
 * The owner a view row is private to, or `null` while it is shared. This is the authority for view
 * visibility on both sides of the seed/feed handoff: `teamIds` cannot express "owner only", and
 * client-side hiding is not an authorization boundary.
 *
 * It is read from the view's *current* row on every filtering pass, never stamped onto the change
 * row. A view that was company-wide when its upsert was written and is private now must stop being
 * delivered — history included — and a stamped copy would keep leaking the name and configuration
 * to everyone whose cursor still sits behind the change that made it private.
 */
export function viewOwnerBinding(view: {
  readonly visibility: "private" | "teams" | "company";
  readonly ownerMembershipId: Id<"memberships">;
}): string | null {
  return view.visibility === "private" ? view.ownerMembershipId : null;
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
  // Sharing needs the same switch creating a shared view does — and re-pointing an already shared
  // view at other teams is just as much an act of sharing as widening its visibility, so the check
  // follows the effective audience rather than the visibility literal.
  const currentScope = viewChangeTeamIds(view);
  const audienceChanged =
    visibility !== view.visibility ||
    teamIds.length !== currentScope.length ||
    teamIds.some((teamId) => !currentScope.includes(teamId));
  if (visibility !== "private" && audienceChanged && !can(actor, "views.shared", teamIds)) {
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
  // Going private narrows the audience to one member, and the upsert below is owner-gated, so it
  // reaches nobody who is losing the view. The departure tombstone goes first and is scoped to the
  // audience being dropped; the owner, if they are in that scope, sees it and then the upsert that
  // restores the row, so their replica converges on holding it.
  const wentPrivate = viewOwnerBinding(view) === null && viewOwnerBinding(doc) !== null;
  return applied(
    ...(wentPrivate ? [departureTombstone("issueView", doc.id, currentScope)] : []),
    upsert(
      "issueView",
      doc.id,
      // Narrowing the audience still has to reach the teams being dropped, so their replicas
      // receive the upsert that tells them the view is no longer theirs.
      scopeChangeTeamIds(currentScope, viewChangeTeamIds(doc)),
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
  // A revoked registration answers exactly like one that was never here: the link stamps an
  // environment as the place the work is happening, and a revoked environment is not that.
  if (registration === null || registration.state !== "active") {
    return rejected("invalid-arguments", `No environment ${args.environmentId} here.`);
  }
  // An environment may only stamp links with itself. Its relay token authenticates one environment
  // id, and nothing else in the operation is evidence about another one, so a link naming a
  // different environment would attribute a thread that environment never ran — including to a
  // registration it has no relationship with at all. A member is not acting as an environment, so
  // they link a thread on an environment they can actually see, which is what `environments.read`
  // over the registration's team scope means.
  if (actor.kind === "environment") {
    if (args.environmentId !== actor.registration.environmentId) {
      return rejected("permission-denied", "An environment may only link its own threads.");
    }
  } else if (!can(actor, "environments.read", registration.teamIds)) {
    return denied("environments.read");
  }

  // The same thread may be linked to several issues, but linking one issue to one thread twice is
  // a duplicate rather than a second link — one point read of the pair, not of the thread's links.
  const duplicate = await ctx.db
    .query("issueThreadLinks")
    .withIndex("by_company_thread_issue_and_deleted", (q) =>
      q
        .eq("companyId", company._id)
        .eq("environmentId", args.environmentId)
        .eq("threadId", args.threadId)
        .eq("issueId", issue.id)
        .eq("deletedAt", null),
    )
    .first();
  if (duplicate !== null) {
    return rejected("invalid-arguments", "This thread is already linked to the issue.");
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
  "issue.triageReject": handler(issueTriageReject),
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
  /** Owner of an owner-private row (a private saved view), `null` otherwise. */
  readonly ownerMembershipId: string | null;
  /** Wire payload; `null` when `deleted` (a deleted row is only a cursor position). */
  readonly payload: unknown;
}

/**
 * The owner-private bindings the rows of one change-feed page need, resolved from the entities'
 * current state. Only saved views are owner-private today, so only view rows cost a read, and the
 * page's row ceiling bounds how many.
 *
 * This is what keeps `listChanges` filtering identical to `bootstrap` filtering: both hand
 * `isChangeVisible` the binding {@link viewOwnerBinding} reports for the live row, so a view that
 * turned private stops being delivered by both at the same instant.
 */
export async function readOwnerPrivateBindings(
  ctx: QueryCtx,
  company: Doc<"companies">,
  rows: readonly { readonly entityKind: string; readonly entityId: string }[],
): Promise<ReadonlyMap<string, string | null>> {
  const bindings = new Map<string, string | null>();
  for (const row of rows) {
    if (row.entityKind !== "issueView" || bindings.has(row.entityId)) continue;
    const view = await byDomain(ctx, "issueViews", company._id, row.entityId);
    // A row whose entity is gone cannot be shown to be shared, so it is withheld from everyone but
    // the membership id no actor carries.
    bindings.set(row.entityId, view === null ? OWNERLESS_PRIVATE : viewOwnerBinding(view));
  }
  return bindings;
}

/** Placeholder owner for an owner-private row whose entity no longer resolves; matches no actor. */
const OWNERLESS_PRIVATE = "\u0000no-owner";

/**
 * The owner binding a feed row carries, given the page's resolved bindings. An owner-private kind
 * with no resolved binding fails closed onto {@link OWNERLESS_PRIVATE}, so forgetting to resolve a
 * page withholds views rather than leaking them.
 */
export function feedRowOwnerBinding(
  row: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly departure?: boolean;
  },
  bindings: ReadonlyMap<string, string | null>,
): string | null {
  // A departure row exists to reach the audience the entity just left; gating it on the entity's
  // current owner would withhold exactly the replicas it is addressed to. See `departureTombstone`.
  if (row.departure === true) return null;
  if (row.entityKind !== "issueView") return null;
  return bindings.has(row.entityId) ? (bindings.get(row.entityId) ?? null) : OWNERLESS_PRIVATE;
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

/**
 * The company-domain tables a bootstrap pages by domain id. `companies` and `companySettings` are
 * absent because they are singletons per company and are read directly rather than walked.
 */
type CompanyBootstrapTable =
  | "memberships"
  | "teams"
  | "teamMemberships"
  | "roles"
  | "roleAssignments"
  | "cloudProjects"
  | "environmentRegistrations"
  | "environmentBindings"
  | "environmentCommands"
  | "agentThreads";

function pageOf<TableName extends IssueDomainTable | CompanyBootstrapTable>(
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
 * The domain id an encoded company payload declares. Every company encoder emits one, and it is the
 * same value the feed writer uses as the change row's `entityId`, so taking the walk position from
 * the payload rather than from the raw row makes "the id the seed pages by" and "the id the client
 * files the entity under" the same string by construction — including for the two tables whose id
 * column is optional in storage.
 */
function encodedCompanyDomainId(payload: unknown): string {
  const id = (payload as { readonly id?: unknown }).id;
  if (typeof id !== "string" || id === "") {
    throw new Error("A company payload was encoded without a domain id.");
  }
  return id;
}

/**
 * Lifts a page of company-domain rows.
 *
 * Three things differ from the issue lift and each is a property of the domain rather than an
 * omission. None of these tables carries a `deletedAt`; deleted join rows leave nothing behind to
 * seed, while a revoked environment registration is consumed by the walker as deleted below. None
 * is owner-private: company administration records are gated by permission, and by self-visibility
 * in `src/sync/visibility`, never by ownership. And every one is company-wide (`teamIds: []`),
 * byte-for-byte the scope `appendCompanyChanges` writes, so a team-scoped grant is refused the same
 * row by the seed and by the feed.
 *
 * `version` reads through {@link companyRowVersion}, which is `row.version ?? 0`. Zero is the value
 * that cannot skip a later feed row: the seed's resume cursor is the company head captured on page
 * one, so every change to this row after the seed arrives on the drain carrying a *higher* version
 * than the payload declares and folds as an ordinary upsert. Reporting a version the row has not
 * actually reached is the failure mode — a replica that then discards the real change as stale.
 *
 * One lifted row per input row, always: the pager reads "fewer rows than asked for" as "this table
 * is exhausted", so dropping one here would end the kind's walk early.
 */
async function liftCompanyRows<Row extends { readonly version?: number }>(
  rows: readonly Row[],
  encode: (row: Row) => Promise<unknown> | unknown,
): Promise<readonly BootstrapRow[]> {
  const lifted: BootstrapRow[] = [];
  for (const row of rows) {
    const payload = await encode(row);
    lifted.push({
      id: encodedCompanyDomainId(payload),
      version: companyRowVersion(row),
      deleted: false,
      teamIds: [],
      ownerMembershipId: null,
      payload,
    });
  }
  return lifted;
}

/**
 * Reads the next raw slice of one entity kind's table, ascending by domain id from `afterId`, and
 * lifts each row for the pager. Deleted rows come back too — with no payload — because the walk
 * has to advance its cursor over them; the pager skips them without delivering anything, exactly
 * like the change feed skips rows the caller cannot see.
 *
 * The switch is exhaustive over `BootstrapEntityKind` with no `default`, deliberately: appending a
 * kind to `BOOTSTRAP_ENTITY_ORDER` without teaching this function to read it is a compile error
 * rather than a table the seed silently skips.
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
    ownerOf: (row: Row) => string | null = () => null,
  ): Promise<readonly BootstrapRow[]> => {
    const lifted: BootstrapRow[] = [];
    for (const row of rows) {
      const deleted = (row.deletedAt ?? null) !== null;
      lifted.push({
        id: row.id,
        version: row.version,
        deleted,
        teamIds: deleted ? [] : await teamsOf(row),
        ownerMembershipId: deleted ? null : ownerOf(row),
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
        (row) => viewOwnerBinding(row),
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

    // --- company domain -----------------------------------------------------
    // The two singletons are read directly rather than walked: there is exactly one of each per
    // company, so a range scan would be a page of at most one row behind an index. They still
    // honour `afterId` so the pager's "the table is exhausted" signal works the same way — once the
    // walk has passed the row's id, the kind yields nothing and the walk moves on.
    case "company":
      return afterId >= company.id
        ? []
        : liftCompanyRows([company], (row) => encodeCompany(ctx, row));
    case "companySettings": {
      if (afterId >= companySettingsDomainId(company)) return [];
      // `first` rather than `unique`: a duplicated settings row is a data fault that must not take
      // a client's whole seed down with it, and the company is a singleton by construction anyway.
      const settings = await ctx.db
        .query("companySettings")
        .withIndex("by_company", (q) => q.eq("companyId", company._id))
        .first();
      // A company with no settings row yet seeds none; the client falls back to its own defaults
      // and picks the row up from the feed the moment one is written.
      if (settings === null) return [];
      return liftCompanyRows([settings], (row) => encodeCompanySettings(company, row));
    }
    case "membership":
      return liftCompanyRows(await pageOf(ctx, "memberships", company._id, afterId, limit), (row) =>
        encodeMembership(row),
      );
    case "team":
      return liftCompanyRows(await pageOf(ctx, "teams", company._id, afterId, limit), (row) =>
        encodeTeam(row),
      );
    case "teamMembership":
      // The id column is `v.optional` in storage, and Convex sorts a missing field *before* every
      // string on the index, so a join row written before the company domain joined the feed is not
      // reachable from `afterId >= ""` and is not seeded. It becomes reachable the moment anything
      // stamps it, which `appendCompanyChanges` does on the row's next write.
      return liftCompanyRows(
        await pageOf(ctx, "teamMemberships", company._id, afterId, limit),
        (row) => encodeTeamMembership(ctx, row),
      );
    case "role":
      return liftCompanyRows(await pageOf(ctx, "roles", company._id, afterId, limit), (row) =>
        encodeRole(row),
      );
    case "roleAssignment":
      return liftCompanyRows(
        await pageOf(ctx, "roleAssignments", company._id, afterId, limit),
        (row) => encodeRoleAssignment(ctx, row),
      );
    case "cloudProject":
      return liftCompanyRows(
        await pageOf(ctx, "cloudProjects", company._id, afterId, limit),
        (row) => encodeCloudProject(row),
      );
    case "environmentRegistration": {
      const rows = await pageOf(ctx, "environmentRegistrations", company._id, afterId, limit);
      const lifted: BootstrapRow[] = [];
      for (const row of rows) {
        lifted.push({
          id: row.id,
          version: companyRowVersion(row),
          // A revoked registration stays in authoritative storage for audit and re-registration,
          // but discovery replicas treat deactivation as deletion.
          deleted: row.state !== "active",
          teamIds: [],
          ownerMembershipId: null,
          payload: row.state === "active" ? await encodeEnvironmentRegistration(ctx, row) : null,
        });
      }
      return lifted;
    }
    case "environmentBinding": {
      const rows = await pageOf(ctx, "environmentBindings", company._id, afterId, limit);
      const lifted: BootstrapRow[] = [];
      for (const row of rows) {
        const pending = row.status === "pending";
        lifted.push({
          id: row.id,
          version: companyRowVersion(row),
          deleted: pending,
          teamIds: [],
          ownerMembershipId: null,
          payload: pending ? null : await encodeEnvironmentBinding(ctx, row),
        });
      }
      return lifted;
    }
    case "environmentCommand":
      // Terminal outcomes are history, not tombstones: a bootstrap must preserve the answer to a
      // command even when its execution can no longer change.
      return liftCompanyRows(
        await pageOf(ctx, "environmentCommands", company._id, afterId, limit),
        (row) => encodeEnvironmentCommand(ctx, row),
      );
    case "agentThread": {
      const rows = await pageOf(ctx, "agentThreads", company._id, afterId, limit);
      const lifted: BootstrapRow[] = [];
      for (const row of rows) {
        lifted.push({
          id: row.id,
          version: companyRowVersion(row),
          deleted: false,
          teamIds: await cachedProjectTeams(ctx, company, cache, row.cloudProjectId),
          ownerMembershipId: null,
          payload: await encodeAgentThread(ctx, row),
        });
      }
      return lifted;
    }
  }
}
