import type {
  CompanyEntity,
  MembershipEntity,
  RoleAssignmentEntity,
  RoleEntity,
  TeamEntity,
  TeamMembershipEntity,
} from "@spiritdevs/client-runtime/sync";
import {
  CompanyId,
  CloudUserId,
  MembershipId,
  RoleAssignmentId,
  RoleId,
  TeamId,
} from "@spiritdevs/contracts/company";
import { SyncEntityId } from "@spiritdevs/contracts/cloudSync";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveCurrentMemberPermissions,
  deriveMemberRows,
  deriveTeamRows,
  permissionGate,
  type CompanyDirectoryEntities,
} from "./companySettings.logic";

const COMPANY_ID = CompanyId.make("company-1");
const OWNER_ID = MembershipId.make("membership-owner");
const MEMBER_ID = MembershipId.make("membership-member");
const TEAM_ID = TeamId.make("team-design");
const ADMIN_ROLE_ID = RoleId.make("role-admin");
const TEAM_ROLE_ID = RoleId.make("role-team");

const company = {
  entityKind: "company",
  id: COMPANY_ID,
  name: "Acme",
  workspaceKind: "organization",
  issueKeyPrefix: "ACME",
  lifecycleState: "active",
  deletionScheduledAt: null,
  purgeAfter: null,
  owners: [{ membershipId: OWNER_ID, grantedByMembershipId: null, createdAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
} as CompanyEntity;

const memberships = [
  {
    entityKind: "membership",
    id: MEMBER_ID,
    userId: CloudUserId.make("user-member"),
    state: "active",
    displayNameSnapshot: "Zoe Member",
    emailSnapshot: "zoe@example.com",
    invitedByMembershipId: OWNER_ID,
    joinedAt: 2,
    createdAt: 2,
    updatedAt: 2,
  },
  {
    entityKind: "membership",
    id: OWNER_ID,
    userId: CloudUserId.make("user-owner"),
    state: "active",
    displayNameSnapshot: "Ada Owner",
    emailSnapshot: "ada@example.com",
    invitedByMembershipId: null,
    joinedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  },
] as ReadonlyArray<MembershipEntity>;

const teams = [
  {
    entityKind: "team",
    id: TEAM_ID,
    name: "Design",
    description: "Product design",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  },
] as ReadonlyArray<TeamEntity>;

const teamMemberships = [
  {
    entityKind: "teamMembership",
    id: SyncEntityId.make(`${TEAM_ID}:${MEMBER_ID}`),
    teamId: TEAM_ID,
    membershipId: MEMBER_ID,
    createdAt: 2,
  },
] as ReadonlyArray<TeamMembershipEntity>;

const roles = [
  {
    entityKind: "role",
    id: ADMIN_ROLE_ID,
    name: "Admin",
    description: "Administrates",
    permissions: ["members.manage", "teams.manage"],
    seeded: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    entityKind: "role",
    id: TEAM_ROLE_ID,
    name: "Team lead",
    description: "Leads one team",
    permissions: ["members.manage", "issues.update"],
    seeded: false,
    createdAt: 1,
    updatedAt: 1,
  },
] as ReadonlyArray<RoleEntity>;

const assignments = [
  {
    entityKind: "roleAssignment",
    id: RoleAssignmentId.make("assignment-company"),
    membershipId: MEMBER_ID,
    roleId: ADMIN_ROLE_ID,
    scope: { kind: "company" },
    createdAt: 1,
  },
  {
    entityKind: "roleAssignment",
    id: RoleAssignmentId.make("assignment-team"),
    membershipId: MEMBER_ID,
    roleId: TEAM_ROLE_ID,
    scope: { kind: "team", teamId: TEAM_ID },
    createdAt: 1,
  },
] as ReadonlyArray<RoleAssignmentEntity>;

const directory: CompanyDirectoryEntities = {
  company,
  memberships,
  teams,
  teamMemberships,
  roles,
  roleAssignments: assignments,
};

describe("company settings derivation", () => {
  it("joins member rows to owners, roles, and teams and sorts by name", () => {
    const rows = deriveMemberRows(directory);
    expect(rows.map((row) => row.displayName)).toEqual(["Ada Owner", "Zoe Member"]);
    expect(rows[0]?.isOwner).toBe(true);
    expect(rows[1]?.teams).toEqual([{ id: TEAM_ID, name: "Design" }]);
    expect(rows[1]?.roles).toEqual([
      expect.objectContaining({ roleName: "Admin", scopeLabel: "Company" }),
      expect.objectContaining({ roleName: "Team lead", scopeLabel: "Design" }),
    ]);
  });

  it("counts and names team members", () => {
    expect(deriveTeamRows(directory)).toEqual([
      expect.objectContaining({
        id: TEAM_ID,
        members: [{ id: MEMBER_ID, displayName: "Zoe Member" }],
      }),
    ]);
  });

  it("mirrors company permission resolution and ignores team-scoped administration", () => {
    const withCompanyRole = deriveCurrentMemberPermissions({
      directory,
      membershipId: MEMBER_ID,
      isOwner: false,
    });
    expect(permissionGate(withCompanyRole, "members.manage").enabled).toBe(true);

    const teamOnly = deriveCurrentMemberPermissions({
      directory: { ...directory, roleAssignments: [assignments[1]!] },
      membershipId: MEMBER_ID,
      isOwner: false,
    });
    expect(permissionGate(teamOnly, "members.manage")).toEqual({
      enabled: false,
      tooltip: "You need the members.manage permission to do this.",
    });
  });

  it("keeps actions enabled when exact actor permissions cannot be derived", () => {
    const unknown = deriveCurrentMemberPermissions({
      directory,
      membershipId: null,
      isOwner: null,
    });
    expect(permissionGate(unknown, "roles.manage")).toEqual({ enabled: true, tooltip: null });
  });
});
