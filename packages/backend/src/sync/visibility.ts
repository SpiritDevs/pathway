/**
 * Which permission a change-feed row requires, and whether a given actor may see it.
 *
 * Filtering happens per row and against current authorization, not against whatever was true when
 * the change was written — an epoch bump has to take records away on the very next page.
 *
 * @module sync/visibility
 */
import {
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

export interface VisibilityCandidate {
  readonly entityKind: string;
  /** Empty means company-wide, which only a company-scoped grant can reach. */
  readonly teamIds: readonly string[];
}

export function isChangeVisible(
  effective: EffectivePermissions,
  change: VisibilityCandidate,
): boolean {
  const permission = READ_PERMISSION[change.entityKind as SyncEntityKind];
  // An entity kind this build does not know is withheld rather than leaked.
  if (permission === undefined) return false;
  return hasRecordPermission(effective, permission, change.teamIds);
}
