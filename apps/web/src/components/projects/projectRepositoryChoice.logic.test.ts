import { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePhysicalProjectKeyFromPath } from "~/logicalProject";
import {
  findProjectsForRepository,
  projectRepositoryChoiceSettings,
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
