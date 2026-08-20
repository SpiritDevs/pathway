import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceProject } from "../projects/workspaceProjects.logic";
import {
  findSourceControlProjectEntry,
  pullRequestProjectSearch,
  sourceControlProjectEntries,
} from "./sourceControlSidebar.logic";

const environmentId = "environment-local" as EnvironmentId;

function workspaceProject(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    projectKey: "cloud:project-cloud",
    displayName: "Pathway",
    companyIds: ["company-1"],
    group: null,
    checkoutCount: 0,
    cloudProjectId: "project-cloud",
    ...overrides,
  };
}

describe("source control sidebar projects", () => {
  it("keeps Convex-only projects visible without making them selectable", () => {
    const [entry] = sourceControlProjectEntries([workspaceProject()], environmentId);

    expect(entry?.project.cloudProjectId).toBe("project-cloud");
    expect(entry?.projectId).toBe("project-cloud");
    expect(entry?.targetProject).toBeNull();
    expect(entry?.targetProjects).toEqual([]);
  });

  it("selects a rooted checkout from the current environment", () => {
    const localProjectId = "project-local" as ProjectId;
    const project = workspaceProject({
      projectKey: "pathway",
      checkoutCount: 2,
      group: {
        id: localProjectId,
        title: "Pathway",
        environmentId,
        workspaceRoot: "/work/pathway",
        faviconPath: null,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        projectKey: "pathway",
        displayName: "Pathway",
        groupedProjectCount: 2,
        environmentPresence: "mixed",
        allRemoteMembersAreDesktopLocal: false,
        memberProjectRefs: [],
        remoteEnvironmentLabels: ["Remote"],
        memberProjects: [
          {
            id: localProjectId,
            title: "Pathway",
            environmentId,
            workspaceRoot: "/work/pathway",
            faviconPath: null,
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
            physicalProjectKey: "environment-local:project-local",
            environmentLabel: "This machine",
          },
        ],
      },
    });

    expect(sourceControlProjectEntries([project], environmentId)[0]?.targetProject?.id).toBe(
      localProjectId,
    );
  });

  it("keeps a remote-only checkout selectable for an all-environment PR read", () => {
    const remoteEnvironmentId = "environment-remote" as EnvironmentId;
    const remoteProjectId = "project-remote" as ProjectId;
    const project = workspaceProject({
      projectKey: "pathway",
      checkoutCount: 1,
      group: {
        id: remoteProjectId,
        title: "Pathway",
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/srv/pathway",
        faviconPath: null,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        projectKey: "pathway",
        displayName: "Pathway",
        groupedProjectCount: 1,
        environmentPresence: "remote-only",
        allRemoteMembersAreDesktopLocal: false,
        memberProjectRefs: [],
        remoteEnvironmentLabels: ["Build box"],
        memberProjects: [
          {
            id: remoteProjectId,
            title: "Pathway",
            environmentId: remoteEnvironmentId,
            workspaceRoot: "/srv/pathway",
            faviconPath: null,
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
            physicalProjectKey: "environment-remote:project-remote",
            environmentLabel: "Build box",
          },
        ],
      },
    });

    const [entry] = sourceControlProjectEntries([project], environmentId);
    expect(entry?.targetProject?.environmentId).toBe(remoteEnvironmentId);
    expect(entry?.targetProjects).toHaveLength(1);
  });

  it("resolves an environment-local project id to its Convex project entry", () => {
    const localProjectId = "project-local" as ProjectId;
    const [entry] = sourceControlProjectEntries(
      [
        workspaceProject({
          group: {
            id: localProjectId,
            title: "Pathway",
            environmentId,
            workspaceRoot: "/work/pathway",
            faviconPath: null,
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
            projectKey: "pathway",
            displayName: "Pathway",
            groupedProjectCount: 1,
            environmentPresence: "local-only",
            allRemoteMembersAreDesktopLocal: false,
            memberProjectRefs: [],
            remoteEnvironmentLabels: [],
            memberProjects: [
              {
                id: localProjectId,
                title: "Pathway",
                environmentId,
                workspaceRoot: "/work/pathway",
                faviconPath: null,
                repositoryIdentity: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-08-21T00:00:00.000Z",
                updatedAt: "2026-08-21T00:00:00.000Z",
                physicalProjectKey: "environment-local:project-local",
                environmentLabel: "This machine",
              },
            ],
          },
        }),
      ],
      environmentId,
    );

    expect(findSourceControlProjectEntry(entry ? [entry] : [], localProjectId)?.projectId).toBe(
      "project-cloud",
    );
  });

  it("changes project scope without carrying an open pull-request selection", () => {
    expect(
      pullRequestProjectSearch(
        {
          state: "merged",
          involvement: "reviewing",
          host: "github.com",
          q: "sync",
          repository: "spiritdevs/pathway",
          number: 34,
          selectedProjectId: "old-project",
        },
        "new-project" as ProjectId,
      ),
    ).toEqual({
      state: "merged",
      involvement: "reviewing",
      host: "github.com",
      q: "sync",
      projectId: "new-project",
    });
  });
});
