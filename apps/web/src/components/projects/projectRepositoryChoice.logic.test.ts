import { EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import { derivePhysicalProjectKeyFromPath } from "~/logicalProject";
import {
  findProjectsForRepository,
  projectRepositoryChoiceSettings,
  resolveCreatedProjectBindingTarget,
} from "./projectRepositoryChoice.logic";

const environmentId = EnvironmentId.make("environment-1");
const identity = {
  canonicalKey: "github.com/spiritdevs/pathway",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "git@github.com:spiritdevs/pathway.git",
  },
  rootPath: "/work/pathway",
};

describe("project repository choices", () => {
  it("binds a new project automatically only when one workspace is available", () => {
    const personal = CompanyId.make("company-personal");
    const organization = CompanyId.make("company-organization");

    expect(
      resolveCreatedProjectBindingTarget({
        choice: null,
        existingTarget: null,
        activeCompanyId: personal,
        availableCompanyIds: [personal],
      }),
    ).toEqual({ companyId: personal, cloudProjectId: null });
    expect(
      resolveCreatedProjectBindingTarget({
        choice: null,
        existingTarget: null,
        activeCompanyId: personal,
        availableCompanyIds: [personal, organization],
      }),
    ).toBeNull();
  });

  it("keeps an explicit repository choice authoritative", () => {
    const personal = CompanyId.make("company-personal");
    const organization = CompanyId.make("company-organization");

    expect(
      resolveCreatedProjectBindingTarget({
        choice: { kind: "new" },
        existingTarget: null,
        activeCompanyId: organization,
        availableCompanyIds: [personal, organization],
      }),
    ).toEqual({ companyId: organization, cloudProjectId: null });
    expect(
      resolveCreatedProjectBindingTarget({
        choice: { kind: "existing", projectKey: "existing" },
        existingTarget: { companyId: personal, cloudProjectId: "cloud-project" },
        activeCompanyId: organization,
        availableCompanyIds: [personal, organization],
      }),
    ).toEqual({ companyId: personal, cloudProjectId: "cloud-project" });
  });

  it("finds every logical project backed by the selected repository", () => {
    const groups = [
      {
        projectKey: "first",
        memberProjects: [{ repositoryIdentity: identity }],
      },
      {
        projectKey: "second",
        memberProjects: [{ repositoryIdentity: { ...identity, rootPath: "/work/pathway-2" } }],
      },
      {
        projectKey: "other",
        memberProjects: [
          {
            repositoryIdentity: {
              ...identity,
              canonicalKey: "github.com/spiritdevs/other",
            },
          },
        ],
      },
    ];

    expect(findProjectsForRepository(groups, identity).map((group) => group.projectKey)).toEqual([
      "first",
      "second",
    ]);
  });

  it("can explicitly join one project or keep the checkout separate", () => {
    const workspaceRoot = "/work/pathway-2";
    const physicalKey = derivePhysicalProjectKeyFromPath(environmentId, workspaceRoot);
    const settings = {
      sidebarProjectGroupAssignments: { stale: "old-project" },
      sidebarProjectGroupingOverrides: { stale: "repository" as const },
    };

    expect(
      projectRepositoryChoiceSettings({
        settings,
        environmentId,
        workspaceRoot,
        choice: { kind: "existing", projectKey: "first" },
      }),
    ).toEqual({
      sidebarProjectGroupAssignments: { stale: "old-project", [physicalKey]: "first" },
      sidebarProjectGroupingOverrides: { stale: "repository" },
    });

    expect(
      projectRepositoryChoiceSettings({
        settings: {
          sidebarProjectGroupAssignments: { [physicalKey]: "first" },
          sidebarProjectGroupingOverrides: {},
        },
        environmentId,
        workspaceRoot,
        choice: { kind: "new" },
      }),
    ).toEqual({
      sidebarProjectGroupAssignments: { [physicalKey]: physicalKey },
      sidebarProjectGroupingOverrides: {},
    });
  });
});
