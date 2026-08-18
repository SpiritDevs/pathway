/** Process-local activation mirror used only to fence legacy local loops after cloud activation. */

const companyOwnedSlackWorkspaceIds = new Map<string, ReadonlySet<string>>();
const companiesWithActiveAutomation = new Set<string>();
let expectedCompanyIntegrationIds = new Set<string>();
let resolvedCompanyIntegrationIds = new Set<string>();
let expectedCompanyAutomationIds = new Set<string>();
let resolvedCompanyAutomationIds = new Set<string>();
let companyIntegrationAuthorityResolved = process.env.VITEST !== undefined;
let companyAutomationAuthorityResolved = process.env.VITEST !== undefined;

function containsEvery(expected: ReadonlySet<string>, actual: ReadonlySet<string>): boolean {
  for (const companyId of expected) {
    if (!actual.has(companyId)) return false;
  }
  return true;
}

/** Reconciles the companies whose first Slack authority read must land before legacy polling. */
export function setExpectedCompanyIntegrationIds(companyIds: ReadonlyArray<string>): void {
  expectedCompanyIntegrationIds = new Set(companyIds);
  resolvedCompanyIntegrationIds = new Set(
    [...resolvedCompanyIntegrationIds].filter((companyId) =>
      expectedCompanyIntegrationIds.has(companyId),
    ),
  );
  for (const companyId of companyOwnedSlackWorkspaceIds.keys()) {
    if (!expectedCompanyIntegrationIds.has(companyId)) {
      companyOwnedSlackWorkspaceIds.delete(companyId);
    }
  }
  companyIntegrationAuthorityResolved = containsEvery(
    expectedCompanyIntegrationIds,
    resolvedCompanyIntegrationIds,
  );
}

/** Reconciles the companies whose first automation authority read must land before legacy work. */
export function setExpectedCompanyAutomationIds(companyIds: ReadonlyArray<string>): void {
  expectedCompanyAutomationIds = new Set(companyIds);
  resolvedCompanyAutomationIds = new Set(
    [...resolvedCompanyAutomationIds].filter((companyId) =>
      expectedCompanyAutomationIds.has(companyId),
    ),
  );
  for (const companyId of companiesWithActiveAutomation) {
    if (!expectedCompanyAutomationIds.has(companyId)) {
      companiesWithActiveAutomation.delete(companyId);
    }
  }
  companyAutomationAuthorityResolved = containsEvery(
    expectedCompanyAutomationIds,
    resolvedCompanyAutomationIds,
  );
}

export function replaceCompanyOwnedSlackWorkspaces(
  companyId: string,
  workspaceIds: ReadonlyArray<string>,
): void {
  companyOwnedSlackWorkspaceIds.set(companyId, new Set(workspaceIds));
  resolvedCompanyIntegrationIds.add(companyId);
  companyIntegrationAuthorityResolved = containsEvery(
    expectedCompanyIntegrationIds,
    resolvedCompanyIntegrationIds,
  );
}

export function removeCompanyOwnedSlackWorkspaces(companyId: string): void {
  companyOwnedSlackWorkspaceIds.delete(companyId);
  resolvedCompanyIntegrationIds.delete(companyId);
}

export function isCompanySlackWorkspaceOwned(workspaceId: string): boolean {
  for (const workspaceIds of companyOwnedSlackWorkspaceIds.values()) {
    if (workspaceIds.has(workspaceId)) return true;
  }
  return false;
}

export function hasCompanyOwnedSlackWorkspaces(): boolean {
  for (const workspaceIds of companyOwnedSlackWorkspaceIds.values()) {
    if (workspaceIds.size > 0) return true;
  }
  return false;
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

export function setCompanyAutomationActive(companyId: string, active: boolean): void {
  if (active) companiesWithActiveAutomation.add(companyId);
  else companiesWithActiveAutomation.delete(companyId);
  resolvedCompanyAutomationIds.add(companyId);
  companyAutomationAuthorityResolved = containsEvery(
    expectedCompanyAutomationIds,
    resolvedCompanyAutomationIds,
  );
}

export function isCompanyAutomationActive(): boolean {
  return companiesWithActiveAutomation.size > 0;
}
