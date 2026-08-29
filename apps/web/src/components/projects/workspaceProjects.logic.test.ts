import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import {
  buildWorkspaceProjects,
  buildCompanyProjectMergeCandidates,
  cloudProjectKey,
  unassignedWorkspaceProjects,
  workspaceProjectAssignmentKey,
  workspaceProjectCloudIdForCompany,
  workspaceProjectMergeTarget,
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
  it("keeps same-repository cloud rows distinct as merge candidates", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
    };
    const entities = [
      {
        entityKind: "cloudProject" as const,
        id: "cloud-target",
        name: "Pathway target",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        repositoryIdentity,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        entityKind: "cloudProject" as const,
        id: "cloud-duplicate",
        name: "Pathway duplicate",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        repositoryIdentity,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        entityKind: "environmentBinding" as const,
        id: "binding-duplicate",
        cloudProjectId: "cloud-duplicate",
        environmentId: "environment-laptop",
        localProjectId: "local-pathway",
        localWorkspaceRoot: "/work/pathway",
        repositoryIdentity,
        status: "active" as const,
        lastSeenAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    expect(
      buildCompanyProjectMergeCandidates({
        companyId: "company-acme",
        targetCloudProjectId: "cloud-target",
        entities,
      }),
    ).toEqual([
      expect.objectContaining({
        displayName: "Pathway duplicate",
        cloudProjectId: "cloud-duplicate",
        checkoutCount: 1,
        repositoryIdentity,
        repositoryIdentities: [repositoryIdentity],
      }),
    ]);
  });

  it("keeps a company project that no machine has a checkout of", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
    };
    const bindingRepositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway-next",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway-next.git",
      },
    };
    const projects = buildWorkspaceProjects({
      groups: [],
      candidates: [
        candidate({
          id: "cloud-planned",
          title: "Planned work",
          companyIds: ["company-acme"],
          projectIds: ["cloud-planned"],
          isCompanyProject: true,
          repositoryIdentity,
          repositoryIdentities: [bindingRepositoryIdentity],
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
        companyProjectIds: [{ companyId: "company-acme", cloudProjectId: "cloud-planned" }],
        repositoryIdentity,
        repositoryIdentities: [bindingRepositoryIdentity],
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
        companyProjectIds: [{ companyId: "company-acme", cloudProjectId: "cloud-pathway" }],
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
    expect(projects[0]?.companyProjectIds).toEqual([
      { companyId: "company-acme", cloudProjectId: "cloud-shared" },
      { companyId: "company-bolt", cloudProjectId: "cloud-shared" },
    ]);
  });

  it("keeps each company paired with its own project id in a folded checkout group", () => {
    const shared = group({ id: "local-shared", projectKey: "repo:shared", displayName: "Shared" });
    const projects = buildWorkspaceProjects({
      groups: [shared],
      candidates: [
        candidate({
          id: "cloud-acme",
          companyIds: ["company-acme"],
          projectIds: ["local-shared"],
          isCompanyProject: true,
        }),
        candidate({
          id: "cloud-bolt",
          companyIds: ["company-bolt"],
          projectIds: ["local-shared"],
          isCompanyProject: true,
        }),
      ],
    });

    expect(workspaceProjectCloudIdForCompany(projects[0]!, "company-acme")).toBe("cloud-acme");
    expect(workspaceProjectCloudIdForCompany(projects[0]!, "company-bolt")).toBe("cloud-bolt");
    expect(workspaceProjectMergeTarget(projects[0]!, null)).toBeNull();
    expect(workspaceProjectMergeTarget(projects[0]!, "company-acme")).toEqual({
      companyId: "company-acme",
      cloudProjectId: "cloud-acme",
    });
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
