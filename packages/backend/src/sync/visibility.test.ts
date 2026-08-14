import { describe, expect, it } from "vite-plus/test";

import { resolveEffectivePermissions, type RoleDefinition } from "../permissions.ts";
import { SYNC_ENTITY_KINDS } from "./protocol.ts";
import { isChangeVisible, readPermissionForEntityKind } from "./visibility.ts";

const issueReader: RoleDefinition = { roleId: "role-reader", permissions: ["issues.read"] };
const auditReader: RoleDefinition = { roleId: "role-audit", permissions: ["audit.read"] };

describe("readPermissionForEntityKind", () => {
  it("gates every entity kind on a switch", () => {
    for (const kind of SYNC_ENTITY_KINDS) {
      expect(readPermissionForEntityKind(kind)).toBeTruthy();
    }
  });

  it("gates audit history separately from issue content", () => {
    expect(readPermissionForEntityKind("issueAuditEvent")).toBe("audit.read");
    expect(readPermissionForEntityKind("issue")).toBe("issues.read");
  });
});

describe("isChangeVisible", () => {
  const teamScoped = resolveEffectivePermissions({
    isOwner: false,
    roles: [issueReader],
    assignments: [{ roleId: "role-reader", scope: { kind: "team", teamId: "team-a" } }],
  });

  it("exposes a change through any attached team the caller can read", () => {
    expect(isChangeVisible(teamScoped, { entityKind: "issue", teamIds: ["team-a"] })).toBe(true);
    expect(isChangeVisible(teamScoped, { entityKind: "issue", teamIds: ["team-b"] })).toBe(false);
  });

  it("withholds company-wide records from a team-only grant", () => {
    expect(isChangeVisible(teamScoped, { entityKind: "issue", teamIds: [] })).toBe(false);
  });

  it("withholds audit events from an issue-only grant", () => {
    expect(
      isChangeVisible(teamScoped, { entityKind: "issueAuditEvent", teamIds: ["team-a"] }),
    ).toBe(false);

    const auditor = resolveEffectivePermissions({
      isOwner: false,
      roles: [auditReader],
      assignments: [{ roleId: "role-audit", scope: { kind: "team", teamId: "team-a" } }],
    });
    expect(isChangeVisible(auditor, { entityKind: "issueAuditEvent", teamIds: ["team-a"] })).toBe(
      true,
    );
  });

  it("withholds an entity kind this build does not know rather than leaking it", () => {
    const owner = resolveEffectivePermissions({ isOwner: true, roles: [], assignments: [] });
    expect(isChangeVisible(owner, { entityKind: "somethingNewer", teamIds: [] })).toBe(false);
  });
});
