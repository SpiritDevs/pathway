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

/** Who is asking. Split from {@link VisibilityCandidate} so one actor filters a whole page. */
export interface ChangeViewer {
  readonly permissions: EffectivePermissions;
  /**
   * Identifies the acting membership for owner-private rows; `null` for an environment identity,
   * which owns nothing and therefore reaches no owner-private row. Any stable membership key works
   * as long as producers and this viewer use the same one — the callers pass the Convex id.
   */
  readonly membershipId: string | null;
}

export interface VisibilityCandidate {
  readonly entityKind: string;
  /**
   * Empty means the row is attached to no team: company-wide for an ordinary record, which only a
   * company-scoped grant can reach, or catalog for a {@link CATALOG_ENTITY_KINDS} kind.
   */
  readonly teamIds: readonly string[];
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

  if (isCatalogRow(change)) return hasAnyScopePermission(viewer.permissions, permission);
  return hasRecordPermission(viewer.permissions, permission, change.teamIds);
}
