import type { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";

export interface ProjectFaviconSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}

export function projectFaviconSourceKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

/** File-picker overrides are relative; automatically discovered icons use absolute paths. */
export function isCustomProjectFaviconPath(path: string | null | undefined): path is string {
  return typeof path === "string" && path.length > 0 && !/^(?:[a-z]:[\\/]|[\\/])/i.test(path);
}

function faviconPriority(path: string | null | undefined): number {
  return isCustomProjectFaviconPath(path) ? 2 : path ? 1 : 0;
}

/** Try the same ordered checkouts for every icon belonging to the same cloud project. */
export function deriveProjectFaviconSources(input: {
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string | null;
    readonly faviconPath?: string | null | undefined;
  }>;
  readonly bindings: ReadonlyArray<EnvironmentBindingEntity>;
  readonly preferredBindingIds: ReadonlySet<string>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyMap<string, ReadonlyArray<ProjectFaviconSource>> {
  const projectsByRef = new Map(
    input.projects.map((project) => [JSON.stringify([project.environmentId, project.id]), project]),
  );
  const groups = new Map<
    string,
    { binding: EnvironmentBindingEntity; source: ProjectFaviconSource }[]
  >();
  for (const binding of input.bindings) {
    if (binding.status === "revoked") continue;
    const project = projectsByRef.get(
      JSON.stringify([binding.environmentId, binding.localProjectId]),
    );
    if (!project?.workspaceRoot) continue;
    const member = {
      binding,
      source: {
        environmentId: project.environmentId,
        cwd: project.workspaceRoot,
        faviconPath: project.faviconPath,
      },
    };
    const members = groups.get(binding.cloudProjectId) ?? [];
    members.push(member);
    groups.set(binding.cloudProjectId, members);
  }
  const result = new Map<string, ReadonlyArray<ProjectFaviconSource>>();
  for (const members of groups.values()) {
    const available = members.filter(({ source }) =>
      input.connectedEnvironmentIds.has(source.environmentId),
    );
    available.sort(
      (left, right) =>
        faviconPriority(right.source.faviconPath) - faviconPriority(left.source.faviconPath) ||
        Number(input.preferredBindingIds.has(right.binding.id)) -
          Number(input.preferredBindingIds.has(left.binding.id)) ||
        left.binding.id.localeCompare(right.binding.id),
    );
    const sources = [
      ...new Map(
        available.map(({ source }) => [
          projectFaviconSourceKey(source.environmentId, source.cwd),
          source,
        ]),
      ).values(),
    ];
    if (sources.length === 0) continue;
    for (const member of members) {
      result.set(projectFaviconSourceKey(member.source.environmentId, member.source.cwd), sources);
    }
  }
  return result;
}
