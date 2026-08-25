import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import {
  buildWorkspaceProjects,
  cloudProjectKey,
  unassignedWorkspaceProjects,
  workspaceProjectAssignmentKey,
  workspaceThreadStartAvailability,
  type WorkspaceProjectCandidate,
} from "./workspaceProjects.logic";

function group(
  overrides: {
    readonly id: string;
    readonly projectKey: string;
    readonly displayName?: string;
  } & Partial<Pick<SidebarProjectSnapshot, "groupedProjectCount" | "memberProjects">>,
): SidebarProjectSnapshot {
  return {
    displayName: overrides.projectKey,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [],
    memberProjectRefs: [],
    remoteEnvironmentLabels: [],
    ...overrides,
  } as unknown as SidebarProjectSnapshot;
}

function candidate(overrides: Partial<WorkspaceProjectCandidate>): WorkspaceProjectCandidate {
  return {
    id: "project-1",
    title: "Project 1",
    companyIds: [],
    projectIds: ["project-1"],
    isCompanyProject: false,
    ...overrides,
  };
}

describe("workspace project list", () => {
  it("keeps a company project that no machine has a checkout of", () => {
    const projects = buildWorkspaceProjects({
      groups: [],
      candidates: [
        candidate({
          id: "cloud-planned",
          title: "Planned work",
          companyIds: ["company-acme"],
          projectIds: ["cloud-planned"],
          isCompanyProject: true,
        }),
      ],
    });
    expect(projects).toEqual([
      {
        projectKey: cloudProjectKey("cloud-planned"),
        displayName: "Planned work",
        companyIds: ["company-acme"],
        group: null,
        checkoutCount: 0,
        cloudProjectId: "cloud-planned",
      },
    ]);
  });

  it("lets the checkout group own the display identity when both describe one project", () => {
    const pathway = group({
      id: "local-pathway",
      projectKey: "repo:pathway",
      displayName: "Pathway",
      groupedProjectCount: 2,
    });
    const projects = buildWorkspaceProjects({
      groups: [pathway],
      candidates: [
        candidate({
          id: "cloud-pathway",
          title: "Pathway (cloud name)",
          companyIds: ["company-acme"],
          projectIds: ["local-pathway", "cloud-pathway"],
          isCompanyProject: true,
        }),
      ],
    });
    expect(projects).toEqual([
      {
        projectKey: "repo:pathway",
        displayName: "Pathway",
        companyIds: ["company-acme"],
        group: pathway,
        checkoutCount: 2,
        cloudProjectId: "cloud-pathway",
      },
    ]);
  });

  it("lists an unregistered local checkout rather than hiding it", () => {
    const scratch = group({
      id: "local-scratch",
      projectKey: "path:scratch",
      displayName: "Scratch",
    });
    const projects = buildWorkspaceProjects({ groups: [scratch], candidates: [] });
    expect(projects).toEqual([
      {
        projectKey: "path:scratch",
        displayName: "Scratch",
        companyIds: [],
        group: scratch,
        checkoutCount: 1,
        cloudProjectId: null,
      },
    ]);
  });

  it("lists a project shared by two companies once, owning both", () => {
    const shared = group({ id: "local-shared", projectKey: "repo:shared", displayName: "Shared" });
    const projects = buildWorkspaceProjects({
      groups: [shared],
      candidates: [
        candidate({
          id: "cloud-shared",
          companyIds: ["company-acme"],
          projectIds: ["local-shared"],
          isCompanyProject: true,
        }),
        candidate({
          id: "cloud-shared",
          companyIds: ["company-bolt"],
          projectIds: ["local-shared"],
          isCompanyProject: true,
        }),
      ],
    });
    expect(projects).toHaveLength(1);
    expect(projects[0]?.companyIds).toEqual(["company-acme", "company-bolt"]);
  });

  it("sorts by display name so the sidebar order does not depend on where a project came from", () => {
    const projects = buildWorkspaceProjects({
      groups: [group({ id: "z", projectKey: "z", displayName: "Zebra" })],
      candidates: [
        candidate({
          id: "cloud-a",
          title: "Apple",
          companyIds: ["company-acme"],
          projectIds: ["cloud-a"],
          isCompanyProject: true,
        }),
      ],
    });
    expect(projects.map((project) => project.displayName)).toEqual(["Apple", "Zebra"]);
  });

  it("reports the projects nobody has assigned to a company", () => {
    const projects = buildWorkspaceProjects({
      groups: [group({ id: "local-scratch", projectKey: "path:scratch", displayName: "Scratch" })],
      candidates: [
        candidate({
          id: "cloud-owned",
          title: "Owned",
          companyIds: ["company-acme"],
          projectIds: ["cloud-owned"],
          isCompanyProject: true,
        }),
      ],
    });
    expect(unassignedWorkspaceProjects(projects).map((project) => project.displayName)).toEqual([
      "Scratch",
    ]);
  });

  it("does not reuse assignment state when the same project path is re-created", () => {
    const assignmentKey = (checkoutId: string) =>
      workspaceProjectAssignmentKey({
        projectKey: "repository:pathway",
        group: group({
          id: checkoutId,
          projectKey: "repository:pathway",
          memberProjects: [
            {
              environmentId: "environment-1",
              id: checkoutId,
            } as never,
          ],
        }),
      });

    expect(assignmentKey("checkout-old")).not.toBe(assignmentKey("checkout-new"));
  });
});

describe("workspaceThreadStartAvailability", () => {
  it("distinguishes an empty catalog from checkoutless and runnable projects", () => {
    expect(workspaceThreadStartAvailability([])).toBe("unavailable");
    expect(workspaceThreadStartAvailability([{ group: null }])).toBe("needs-checkout");
    expect(
      workspaceThreadStartAvailability([
        { group: null },
        { group: group({ id: "local", projectKey: "local" }) },
      ]),
    ).toBe("available");
  });
});
