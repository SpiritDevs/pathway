/**
 * Company, membership, team, role, and invitation contracts for the Convex cloud backend.
 *
 * These are the wire shapes web, desktop, mobile, and the Pathway server all decode. Convex owns
 * the records; every client holds a read cache of them and administers them online only, so the
 * schemas here describe *what a client is handed*, not what the database stores — a company's
 * invitation token hash, for instance, has no wire form at all.
 *
 * Two conventions run through the module:
 *
 * - Identifiers are client-generated UUIDv7 domain ids. Convex `_id` values stay a storage detail,
 *   which is what lets an offline client build relationships before the server has seen them.
 * - Timestamps are {@link CloudTimestamp} epoch milliseconds rather than the `IsoDateTime` strings
 *   the WebSocket contracts use. The cloud surface is compared, indexed, and range-scanned on these
 *   values inside Convex, and a numeric instant is the one representation that survives that
 *   without a decode step on every read.
 *
 * @module company
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { IssueKeyPrefix } from "./issues.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Epoch milliseconds. Named rather than inlined because the whole cloud surface agrees on it and
 * because it deliberately differs from `IsoDateTime`, which the environment-scoped WS contracts use.
 */
export const CloudTimestamp = NonNegativeInt;
export type CloudTimestamp = typeof CloudTimestamp.Type;

const makeCompanyEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const CompanyId = makeCompanyEntityId("CompanyId");
export type CompanyId = typeof CompanyId.Type;
export const MembershipId = makeCompanyEntityId("MembershipId");
export type MembershipId = typeof MembershipId.Type;
export const TeamId = makeCompanyEntityId("TeamId");
export type TeamId = typeof TeamId.Type;
export const RoleId = makeCompanyEntityId("RoleId");
export type RoleId = typeof RoleId.Type;
export const RoleAssignmentId = makeCompanyEntityId("RoleAssignmentId");
export type RoleAssignmentId = typeof RoleAssignmentId.Type;
export const CompanyInvitationId = makeCompanyEntityId("CompanyInvitationId");
export type CompanyInvitationId = typeof CompanyInvitationId.Type;
/** Opaque, server-assigned, and stable for the life of the Clerk identity behind it. */
export const CloudUserId = makeCompanyEntityId("CloudUserId");
export type CloudUserId = typeof CloudUserId.Type;
/** The `sub` claim Clerk issues. The only thing that authenticates a human to Convex. */
export const ClerkSubject = makeCompanyEntityId("ClerkSubject");
export type ClerkSubject = typeof ClerkSubject.Type;

export const COMPANY_NAME_MAX_CHARS = 120;
export const TEAM_NAME_MAX_CHARS = 120;
export const ROLE_NAME_MAX_CHARS = 60;

/**
 * A lower-cased, trimmed address. Invitations bind to this and only this: the acceptance gate
 * compares the invited address against the signed-in identity's verified address after both have
 * passed {@link normalizeEmail}, so `Ada@Example.com ` is accepted by `ada@example.com` alone.
 */
export const NormalizedEmail = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[^\s@A-Z]+@[^\s@A-Z]+$/),
);
export type NormalizedEmail = typeof NormalizedEmail.Type;

/** The one normalization both sides of an invitation pass through. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** A person, identified by their membership so a departure leaves attribution intact. */
const CloudMemberActor = Schema.Struct({
  kind: Schema.Literal("member"),
  membershipId: MembershipId,
});
/** A provider run. `onBehalfOfMembershipId` is null for work nobody asked for directly. */
const CloudAgentActor = Schema.Struct({
  kind: Schema.Literal("agent"),
  provider: ProviderDriverKind,
  onBehalfOfMembershipId: Schema.NullOr(MembershipId),
});
/** Not a person: a write the cloud made on somebody's behalf. */
const CloudSystemActor = Schema.Struct({
  kind: Schema.Literal("system"),
  source: Schema.Literals(["import", "cycles", "slack", "automation"]),
});
/**
 * A Pathway environment acting as itself — claiming a command, reporting a result. Its service
 * identity alone grants nothing: an environment-to-environment call still carries the on-behalf-of
 * actor whose company permissions the target enforces.
 */
const CloudEnvironmentActor = Schema.Struct({
  kind: Schema.Literal("environment"),
  environmentId: EnvironmentId,
});

/**
 * Who performed a cloud write. This is the company-model actor: it replaces the tracker's
 * anonymous `{kind: "user"}` with a specific membership, and adds the environment identity the
 * remote-control layers need.
 */
export const CloudActor = Schema.Union([
  CloudMemberActor,
  CloudAgentActor,
  CloudSystemActor,
  CloudEnvironmentActor,
]);
export type CloudActor = typeof CloudActor.Type;

/** Assignment records intent, so it never names a system source: nobody assigns work to `cycles`. */
export const CloudAssignee = Schema.Union([CloudMemberActor, CloudAgentActor]);
export type CloudAssignee = typeof CloudAssignee.Type;

/**
 * Which status chain an issue answers to. Exactly one, regardless of how many teams can see the
 * issue — a multi-team issue with two workflows would have two truths about whether it is done.
 */
export const WorkflowOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("company") }),
  Schema.Struct({ kind: Schema.Literal("team"), teamId: TeamId }),
]);
export type WorkflowOwner = typeof WorkflowOwner.Type;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Every switch a role can carry.
 *
 * Ownership is deliberately absent. Owners are a separate relation that passes every check, so a
 * switch for it would let a role hand ownership out. Billing switches ship now so role editing is
 * complete; nothing reads them until Stripe lands.
 */
export const COMPANY_PERMISSIONS = [
  "company.read",
  "company.manage",
  "members.read",
  "members.invite",
  "members.manage",
  "teams.read",
  "teams.manage",
  "roles.read",
  "roles.manage",
  "billing.read",
  "billing.manage",
  "projects.read",
  "projects.manage",
  "issues.read",
  "issues.create",
  "issues.update",
  "issues.delete",
  "workflow.manage",
  "comments.create",
  "comments.updateOwn",
  "comments.moderate",
  "views.shared",
  "automation.run",
  "automation.manage",
  "integrations.read",
  "integrations.manage",
  "environments.read",
  "environments.manage",
  "remoteAgents.dispatch",
  "remoteAgents.control",
  "audit.read",
  "data.export",
] as const;

export const CompanyPermission = Schema.Literals(COMPANY_PERMISSIONS);
export type CompanyPermission = typeof CompanyPermission.Type;

const COMPANY_PERMISSION_SET: ReadonlySet<string> = new Set(COMPANY_PERMISSIONS);

export function isCompanyPermission(value: string): value is CompanyPermission {
  return COMPANY_PERMISSION_SET.has(value);
}

/**
 * Switches that administer the company itself.
 *
 * A team-scoped assignment carrying one of these grants nothing: a team lead handed an Admin role
 * inside their own team must not thereby become a company admin.
 */
export const COMPANY_ADMINISTRATION_PERMISSIONS: ReadonlySet<CompanyPermission> = new Set([
  "company.manage",
  "members.invite",
  "members.manage",
  "teams.manage",
  "roles.manage",
  "billing.read",
  "billing.manage",
  "integrations.read",
  "integrations.manage",
  "environments.manage",
  "data.export",
]);

/**
 * Where an assignment applies. Company scope reaches every record; team scope reaches only records
 * that list the team, which is what keeps one team's role from opening another team's work.
 */
export const RoleAssignmentScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("company") }),
  Schema.Struct({ kind: Schema.Literal("team"), teamId: TeamId }),
]);
export type RoleAssignmentScope = typeof RoleAssignmentScope.Type;

/** Just enough of a role to resolve permissions; the full record is {@link CompanyRole}. */
export interface CompanyRoleGrant {
  readonly id: RoleId;
  readonly permissions: ReadonlyArray<CompanyPermission>;
}

/** Just enough of an assignment to resolve permissions. */
export interface CompanyRoleAssignmentGrant {
  readonly roleId: RoleId;
  readonly scope: RoleAssignmentScope;
}

export interface EffectiveCompanyPermissions {
  /** Owners pass every check without consulting the sets below. */
  readonly isOwner: boolean;
  readonly company: ReadonlySet<CompanyPermission>;
  readonly teams: ReadonlyMap<TeamId, ReadonlySet<CompanyPermission>>;
}

/**
 * Unions every applicable assignment.
 *
 * Assignments are allow-only — there is no deny switch anywhere in the model — so this is a plain
 * OR across company and team scopes, with the company-administration carve-out applied to
 * team-scoped grants. Clients run it to grey out an action; Convex runs it to refuse one.
 */
export function resolveEffectivePermissions(input: {
  readonly isOwner: boolean;
  readonly roles: ReadonlyArray<CompanyRoleGrant>;
  readonly assignments: ReadonlyArray<CompanyRoleAssignmentGrant>;
}): EffectiveCompanyPermissions {
  const byRoleId = new Map(input.roles.map((role) => [role.id, role]));
  const company = new Set<CompanyPermission>();
  const teams = new Map<TeamId, Set<CompanyPermission>>();

  for (const assignment of input.assignments) {
    const role = byRoleId.get(assignment.roleId);
    if (role === undefined) continue;

    if (assignment.scope.kind === "company") {
      for (const permission of role.permissions) company.add(permission);
      continue;
    }

    const teamId = assignment.scope.teamId;
    let bucket = teams.get(teamId);
    if (bucket === undefined) {
      bucket = new Set<CompanyPermission>();
      teams.set(teamId, bucket);
    }
    for (const permission of role.permissions) {
      if (COMPANY_ADMINISTRATION_PERMISSIONS.has(permission)) continue;
      bucket.add(permission);
    }
  }

  return { isOwner: input.isOwner, company, teams };
}

/** Company-wide check. A record attached to no team is reachable only through this. */
export function hasCompanyPermission(
  effective: EffectiveCompanyPermissions,
  permission: CompanyPermission,
): boolean {
  return effective.isOwner || effective.company.has(permission);
}

/**
 * Record-level check. A record attached to teams is reachable through any one of them, which is
 * what makes a multi-team issue fully visible — comments, attachments, history — to every attached
 * team rather than partially visible to each.
 */
export function hasRecordPermission(
  effective: EffectiveCompanyPermissions,
  permission: CompanyPermission,
  teamIds: ReadonlyArray<TeamId>,
): boolean {
  if (hasCompanyPermission(effective, permission)) return true;
  for (const teamId of teamIds) {
    if (effective.teams.get(teamId)?.has(permission) === true) return true;
  }
  return false;
}

/** Teams this membership can reach with `permission`; the filter a change-feed page is cut with. */
export function permittedTeamIds(
  effective: EffectiveCompanyPermissions,
  permission: CompanyPermission,
): ReadonlySet<TeamId> {
  const result = new Set<TeamId>();
  for (const [teamId, permissions] of effective.teams) {
    if (permissions.has(permission)) result.add(teamId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const CloudUser = Schema.Struct({
  id: CloudUserId,
  clerkSubject: ClerkSubject,
  /** Verified and normalized. An unverified address never reaches a company record. */
  email: NormalizedEmail,
  displayName: Schema.String,
  imageUrl: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CloudUser = typeof CloudUser.Type;

/**
 * `deletionScheduled` disables normal access immediately and stays owner-restorable for 30 days;
 * `purged` is the terminal state after records, files, invitations, credentials, and feed data are
 * gone.
 */
export const CompanyLifecycleState = Schema.Literals(["active", "deletionScheduled", "purged"]);
export type CompanyLifecycleState = typeof CompanyLifecycleState.Type;

/** Deletion disables access immediately and remains owner-restorable for this long. */
export const COMPANY_DELETION_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

export const Company = Schema.Struct({
  id: CompanyId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPANY_NAME_MAX_CHARS)),
  /** The human half of every issue key in the company; immutable once keys are handed out. */
  issueKeyPrefix: IssueKeyPrefix,
  /** Next number to hand out. Leases move it forward and never move it back; gaps are fine. */
  nextIssueNumber: PositiveInt,
  lifecycleState: CompanyLifecycleState,
  deletionScheduledAt: Schema.NullOr(CloudTimestamp),
  purgeAfter: Schema.NullOr(CloudTimestamp),
  /** Bumped by any authorization change. A client that sees a new epoch reseeds its replica. */
  authorizationEpoch: NonNegativeInt,
  /** Head of the company change feed. Every accepted operation advances it contiguously. */
  syncVersion: NonNegativeInt,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type Company = typeof Company.Type;

export const OFFLINE_ACCESS_DEFAULT_DAYS = 30;
export const OFFLINE_ACCESS_MIN_DAYS = 0;
export const OFFLINE_ACCESS_MAX_DAYS = 90;

/** Zero means company data cannot be opened at all without an online authorization check. */
export const OfflineAccessDays = Schema.Int.check(
  Schema.isBetween({ minimum: OFFLINE_ACCESS_MIN_DAYS, maximum: OFFLINE_ACCESS_MAX_DAYS }),
);
export type OfflineAccessDays = typeof OfflineAccessDays.Type;

export const CompanySettings = Schema.Struct({
  companyId: CompanyId,
  offlineAccessDays: OfflineAccessDays,
  updatedByMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanySettings = typeof CompanySettings.Type;

/**
 * `locked` keeps the row and its history while denying access; `left` is a departure. Neither is a
 * delete, because audit attribution outlives the person.
 */
export const MembershipState = Schema.Literals(["active", "locked", "left"]);
export type MembershipState = typeof MembershipState.Type;

export const CompanyMembership = Schema.Struct({
  id: MembershipId,
  companyId: CompanyId,
  userId: CloudUserId,
  state: MembershipState,
  /** Snapshots, so a removed member still reads as a person in audit history. */
  displayNameSnapshot: Schema.String,
  emailSnapshot: NormalizedEmail,
  invitedByMembershipId: Schema.NullOr(MembershipId),
  joinedAt: CloudTimestamp,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanyMembership = typeof CompanyMembership.Type;

/**
 * Ownership is a relation, not a role: it is never editable, implicitly passes every authorization
 * check, and the last one cannot be removed, locked, or allowed to leave. A company may have any
 * number of owners, and any owner may add or remove another.
 */
export const CompanyOwner = Schema.Struct({
  companyId: CompanyId,
  membershipId: MembershipId,
  grantedByMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
});
export type CompanyOwner = typeof CompanyOwner.Type;

export const Team = Schema.Struct({
  id: TeamId,
  companyId: CompanyId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(TEAM_NAME_MAX_CHARS)),
  description: Schema.String,
  archivedAt: Schema.NullOr(CloudTimestamp),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type Team = typeof Team.Type;

/** Many-to-many: a user belongs to any number of teams in any number of companies. */
export const TeamMembership = Schema.Struct({
  companyId: CompanyId,
  teamId: TeamId,
  membershipId: MembershipId,
  createdAt: CloudTimestamp,
});
export type TeamMembership = typeof TeamMembership.Type;

export const CompanyRole = Schema.Struct({
  id: RoleId,
  companyId: CompanyId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ROLE_NAME_MAX_CHARS)),
  description: Schema.String,
  permissions: Schema.Array(CompanyPermission),
  /** Provenance only. The seeded Admin/Manager/Member roles stay ordinary editable roles. */
  seeded: Schema.Boolean,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanyRole = typeof CompanyRole.Type;

export const CompanyRoleAssignment = Schema.Struct({
  id: RoleAssignmentId,
  companyId: CompanyId,
  membershipId: MembershipId,
  roleId: RoleId,
  scope: RoleAssignmentScope,
  createdAt: CloudTimestamp,
});
export type CompanyRoleAssignment = typeof CompanyRoleAssignment.Type;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** A link is good for seven days. */
export const COMPANY_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lifecycle. `expired` is written by the sweep, but a `pending` invitation past `expiresAt` is
 * already refused — a client must not treat the stored state as the whole gate.
 */
export const CompanyInvitationState = Schema.Literals([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export type CompanyInvitationState = typeof CompanyInvitationState.Type;

/**
 * Why an acceptance was refused. The reasons are distinct because the acceptance route shows a
 * different recovery for each: a mismatched address needs a different sign-in, an expired link
 * needs a resend.
 */
export const CompanyInvitationRejection = Schema.Literals([
  "invitation-not-found",
  "invitation-expired",
  "invitation-consumed",
  "invitation-revoked",
  "invitation-email-mismatch",
  "invitation-email-unverified",
]);
export type CompanyInvitationRejection = typeof CompanyInvitationRejection.Type;

/**
 * The client-visible half of an invitation. There is no token field: the plaintext exists only in
 * the emailed link and Convex stores nothing but its SHA-256 hash, so no read of this record can
 * ever produce something that accepts the invitation.
 */
export const CompanyInvitation = Schema.Struct({
  id: CompanyInvitationId,
  companyId: CompanyId,
  /** The address the accepting identity's *verified* email must equal after normalization. */
  email: NormalizedEmail,
  expiresAt: CloudTimestamp,
  /** Teams and roles applied atomically when the invitation is consumed. */
  teamIds: Schema.Array(TeamId),
  roleIds: Schema.Array(RoleId),
  invitedByMembershipId: MembershipId,
  state: CompanyInvitationState,
  /** Increments per deliberate resend; the Resend idempotency key is built from it. */
  deliveryAttempt: NonNegativeInt,
  lastDeliveryAt: Schema.NullOr(CloudTimestamp),
  lastDeliveryError: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(CloudTimestamp),
  acceptedMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CompanyInvitation = typeof CompanyInvitation.Type;

/**
 * Resend deduplicates on this key, so a retried delivery of the same attempt never sends twice
 * while a deliberate resend — which bumps the attempt — always does.
 *
 * @see https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export function invitationDeliveryIdempotencyKey(
  invitationId: CompanyInvitationId,
  deliveryAttempt: number,
): string {
  return `company-invite/${invitationId}/${deliveryAttempt}`;
}
