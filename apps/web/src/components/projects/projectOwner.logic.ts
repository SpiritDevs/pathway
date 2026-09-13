import type { CompanyId, WorkspaceKind } from "@spiritdevs/contracts/company";

export const PERSONAL_PROJECT_OWNER = "personal-workspace";

type Company = {
  readonly id: CompanyId;
  readonly name: string;
  readonly workspaceKind: WorkspaceKind;
};

/** Personal always comes first, including accounts that still need it provisioned. */
export function projectOwnerOptions(companies: ReadonlyArray<Company>) {
  const personal = companies.find((company) => company.workspaceKind === "personal");
  return [
    personal ?? { id: PERSONAL_PROJECT_OWNER, name: "Personal workspace" },
    ...companies.filter((company) => company.workspaceKind !== "personal"),
  ];
}

export function defaultProjectOwner(
  companies: ReadonlyArray<Company>,
  activeCompanyId: CompanyId | null,
): string {
  return (
    companies.find((company) => company.id === activeCompanyId)?.id ??
    projectOwnerOptions(companies)[0]!.id
  );
}
