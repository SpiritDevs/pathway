import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import type { ActiveCompanyRow } from "./activeCompany";
import {
  hasMultipleCompanies,
  isExplicitSettingsCompanyScope,
  organizationCompanies,
  resolveSettingsCompanyId,
  SETTINGS_AUTO_SCOPE,
  SETTINGS_PROFILE_SCOPE,
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

  it("keeps explicit Profile company-free even with one organization", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME],
        scope: SETTINGS_PROFILE_SCOPE,
      }),
    ).toBeNull();
  });

  it("automatically selects a sole organization when the picker is absent", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME],
        scope: SETTINGS_AUTO_SCOPE,
      }),
    ).toBe(ACME.id);
  });

  it("keeps Auto company-free when multiple organizations require an explicit choice", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME, BETA],
        scope: SETTINGS_AUTO_SCOPE,
      }),
    ).toBeNull();
  });

  it("uses an explicitly selected organization", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME],
        scope: ACME.id,
      }),
    ).toBe(ACME.id);
  });

  it("uses profile as a company-free scope for multi-company accounts", () => {
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME, BETA],
        scope: SETTINGS_PROFILE_SCOPE,
      }),
    ).toBeNull();
    expect(
      resolveSettingsCompanyId({
        companies: [PERSONAL, ACME, BETA],
        scope: BETA.id,
      }),
    ).toBe(BETA.id);
  });

  it("distinguishes explicit company bootstrap from Auto and Profile", () => {
    expect(isExplicitSettingsCompanyScope(ACME.id)).toBe(true);
    expect(isExplicitSettingsCompanyScope(SETTINGS_AUTO_SCOPE)).toBe(false);
    expect(isExplicitSettingsCompanyScope(SETTINGS_PROFILE_SCOPE)).toBe(false);
  });
});
