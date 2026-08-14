import { describe, expect, it } from "vite-plus/test";

import {
  isRegisteredProofKey,
  serviceRoleScopes,
  tokenProofKeyThumbprint,
} from "./environmentRegistrations.ts";
import {
  hasCompanyPermission,
  hasRecordPermission,
  resolveEffectivePermissions,
  type RoleDefinition,
} from "./permissions.ts";

const serviceRole: RoleDefinition = {
  roleId: "role-service",
  permissions: ["issues.read", "issues.update", "members.manage"],
};

describe("tokenProofKeyThumbprint", () => {
  it("reads Convex's flattened custom-JWT confirmation claim", () => {
    expect(tokenProofKeyThumbprint({ "cnf.jkt": "thumb-flat" })).toBe("thumb-flat");
  });

  it("reads the confirmation claim the relay bound the token to", () => {
    expect(tokenProofKeyThumbprint({ cnf: { jkt: "thumb-a" } })).toBe("thumb-a");
  });

  it("does not fall back when the flattened claim is malformed", () => {
    expect(tokenProofKeyThumbprint({ "cnf.jkt": 7, cnf: { jkt: "thumb-a" } })).toBeNull();
  });

  it("treats a token with no usable confirmation claim as unbound", () => {
    expect(tokenProofKeyThumbprint({})).toBeNull();
    expect(tokenProofKeyThumbprint({ cnf: null })).toBeNull();
    expect(tokenProofKeyThumbprint({ cnf: {} })).toBeNull();
    expect(tokenProofKeyThumbprint({ cnf: { jkt: "" } })).toBeNull();
    expect(tokenProofKeyThumbprint({ cnf: { jkt: 7 } })).toBeNull();
  });
});

describe("isRegisteredProofKey", () => {
  it("accepts the key the registration recorded", () => {
    expect(
      isRegisteredProofKey({ tokenThumbprint: "thumb-a", registeredThumbprint: "thumb-a" }),
    ).toBe(true);
  });

  it("rejects a token bound to a different key", () => {
    expect(
      isRegisteredProofKey({ tokenThumbprint: "thumb-b", registeredThumbprint: "thumb-a" }),
    ).toBe(false);
  });

  it("rejects an unbound token and a registration with no recorded key", () => {
    expect(isRegisteredProofKey({ tokenThumbprint: null, registeredThumbprint: "thumb-a" })).toBe(
      false,
    );
    expect(isRegisteredProofKey({ tokenThumbprint: "thumb-a", registeredThumbprint: "" })).toBe(
      false,
    );
  });
});

describe("serviceRoleScopes", () => {
  it("grants company scope only to a registration with no teams", () => {
    expect(serviceRoleScopes([])).toEqual([{ kind: "company" }]);
  });

  it("scopes a registration's roles to the teams it was registered for", () => {
    expect(serviceRoleScopes(["team-a", "team-b", "team-a"])).toEqual([
      { kind: "team", teamId: "team-a" },
      { kind: "team", teamId: "team-b" },
    ]);
  });

  it("does not let an environment registered for one team reach another", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [serviceRole],
      assignments: serviceRoleScopes(["team-a"]).map((scope) => ({
        roleId: serviceRole.roleId,
        scope,
      })),
    });

    expect(hasRecordPermission(effective, "issues.read", ["team-a"])).toBe(true);
    expect(hasRecordPermission(effective, "issues.read", ["team-b"])).toBe(false);
    // Company-wide records are out of reach too, and the company-administration switch the role
    // carries is dropped the way any team-scoped grant drops it.
    expect(hasCompanyPermission(effective, "issues.read")).toBe(false);
    expect(hasRecordPermission(effective, "members.manage", ["team-a"])).toBe(false);
  });

  it("keeps a company-wide registration reaching every team", () => {
    const effective = resolveEffectivePermissions({
      isOwner: false,
      roles: [serviceRole],
      assignments: serviceRoleScopes([]).map((scope) => ({ roleId: serviceRole.roleId, scope })),
    });

    expect(hasRecordPermission(effective, "issues.read", ["team-b"])).toBe(true);
    expect(hasCompanyPermission(effective, "members.manage")).toBe(true);
  });
});
