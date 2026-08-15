import { useMemo } from "react";

import { selectProjectGroupingSettings } from "~/logicalProject";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects } from "~/state/entities";

/** Logical project groups shared by the Projects workspace and project settings. */
export function useProjectGroups() {
  const projects = useProjects();
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
