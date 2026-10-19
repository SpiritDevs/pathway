import {
  CompanyEntity,
  MembershipEntity,
  RoleAssignmentEntity,
  RoleEntity,
} from "@spiritdevs/client-runtime/sync";
import { MembershipId } from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { canManageContactsFromReplica } from "./contactPermissions";

const memberId = MembershipId.make("member-a");
const otherMemberId = MembershipId.make("member-b");
const company = Schema.decodeUnknownSync(CompanyEntity)({
  entityKind: "company",
  id: "company-a",
  name: "A",
  workspaceKind: "organization",
  issueKeyPrefix: "A",
  lifecycleState: "active",
  deletionScheduledAt: null,
  purgeAfter: null,
  owners: [],
  createdAt: 1,
  updatedAt: 1,
});
const member = Schema.decodeUnknownSync(MembershipEntity)({
  entityKind: "membership",
  id: memberId,
  userId: "user",
  state: "active",
  displayNameSnapshot: "Member",
  emailSnapshot: "member@example.com",
  invitedByMembershipId: null,
  joinedAt: 1,
  createdAt: 1,
  updatedAt: 1,
});
const role = Schema.decodeUnknownSync(RoleEntity)({
  entityKind: "role",
  id: "contact-manager",
  name: "Contacts",
  description: "",
  permissions: ["projects.manage"],
  seeded: false,
  createdAt: 1,
  updatedAt: 1,
});
const assignment = Schema.decodeUnknownSync(RoleAssignmentEntity)({
  entityKind: "roleAssignment",
  id: "grant",
  membershipId: memberId,
  roleId: role.id,
  scope: { kind: "company" },
  createdAt: 1,
});
const ownerCompany = {
  ...company,
  owners: [{ membershipId: memberId, grantedByMembershipId: null, createdAt: 1 }],
};

describe("contact write permissions", () => {
  it("allows an active owner without a role", () => {
    expect(canManageContactsFromReplica([ownerCompany, member], memberId)).toBe(true);
  });

  it("requires projects.manage in a company-scoped role", () => {
    expect(canManageContactsFromReplica([company, member, role, assignment], memberId)).toBe(true);
    expect(
      canManageContactsFromReplica(
        [company, member, { ...role, permissions: ["issues.update"] }, assignment],
        memberId,
      ),
    ).toBe(false);
    expect(canManageContactsFromReplica([company, member], memberId)).toBe(false);
  });

  it("does not turn a team-scoped grant into company contact access", () => {
    const teamGrant = { ...assignment, scope: { kind: "team", teamId: "team" } };
    expect(canManageContactsFromReplica([company, member, role, teamGrant], memberId)).toBe(false);
  });

  it.each(["locked", "left"])(
    "denies a %s membership even for an owner or company manager",
    (state) => {
      const inactive = { ...member, state };
      expect(canManageContactsFromReplica([ownerCompany, inactive], memberId)).toBe(false);
      expect(canManageContactsFromReplica([company, inactive, role, assignment], memberId)).toBe(
        false,
      );
    },
  );

  it("denies missing company, membership, or assigned role data", () => {
    expect(canManageContactsFromReplica([member, role, assignment], memberId)).toBe(false);
    expect(canManageContactsFromReplica([ownerCompany], memberId)).toBe(false);
    expect(canManageContactsFromReplica([company, member, role, assignment], null)).toBe(false);
    expect(canManageContactsFromReplica([company, member, assignment], memberId)).toBe(false);
  });

  it("does not use another company's membership or grants from its selected replica", () => {
    // Replica rows are company-scoped by the caller; membership IDs are company-specific.
    const otherCompany = { ...company, id: "company-b" };
    const otherMember = { ...member, id: otherMemberId };
    const otherGrant = { ...assignment, membershipId: otherMemberId };
    expect(
      canManageContactsFromReplica([otherCompany, otherMember, role, otherGrant], memberId),
    ).toBe(false);
    expect(canManageContactsFromReplica([company, member, role, otherGrant], memberId)).toBe(false);
  });
});
