/**
 * The Convex cloud-sync wire protocol — see `docs/internals/cloud-sync.md`.
 *
 * This module is the single source of truth for everything that crosses the boundary between a
 * client replica and Convex: the operation envelope the outbox stores and replays, the change
 * records the feed delivers, the five function signatures, and the bounds all three sides enforce.
 * `packages/backend` validates against these shapes, `packages/client-runtime/src/sync` drives
 * them, and web/desktop/mobile read them through the same import.
 *
 * Two rules run through the whole protocol:
 *
 * - **Domain ids are client-generated UUIDv7 strings.** An offline client builds relationships
 *   before Convex has seen any of the records, so a Convex `_id` is never a wire value.
 * - **Company versions, not clocks, decide order.** Every accepted operation appends contiguous
 *   per-company versions; a client's cursor is a version, and client clocks never break ties.
 *
 * @module cloudSync
 */
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { CloudProjectId } from "./cloudProject.ts";
import {
  CloudTimestamp,
  CloudUserId,
  CompanyId,
  CompanyLifecycleState,
  MembershipId,
  MembershipState,
  OfflineAccessDays,
  RoleAssignmentId,
  RoleAssignmentScope,
  RoleId,
  TeamId,
  isCompanyPermission,
  type CompanyPermission,
} from "./company.ts";
import {
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  ISSUE_COMMENT_MAX_CHARS,
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_LABELS_MAX_PER_ISSUE,
  ISSUE_TITLE_MAX_CHARS,
  IssueAgentActor,
  IssueAssignee,
  IssueColor,
  IssueCycleId,
  IssueDate,
  IssueId,
  IssueKey,
  IssueKeyPrefix,
  IssueLabelId,
  IssueLabelPatch,
  IssueMemberActor,
  IssueMilestoneId,
  IssuePriority,
  IssueRelationKind,
  IssueStatusCategory,
  IssueStatusId,
  IssueSystemActor,
  IssueThreadLinkOrigin,
  IssueViewConfig,
} from "./issues.ts";
import { ModelSelection } from "./modelSelection.ts";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Protocol version and bounds
// ---------------------------------------------------------------------------

/**
 * Stamped on every operation. Convex answers `upgrade-required` rather than guessing when a client
 * speaks a version outside the supported window, which is what keeps an old build from writing a
 * shape the current deployment would misread.
 */
export const SYNC_PROTOCOL_VERSION = 1;

/** Oldest protocol a deployment still accepts. Older clients get `upgrade-required`, not a retry. */
export const SYNC_PROTOCOL_MIN_SUPPORTED_VERSION = 1;

/**
 * How many operations one `sync.applyOperations` call may carry. The client chunks its outbox to
 * this; an outbox that batches more only discovers the limit by having the whole batch refused,
 * which would scramble its local sequence.
 */
export const SYNC_MAX_OPERATIONS_PER_BATCH = 25;

/** Total argument bytes in one batch. Files never travel in operation arguments. */
export const SYNC_MAX_OPERATION_ARGS_BYTES = 512 * 1024;

/** `sync.listChanges` never returns more than this, so draining is always bounded. */
export const SYNC_MAX_CHANGES_PER_PAGE = 100;

/** Byte ceiling for one change page, well under the Convex read/transaction limits. */
export const SYNC_MAX_CHANGE_PAGE_BYTES = 1024 * 1024;

/** Entities per `sync.bootstrap` page. A seed is paginated; a whole company never fits one read. */
export const SYNC_BOOTSTRAP_PAGE_SIZE = 200;

/**
 * Change feed and operation receipts are pruned at 90 days. Issue audit history is not: it lives
 * until the company is deleted. A cursor older than the surviving feed forces a full bootstrap.
 */
export const SYNC_FEED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The version a company starts at. The first accepted change is version 1. */
export const SYNC_INITIAL_VERSION = 0;

/** Company setting range for opening cloud data without an online authorization check. */
export const SYNC_OFFLINE_ACCESS_DEFAULT_DAYS = 30;
export const SYNC_OFFLINE_ACCESS_MIN_DAYS = 0;
export const SYNC_OFFLINE_ACCESS_MAX_DAYS = 90;

/** The five Convex functions the protocol is made of. */
export const SYNC_FUNCTIONS = {
  /** Full paginated seed for a client with no usable cursor. */
  bootstrap: "sync.bootstrap",
  /** The only query a client subscribes to: one small row carrying the head and the epoch. */
  latestVersion: "sync.latestVersion",
  listChanges: "sync.listChanges",
  applyOperations: "sync.applyOperations",
  reserveIssueKeys: "sync.reserveIssueKeys",
} as const;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const makeSyncId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

/**
 * Stable per-installation identifier. It scopes the local sequence and is echoed into every
 * operation, so the same person on two devices has two independent outboxes.
 */
export const SyncClientId = makeSyncId("SyncClientId");
export type SyncClientId = typeof SyncClientId.Type;

/**
 * Client-generated UUIDv7. The deduplication key on both sides: the outbox refuses a second
 * enqueue and Convex refuses a second application, which is what makes a retried submission apply
 * exactly once.
 */
export const SyncOperationId = makeSyncId("SyncOperationId");
export type SyncOperationId = typeof SyncOperationId.Type;

/** Client-generated UUIDv7 naming the entity an operation writes or a change carries. */
export const SyncEntityId = makeSyncId("SyncEntityId");
export type SyncEntityId = typeof SyncEntityId.Type;

/** Contiguous per-company version assigned by Convex. Never a clock reading. */
export const CompanyVersion = NonNegativeInt.pipe(Schema.brand("CompanyVersion"));
export type CompanyVersion = typeof CompanyVersion.Type;

/**
 * Bumped by any authorization change — membership, role, team, company. A client that sees a new
 * epoch reseeds, because records it could read a moment ago may no longer be visible.
 */
export const AuthorizationEpoch = NonNegativeInt.pipe(Schema.brand("AuthorizationEpoch"));
export type AuthorizationEpoch = typeof AuthorizationEpoch.Type;

/** Outbox ordering. Monotonic per client, persisted, and never reused. */
export const LocalSequence = NonNegativeInt.pipe(Schema.brand("LocalSequence"));
export type LocalSequence = typeof LocalSequence.Type;

/**
 * Fractional order key with id tie-breaking, used by every collection a user can reorder offline.
 * A whole-list rewrite cannot converge when two people drag the same list on two planes.
 */
export const SyncOrderKey = TrimmedNonEmptyString;
export type SyncOrderKey = typeof SyncOrderKey.Type;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * An agent acting inside a company. Unlike the environment-local {@link IssueAgentActor} it names
 * the human it is acting for, because a company audit trail has to answer "who asked for this".
 */
export const SyncAgentActor = Schema.Struct({
  ...IssueAgentActor.fields,
  onBehalfOfMembershipId: Schema.NullOr(MembershipId),
});
export type SyncAgentActor = typeof SyncAgentActor.Type;

/** A Pathway server acting with its own service identity, not on any person's behalf. */
export const SyncEnvironmentActor = Schema.Struct({
  kind: Schema.Literal("environment"),
  environmentId: EnvironmentId,
});
export type SyncEnvironmentActor = typeof SyncEnvironmentActor.Type;

/**
 * Who performed a cloud write.
 *
 * Deliberately excludes the environment-local anonymous `{kind: "user"}` actor: a cloud operation
 * always arrives with an authenticated identity, and a membership tombstone keeps that attribution
 * readable after the person leaves.
 */
export const SyncActor = Schema.Union([
  IssueMemberActor,
  SyncAgentActor,
  IssueSystemActor,
  SyncEnvironmentActor,
]);
export type SyncActor = typeof SyncActor.Type;

// ---------------------------------------------------------------------------
// Change feed
// ---------------------------------------------------------------------------

/**
 * Entities that travel through the change feed. One kind per authoritative table, so a change is
 * always a whole entity or a tombstone — never a field-level patch a client would have to replay
 * in order to make sense of.
 */
export const SYNC_ENTITY_KINDS = [
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
  "cloudProject",
  "environmentRegistration",
  "environmentBinding",
  "environmentCommand",
  "issue",
  "issueStatus",
  "issueLabel",
  "issueMilestone",
  "issueCycle",
  "issueTodo",
  "issueRelation",
  "issueComment",
  "issueAttachment",
  "issueView",
  "issueAuditEvent",
  "issueThreadLink",
] as const;
export const SyncEntityKind = Schema.Literals(SYNC_ENTITY_KINDS);
export type SyncEntityKind = typeof SyncEntityKind.Type;

/** `tombstone` carries no payload: a delete is the absence of the entity, not a version of it. */
export const SyncChangeKind = Schema.Literals(["upsert", "tombstone"]);
export type SyncChangeKind = typeof SyncChangeKind.Type;

/**
 * One feed entry. Convex appends the complete entity rather than a diff, so a client that missed
 * intermediate versions still converges from whatever page it receives.
 *
 * `payload` stays opaque here because the entity schema is chosen by `entityKind`, and a build
 * that does not know a kind must drop the row rather than fail the page.
 */
export const SyncChangeEnvelope = Schema.Struct({
  version: CompanyVersion,
  entityKind: SyncEntityKind,
  entityId: SyncEntityId,
  changeKind: SyncChangeKind,
  /** Encoded entity for `upsert`; `null` for `tombstone`. */
  payload: Schema.Unknown,
});
export type SyncChangeEnvelope = typeof SyncChangeEnvelope.Type;

// ---------------------------------------------------------------------------
// Company-domain change payloads
// ---------------------------------------------------------------------------

/**
 * What the feed carries for the seven company-administration kinds.
 *
 * Company, membership, team, and role administration is online-only — none of it has an operation
 * kind and none of it ever enters an outbox — but the records still ride the change feed so a
 * client can render a member list, a team picker, and a permission-greyed toolbar with no
 * connection. They are a permission-filtered read cache: `sync/visibility.ts` gates each kind on
 * the same switch its admin screen uses, and the confirmed row always wins locally because there
 * is no optimistic company state to merge with.
 *
 * Four conventions, all shared with the issue-domain payloads in
 * `client-runtime/src/sync/issueDomain.ts`:
 *
 * - **No `companyId`.** A replica is one company by construction, and the id would be the same
 *   value on every row of every page.
 * - **No `version` and no `deletedAt`.** The envelope carries the version, and a delete is a
 *   payloadless `tombstone` rather than a flag inside a payload.
 * - **Timestamps are epoch milliseconds** ({@link CloudTimestamp}), matching what Convex stores.
 * - **Free text is not validated.** Names, descriptions, and the membership snapshots decode as
 *   plain strings: the check belongs on the mutation that writes them, and quarantining a whole
 *   member row over a long display name would take the offline member list away instead.
 *
 * Two kinds are deliberately absent. `companyOwner` has no wire kind — ownership is a small,
 * always-loaded relation, so it embeds into {@link SyncCompanyPayload.owners} rather than
 * fragmenting the "who runs this company" answer across two feed rows that can arrive apart. And
 * invitations never ride the feed at all: they are query-only (`invitations.list`), because a
 * pending invitation is administration state with a secret behind it, not something a client needs
 * offline. No payload here carries secret material — `companyInvitations.tokenHash` has no wire
 * form anywhere in the protocol.
 */

/**
 * One owner, embedded in its company's payload. `companyId` is dropped as everywhere else, and
 * `membershipId` is the domain id so it joins against a {@link SyncMembershipPayload} the client
 * already holds.
 */
export const SyncCompanyOwnerGrant = Schema.Struct({
  membershipId: MembershipId,
  /** Null for the founding owner, who was granted ownership by provisioning rather than a person. */
  grantedByMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
});
export type SyncCompanyOwnerGrant = typeof SyncCompanyOwnerGrant.Type;

/**
 * The company record itself, owners included.
 *
 * Three stored columns are deliberately not here. `syncVersion` is the feed head this very row is
 * appended to, so a copy inside the payload would be stale before it was written; a client reads
 * the head from `sync.latestVersion`. `authorizationEpoch` arrives on the same query and on every
 * page and bootstrap response, and a second copy that lagged by one change is exactly the
 * disagreement that would stop a client reseeding when it must. `nextIssueNumber` is the issue-key
 * lease counter: it moves on every `sync.reserveIssueKeys`, so putting it here would mean a
 * company change row per lease, and no client has any use for it.
 */
export const SyncCompanyPayload = Schema.Struct({
  id: CompanyId,
  name: Schema.String,
  /** The human half of every issue key in the company; immutable once keys are handed out. */
  issueKeyPrefix: IssueKeyPrefix,
  lifecycleState: CompanyLifecycleState,
  deletionScheduledAt: Schema.NullOr(CloudTimestamp),
  purgeAfter: Schema.NullOr(CloudTimestamp),
  /** The `companyOwners` rows for this company; ownership has no wire kind of its own. */
  owners: Schema.Array(SyncCompanyOwnerGrant),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SyncCompanyPayload = typeof SyncCompanyPayload.Type;

/**
 * The company's settings row. There is exactly one per company and the `companySettings` table has
 * no domain id of its own, so `id` *is* the company's domain id and the change envelope's
 * `entityId` is that same value.
 */
export const SyncCompanySettingsPayload = Schema.Struct({
  id: CompanyId,
  offlineAccessDays: OfflineAccessDays,
  updatedByMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SyncCompanySettingsPayload = typeof SyncCompanySettingsPayload.Type;

/**
 * One person's membership. `userId` is the identity behind it, which is what lets two memberships
 * in two companies be recognised as the same human; the snapshots are what keep a departed member
 * readable in audit history, so they are historical text and are never re-derived.
 */
export const SyncMembershipPayload = Schema.Struct({
  id: MembershipId,
  userId: CloudUserId,
  state: MembershipState,
  displayNameSnapshot: Schema.String,
  /** Normalized when written; loose here so a historical address can never quarantine a member. */
  emailSnapshot: Schema.String,
  invitedByMembershipId: Schema.NullOr(MembershipId),
  joinedAt: CloudTimestamp,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SyncMembershipPayload = typeof SyncMembershipPayload.Type;

/** A team. Archiving is a timestamp rather than a delete, so its records keep resolving. */
export const SyncTeamPayload = Schema.Struct({
  id: TeamId,
  name: Schema.String,
  description: Schema.String,
  archivedAt: Schema.NullOr(CloudTimestamp),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SyncTeamPayload = typeof SyncTeamPayload.Type;

/**
 * Membership of a team. The `teamMemberships` table is a pure join with no domain id, so the wire
 * id is the composite {@link teamMembershipSyncEntityId} — stable, derivable from either side, and
 * therefore idempotent under redelivery.
 */
export const SyncTeamMembershipPayload = Schema.Struct({
  id: SyncEntityId,
  teamId: TeamId,
  membershipId: MembershipId,
  createdAt: CloudTimestamp,
});
export type SyncTeamMembershipPayload = typeof SyncTeamMembershipPayload.Type;

/**
 * The entity id for a team-membership feed row.
 *
 * Both halves are UUIDv7 domain ids, so neither can contain the separator and the composite is
 * unambiguous. Producers and consumers must agree on it exactly: it is the key a tombstone for a
 * removed team member has to match.
 */
export function teamMembershipSyncEntityId(teamId: string, membershipId: string): SyncEntityId {
  return SyncEntityId.make(`${teamId}:${membershipId}`);
}

/**
 * A role: an allow-only bundle of {@link CompanyPermission} switches.
 *
 * `permissions` decodes as plain strings for the reason the `roles` table stores it that way — a
 * role written by a newer deployment must survive a rollback rather than quarantine the row and
 * take the whole permission list with it. Read it through {@link grantedCompanyPermissions}, which
 * drops the switches this build does not know; an unknown switch grants nothing either way, so the
 * failure mode is a greyed button rather than an opened door.
 */
export const SyncRolePayload = Schema.Struct({
  id: RoleId,
  name: Schema.String,
  description: Schema.String,
  permissions: Schema.Array(Schema.String),
  /** Provenance only. The seeded Admin/Manager/Member roles stay ordinary editable roles. */
  seeded: Schema.Boolean,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type SyncRolePayload = typeof SyncRolePayload.Type;

/** The switches this build understands, in the order the role listed them. */
export function grantedCompanyPermissions(
  permissions: ReadonlyArray<string>,
): ReadonlyArray<CompanyPermission> {
  return permissions.filter(isCompanyPermission);
}

/**
 * One role granted to one membership, company-wide or within a single team.
 *
 * `scope` is the tagged union from `contracts/company`, not the table's literal-plus-nullable-column
 * split: that split exists so both "everything for this membership" and "everything through this
 * team" are single index reads, and it is storage-only. A team-scoped grant never confers company
 * administration — `resolveEffectivePermissions` applies that carve-out on both sides.
 */
export const SyncRoleAssignmentPayload = Schema.Struct({
  id: RoleAssignmentId,
  membershipId: MembershipId,
  roleId: RoleId,
  scope: RoleAssignmentScope,
  createdAt: CloudTimestamp,
});
export type SyncRoleAssignmentPayload = typeof SyncRoleAssignmentPayload.Type;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Operation kinds mirror the existing issue commands one-for-one. Company administration is not
 * here on purpose: memberships, teams, roles, invitations, and bindings are online-only and go
 * through their own mutations, so they never sit in an offline outbox.
 */
export const SYNC_OPERATION_KINDS = [
  "issue.create",
  "issue.update",
  "issue.delete",
  "issue.restore",
  "issue.setSortOrder",
  "issue.setWorkflowOwner",
  "issue.setTeams",
  "issueStatus.create",
  "issueStatus.update",
  "issueStatus.delete",
  "issueStatus.reorder",
  "issueLabel.create",
  "issueLabel.update",
  "issueLabel.delete",
  "issueMilestone.create",
  "issueMilestone.update",
  "issueMilestone.delete",
  "issueCycle.create",
  "issueCycle.update",
  "issueCycle.delete",
  "issueTodo.create",
  "issueTodo.update",
  "issueTodo.delete",
  "issueRelation.create",
  "issueRelation.delete",
  "issueComment.create",
  "issueComment.update",
  "issueComment.delete",
  "issueView.create",
  "issueView.update",
  "issueView.delete",
  "issueThreadLink.create",
  "issueThreadLink.delete",
] as const;
export const SyncOperationKind = Schema.Literals(SYNC_OPERATION_KINDS);
export type SyncOperationKind = typeof SyncOperationKind.Type;

const OPERATION_KIND_SET: ReadonlySet<string> = new Set<string>(SYNC_OPERATION_KINDS);
export function isSyncOperationKind(value: string): value is SyncOperationKind {
  return OPERATION_KIND_SET.has(value);
}

/**
 * Everything an operation carries besides its kind and arguments.
 *
 * `baseVersion` is the company version the client had confirmed when it authored the write. It is
 * never a clock reading: a stale base is what the audit trail records as an overwrite, and the
 * later Convex-accepted operation still wins.
 */
const SyncOperationHeader = Schema.Struct({
  protocolVersion: PositiveInt,
  operationId: SyncOperationId,
  companyId: CompanyId,
  /** The installation that authored the write; scopes `localSequence`. */
  clientId: SyncClientId,
  /** Set when a Pathway server authored the write, `null` for a browser or mobile client. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Asserted by the caller for attribution only; Convex re-derives it from the token. */
  actor: SyncActor,
  localSequence: LocalSequence,
  baseVersion: CompanyVersion,
  /** The entity this operation writes. A create names the id the client already generated. */
  entityId: SyncEntityId,
  /**
   * Operations that must be accepted first. An unmet dependency blocks its dependents with a
   * visible reason rather than dropping them, so a rejected create never silently loses its edits.
   */
  dependsOn: Schema.Array(SyncOperationId),
});

/**
 * The envelope with its kind and arguments left open.
 *
 * This is the shape the transport, the outbox, and the Convex validator all agree on. Decode
 * through {@link SyncOperation} when the typed arguments are wanted; a client that only stores and
 * forwards an operation does not need to understand it.
 */
export const SyncOperationEnvelope = Schema.Struct({
  ...SyncOperationHeader.fields,
  kind: SyncOperationKind,
  args: Schema.Unknown,
});
export type SyncOperationEnvelope = typeof SyncOperationEnvelope.Type;

const syncOperation = <const Kind extends SyncOperationKind, Args extends Schema.Top>(
  kind: Kind,
  args: Args,
) => Schema.Struct({ ...SyncOperationHeader.fields, kind: Schema.Literal(kind), args });

const syncOperations = <
  const Kinds extends ReadonlyArray<SyncOperationKind>,
  Args extends Schema.Top,
>(
  kinds: Kinds,
  args: Args,
) => Schema.Struct({ ...SyncOperationHeader.fields, kind: Schema.Literals(kinds), args });

/** Operations whose whole request is "this entity, this verb"; the envelope's `entityId` says which. */
const NoArgs = Schema.Struct({});

// --- Issue-domain argument shapes ------------------------------------------

const IssueTitleArg = TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS));
const IssueDescriptionArg = Schema.String.check(
  Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS),
).annotate({ description: "Markdown body; whitespace is significant so it is not trimmed." });
const IssueLabelIdsArg = Schema.Array(IssueLabelId).check(
  Schema.isMaxLength(ISSUE_LABELS_MAX_PER_ISSUE),
);

/**
 * An issue's single workflow owner: the company status chain, or exactly one of the teams the
 * issue is attached to. One authoritative status regardless of how many teams can see the issue.
 */
export const IssueWorkflowOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("company") }),
  Schema.Struct({ kind: Schema.Literal("team"), teamId: TeamId }),
]);
export type IssueWorkflowOwner = typeof IssueWorkflowOwner.Type;

/**
 * A new issue. `key` is present when the client spent a leased number and absent when it ran its
 * block dry offline — Convex assigns the real key before accepting the create, and the local
 * {@link ISSUE_KEY_DRAFT_PLACEHOLDER} is only ever shown, never stored.
 */
export const SyncIssueCreateArgs = Schema.Struct({
  key: Schema.optional(IssueKey),
  title: IssueTitleArg,
  description: Schema.optional(IssueDescriptionArg),
  /** Absent takes the first status of the effective workflow, except on a triage item. */
  statusId: Schema.optional(IssueStatusId),
  priority: Schema.optional(IssuePriority),
  assignee: Schema.optional(IssueAssignee),
  projectId: Schema.optional(CloudProjectId),
  milestoneId: Schema.optional(IssueMilestoneId),
  cycleId: Schema.optional(IssueCycleId),
  parentId: Schema.optional(IssueId),
  labelIds: Schema.optional(IssueLabelIdsArg),
  dueDate: Schema.optional(IssueDate),
  triage: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(SyncOrderKey),
  /** Empty or absent means company-wide; any listed team exposes the complete issue. */
  teamIds: Schema.optional(Schema.Array(TeamId)),
  /** Absent takes the company workflow, or the cloud project's default owner when it has one. */
  workflowOwner: Schema.optional(IssueWorkflowOwner),
  workModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type SyncIssueCreateArgs = typeof SyncIssueCreateArgs.Type;

/**
 * An absent key leaves the field alone; an explicit `null` clears it. That distinction is what
 * makes two offline clients editing different fields merge: an update carries only what it touched.
 */
export const SyncIssuePatchArgs = Schema.Struct({
  title: Schema.optional(IssueTitleArg),
  description: Schema.optional(IssueDescriptionArg),
  statusId: Schema.optional(IssueStatusId),
  priority: Schema.optional(IssuePriority),
  assignee: Schema.optional(Schema.NullOr(IssueAssignee)),
  workModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  projectId: Schema.optional(Schema.NullOr(CloudProjectId)),
  milestoneId: Schema.optional(Schema.NullOr(IssueMilestoneId)),
  cycleId: Schema.optional(Schema.NullOr(IssueCycleId)),
  parentId: Schema.optional(Schema.NullOr(IssueId)),
  labelIds: Schema.optional(IssueLabelIdsArg),
  dueDate: Schema.optional(Schema.NullOr(IssueDate)),
  triage: Schema.optional(Schema.Boolean),
});
export type SyncIssuePatchArgs = typeof SyncIssuePatchArgs.Type;

/** A drag across kanban columns is one write, not a status change the list briefly misplaces. */
export const SyncIssueSetSortOrderArgs = Schema.Struct({
  sortOrder: SyncOrderKey,
  statusId: Schema.optional(IssueStatusId),
});
export type SyncIssueSetSortOrderArgs = typeof SyncIssueSetSortOrderArgs.Type;

/**
 * Moving an issue between workflows. The server reuses the same inherited base status when it can
 * and otherwise the first target status in the same semantic category; `statusId` is required only
 * when no category match exists, and the move and the status change land atomically.
 */
export const SyncIssueSetWorkflowOwnerArgs = Schema.Struct({
  workflowOwner: IssueWorkflowOwner,
  statusId: Schema.optional(IssueStatusId),
});
export type SyncIssueSetWorkflowOwnerArgs = typeof SyncIssueSetWorkflowOwnerArgs.Type;

/**
 * The complete team set, not a delta. Removing a team atomically clears or reassigns the
 * team-scoped labels, cycles, workflow ownership, and project references it would invalidate.
 */
export const SyncIssueSetTeamsArgs = Schema.Struct({ teamIds: Schema.Array(TeamId) });
export type SyncIssueSetTeamsArgs = typeof SyncIssueSetTeamsArgs.Type;

/**
 * One row of the workflow catalog: a company base status, a team's override of one, or a team-only
 * status. `baseStatusId` is what keeps an untouched company edit flowing into a team's workflow;
 * an override leaves the fields it does not set null so the base keeps supplying them.
 */
export const SyncIssueStatusCreateArgs = Schema.Struct({
  scope: Schema.Literals(["company", "team"]),
  /** Required for a `team` scope, `null` for a company status. */
  teamId: Schema.optional(Schema.NullOr(TeamId)),
  /** Set when this row overrides an inherited company status rather than adding a new one. */
  baseStatusId: Schema.optional(Schema.NullOr(IssueStatusId)),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  color: Schema.optional(IssueColor),
  category: Schema.optional(IssueStatusCategory),
  /** Ascending; ties are broken by id so an order is always total. */
  position: Schema.optional(Schema.Number),
  /** A team may hide every inherited status and run a completely different chain. */
  hidden: Schema.optional(Schema.Boolean),
});
export type SyncIssueStatusCreateArgs = typeof SyncIssueStatusCreateArgs.Type;

export const SyncIssueStatusPatchArgs = Schema.Struct({
  name: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  ),
  color: Schema.optional(Schema.NullOr(IssueColor)),
  category: Schema.optional(Schema.NullOr(IssueStatusCategory)),
  position: Schema.optional(Schema.NullOr(Schema.Number)),
  hidden: Schema.optional(Schema.Boolean),
});
export type SyncIssueStatusPatchArgs = typeof SyncIssueStatusPatchArgs.Type;

/**
 * Deleting a status has to say where its issues go: there is no unset status outside triage, and
 * dropping rows into the first remaining column is a worse answer than asking.
 */
export const SyncIssueStatusDeleteArgs = Schema.Struct({
  reassignToStatusId: IssueStatusId,
});
export type SyncIssueStatusDeleteArgs = typeof SyncIssueStatusDeleteArgs.Type;

/** The complete order within one workflow, not a move: positions are rewritten from this list. */
export const SyncIssueStatusesReorderArgs = Schema.Struct({
  statusIds: Schema.Array(IssueStatusId).check(Schema.isMinLength(1)),
});
export type SyncIssueStatusesReorderArgs = typeof SyncIssueStatusesReorderArgs.Type;

/** `teamId` null is a company label, usable by every issue; a team label needs that team attached. */
export const SyncIssueLabelCreateArgs = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  color: IssueColor,
  teamId: Schema.optional(Schema.NullOr(TeamId)),
});
export type SyncIssueLabelCreateArgs = typeof SyncIssueLabelCreateArgs.Type;

/** Milestones stay project-owned, unlike labels and cycles, which may also be team-scoped. */
export const SyncIssueMilestoneCreateArgs = Schema.Struct({
  cloudProjectId: CloudProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  description: Schema.optional(IssueDescriptionArg),
  startDate: Schema.optional(IssueDate),
  targetDate: Schema.optional(IssueDate),
  position: Schema.optional(Schema.Number),
});
export type SyncIssueMilestoneCreateArgs = typeof SyncIssueMilestoneCreateArgs.Type;

export const SyncIssueMilestonePatchArgs = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  description: Schema.optional(Schema.NullOr(IssueDescriptionArg)),
  startDate: Schema.optional(Schema.NullOr(IssueDate)),
  targetDate: Schema.optional(Schema.NullOr(IssueDate)),
  position: Schema.optional(Schema.Number),
  /** Moving a milestone clears `milestoneId` on any issue left behind in the old project. */
  cloudProjectId: Schema.optional(CloudProjectId),
});
export type SyncIssueMilestonePatchArgs = typeof SyncIssueMilestonePatchArgs.Type;

export const SyncIssueCycleCreateArgs = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  startDate: IssueDate,
  endDate: IssueDate,
  teamId: Schema.optional(Schema.NullOr(TeamId)),
});
export type SyncIssueCycleCreateArgs = typeof SyncIssueCycleCreateArgs.Type;

export const SyncIssueCyclePatchArgs = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  startDate: Schema.optional(IssueDate),
  endDate: Schema.optional(IssueDate),
});
export type SyncIssueCyclePatchArgs = typeof SyncIssueCyclePatchArgs.Type;

export const SyncIssueTodoCreateArgs = Schema.Struct({
  issueId: IssueId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  /** Absent appends after the last todo on the issue. */
  sortOrder: Schema.optional(SyncOrderKey),
});
export type SyncIssueTodoCreateArgs = typeof SyncIssueTodoCreateArgs.Type;

export const SyncIssueTodoPatchArgs = Schema.Struct({
  text: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  done: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(SyncOrderKey),
});
export type SyncIssueTodoPatchArgs = typeof SyncIssueTodoPatchArgs.Type;

/**
 * The canonical directed pair. `issueId` and `relatedIssueId` must differ and a duplicate pair is
 * rejected; the inverse is never materialised, so "blocked by" is this row read from the other end.
 */
export const SyncIssueRelationCreateArgs = Schema.Struct({
  issueId: IssueId,
  relatedIssueId: IssueId,
  kind: IssueRelationKind,
});
export type SyncIssueRelationCreateArgs = typeof SyncIssueRelationCreateArgs.Type;

/**
 * Attachment ids only. Bytes go straight to Convex file storage through a short-lived upload URL
 * and are finalized before the comment is submitted, so no file ever rides an operation argument.
 */
export const SyncIssueCommentCreateArgs = Schema.Struct({
  issueId: IssueId,
  body: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS)),
  attachmentIds: Schema.optional(
    Schema.Array(ChatAttachmentId).check(Schema.isMaxLength(ISSUE_COMMENT_MAX_ATTACHMENTS)),
  ),
});
export type SyncIssueCommentCreateArgs = typeof SyncIssueCommentCreateArgs.Type;

export const SyncIssueCommentPatchArgs = Schema.Struct({
  body: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS)),
  ),
  attachmentIds: Schema.optional(
    Schema.Array(ChatAttachmentId).check(Schema.isMaxLength(ISSUE_COMMENT_MAX_ATTACHMENTS)),
  ),
});
export type SyncIssueCommentPatchArgs = typeof SyncIssueCommentPatchArgs.Type;

/**
 * Who can see a saved view. `teams` names the teams it is shared with; `private` is its creator's
 * alone, and `company` needs the shared-view permission like `teams` does.
 */
export const IssueViewVisibility = Schema.Literals(["private", "teams", "company"]);
export type IssueViewVisibility = typeof IssueViewVisibility.Type;

export const SyncIssueViewCreateArgs = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  config: IssueViewConfig,
  visibility: Schema.optional(IssueViewVisibility),
  /** Only meaningful for `teams` visibility; ignored otherwise. */
  teamIds: Schema.optional(Schema.Array(TeamId)),
  position: Schema.optional(Schema.Number),
});
export type SyncIssueViewCreateArgs = typeof SyncIssueViewCreateArgs.Type;

/** `config` is replaced wholesale: a chip bar is edited as a unit, so a merge could not remove one. */
export const SyncIssueViewPatchArgs = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  config: Schema.optional(IssueViewConfig),
  visibility: Schema.optional(IssueViewVisibility),
  teamIds: Schema.optional(Schema.Array(TeamId)),
  position: Schema.optional(Schema.Number),
});
export type SyncIssueViewPatchArgs = typeof SyncIssueViewPatchArgs.Type;

/**
 * The link is cloud-owned; the thread stays environment-owned. Both ids travel so another client
 * can say where the work is happening without pretending the thread is portable.
 */
export const SyncIssueThreadLinkCreateArgs = Schema.Struct({
  issueId: IssueId,
  environmentId: EnvironmentId,
  threadId: TrimmedNonEmptyString,
  origin: IssueThreadLinkOrigin,
});
export type SyncIssueThreadLinkCreateArgs = typeof SyncIssueThreadLinkCreateArgs.Type;

/**
 * The typed operation union. Every variant carries the same envelope; `kind` selects the argument
 * shape, and the argument shapes mirror the existing issue commands in {@link module:issues} so an
 * offline write is the same request the online tracker already accepts.
 *
 * Entity-only operations — deletes, restores — carry no arguments: the envelope's `entityId`
 * already names the row, and a second copy of it could disagree.
 */
export const SyncOperation = Schema.Union([
  syncOperation("issue.create", SyncIssueCreateArgs),
  syncOperation("issue.update", SyncIssuePatchArgs),
  syncOperations(["issue.delete", "issue.restore"], NoArgs),
  syncOperation("issue.setSortOrder", SyncIssueSetSortOrderArgs),
  syncOperation("issue.setWorkflowOwner", SyncIssueSetWorkflowOwnerArgs),
  syncOperation("issue.setTeams", SyncIssueSetTeamsArgs),
  syncOperation("issueStatus.create", SyncIssueStatusCreateArgs),
  syncOperation("issueStatus.update", SyncIssueStatusPatchArgs),
  syncOperation("issueStatus.delete", SyncIssueStatusDeleteArgs),
  syncOperation("issueStatus.reorder", SyncIssueStatusesReorderArgs),
  syncOperation("issueLabel.create", SyncIssueLabelCreateArgs),
  syncOperation("issueLabel.update", IssueLabelPatch),
  syncOperation("issueMilestone.create", SyncIssueMilestoneCreateArgs),
  syncOperation("issueMilestone.update", SyncIssueMilestonePatchArgs),
  syncOperation("issueCycle.create", SyncIssueCycleCreateArgs),
  syncOperation("issueCycle.update", SyncIssueCyclePatchArgs),
  syncOperation("issueTodo.create", SyncIssueTodoCreateArgs),
  syncOperation("issueTodo.update", SyncIssueTodoPatchArgs),
  syncOperation("issueRelation.create", SyncIssueRelationCreateArgs),
  syncOperation("issueComment.create", SyncIssueCommentCreateArgs),
  syncOperation("issueComment.update", SyncIssueCommentPatchArgs),
  syncOperation("issueView.create", SyncIssueViewCreateArgs),
  syncOperation("issueView.update", SyncIssueViewPatchArgs),
  syncOperation("issueThreadLink.create", SyncIssueThreadLinkCreateArgs),
  syncOperations(
    [
      "issueLabel.delete",
      "issueMilestone.delete",
      "issueCycle.delete",
      "issueTodo.delete",
      "issueRelation.delete",
      "issueComment.delete",
      "issueView.delete",
      "issueThreadLink.delete",
    ],
    NoArgs,
  ),
]);
export type SyncOperation = typeof SyncOperation.Type;

// ---------------------------------------------------------------------------
// Acknowledgement and rejection
// ---------------------------------------------------------------------------

/**
 * Why an operation was refused. Each one has to be actionable on its own, because a client shows
 * it verbatim in the rejected-changes panel next to the write the user is about to lose.
 */
export const SYNC_REJECTION_CODES = [
  /** Whole-batch refusals. A client that trips one of these has a bug, not a conflict. */
  "batch-empty",
  "batch-too-large",
  "batch-args-too-large",
  "batch-duplicate-operation-id",
  "upgrade-required",
  "company-mismatch",
  /** Authorization. The overlay rolls back; independent operations keep going. */
  "not-authenticated",
  "not-a-member",
  "permission-denied",
  "company-unavailable",
  /** Domain. */
  "unknown-operation",
  "entity-not-found",
  /** An update reached a tombstoned entity; an explicit restore has to come first. */
  "entity-deleted",
  "invalid-arguments",
  "dependency-blocked",
] as const;
export const SyncRejectionCode = Schema.Literals(SYNC_REJECTION_CODES);
export type SyncRejectionCode = typeof SyncRejectionCode.Type;

/**
 * What became of one operation.
 *
 * `status` is always the operation's real outcome, and `duplicate` says only whether this answer
 * replayed a receipt an earlier attempt already wrote. The two are deliberately orthogonal: a
 * resend after a dropped response must come back with the *original* outcome, so an operation
 * rejected the first time reads as rejected on every retry instead of turning into a success the
 * client silently keeps.
 *
 * `firstVersion`/`lastVersion` bound the versions the operation produced, and the outbox holds the
 * entry until its cursor covers `lastVersion` — an acknowledged operation whose change has not
 * arrived is still pending.
 */
export const SyncOperationReceipt = Schema.Union([
  Schema.Struct({
    operationId: SyncOperationId,
    status: Schema.Literal("accepted"),
    /** True when this receipt replays a stored outcome rather than a fresh apply. */
    duplicate: Schema.Boolean,
    firstVersion: CompanyVersion,
    lastVersion: CompanyVersion,
  }),
  Schema.Struct({
    operationId: SyncOperationId,
    status: Schema.Literal("rejected"),
    duplicate: Schema.Boolean,
    code: SyncRejectionCode,
    message: Schema.String,
  }),
]);
export type SyncOperationReceipt = typeof SyncOperationReceipt.Type;

// ---------------------------------------------------------------------------
// Function signatures
// ---------------------------------------------------------------------------

/** Every company-scoped call names its company; there is no cross-company read path. */
const CompanyScopedRequest = Schema.Struct({ companyId: CompanyId });

export const SyncLatestVersionRequest = CompanyScopedRequest;
export type SyncLatestVersionRequest = typeof SyncLatestVersionRequest.Type;

/**
 * The head every client subscribes to. Deliberately tiny: subscribing to the pages themselves
 * would push a company's history at every idle client on every edit.
 */
export const SyncLatestVersionResponse = Schema.Struct({
  version: CompanyVersion,
  authorizationEpoch: AuthorizationEpoch,
});
export type SyncLatestVersionResponse = typeof SyncLatestVersionResponse.Type;

export const SyncListChangesRequest = Schema.Struct({
  companyId: CompanyId,
  cursor: CompanyVersion,
  /** Clamped to {@link SYNC_MAX_CHANGES_PER_PAGE}. */
  limit: Schema.optional(PositiveInt),
});
export type SyncListChangesRequest = typeof SyncListChangesRequest.Type;

/**
 * One drained page, or the instruction to start over.
 *
 * `Changes.cursor` advances even when authorization filtering emptied the page: a member who
 * cannot read one busy team must still make progress instead of re-reading the same window
 * forever. `CursorExpired` means the cursor predates the 90-day feed, so the changes that would
 * have carried it forward are gone and the client discards its replica and bootstraps.
 */
export const SyncListChangesResponse = Schema.Union([
  Schema.TaggedStruct("Changes", {
    changes: Schema.Array(SyncChangeEnvelope),
    cursor: CompanyVersion,
    hasMore: Schema.Boolean,
    latestVersion: CompanyVersion,
    authorizationEpoch: AuthorizationEpoch,
  }),
  Schema.TaggedStruct("CursorExpired", {
    latestVersion: CompanyVersion,
    authorizationEpoch: AuthorizationEpoch,
  }),
]);
export type SyncListChangesResponse = typeof SyncListChangesResponse.Type;

export const SyncBootstrapRequest = Schema.Struct({
  companyId: CompanyId,
  /** Opaque page token; `null` starts a fresh seed. Not a company version. */
  cursor: Schema.NullOr(TrimmedNonEmptyString),
  /** Clamped to {@link SYNC_BOOTSTRAP_PAGE_SIZE}. */
  pageSize: Schema.optional(PositiveInt),
});
export type SyncBootstrapRequest = typeof SyncBootstrapRequest.Type;

/**
 * One seed page. Entities arrive in the same envelope the feed uses, so a client folds a bootstrap
 * and a drain through one code path. `version` is the company version the completed seed is
 * consistent at and becomes the client's first cursor.
 */
export const SyncBootstrapResponse = Schema.Struct({
  version: CompanyVersion,
  authorizationEpoch: AuthorizationEpoch,
  entities: Schema.Array(SyncChangeEnvelope),
  /** Token for the next page; `null` together with `isDone` on the last one. */
  cursor: Schema.NullOr(TrimmedNonEmptyString),
  isDone: Schema.Boolean,
});
export type SyncBootstrapResponse = typeof SyncBootstrapResponse.Type;

export const SyncApplyOperationsRequest = Schema.Struct({
  companyId: CompanyId,
  /** In local sequence, at most {@link SYNC_MAX_OPERATIONS_PER_BATCH}. */
  operations: Schema.Array(SyncOperationEnvelope).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SYNC_MAX_OPERATIONS_PER_BATCH),
  ),
});
export type SyncApplyOperationsRequest = typeof SyncApplyOperationsRequest.Type;

/**
 * One receipt per submitted operation plus the version range the batch produced. `versionFrom` is
 * the head before the batch, so `(versionFrom, versionTo]` is exactly what the client's next drain
 * will carry.
 */
export const SyncApplyOperationsResponse = Schema.Struct({
  receipts: Schema.Array(SyncOperationReceipt),
  versionFrom: CompanyVersion,
  versionTo: CompanyVersion,
  authorizationEpoch: AuthorizationEpoch,
});
export type SyncApplyOperationsResponse = typeof SyncApplyOperationsResponse.Type;

// ---------------------------------------------------------------------------
// Issue key leases
// ---------------------------------------------------------------------------

/** Numbers leased per request. A client spends them offline and never recycles what it dropped. */
export const ISSUE_KEY_BLOCK_SIZE = 25;

/** Ask for the next block while this many numbers remain, so a client rarely runs dry online. */
export const ISSUE_KEY_REPLENISH_THRESHOLD = 5;

/**
 * Shown in place of a key when a client exhausts its block offline. The issue id stays stable, so
 * the placeholder never becomes a relationship: Convex assigns the real key before accepting the
 * create.
 */
export const ISSUE_KEY_DRAFT_PLACEHOLDER = "Draft";

export const SyncReserveIssueKeysRequest = Schema.Struct({
  companyId: CompanyId,
  clientId: SyncClientId,
  /** Clamped to {@link ISSUE_KEY_BLOCK_SIZE}. */
  blockSize: Schema.optional(PositiveInt),
});
export type SyncReserveIssueKeysRequest = typeof SyncReserveIssueKeysRequest.Type;

/** Inclusive range. Gaps are acceptable; two issues sharing a key is not. */
export const IssueKeyBlock = Schema.Struct({
  prefix: IssueKeyPrefix,
  blockStart: PositiveInt,
  blockEnd: PositiveInt,
  /** `prefix-blockStart`, so a caller never has to reimplement the format. */
  firstKey: IssueKey,
});
export type IssueKeyBlock = typeof IssueKeyBlock.Type;

export const SyncReserveIssueKeysResponse = IssueKeyBlock;
export type SyncReserveIssueKeysResponse = typeof SyncReserveIssueKeysResponse.Type;

/** The human-facing key for one leased number. */
export const formatIssueKey = (prefix: string, issueNumber: number): string =>
  `${prefix}-${issueNumber}`;

export const shouldReplenishIssueKeys = (remaining: number): boolean =>
  remaining <= ISSUE_KEY_REPLENISH_THRESHOLD;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Sync status as the UI shows it. Precedence when several apply is
 * `initializing → error → offline → blocked → syncing → live`: a user who is offline with blocked
 * work needs the actionable problem, not a spinner that lies.
 */
export const SyncStatus = Schema.Literals([
  /** Decoding or quarantining the local replica; nothing has been rendered yet. */
  "initializing",
  /** Confirmed and pending agree, and the cursor is at the head. */
  "live",
  /** No authorized connection. Writes still land in the outbox. */
  "offline",
  "syncing",
  /** Pending work is held by a dependency or a domain invariant, with a reason to show. */
  "blocked",
  "error",
]);
export type SyncStatus = typeof SyncStatus.Type;

export const SyncPresentation = Schema.Struct({
  status: SyncStatus,
  /** Operations still to send, or sent and still awaiting their confirmed change. */
  pendingCount: NonNegativeInt,
  blockedCount: NonNegativeInt,
  /** Refused operations awaiting the user in the rejected-changes panel. */
  rejectedCount: NonNegativeInt,
  /** The first blocking or failing reason, shown under the status. */
  reason: Schema.NullOr(Schema.String),
});
export type SyncPresentation = typeof SyncPresentation.Type;

/**
 * The cached grant that lets a company be opened without an online authorization check. Refreshed
 * after every successful authorization; a company whose offline window is zero has none, and a new
 * device cannot bootstrap offline at all.
 */
export const SyncOfflineAccessGrant = Schema.Struct({
  companyId: CompanyId,
  authorizationEpoch: AuthorizationEpoch,
  grantedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type SyncOfflineAccessGrant = typeof SyncOfflineAccessGrant.Type;
