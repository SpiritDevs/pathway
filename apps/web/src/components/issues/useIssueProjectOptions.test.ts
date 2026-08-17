import type {
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
} from "@spiritdevs/client-runtime/sync";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import {
  buildIssueProjectOptions,
  issueProjectEnvironmentProjects,
  resolveIssueEnvironmentProject,
} from "./useIssueProjectOptions";

function group(
  title: string,
  representativeId: string,
  ...memberIds: ReadonlyArray<string>
): SidebarProjectSnapshot {
  const environmentId = EnvironmentId.make("local");
  const members = memberIds.map((id, index) => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(index === 0 ? "local" : `remote-${index}`),
    physicalProjectKey: `${index === 0 ? "local" : `remote-${index}`}:${id}`,
    environmentLabel: index === 0 ? "This machine" : `Remote ${index}`,
    workspaceRoot: `/projects/${id}`,
  }));
  return {
    id: ProjectId.make(representativeId),
    environmentId,
    displayName: title,
    memberProjects: members,
  } as unknown as SidebarProjectSnapshot;
}

function cloudProject(
  id: string,
  name: string,
  preferredBindingId: string | null = null,
): CloudProjectSyncEntity {
  return {
    id,
    name,
    preferredBindingId,
    archivedAt: null,
  } as CloudProjectSyncEntity;
}

function binding(
  id: string,
  cloudProjectId: string,
  environmentId: string,
  localProjectId: string,
): EnvironmentBindingEntity {
  return {
    id,
    cloudProjectId,
    environmentId,
    localProjectId,
    status: "active",
  } as EnvironmentBindingEntity;
}

describe("buildIssueProjectOptions", () => {
  it("collapses physical and company rows into one logical project choice", () => {
    const options = buildIssueProjectOptions({
      groups: [
        group("Pathway", "pathway-local", "pathway-local", "pathway-remote"),
        group("personal-site", "personal", "personal"),
      ],
      cloudProjects: [
        cloudProject("pathway-local", "Pathway"),
        cloudProject("pathway-remote", "Pathway"),
      ],
      environmentBindings: [],
    });

    expect(options.map((project) => project.title)).toEqual(["Pathway", "personal-site"]);
    expect(options[0]).toMatchObject({
      id: "pathway-local",
      isCompanyProject: true,
      projectIds: ["pathway-local", "pathway-remote"],
    });
    expect(options[0]?.environmentProjects).toHaveLength(2);
  });

  it("keeps a company project with no currently connected checkout", () => {
    const options = buildIssueProjectOptions({
      groups: [],
      cloudProjects: [cloudProject("offline", "Offline project")],
      environmentBindings: [],
    });

    expect(options).toMatchObject([
      {
        id: "offline",
        title: "Offline project",
        isCompanyProject: true,
        localProject: null,
        environmentProjects: [],
      },
    ]);
  });

  it("defaults agent execution to the preferred environment and honors an explicit choice", () => {
    const projects = buildIssueProjectOptions({
      groups: [group("Pathway", "pathway-local", "pathway-local", "pathway-remote")],
      cloudProjects: [],
      environmentBindings: [],
    });

    expect(
      resolveIssueEnvironmentProject({
        issueProjectId: ProjectId.make("pathway-local"),
        projects,
        selectedPhysicalProjectKey: null,
        preferredEnvironmentId: EnvironmentId.make("remote-1"),
      })?.id,
    ).toBe("pathway-remote");
    expect(
      resolveIssueEnvironmentProject({
        issueProjectId: ProjectId.make("pathway-local"),
        projects,
        selectedPhysicalProjectKey: "local:pathway-local",
        preferredEnvironmentId: EnvironmentId.make("remote-1"),
      })?.id,
    ).toBe("pathway-local");
  });

  it("offers one agent target per environment", () => {
    const projects = buildIssueProjectOptions({
      groups: [
        group(
          "Pathway",
          "pathway-local",
          "pathway-local",
          "pathway-remote",
          "pathway-remote-worktree",
        ),
      ],
      cloudProjects: [],
      environmentBindings: [],
    });
    const project = projects[0]!;
    const duplicateEnvironmentProject = {
      ...project.environmentProjects[2]!,
      environmentId: EnvironmentId.make("remote-1"),
    };

    expect(
      issueProjectEnvironmentProjects({
        ...project,
        environmentProjects: [
          ...project.environmentProjects.slice(0, 2),
          duplicateEnvironmentProject,
        ],
      }).map((member) => member.id),
    ).toEqual(["pathway-local", "pathway-remote"]);
  });

  it("joins a company project to its local checkout through the environment binding", () => {
    const options = buildIssueProjectOptions({
      groups: [group("quotecloud-v2", "quotecloud-local", "quotecloud-local")],
      cloudProjects: [cloudProject("quotecloud-company", "quotecloud-v2", "binding-quotecloud")],
      environmentBindings: [
        binding("binding-quotecloud", "quotecloud-company", "local", "quotecloud-local"),
      ],
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      id: "quotecloud-company",
      projectIds: ["quotecloud-local", "quotecloud-company"],
      companyProject: { id: "quotecloud-company" },
    });
  });

  it("shows one company project when local grouping keeps its bound checkouts separate", () => {
    const options = buildIssueProjectOptions({
      groups: [
        group("quotecloud-v2", "quotecloud-local", "quotecloud-local"),
        group("quotecloud-v2", "quotecloud-remote", "quotecloud-remote"),
      ],
      cloudProjects: [cloudProject("quotecloud-company", "quotecloud-v2")],
      environmentBindings: [
        binding("binding-local", "quotecloud-company", "local", "quotecloud-local"),
        binding("binding-remote", "quotecloud-company", "local", "quotecloud-remote"),
      ],
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.projectIds).toEqual([
      "quotecloud-local",
      "quotecloud-company",
      "quotecloud-remote",
    ]);
    expect(options[0]?.environmentProjects).toHaveLength(2);
  });

  it("uses the company project's preferred binding before the client's primary environment", () => {
    const projects = buildIssueProjectOptions({
      groups: [group("Pathway", "pathway-local", "pathway-local", "pathway-remote")],
      cloudProjects: [cloudProject("pathway-company", "Pathway", "binding-remote")],
      environmentBindings: [
        binding("binding-local", "pathway-company", "local", "pathway-local"),
        binding("binding-remote", "pathway-company", "remote-1", "pathway-remote"),
      ],
    });

    expect(
      resolveIssueEnvironmentProject({
        issueProjectId: ProjectId.make("pathway-company"),
        projects,
        selectedPhysicalProjectKey: null,
        preferredEnvironmentId: EnvironmentId.make("local"),
      })?.id,
    ).toBe("pathway-remote");
  });
});
