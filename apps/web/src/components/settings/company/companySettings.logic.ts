import {
  CompanyEntity,
  MembershipEntity,
  RoleAssignmentEntity,
  RoleEntity,
  TeamEntity,
  TeamMembershipEntity,
  type CompanyEntity as CompanyEntityType,
  type MembershipEntity as MembershipEntityType,
  type RoleAssignmentEntity as RoleAssignmentEntityType,
  type RoleEntity as RoleEntityType,
  type TeamEntity as TeamEntityType,
  type TeamMembershipEntity as TeamMembershipEntityType,
} from "@spiritdevs/client-runtime/sync";
import { grantedCompanyPermissions } from "@spiritdevs/contracts/cloudSync";
import {
  hasCompanyPermission,
  resolveEffectivePermissions,
  type CompanyPermission,
  type MembershipId,
} from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";

const isCompany = Schema.is(CompanyEntity);
const isMembership = Schema.is(MembershipEntity);
const isTeam = Schema.is(TeamEntity);
const isTeamMembership = Schema.is(TeamMembershipEntity);
const isRole = Schema.is(RoleEntity);
const isRoleAssignment = Schema.is(RoleAssignmentEntity);

export interface CompanyDirectoryEntities {
  readonly company: CompanyEntityType | null;
  readonly memberships: ReadonlyArray<MembershipEntityType>;
  readonly teams: ReadonlyArray<TeamEntityType>;
  readonly teamMemberships: ReadonlyArray<TeamMembershipEntityType>;
  readonly roles: ReadonlyArray<RoleEntityType>;
  readonly roleAssignments: ReadonlyArray<RoleAssignmentEntityType>;
}

export function companyDirectoryFromReplicaValues(
  values: Iterable<unknown>,
): CompanyDirectoryEntities {
  let company: CompanyEntityType | null = null;
  const memberships: MembershipEntityType[] = [];
  const teams: TeamEntityType[] = [];
  const teamMemberships: TeamMembershipEntityType[] = [];
  const roles: RoleEntityType[] = [];
  const roleAssignments: RoleAssignmentEntityType[] = [];

  for (const value of values) {
    if (isCompany(value)) company = value;
    else if (isMembership(value)) memberships.push(value);
    else if (isTeam(value)) teams.push(value);
    else if (isTeamMembership(value)) teamMemberships.push(value);
    else if (isRole(value)) roles.push(value);
    else if (isRoleAssignment(value)) roleAssignments.push(value);
  }

  return { company, memberships, teams, teamMemberships, roles, roleAssignments };
}

export interface MemberRoleRow {
  readonly assignmentId: RoleAssignmentEntityType["id"];
  readonly roleId: RoleAssignmentEntityType["roleId"];
  readonly roleName: string;
  readonly scopeLabel: string;
  readonly isCompanyScoped: boolean;
}

export interface CompanyMemberRow {
  readonly id: MembershipEntityType["id"];
  readonly displayName: string;
  readonly email: string;
  readonly state: MembershipEntityType["state"];
  readonly isOwner: boolean;
  readonly joinedAt: number;
  readonly teams: ReadonlyArray<{
    readonly id: TeamEntityType["id"];
    readonly name: string;
    readonly archivedAt: number | null;
  }>;
  readonly roles: ReadonlyArray<MemberRoleRow>;
}

const MEMBER_STATE_ORDER: Readonly<Record<MembershipEntityType["state"], number>> = {
  active: 0,
  locked: 1,
  left: 2,
};

export function deriveMemberRows(input: CompanyDirectoryEntities): ReadonlyArray<CompanyMemberRow> {
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const ownerIds = new Set(input.company?.owners.map((owner) => owner.membershipId) ?? []);
  const teamIdsByMembership = new Map<string, TeamEntityType["id"][]>();
  for (const join of input.teamMemberships) {
    const bucket = teamIdsByMembership.get(join.membershipId);
    if (bucket) bucket.push(join.teamId);
    else teamIdsByMembership.set(join.membershipId, [join.teamId]);
  }
  const assignmentsByMembership = new Map<string, RoleAssignmentEntityType[]>();
  for (const assignment of input.roleAssignments) {
    const bucket = assignmentsByMembership.get(assignment.membershipId);
    if (bucket) bucket.push(assignment);
    else assignmentsByMembership.set(assignment.membershipId, [assignment]);
  }

  return input.memberships
    .map((membership): CompanyMemberRow => {
      const teams = (teamIdsByMembership.get(membership.id) ?? [])
        .flatMap((teamId) => {
          const team = teamById.get(teamId);
          return team ? [{ id: team.id, name: team.name, archivedAt: team.archivedAt }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const roles = (assignmentsByMembership.get(membership.id) ?? [])
        .flatMap((assignment): MemberRoleRow[] => {
          const role = roleById.get(assignment.roleId);
          if (!role) return [];
          const team =
            assignment.scope.kind === "team" ? teamById.get(assignment.scope.teamId) : null;
          return [
            {
              assignmentId: assignment.id,
              roleId: role.id,
              roleName: role.name,
              scopeLabel: assignment.scope.kind === "company" ? "Company" : (team?.name ?? "Team"),
              isCompanyScoped: assignment.scope.kind === "company",
            },
          ];
        })
        .sort(
          (a, b) =>
            Number(b.isCompanyScoped) - Number(a.isCompanyScoped) ||
            a.roleName.localeCompare(b.roleName) ||
            a.scopeLabel.localeCompare(b.scopeLabel),
        );
      return {
        id: membership.id,
        displayName: membership.displayNameSnapshot,
        email: membership.emailSnapshot,
        state: membership.state,
        isOwner: ownerIds.has(membership.id),
        joinedAt: membership.joinedAt,
        teams,
        roles,
      };
    })
    .sort(
      (a, b) =>
        MEMBER_STATE_ORDER[a.state] - MEMBER_STATE_ORDER[b.state] ||
        a.displayName.localeCompare(b.displayName) ||
        a.email.localeCompare(b.email),
    );
}

export interface CompanyTeamRow {
  readonly id: TeamEntityType["id"];
  readonly name: string;
  readonly description: string;
  readonly archivedAt: number | null;
  readonly members: ReadonlyArray<{
    readonly id: MembershipEntityType["id"];
    readonly displayName: string;
  }>;
}

export function deriveTeamRows(input: CompanyDirectoryEntities): ReadonlyArray<CompanyTeamRow> {
  const membershipById = new Map(
    input.memberships.map((membership) => [membership.id, membership]),
  );
  const membershipIdsByTeam = new Map<string, MembershipEntityType["id"][]>();
  for (const join of input.teamMemberships) {
    const bucket = membershipIdsByTeam.get(join.teamId);
    if (bucket) bucket.push(join.membershipId);
    else membershipIdsByTeam.set(join.teamId, [join.membershipId]);
  }

  return input.teams
    .map(
      (team): CompanyTeamRow => ({
        id: team.id,
        name: team.name,
        description: team.description,
        archivedAt: team.archivedAt,
        members: (membershipIdsByTeam.get(team.id) ?? [])
          .flatMap((membershipId) => {
            const membership = membershipById.get(membershipId);
            return membership
              ? [{ id: membership.id, displayName: membership.displayNameSnapshot }]
              : [];
          })
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }),
    )
    .sort(
      (a, b) =>
        Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
        a.name.localeCompare(b.name),
    );
}

export function sortRoles(roles: ReadonlyArray<RoleEntityType>): ReadonlyArray<RoleEntityType> {
  return [...roles].sort(
    (a, b) => Number(b.seeded) - Number(a.seeded) || a.name.localeCompare(b.name),
  );
}

export type CurrentMemberPermissions =
  | { readonly status: "unknown" }
  | {
      readonly status: "known";
      readonly membershipId: MembershipId;
      readonly isOwner: boolean;
      readonly company: ReadonlySet<CompanyPermission>;
    };

export function deriveCurrentMemberPermissions(input: {
  readonly directory: CompanyDirectoryEntities;
  readonly membershipId: MembershipId | null;
  readonly isOwner: boolean | null;
}): CurrentMemberPermissions {
  if (input.membershipId === null || input.isOwner === null) return { status: "unknown" };
  if (input.isOwner) {
    return {
      status: "known",
      membershipId: input.membershipId,
      isOwner: true,
      company: new Set(),
    };
  }

  const assignments = input.directory.roleAssignments.filter(
    (assignment) => assignment.membershipId === input.membershipId,
  );
  const roleById = new Map(input.directory.roles.map((role) => [role.id, role]));
  if (assignments.some((assignment) => !roleById.has(assignment.roleId))) {
    return { status: "unknown" };
  }
  const effective = resolveEffectivePermissions({
    isOwner: false,
    roles: input.directory.roles.map((role) => ({
      id: role.id,
      permissions: grantedCompanyPermissions(role.permissions),
    })),
    assignments: assignments.map((assignment) => ({
      roleId: assignment.roleId,
      scope: assignment.scope,
    })),
  });
  return {
    status: "known",
    membershipId: input.membershipId,
    isOwner: false,
    company: effective.company,
  };
}

export function permissionGate(
  current: CurrentMemberPermissions,
  permission: CompanyPermission,
): { readonly enabled: boolean; readonly tooltip: string | null } {
  if (current.status === "unknown") return { enabled: true, tooltip: null };
  if (current.isOwner || hasCompanyPermission({ ...current, teams: new Map() }, permission)) {
    return { enabled: true, tooltip: null };
  }
  return {
    enabled: false,
    tooltip: `You need the ${permission} permission to do this.`,
  };
}
