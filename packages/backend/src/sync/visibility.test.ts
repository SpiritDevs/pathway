import { describe, expect, it } from "vite-plus/test";

import { resolveEffectivePermissions, type RoleDefinition } from "../permissions.ts";
import { SYNC_ENTITY_KINDS } from "./protocol.ts";
import { isChangeVisible, readPermissionForEntityKind, type ChangeViewer } from "./visibility.ts";

const issueReader: RoleDefinition = { roleId: "role-reader", permissions: ["issues.read"] };
const auditReader: RoleDefinition = { roleId: "role-audit", permissions: ["audit.read"] };

const viewer = (
  permissions: ChangeViewer["permissions"],
  membershipId: string | null = null,
): ChangeViewer => ({ permissions, membershipId });

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
    expect(isChangeVisible(viewer(teamScoped), { entityKind: "issue", teamIds: ["team-a"] })).toBe(
      true,
    );
    expect(isChangeVisible(viewer(teamScoped), { entityKind: "issue", teamIds: ["team-b"] })).toBe(
      false,
    );
  });

  it("withholds company-wide records from a team-only grant", () => {
    expect(isChangeVisible(viewer(teamScoped), { entityKind: "issue", teamIds: [] })).toBe(false);
  });

  it("withholds audit events from an issue-only grant", () => {
    expect(
      isChangeVisible(viewer(teamScoped), { entityKind: "issueAuditEvent", teamIds: ["team-a"] }),
    ).toBe(false);

    const auditor = resolveEffectivePermissions({
      isOwner: false,
      roles: [auditReader],
      assignments: [{ roleId: "role-audit", scope: { kind: "team", teamId: "team-a" } }],
    });
    expect(
      isChangeVisible(viewer(auditor), { entityKind: "issueAuditEvent", teamIds: ["team-a"] }),
    ).toBe(true);
  });

  it("withholds an entity kind this build does not know rather than leaking it", () => {
    const owner = resolveEffectivePermissions({ isOwner: true, roles: [], assignments: [] });
    expect(isChangeVisible(viewer(owner), { entityKind: "somethingNewer", teamIds: [] })).toBe(
      false,
    );
  });

  describe("company catalog", () => {
    it("delivers the inherited catalog to a reader whose only grant is one team", () => {
      for (const entityKind of ["issueStatus", "issueLabel", "issueCycle", "issueMilestone"]) {
        expect(isChangeVisible(viewer(teamScoped), { entityKind, teamIds: [] })).toBe(true);
      }
    });

    it("does not widen company-wide records of other kinds", () => {
      for (const entityKind of ["issue", "issueComment", "issueTodo", "issueView"]) {
        expect(isChangeVisible(viewer(teamScoped), { entityKind, teamIds: [] })).toBe(false);
      }
    });

    it("still gates the catalog on holding the switch somewhere", () => {
      const auditOnly = resolveEffectivePermissions({
        isOwner: false,
        roles: [auditReader],
        assignments: [{ roleId: "role-audit", scope: { kind: "team", teamId: "team-a" } }],
      });
      expect(isChangeVisible(viewer(auditOnly), { entityKind: "issueStatus", teamIds: [] })).toBe(
        false,
      );
    });

    it("leaves a team-scoped catalog row on the ordinary team rule", () => {
      expect(
        isChangeVisible(viewer(teamScoped), { entityKind: "issueStatus", teamIds: ["team-b"] }),
      ).toBe(false);
    });
  });

  describe("owner-private rows", () => {
    const companyWide = resolveEffectivePermissions({
      isOwner: false,
      roles: [issueReader],
      assignments: [{ roleId: "role-reader", scope: { kind: "company" } }],
    });
    const owned = { entityKind: "issueView", teamIds: [], ownerMembershipId: "membership-owner" };

    it("withholds a private view from every other reader, company-scoped or not", () => {
      expect(isChangeVisible(viewer(companyWide, "membership-other"), owned)).toBe(false);
      expect(isChangeVisible(viewer(teamScoped, "membership-other"), owned)).toBe(false);
    });

    it("withholds it from an owner in every sense but this one", () => {
      const companyOwner = resolveEffectivePermissions({
        isOwner: true,
        roles: [],
        assignments: [],
      });
      expect(isChangeVisible(viewer(companyOwner, "membership-other"), owned)).toBe(false);
    });

    it("delivers it to its owner even when their read grants are team-scoped", () => {
      expect(isChangeVisible(viewer(teamScoped, "membership-owner"), owned)).toBe(true);
    });

    it("reaches no environment identity, which carries no membership", () => {
      expect(isChangeVisible(viewer(companyWide, null), owned)).toBe(false);
    });
  });
});
