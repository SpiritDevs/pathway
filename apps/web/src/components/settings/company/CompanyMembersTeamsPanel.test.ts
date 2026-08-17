import { describe, expect, it } from "vite-plus/test";

import { companyWorkspaceKind } from "./CompanyMembersTeamsPanel";
import type { CompanySettings } from "./useCompanySettings";

type Company = CompanySettings["directory"]["company"];

describe("companyWorkspaceKind", () => {
  it("shows the upgrade experience for personal workspaces", () => {
    expect(companyWorkspaceKind({ workspaceKind: "personal" } as Company)).toBe("personal");
  });

  it("shows collaboration controls for organizations and an absent kind fallback", () => {
    expect(companyWorkspaceKind({ workspaceKind: "organization" } as Company)).toBe("organization");
    expect(companyWorkspaceKind(null)).toBe("organization");
  });
});
