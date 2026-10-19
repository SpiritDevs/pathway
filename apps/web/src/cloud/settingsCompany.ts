import type { CompanyId } from "@spiritdevs/contracts/company";
import { Atom } from "effect/unstable/reactivity";

import type { ActiveCompanyRow } from "./activeCompany";

export const SETTINGS_AUTO_SCOPE = "auto" as const;
export const SETTINGS_PROFILE_SCOPE = "profile" as const;

export type SettingsCompanyScope =
  | CompanyId
  | typeof SETTINGS_AUTO_SCOPE
  | typeof SETTINGS_PROFILE_SCOPE;

export function organizationCompanies(
  companies: ReadonlyArray<ActiveCompanyRow>,
): ReadonlyArray<ActiveCompanyRow> {
  return companies.filter((company) => company.workspaceKind === "organization");
}

export function personalCompany(
  companies: ReadonlyArray<ActiveCompanyRow>,
): ActiveCompanyRow | null {
  return companies.find((company) => company.workspaceKind === "personal") ?? null;
}

export function hasMultipleCompanies(companies: ReadonlyArray<ActiveCompanyRow>): boolean {
  return organizationCompanies(companies).length > 1;
}

export function isExplicitSettingsCompanyScope(scope: SettingsCompanyScope): scope is CompanyId {
  return scope !== SETTINGS_AUTO_SCOPE && scope !== SETTINGS_PROFILE_SCOPE;
}

/** Auto selects the only workspace that has company administration to show. */
export function resolveSettingsCompanyId(input: {
  readonly companies: ReadonlyArray<ActiveCompanyRow>;
  readonly scope: SettingsCompanyScope;
}): CompanyId | null {
  if (input.scope === SETTINGS_PROFILE_SCOPE) return null;
  const companyChoices = organizationCompanies(input.companies);
  if (input.scope === SETTINGS_AUTO_SCOPE) {
    if (companyChoices.length === 1) return companyChoices[0]!.id;
    if (companyChoices.length === 0) return personalCompany(input.companies)?.id ?? null;
    return null;
  }
  return companyChoices.find((company) => company.id === input.scope)?.id ?? null;
}

/** Content settings use the personal workspace while Profile is selected. */
export function resolveSettingsContentCompanyId(input: {
  readonly companies: ReadonlyArray<ActiveCompanyRow>;
  readonly scope: SettingsCompanyScope;
}): CompanyId | null {
  const selectedCompanyId = resolveSettingsCompanyId(input);
  if (selectedCompanyId !== null || isExplicitSettingsCompanyScope(input.scope)) {
    return selectedCompanyId;
  }
  return personalCompany(input.companies)?.id ?? null;
}

export const settingsCompanyScopeAtom = Atom.make<SettingsCompanyScope>(SETTINGS_AUTO_SCOPE).pipe(
  Atom.keepAlive,
  Atom.withLabel("settings:company-scope"),
);
