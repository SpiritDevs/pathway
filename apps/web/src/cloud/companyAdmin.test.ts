import type { CompanyId, MembershipId, TeamId } from "@spiritdevs/contracts/company";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPANY_ADMIN_FUNCTION_REFERENCES,
  makeCompanyAdminClient,
  mapCompanyAdminError,
  newCompanyDomainId,
  type CompanyAdminConvexClient,
} from "./companyAdmin";

const COMPANY_ID = "company-1" as CompanyId;
const MEMBERSHIP_ID = "membership-1" as MembershipId;
const TEAM_ID = "team-1" as TeamId;

function fakeClient() {
  const calls: Array<{ readonly kind: string; readonly name: string; readonly args: unknown }> = [];
  const client: CompanyAdminConvexClient = {
    query: async (reference, args) => {
      calls.push({ kind: "query", name: getFunctionName(reference), args });
      return [];
    },
    mutation: async (reference, args) => {
      calls.push({ kind: "mutation", name: getFunctionName(reference), args });
      return null;
    },
    action: async (reference, args) => {
      calls.push({ kind: "action", name: getFunctionName(reference), args });
      return null;
    },
    setAuth: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { calls, client };
}

describe("company admin function references", () => {
  it("mints UUIDv7-shaped, time-sortable domain ids", () => {
    expect(newCompanyDomainId(0x0123456789ab, "00000000-0000-4000-8000-000000000000")).toBe(
      "01234567-89ab-7000-8000-000000000000",
    );
  });

  it("names every public backend function exactly", () => {
    expect(
      Object.fromEntries(
        Object.entries(COMPANY_ADMIN_FUNCTION_REFERENCES).map(([key, reference]) => [
          key,
          getFunctionName(reference as FunctionReference<"query">),
        ]),
      ),
    ).toEqual({
      listMine: "companies:listMine",
      upgradeToOrganization: "companies:upgradeToOrganization",
      listInvitations: "invitations:list",
      createInvitation: "invitations:create",
      resendInvitation: "invitations:resend",
      revokeInvitation: "invitations:revoke",
      setMembershipState: "memberships:setState",
      removeMembership: "memberships:remove",
      createTeam: "teams:create",
      updateTeam: "teams:update",
      archiveTeam: "teams:archive",
      addTeamMember: "teams:addMember",
      removeTeamMember: "teams:removeMember",
      createRole: "roles:create",
      updateRole: "roles:update",
      removeRole: "roles:remove",
      assignRole: "roles:assign",
      unassignRole: "roles:unassign",
    });
  });

  it("authenticates once and forwards mutation arguments", async () => {
    const fake = fakeClient();
    const fetchToken = vi.fn(async () => "token");
    const admin = makeCompanyAdminClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken,
      client: fake.client,
    });

    await admin.addTeamMember({
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      membershipId: MEMBERSHIP_ID,
    });

    expect(fake.client.setAuth).toHaveBeenCalledWith(fetchToken);
    expect(fake.calls).toEqual([
      {
        kind: "mutation",
        name: "teams:addMember",
        args: { companyId: COMPANY_ID, teamId: TEAM_ID, membershipId: MEMBERSHIP_ID },
      },
    ]);
    await admin.close();
    expect(fake.client.close).not.toHaveBeenCalled();
  });

  it("upgrades a personal workspace with the chosen organization name", async () => {
    const fake = fakeClient();
    const admin = makeCompanyAdminClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: fake.client,
    });

    await admin.upgradeToOrganization({ companyId: COMPANY_ID, name: "Spirit Devs" });

    expect(fake.calls).toEqual([
      {
        kind: "mutation",
        name: "companies:upgradeToOrganization",
        args: { companyId: COMPANY_ID, name: "Spirit Devs" },
      },
    ]);
  });
});

describe("mapCompanyAdminError", () => {
  it("maps authorization refusals to concise user copy", () => {
    const mapped = mapCompanyAdminError(
      new ConvexError({ code: "permission-denied", message: "Missing permission teams.manage." }),
    );
    expect(mapped.code).toBe("permission-denied");
    expect(mapped.message).toBe("You do not have permission to perform this action.");
  });

  it("preserves an unknown backend refusal message", () => {
    const mapped = mapCompanyAdminError(
      new ConvexError({ code: "future-code", message: "A useful backend explanation." }),
    );
    expect(mapped.code).toBe("future-code");
    expect(mapped.message).toBe("A useful backend explanation.");
  });
});
