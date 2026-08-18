import type { CompanyId } from "@spiritdevs/contracts/company";
import { Atom } from "effect/unstable/reactivity";

import type { ActiveCompanyRow } from "./activeCompany";

export const SETTINGS_PROFILE_SCOPE = "profile" as const;

export type SettingsCompanyScope = CompanyId | typeof SETTINGS_PROFILE_SCOPE;

export function organizationCompanies(
  companies: ReadonlyArray<ActiveCompanyRow>,
): ReadonlyArray<ActiveCompanyRow> {
  return companies.filter((company) => company.workspaceKind === "organization");
}

export function hasMultipleCompanies(companies: ReadonlyArray<ActiveCompanyRow>): boolean {
  return organizationCompanies(companies).length > 1;
}

/**
 * Multi-company Settings starts at the user's profile and only gains a company context after an
 * explicit choice. Single-workspace accounts retain the existing implicit workspace behavior.
 */
export function resolveSettingsCompanyId(input: {
  readonly companies: ReadonlyArray<ActiveCompanyRow>;
  readonly activeCompanyId: CompanyId | null;
  readonly scope: SettingsCompanyScope;
}): CompanyId | null {
  const companyChoices = organizationCompanies(input.companies);
  if (input.scope !== SETTINGS_PROFILE_SCOPE) {
    const selectedCompany = companyChoices.find((company) => company.id === input.scope);
    if (selectedCompany !== undefined) return selectedCompany.id;
  }
  if (companyChoices.length <= 1) {
    return (
      input.companies.find((company) => company.id === input.activeCompanyId)?.id ??
      input.companies[0]?.id ??
      null
    );
  }
  if (input.scope === SETTINGS_PROFILE_SCOPE) return null;
  return null;
}

export const settingsCompanyScopeAtom = Atom.make<SettingsCompanyScope>(
  SETTINGS_PROFILE_SCOPE,
).pipe(Atom.keepAlive, Atom.withLabel("settings:company-scope"));
