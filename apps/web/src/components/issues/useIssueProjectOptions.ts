import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type { CloudProjectSyncEntity } from "@spiritdevs/client-runtime/sync";
import { ProjectId, type EnvironmentId } from "@spiritdevs/contracts";
import { useMemo } from "react";

import { activeCompanyReplicaRoutingAtom } from "~/cloud/activeCompany";
import { useSyncedCloudProjects } from "~/cloud/issueDomainReadModel";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { useProjectGroups } from "../projects/useProjectGroups";

export interface IssueProjectChoice {
  readonly id: ProjectId;
  readonly title: string;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export interface IssueProjectOption extends IssueProjectChoice {
  readonly isCompanyProject: boolean;
  /** Every environment-local or cloud id represented by this logical project. */
  readonly projectIds: ReadonlyArray<ProjectId>;
  /** The checkout used when this project still needs to be registered with the company. */
  readonly localProject: EnvironmentProject | null;
  /** One physical checkout per environment where this logical project can run agents. */
  readonly environmentProjects: ReadonlyArray<SidebarProjectGroupMember>;
}

/**
 * A logical project may contain multiple worktrees in one environment. The issue rail chooses the
 * environment first; its workspace control decides whether work stays in the checkout or branches
 * into a new worktree. Prefer the canonical member, then a member with a directory.
 */
export function issueProjectEnvironmentProjects(
  project: IssueProjectOption,
): ReadonlyArray<SidebarProjectGroupMember> {
  const byEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember>();
  for (const member of project.environmentProjects) {
    const current = byEnvironment.get(member.environmentId);
    if (
      current === undefined ||
      member.id === project.id ||
      (current.workspaceRoot === null && member.workspaceRoot !== null)
    ) {
      byEnvironment.set(member.environmentId, member);
    }
  }
  return [...byEnvironment.values()];
}

export function resolveIssueEnvironmentProject(input: {
  readonly issueProjectId: ProjectId | null;
  readonly projects: ReadonlyArray<IssueProjectOption>;
  readonly selectedPhysicalProjectKey: string | null;
  readonly preferredEnvironmentId: EnvironmentId | null;
}): SidebarProjectGroupMember | null {
  if (input.issueProjectId === null) return null;
  const issueProjectId = input.issueProjectId;
  const logicalProject = input.projects.find(
    (project) => project.id === issueProjectId || project.projectIds.includes(issueProjectId),
  );
  if (logicalProject === undefined) return null;
  const environmentProjects = issueProjectEnvironmentProjects(logicalProject);
  return (
    environmentProjects.find(
      (project) => project.physicalProjectKey === input.selectedPhysicalProjectKey,
    ) ??
    environmentProjects.find((project) => project.environmentId === input.preferredEnvironmentId) ??
    environmentProjects.find((project) => project.workspaceRoot !== null) ??
    environmentProjects[0] ??
    null
  );
}

/**
 * Turns environment-local checkouts and their company project rows into one choice per logical
 * project. A cloud id wins when one exists because issue associations are company-owned, while all
 * member ids remain aliases for filters and labels on issues created before the environments were
 * grouped.
 */
export function buildIssueProjectOptions(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly cloudProjects: ReadonlyArray<CloudProjectSyncEntity>;
}): ReadonlyArray<IssueProjectOption> {
  const cloudProjects = input.cloudProjects.filter((project) => project.archivedAt === null);
  const usedCloudIds = new Set<string>();
  const options = input.groups.map((group): IssueProjectOption => {
    const memberById = new Map(
      group.memberProjects.map((member) => [String(member.id), member] as const),
    );
    const matchingCloudProjects = cloudProjects.filter((project) => memberById.has(project.id));
    const canonicalCloudProject =
      matchingCloudProjects.find((project) => String(project.id) === String(group.id)) ??
      matchingCloudProjects[0] ??
      null;
    for (const project of matchingCloudProjects) usedCloudIds.add(String(project.id));

    const cloudMember =
      canonicalCloudProject === null ? undefined : memberById.get(String(canonicalCloudProject.id));
    const localProject =
      cloudMember ??
      group.memberProjects.find(
        (member) => member.environmentId === group.environmentId && member.id === group.id,
      ) ??
      group.memberProjects[0];
    const id = canonicalCloudProject?.id ?? localProject?.id ?? group.id;
    const projectIds = new Set<ProjectId>(group.memberProjects.map((member) => member.id));
    projectIds.add(ProjectId.make(String(id)));

    return {
      id: ProjectId.make(String(id)),
      title: group.displayName,
      isCompanyProject: canonicalCloudProject !== null,
      projectIds: [...projectIds],
      localProject: localProject ?? null,
      environmentProjects: group.memberProjects,
    };
  });

  // A company project can outlive every connected checkout. Keep it selectable so existing issues
  // never lose their project merely because its environment is offline.
  for (const project of cloudProjects) {
    if (usedCloudIds.has(String(project.id))) continue;
    options.push({
      id: ProjectId.make(project.id),
      title: project.name,
      isCompanyProject: true,
      projectIds: [ProjectId.make(project.id)],
      localProject: null,
      environmentProjects: [],
    });
  }

  return options.sort((left, right) => left.title.localeCompare(right.title));
}

export function useIssueProjectOptions(): ReadonlyArray<IssueProjectOption> {
  const groups = useProjectGroups();
  const companyId = useAtomValue(activeCompanyReplicaRoutingAtom);
  const syncedCloudProjects = useSyncedCloudProjects();
  return useMemo(
    () =>
      buildIssueProjectOptions({
        groups,
        cloudProjects: companyId === null ? [] : syncedCloudProjects,
      }),
    [companyId, groups, syncedCloudProjects],
  );
}
