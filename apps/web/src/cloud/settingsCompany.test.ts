import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import type { ActiveCompanyRow } from "./activeCompany";
import {
  hasMultipleCompanies,
  organizationCompanies,
  resolveSettingsCompanyId,
} from "./settingsCompany";

const PERSONAL = {
  id: CompanyId.make("personal"),
  name: "Corey's Workspace",
  workspaceKind: "personal",
  issueKeyPrefix: "COR",
} satisfies ActiveCompanyRow;
const ACME = {
  id: CompanyId.make("acme"),
  name: "Acme",
  workspaceKind: "organization",
  issueKeyPrefix: "ACM",
} satisfies ActiveCompanyRow;
const BETA = {
  id: CompanyId.make("beta"),
  name: "Beta",
  workspaceKind: "organization",
  issueKeyPrefix: "BET",
} satisfies ActiveCompanyRow;

describe("settings company scope", () => {
  it("counts organizations rather than the personal workspace as companies", () => {
    expect(organizationCompanies([PERSONAL, ACME, BETA])).toEqual([ACME, BETA]);
    expect(hasMultipleCompanies([PERSONAL, ACME])).toBe(false);
    expect(hasMultipleCompanies([PERSONAL, ACME, BETA])).toBe(true);
  });

  it("keeps the existing active workspace behavior until there are multiple companies", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME],
        activeCompanyId: ACME.id,
        scope: "profile",
      }),
    ).toBe(ACME.id);
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME],
        activeCompanyId: PERSONAL.id,
        scope: ACME.id,
      }),
    ).toBe(ACME.id);
  });

  it("uses profile as a company-free scope for multi-company accounts", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME, BETA],
        activeCompanyId: ACME.id,
        scope: "profile",
      }),
    ).toBeNull();
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME, BETA],
        activeCompanyId: ACME.id,
        scope: BETA.id,
      }),
    ).toBe(BETA.id);
  });
});
