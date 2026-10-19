import { describe, expect, it } from "vite-plus/test";

import {
  COMPANY_ADMINISTRATION_PERMISSIONS,
  hasCompanyPermission,
  hasRecordPermission,
  permittedTeamIds,
  resolveEffectivePermissions,
  SEED_ROLES,
  type RoleDefinition,
} from "./permissions.ts";

const reader: RoleDefinition = { roleId: "role-reader", permissions: ["issues.read"] };
const writer: RoleDefinition = {
  roleId: "role-writer",
  permissions: ["issues.read", "issues.update"],
};
const companyAdmin: RoleDefinition = {
  roleId: "role-admin",
  permissions: ["issues.read", "members.manage"],
};

describe("resolveEffectivePermissions", () => {
  it("unions company and team assignments", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [reader, writer],
      assignments: [
        { roleId: "role-reader", scope: { kind: "company" } },
        { roleId: "role-writer", scope: { kind: "team", teamId: "team-a" } },
      ],
    });

    expect(hasCompanyPermission(effective, "issues.read")).toBe(true);
    expect(hasCompanyPermission(effective, "issues.update")).toBe(false);
    expect(hasRecordPermission(effective, "issues.update", ["team-a"])).toBe(true);
  });

  it("does not let a role in one team grant access through another", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [writer],
      assignments: [{ roleId: "role-writer", scope: { kind: "team", teamId: "team-a" } }],
    });

    expect(hasRecordPermission(effective, "issues.update", ["team-b"])).toBe(false);
    // Any one attached team is enough, which is what makes a multi-team issue fully visible.
    expect(hasRecordPermission(effective, "issues.update", ["team-b", "team-a"])).toBe(true);
  });

  it("requires a company-scoped grant for records attached to no team", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [writer],
      assignments: [{ roleId: "role-writer", scope: { kind: "team", teamId: "team-a" } }],
    });

    expect(hasRecordPermission(effective, "issues.update", [])).toBe(false);
  });

  it("drops company administration from a team-scoped assignment", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [companyAdmin],
      assignments: [{ roleId: "role-admin", scope: { kind: "team", teamId: "team-a" } }],
    });

    expect(COMPANY_ADMINISTRATION_PERMISSIONS.has("members.manage")).toBe(true);
    expect(hasCompanyPermission(effective, "members.manage")).toBe(false);
    expect(hasRecordPermission(effective, "members.manage", ["team-a"])).toBe(false);
    expect(hasRecordPermission(effective, "issues.read", ["team-a"])).toBe(true);
  });

  it("keeps company administration when the assignment is company-scoped", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [companyAdmin],
      assignments: [{ roleId: "role-admin", scope: { kind: "company" } }],
    });

    expect(hasCompanyPermission(effective, "members.manage")).toBe(true);
  });

  it("passes every check for an owner without any assignment", () => {
    const effective = resolveEffectivePermissions({ isOwner: true, roles: [], assignments: [] });

    expect(hasCompanyPermission(effective, "roles.manage")).toBe(true);
    expect(hasRecordPermission(effective, "issues.delete", [])).toBe(true);
  });

  it("ignores assignments whose role no longer exists", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [],
      assignments: [{ roleId: "role-deleted", scope: { kind: "company" } }],
    });

    expect(hasCompanyPermission(effective, "issues.read")).toBe(false);
  });

  it("reports the teams a permission reaches", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [reader, writer],
      assignments: [
        { roleId: "role-reader", scope: { kind: "team", teamId: "team-a" } },
        { roleId: "role-writer", scope: { kind: "team", teamId: "team-b" } },
      ],
    });

    expect([...permittedTeamIds(effective, "issues.update")]).toEqual(["team-b"]);
    expect([...permittedTeamIds(effective, "issues.read")].sort()).toEqual(["team-a", "team-b"]);
  });
});

describe("SEED_ROLES", () => {
  it("seeds Admin, Manager, and Member and grants ownership through none of them", () => {
    expect(SEED_ROLES.map((role) => role.key)).toEqual(["admin", "manager", "member"]);
    for (const role of SEED_ROLES) {
      expect(role.permissions.length).toBeGreaterThan(0);
    }
  });

  it("keeps company administration out of the Member role", () => {
    const member = SEED_ROLES.find((role) => role.key === "member");
    expect(member).toBeDefined();
    for (const permission of member?.permissions ?? []) {
      expect(COMPANY_ADMINISTRATION_PERMISSIONS.has(permission)).toBe(false);
    }
  });
});
