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

export function hasMultipleCompanies(companies: ReadonlyArray<ActiveCompanyRow>): boolean {
  return organizationCompanies(companies).length > 1;
}

export function isExplicitSettingsCompanyScope(scope: SettingsCompanyScope): scope is CompanyId {
  return scope !== SETTINGS_AUTO_SCOPE && scope !== SETTINGS_PROFILE_SCOPE;
}

/**
 * Auto preserves the no-picker single-company experience. Explicit Profile is always company-free.
 */
export function resolveSettingsCompanyId(input: {
  readonly companies: ReadonlyArray<ActiveCompanyRow>;
  readonly scope: SettingsCompanyScope;
}): CompanyId | null {
  if (input.scope === SETTINGS_PROFILE_SCOPE) return null;
  const companyChoices = organizationCompanies(input.companies);
  if (input.scope === SETTINGS_AUTO_SCOPE) {
    return companyChoices.length === 1 ? companyChoices[0]!.id : null;
  }
  return companyChoices.find((company) => company.id === input.scope)?.id ?? null;
}

export const settingsCompanyScopeAtom = Atom.make<SettingsCompanyScope>(SETTINGS_AUTO_SCOPE).pipe(
  Atom.keepAlive,
  Atom.withLabel("settings:company-scope"),
);
