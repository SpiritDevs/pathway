import { describe, expect, it } from "vite-plus/test";

import { resolveEffectivePermissions, type RoleDefinition } from "../permissions.ts";
import { SYNC_ENTITY_KINDS } from "./protocol.ts";
import {
  isChangeVisible,
  readPermissionForEntityKind,
  type ChangeViewer,
  type VisibilityCandidate,
} from "./visibility.ts";

const issueReader: RoleDefinition = { roleId: "role-reader", permissions: ["issues.read"] };
const auditReader: RoleDefinition = { roleId: "role-audit", permissions: ["audit.read"] };

const viewer = (
  permissions: ChangeViewer["permissions"],
  membershipId: string | null = null,
  membershipDomainId: string | null = null,
): ChangeViewer => ({ permissions, membershipId, membershipDomainId });

/** Entity ids are load-bearing only for the company domain; issue rows get a stable filler. */
const row = (
  entityKind: string,
  teamIds: readonly string[] = [],
  overrides: Partial<VisibilityCandidate> = {},
): VisibilityCandidate => ({ entityKind, entityId: `${entityKind}-1`, teamIds, ...overrides });

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
    expect(isChangeVisible(viewer(teamScoped), row("issue", ["team-a"]))).toBe(true);
    expect(isChangeVisible(viewer(teamScoped), row("issue", ["team-b"]))).toBe(false);
  });

  it("withholds company-wide records from a team-only grant", () => {
    expect(isChangeVisible(viewer(teamScoped), row("issue", []))).toBe(false);
  });

  it("withholds audit events from an issue-only grant", () => {
    expect(isChangeVisible(viewer(teamScoped), row("issueAuditEvent", ["team-a"]))).toBe(false);

    const auditor = resolveEffectivePermissions({
      isOwner: false,
      roles: [auditReader],
      assignments: [{ roleId: "role-audit", scope: { kind: "team", teamId: "team-a" } }],
    });
    expect(isChangeVisible(viewer(auditor), row("issueAuditEvent", ["team-a"]))).toBe(true);
  });

  it("withholds an entity kind this build does not know rather than leaking it", () => {
    const owner = resolveEffectivePermissions({ isOwner: true, roles: [], assignments: [] });
    expect(isChangeVisible(viewer(owner), row("somethingNewer", []))).toBe(false);
  });

  it("withholds an unknown kind even from an actor the self rules would otherwise widen for", () => {
    // Fail-closed has to survive the company-domain widening: an unknown kind is refused before
    // anything looks at who the row is about, so a newer deployment's kind cannot ride in on it.
    const owner = resolveEffectivePermissions({ isOwner: true, roles: [], assignments: [] });
    const self = viewer(owner, "m-convex", "membership-self");
    expect(
      isChangeVisible(self, {
        entityKind: "companyInvitation",
        entityId: "membership-self",
        teamIds: [],
      }),
    ).toBe(false);
  });

  describe("company catalog", () => {
    it("delivers the inherited catalog to a reader whose only grant is one team", () => {
      for (const entityKind of ["issueStatus", "issueLabel", "issueCycle", "issueMilestone"]) {
        expect(isChangeVisible(viewer(teamScoped), row(entityKind, []))).toBe(true);
      }
    });

    it("does not widen company-wide records of other kinds", () => {
      for (const entityKind of ["issue", "issueComment", "issueTodo", "issueView"]) {
        expect(isChangeVisible(viewer(teamScoped), row(entityKind, []))).toBe(false);
      }
    });

    it("still gates the catalog on holding the switch somewhere", () => {
      const auditOnly = resolveEffectivePermissions({
        isOwner: false,
        roles: [auditReader],
        assignments: [{ roleId: "role-audit", scope: { kind: "team", teamId: "team-a" } }],
      });
      expect(isChangeVisible(viewer(auditOnly), row("issueStatus", []))).toBe(false);
    });

    it("leaves a team-scoped catalog row on the ordinary team rule", () => {
      expect(isChangeVisible(viewer(teamScoped), row("issueStatus", ["team-b"]))).toBe(false);
    });
  });

  describe("owner-private rows", () => {
    const companyWide = resolveEffectivePermissions({
      isOwner: false,
      roles: [issueReader],
      assignments: [{ roleId: "role-reader", scope: { kind: "company" } }],
    });
    const owned = row("issueView", [], { ownerMembershipId: "membership-owner" });

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

  describe("company domain", () => {
    const SELF = "0198c0de-0000-7000-8000-00000000se1f";
    const OTHER = "0198c0de-0000-7000-8000-000000000oth";
    const TEAM = "0198c0de-0000-7000-8000-0000000team1";

    const memberReader: RoleDefinition = {
      roleId: "role-members",
      permissions: ["members.read", "teams.read", "roles.read", "company.read"],
    };

    /** A member with no grants at all — the case the self rules exist for. */
    const ungranted = resolveEffectivePermissions({ isOwner: false, roles: [], assignments: [] });
    /** `members.read`/`teams.read`/`roles.read`, but only inside one team. */
    const teamAdminGrants = resolveEffectivePermissions({
      isOwner: false,
      roles: [memberReader],
      assignments: [{ roleId: "role-members", scope: { kind: "team", teamId: TEAM } }],
    });
    const companyAdminGrants = resolveEffectivePermissions({
      isOwner: false,
      roles: [memberReader],
      assignments: [{ roleId: "role-members", scope: { kind: "company" } }],
    });

    const self = (permissions: ChangeViewer["permissions"]) =>
      viewer(permissions, "convex-self", SELF);
    const environment = (permissions: ChangeViewer["permissions"]) =>
      viewer(permissions, null, null);

    it("delivers the company and its settings to an active member with zero grants", () => {
      expect(isChangeVisible(self(ungranted), row("company", []))).toBe(true);
      expect(isChangeVisible(self(ungranted), row("companySettings", []))).toBe(true);
    });

    it("delivers the member their own membership row and nobody else's", () => {
      expect(
        isChangeVisible(self(ungranted), { entityKind: "membership", entityId: SELF, teamIds: [] }),
      ).toBe(true);
      expect(
        isChangeVisible(self(ungranted), {
          entityKind: "membership",
          entityId: OTHER,
          teamIds: [],
        }),
      ).toBe(false);
    });

    it("delivers their own team memberships, read out of the composite entity id", () => {
      expect(
        isChangeVisible(self(ungranted), {
          entityKind: "teamMembership",
          entityId: `${TEAM}:${SELF}`,
          teamIds: [],
        }),
      ).toBe(true);
      expect(
        isChangeVisible(self(ungranted), {
          entityKind: "teamMembership",
          entityId: `${TEAM}:${OTHER}`,
          teamIds: [],
        }),
      ).toBe(false);
    });

    it("refuses a malformed team-membership composite rather than guessing at it", () => {
      for (const entityId of [SELF, `${TEAM}:${SELF}:extra`, `${TEAM}:`, ":"]) {
        expect(
          isChangeVisible(self(ungranted), { entityKind: "teamMembership", entityId, teamIds: [] }),
        ).toBe(false);
      }
    });

    it("delivers their own role assignments, read out of the payload", () => {
      const assignment = (membershipId: string): VisibilityCandidate => ({
        entityKind: "roleAssignment",
        entityId: "0198c0de-0000-7000-8000-00000000ra01",
        teamIds: [],
        payload: { id: "0198c0de-0000-7000-8000-00000000ra01", membershipId, roleId: "r" },
      });
      expect(isChangeVisible(self(ungranted), assignment(SELF))).toBe(true);
      expect(isChangeVisible(self(ungranted), assignment(OTHER))).toBe(false);
    });

    it("withholds a role-assignment tombstone, which carries no payload to name a subject", () => {
      // Deliberate: a minted assignment id does not encode its member, and every assignment write
      // bumps `authorizationEpoch`, so the revoked client reseeds rather than waiting for this row.
      expect(
        isChangeVisible(self(ungranted), {
          entityKind: "roleAssignment",
          entityId: "0198c0de-0000-7000-8000-00000000ra01",
          teamIds: [],
          payload: null,
        }),
      ).toBe(false);
    });

    it("keeps team-scoped members.read from seeing any foreign company-domain row", () => {
      const granted = viewer(teamAdminGrants, "convex-self", SELF);
      for (const candidate of [
        { entityKind: "membership", entityId: OTHER, teamIds: [] },
        { entityKind: "team", entityId: TEAM, teamIds: [] },
        { entityKind: "teamMembership", entityId: `${TEAM}:${OTHER}`, teamIds: [] },
        { entityKind: "role", entityId: "role-1", teamIds: [] },
        {
          entityKind: "roleAssignment",
          entityId: "ra-1",
          teamIds: [],
          payload: { id: "ra-1", membershipId: OTHER },
        },
      ]) {
        expect(isChangeVisible(granted, candidate)).toBe(false);
      }
    });

    it("delivers every foreign row to a company-scoped grant", () => {
      const granted = viewer(companyAdminGrants, "convex-self", SELF);
      for (const candidate of [
        { entityKind: "membership", entityId: OTHER, teamIds: [] },
        { entityKind: "team", entityId: TEAM, teamIds: [] },
        { entityKind: "teamMembership", entityId: `${TEAM}:${OTHER}`, teamIds: [] },
        { entityKind: "role", entityId: "role-1", teamIds: [] },
        {
          entityKind: "roleAssignment",
          entityId: "ra-1",
          teamIds: [],
          payload: { id: "ra-1", membershipId: OTHER },
        },
        { entityKind: "company", entityId: "c-1", teamIds: [] },
        { entityKind: "companySettings", entityId: "c-1", teamIds: [] },
      ]) {
        expect(isChangeVisible(granted, candidate)).toBe(true);
      }
    });

    it("gives an environment identity no self rows at all", () => {
      // A registration is nobody's member: it reaches the company domain only through the service
      // roles it was granted, and `ungranted` has none.
      expect(isChangeVisible(environment(ungranted), row("company", []))).toBe(false);
      expect(isChangeVisible(environment(ungranted), row("companySettings", []))).toBe(false);
      expect(
        isChangeVisible(environment(ungranted), {
          entityKind: "membership",
          entityId: SELF,
          teamIds: [],
        }),
      ).toBe(false);
    });

    it("still honours company.read for an environment holding it", () => {
      const registered = resolveEffectivePermissions({
        isOwner: false,
        roles: [memberReader],
        assignments: [{ roleId: "role-members", scope: { kind: "company" } }],
      });
      expect(isChangeVisible(environment(registered), row("company", []))).toBe(true);
    });

    it("does not widen the issue domain for a self row that looks like one", () => {
      // The self rules are keyed on the company kinds only; an issue whose id happens to equal the
      // viewer's membership id stays on the ordinary team rule.
      expect(
        isChangeVisible(self(ungranted), { entityKind: "issue", entityId: SELF, teamIds: [] }),
      ).toBe(false);
    });
  });
});
