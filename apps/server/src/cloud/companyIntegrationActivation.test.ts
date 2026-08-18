import { describe, expect, it } from "vite-plus/test";

import {
  hasCompanyOwnedSlackWorkspaces,
  isCompanyAutomationActive,
  isCompanySlackWorkspaceOwned,
  removeCompanyOwnedSlackWorkspaces,
  replaceCompanyOwnedSlackWorkspaces,
  setExpectedCompanyAutomationIds,
  setExpectedCompanyIntegrationIds,
  setCompanyAutomationActive,
  shouldDeferLocalIssueAutomation,
  shouldDeferLocalSlackPolling,
} from "./companyIntegrationActivation.ts";

describe("company integration activation", () => {
  it("aggregates Slack ownership instead of letting one company replace another", () => {
    setExpectedCompanyIntegrationIds(["company-a", "company-b"]);
    expect(shouldDeferLocalSlackPolling()).toBe(true);

    replaceCompanyOwnedSlackWorkspaces("company-a", ["workspace-a"]);
    expect(shouldDeferLocalSlackPolling()).toBe(true);
    replaceCompanyOwnedSlackWorkspaces("company-b", ["workspace-b"]);
    expect(shouldDeferLocalSlackPolling()).toBe(false);

    expect(hasCompanyOwnedSlackWorkspaces()).toBe(true);
    expect(isCompanySlackWorkspaceOwned("workspace-a")).toBe(true);
    expect(isCompanySlackWorkspaceOwned("workspace-b")).toBe(true);

    removeCompanyOwnedSlackWorkspaces("company-a");
    expect(isCompanySlackWorkspaceOwned("workspace-a")).toBe(false);
    expect(isCompanySlackWorkspaceOwned("workspace-b")).toBe(true);

    removeCompanyOwnedSlackWorkspaces("company-b");
    expect(hasCompanyOwnedSlackWorkspaces()).toBe(false);
    setExpectedCompanyIntegrationIds([]);
  });

  it("keeps legacy automation fenced while any company has cloud automation active", () => {
    setExpectedCompanyAutomationIds(["company-a", "company-b"]);
    expect(shouldDeferLocalIssueAutomation()).toBe(true);

    setCompanyAutomationActive("company-a", true);
    expect(shouldDeferLocalIssueAutomation()).toBe(true);
    setCompanyAutomationActive("company-b", true);
    expect(shouldDeferLocalIssueAutomation()).toBe(false);
    setCompanyAutomationActive("company-a", false);

    expect(isCompanyAutomationActive()).toBe(true);

    setCompanyAutomationActive("company-b", false);
    expect(isCompanyAutomationActive()).toBe(false);
    setExpectedCompanyAutomationIds([]);
  });
});
