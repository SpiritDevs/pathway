/** Process-local activation mirror used only to fence legacy local loops after cloud activation. */

let companyOwnedSlackWorkspaceIds = new Set<string>();
let companyAutomationActive = false;
let companyIntegrationAuthorityResolved = process.env.VITEST !== undefined;
let companyAutomationAuthorityResolved = process.env.VITEST !== undefined;

export function replaceCompanyOwnedSlackWorkspaces(workspaceIds: ReadonlyArray<string>): void {
  companyOwnedSlackWorkspaceIds = new Set(workspaceIds);
}

export function isCompanySlackWorkspaceOwned(workspaceId: string): boolean {
  return companyOwnedSlackWorkspaceIds.has(workspaceId);
}

export function hasCompanyOwnedSlackWorkspaces(): boolean {
  return companyOwnedSlackWorkspaceIds.size > 0;
}

export function markCompanyIntegrationAuthorityResolved(): void {
  companyIntegrationAuthorityResolved = true;
}

export function markCompanyAutomationAuthorityResolved(): void {
  companyAutomationAuthorityResolved = true;
}

export function shouldDeferLocalSlackPolling(): boolean {
  return !companyIntegrationAuthorityResolved;
}

export function shouldDeferLocalIssueAutomation(): boolean {
  return !companyAutomationAuthorityResolved;
}

export function setCompanyAutomationActive(active: boolean): void {
  companyAutomationActive = active;
}

export function isCompanyAutomationActive(): boolean {
  return companyAutomationActive;
}
