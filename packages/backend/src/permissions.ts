/**
 * Company permission switches and the allow-only union that resolves them.
 *
 * Kept free of Convex imports so the same resolution the backend enforces can be unit tested and,
 * later, mirrored by clients that need to grey out an action before the mutation rejects it.
 *
 * @module permissions
 */

/**
 * Every switch a role can carry. Ownership is deliberately absent: owners are a separate relation
 * that passes every check, so representing it here would let a role grant it.
 */
export const PERMISSIONS = [
  "company.read",
  "company.manage",
  "members.read",
  "members.invite",
  "members.manage",
  "teams.read",
  "teams.manage",
  "roles.read",
  "roles.manage",
  // Billing switches ship now so role editing is complete; nothing reads them yet.
  "billing.read",
  "billing.manage",
  "projects.read",
  "projects.manage",
  "calendar.read",
  "calendar.readAll",
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
export type PermissionKey = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_SET.has(value);
}

/**
 * Switches that administer the company itself. A team-scoped assignment carrying one of these
 * grants nothing: a team lead must not become a company admin by being handed a role inside their
 * own team.
 */
export const COMPANY_ADMINISTRATION_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
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

export type RoleAssignmentScope =
  | { readonly kind: "company" }
  | { readonly kind: "team"; readonly teamId: string };

export interface RoleDefinition {
  readonly roleId: string;
  readonly permissions: readonly PermissionKey[];
}

export interface RoleAssignment {
  readonly roleId: string;
  readonly scope: RoleAssignmentScope;
}

export interface EffectivePermissions {
  /** Owners pass every check without consulting the sets below. */
  readonly isOwner: boolean;
  readonly company: ReadonlySet<PermissionKey>;
  readonly teams: ReadonlyMap<string, ReadonlySet<PermissionKey>>;
}

/**
 * Unions every applicable assignment. Assignments are allow-only — there is no deny — so this is a
 * plain OR, with the company-administration carve-out applied to team-scoped grants.
 */
export function resolveEffectivePermissions(input: {
  readonly isOwner: boolean;
  readonly roles: readonly RoleDefinition[];
  readonly assignments: readonly RoleAssignment[];
}): EffectivePermissions {
  const byRoleId = new Map(input.roles.map((role) => [role.roleId, role]));
  const company = new Set<PermissionKey>();
  const teams = new Map<string, Set<PermissionKey>>();

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
      bucket = new Set<PermissionKey>();
      teams.set(teamId, bucket);
    }
    for (const permission of role.permissions) {
      if (COMPANY_ADMINISTRATION_PERMISSIONS.has(permission)) continue;
      bucket.add(permission);
    }
  }

  return { isOwner: input.isOwner, company, teams };
}

/** Company-wide check. Records attached to no team are reachable only through this. */
export function hasCompanyPermission(
  effective: EffectivePermissions,
  permission: PermissionKey,
): boolean {
  return effective.isOwner || effective.company.has(permission);
}

/**
 * Record-level check. A record attached to teams is reachable through any one of them, which is
 * what makes a multi-team issue fully visible to every attached team.
 */
export function hasRecordPermission(
  effective: EffectivePermissions,
  permission: PermissionKey,
  teamIds: readonly string[],
): boolean {
  if (hasCompanyPermission(effective, permission)) return true;
  for (const teamId of teamIds) {
    if (effective.teams.get(teamId)?.has(permission) === true) return true;
  }
  return false;
}

/**
 * Whether `permission` is granted *anywhere* — company-wide, or inside any single team. This is a
 * deliberately weaker question than {@link hasRecordPermission} and answers exactly one thing: may
 * this actor use the company catalog the workflow inherits into every team? A member who reads only
 * team A still needs the company statuses, labels, and cycles team A's board is built from, and
 * those rows are attached to no team at all.
 */
export function hasAnyScopePermission(
  effective: EffectivePermissions,
  permission: PermissionKey,
): boolean {
  if (hasCompanyPermission(effective, permission)) return true;
  for (const permissions of effective.teams.values()) {
    if (permissions.has(permission)) return true;
  }
  return false;
}

/** Teams the membership can reach with `permission`, used to filter change-feed pages. */
export function permittedTeamIds(
  effective: EffectivePermissions,
  permission: PermissionKey,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const [teamId, permissions] of effective.teams) {
    if (permissions.has(permission)) result.add(teamId);
  }
  return result;
}

export interface SeedRole {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly PermissionKey[];
}

/**
 * Seeded on company creation and editable afterwards — they are ordinary roles, not a second
 * authorization model. Ownership is not among them.
 */
export const SEED_ROLES: readonly SeedRole[] = [
  {
    key: "admin",
    name: "Admin",
    description: "Full administration of the company, short of ownership.",
    permissions: PERMISSIONS,
  },
  {
    key: "manager",
    name: "Manager",
    description: "Runs teams and their work without company-level administration.",
    permissions: [
      "company.read",
      "members.read",
      "members.invite",
      "teams.read",
      "roles.read",
      "projects.read",
      "projects.manage",
      "calendar.read",
      "calendar.readAll",
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
      "environments.read",
      "remoteAgents.dispatch",
      "audit.read",
    ],
  },
  {
    key: "member",
    name: "Member",
    description: "Works issues in the teams they belong to.",
    permissions: [
      "company.read",
      "members.read",
      "teams.read",
      "projects.read",
      "calendar.read",
      "issues.read",
      "issues.create",
      "issues.update",
      "comments.create",
      "comments.updateOwn",
      "environments.read",
    ],
  },
];
