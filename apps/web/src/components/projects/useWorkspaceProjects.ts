import { useMemo } from "react";

import { useIssueProjectOptions } from "../issues/useIssueProjectOptions";
import { buildWorkspaceProjects, type WorkspaceProject } from "./workspaceProjects.logic";
import { useProjectGroups } from "./useProjectGroups";

/**
 * Every project in this workspace, checked out or not.
 *
 * `useIssueProjectOptions` already merges company projects with their local checkouts for the
 * issue rail, so this reuses that merge rather than growing a second one that could disagree with
 * it about which ids are the same project.
 */
export function useWorkspaceProjects(): ReadonlyArray<WorkspaceProject> {
  const groups = useProjectGroups();
  const options = useIssueProjectOptions();
  return useMemo(
    () =>
      buildWorkspaceProjects({
        groups,
        candidates: options.map((option) => ({
          id: String(option.id),
          title: option.title,
          companyIds: option.companyIds.map(String),
          projectIds: option.projectIds.map(String),
          isCompanyProject: option.isCompanyProject,
        })),
      }),
    [groups, options],
  );
}
