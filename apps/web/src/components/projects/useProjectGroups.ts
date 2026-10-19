import { useMemo } from "react";

import { selectProjectGroupingSettings } from "~/logicalProject";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects, useUnscopedProjects } from "~/state/entities";

function useGroupedProjects(projects: ReturnType<typeof useProjects>) {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

/** Logical project groups shared by the Projects workspace and project settings. */
export function useProjectGroups() {
  return useGroupedProjects(useProjects());
}

/** Logical project groups used only while assigning unowned local checkouts. */
export function useUnscopedProjectGroups() {
  return useGroupedProjects(useUnscopedProjects());
}
