/**
 * Which permission a change-feed row requires, and whether a given actor may see it.
 *
 * Filtering happens per row and against current authorization, not against whatever was true when
 * the change was written — an epoch bump has to take records away on the very next page.
 *
 * This is the *only* visibility predicate. `sync.listChanges` and `sync.bootstrap` both route every
 * row through {@link isChangeVisible}, because a seed that disagrees with the feed by one row is a
 * replica that either never converges or holds something it was never granted.
 *
 * @module sync/visibility
 */
import {
  hasAnyScopePermission,
  hasRecordPermission,
  type EffectivePermissions,
  type PermissionKey,
} from "../permissions.ts";
import type { SyncEntityKind } from "./protocol.ts";

/**
 * Read gate per entity kind. Company administration records ride the feed so a client can render
 * a member list offline, but they are gated on the same switches the admin screens use.
 */
const READ_PERMISSION: Record<SyncEntityKind, PermissionKey> = {
  company: "company.read",
  companySettings: "company.read",
  membership: "members.read",
  team: "teams.read",
  teamMembership: "teams.read",
  role: "roles.read",
  roleAssignment: "roles.read",
  cloudProject: "projects.read",
  environmentRegistration: "environments.read",
  environmentBinding: "environments.read",
  environmentCommand: "environments.read",
  issue: "issues.read",
  issueStatus: "issues.read",
  issueLabel: "issues.read",
  issueMilestone: "issues.read",
  issueCycle: "issues.read",
  issueTodo: "issues.read",
  issueRelation: "issues.read",
  issueComment: "issues.read",
  issueAttachment: "issues.read",
  issueView: "issues.read",
  issueAuditEvent: "audit.read",
  issueThreadLink: "issues.read",
};

export function readPermissionForEntityKind(kind: SyncEntityKind): PermissionKey {
  return READ_PERMISSION[kind];
}

/**
 * Kinds whose company-scoped rows are *catalog*: the shared vocabulary a team board inherits rather
 * than a company-wide record of its own.
 *
 * A company base status, a company label, a company cycle, and a milestone on a company-wide project
 * are all attached to no team, but every team's issues resolve against them — an issue in team A
 * carries a `statusId` that names a company base status. Withholding them from a team-scoped reader
 * delivers issues whose status, labels, and cycle are unresolvable ids and a board that cannot be
 * drawn. So they are classified by kind plus row shape (no team attachment) and reach any actor
 * holding the kind's read switch *somewhere*, which is strictly narrower than making company-wide
 * records visible: a company-wide *issue* still needs a company-scoped grant.
 */
const CATALOG_ENTITY_KINDS: ReadonlySet<SyncEntityKind> = new Set<SyncEntityKind>([
  "issueStatus",
  "issueLabel",
  "issueCycle",
  "issueMilestone",
]);

/**
 * The company domain: administration records delivered as a permission-filtered read cache.
 *
 * Every one of them is company-wide (`teamIds: []`), so the ordinary rule already says a
 * team-scoped `members.read` sees no member rows at all — which is the rule, and it stays. What it
 * cannot be is the *whole* rule, because a client that receives nothing until somebody grants it
 * `company.read` cannot answer three questions it must answer offline: which company am I in, how
 * many days may I stay offline (`companySettings.offlineAccessDays`), and who am I. Hence
 * {@link isSelfCompanyRow}, which widens this set and nothing else.
 */
const COMPANY_ENTITY_KINDS: ReadonlySet<SyncEntityKind> = new Set<SyncEntityKind>([
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
]);

/**
 * The company-domain kinds every active member receives whatever their grants.
 *
 * A member necessarily knows their company exists — they authenticated into it — so withholding the
 * one row that names it protects nothing, and `companySettings` carries the offline-access budget
 * the client enforces against itself while disconnected. Both are singletons, so this widens the
 * page by exactly two rows.
 */
const MEMBER_BASELINE_KINDS: ReadonlySet<SyncEntityKind> = new Set<SyncEntityKind>([
  "company",
  "companySettings",
]);

/** Who is asking. Split from {@link VisibilityCandidate} so one actor filters a whole page. */
export interface ChangeViewer {
  readonly permissions: EffectivePermissions;
  /**
   * Identifies the acting membership for owner-private rows; `null` for an environment identity,
   * which owns nothing and therefore reaches no owner-private row. Any stable membership key works
   * as long as producers and this viewer use the same one — the callers pass the Convex id.
   */
  readonly membershipId: string | null;
  /**
   * The same membership in the *domain* id space, which is what company-domain payloads and entity
   * ids are written in — a `membership` row's entity id, the second half of a `teamMembership`
   * composite, a `roleAssignment`'s `membershipId`. Kept separate from {@link membershipId} rather
   * than replacing it because saved-view ownership is recorded as a Convex id and comparing across
   * the two spaces would silently never match.
   *
   * `null` for an environment identity, which has no membership: it is not its own member, reaches
   * no self row, and sees the company domain only through the grants its service roles carry.
   * Non-null implies *active*, because `requireCompanyActor` resolves no actor at all for a locked
   * or departed membership.
   */
  readonly membershipDomainId: string | null;
}

export interface VisibilityCandidate {
  readonly entityKind: string;
  /**
   * The row's domain id. Required rather than optional so both callers must supply it: it is how a
   * company-domain row names the member it is about, and a page that omitted it would quietly stop
   * delivering self rows.
   */
  readonly entityId: string;
  /**
   * Empty means the row is attached to no team: company-wide for an ordinary record, which only a
   * company-scoped grant can reach, or catalog for a {@link CATALOG_ENTITY_KINDS} kind.
   */
  readonly teamIds: readonly string[];
  /**
   * The encoded entity, when the row has one. Read for exactly one purpose — finding the membership
   * a `roleAssignment` is about, which its minted entity id does not encode — and never as an input
   * to a permission decision beyond that. A tombstone has none; see {@link isSelfCompanyRow}.
   */
  readonly payload?: unknown;
  /**
   * Set only for a row whose audience is exactly one member — a private saved view. Team scope is
   * then irrelevant in both directions: nobody else receives it however broad their grants, and the
   * owner receives it however narrow theirs.
   *
   * Producers must derive this from the row's *current* state, so a view that was company-wide
   * yesterday and private today stops being delivered, historical feed rows included. The one
   * exception is the payloadless tombstone that announces that narrowing to the audience it drops:
   * it passes `null` and is filtered on team scope alone, because gating it on the entity's new
   * owner would withhold it from precisely the replicas it exists to reach.
   */
  readonly ownerMembershipId?: string | null;
}

/** Whether a row of this kind and shape is company catalog rather than a company-wide record. */
function isCatalogRow(candidate: VisibilityCandidate): boolean {
  return (
    candidate.teamIds.length === 0 &&
    CATALOG_ENTITY_KINDS.has(candidate.entityKind as SyncEntityKind)
  );
}

/** The `membershipId` a company-domain payload records, when it is legible as one. */
function payloadMembershipId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { membershipId?: unknown }).membershipId;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The member a company-domain row is *about*, in domain id space, or `null` when the row is about
 * the company rather than a person — or when this build cannot tell.
 *
 * Derived from the entity id wherever the id is the answer, so a tombstone (which carries no
 * payload) still resolves: a `membership` row is named by the member's own id, and a
 * `teamMembership` by the `${teamId}:${membershipId}` composite `teamMembershipDomainId` mints.
 * A malformed composite resolves to `null` rather than to a guess, which withholds rather than
 * leaks.
 *
 * `roleAssignment` is the exception: its id is minted, so the subject is only legible from the
 * payload, and a *tombstone* therefore has no subject at all. That is deliberate and safe rather
 * than merely tolerable — every role-assignment write bumps `authorizationEpoch`, so the client
 * whose assignment was revoked discards its whole replica and reseeds instead of waiting for a
 * tombstone it would not be shown.
 */
function selfSubjectMembershipId(change: VisibilityCandidate): string | null {
  switch (change.entityKind) {
    case "membership":
      return change.entityId === "" ? null : change.entityId;
    case "teamMembership": {
      const parts = change.entityId.split(":");
      return parts.length === 2 && parts[1] !== "" ? (parts[1] ?? null) : null;
    }
    case "roleAssignment":
      return payloadMembershipId(change.payload);
    default:
      return null;
  }
}

/**
 * Whether a company-domain row is one the viewer receives as *themselves* rather than through a
 * grant: the two company singletons for any active member, and the rows that describe this
 * member's own identity, team memberships, and role assignments.
 *
 * Without it, a member holding no `members.read`/`teams.read`/`roles.read` switch replicates a
 * company they cannot name, cannot find themselves in, and cannot evaluate their own offline budget
 * for. Nothing here widens the audience of a *foreign* row: the subject must be the viewer.
 */
function isSelfCompanyRow(viewer: ChangeViewer, change: VisibilityCandidate): boolean {
  const self = viewer.membershipDomainId;
  // An environment identity is nobody's member; it reaches the company domain only through grants.
  if (self === null) return false;
  if (MEMBER_BASELINE_KINDS.has(change.entityKind as SyncEntityKind)) return true;
  return selfSubjectMembershipId(change) === self;
}

export function isChangeVisible(viewer: ChangeViewer, change: VisibilityCandidate): boolean {
  const permission = READ_PERMISSION[change.entityKind as SyncEntityKind];
  // An entity kind this build does not know is withheld rather than leaked.
  if (permission === undefined) return false;

  const owner = change.ownerMembershipId ?? null;
  if (owner !== null) {
    // Ownership is the whole grant here, and the whole gate. A private saved view is the owner's
    // own row — no company or team permission widens the audience past them, and none is required
    // of them to receive what is already theirs.
    return viewer.membershipId !== null && viewer.membershipId === owner;
  }

  // Widens the company domain and nothing else, and only onto rows about the viewer themselves. A
  // foreign membership, team, or role still needs the kind's switch at company scope, because every
  // company-domain row is company-wide and `hasRecordPermission` refuses those to a team grant.
  if (
    COMPANY_ENTITY_KINDS.has(change.entityKind as SyncEntityKind) &&
    isSelfCompanyRow(viewer, change)
  ) {
    return true;
  }

  if (isCatalogRow(change)) return hasAnyScopePermission(viewer.permissions, permission);
  return hasRecordPermission(viewer.permissions, permission, change.teamIds);
}
