/**
 * The project list a "where should this thread run" menu shows.
 *
 * Every such menu was built from environment-local checkouts, so a company project nobody had
 * checked out was simply missing — visible on the Projects page, absent from the palette. This
 * appends those, and resolves the checkout lazily: selecting one materialises it rather than
 * refusing, so the menu never lists something it will not let you pick.
 *
 * Callers pass their own already-sorted groups, because each surface sorts differently (manual
 * order in the sidebar, recency in the palette) and that ordering is a user preference. The
 * checkoutless entries append after them: a project you cannot yet run in should not outrank one
 * you can.
 *
 * @module components/projects/useWorkspaceProjectPicker
 */
import type { ScopedProjectRef } from "@spiritdevs/contracts";
import { useCallback, useMemo } from "react";

import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import {
  buildSidebarProjectPickerEntries,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { useMaterializeWorkspaceProject } from "./useMaterializeWorkspaceProject";
import { useWorkspaceProjects } from "./useWorkspaceProjects";
import type { WorkspaceProject } from "./workspaceProjects.logic";

export interface WorkspaceProjectPickerEntry {
  readonly projectKey: string;
  /** Every checkout key represented by this logical project. */
  readonly projectKeys: ReadonlyArray<string>;
  readonly displayName: string;
  /** The checkout this entry runs in, or null when one has to be created on selection. */
  readonly targetProject: SidebarProjectGroupMember | null;
  readonly isPreferred: boolean;
  /** True when no machine has a checkout — the row that needs a folder before it can run. */
  readonly needsCheckout: boolean;
  /** Present only for a checkoutless entry, so selection can materialise it. */
  readonly project: WorkspaceProject | null;
}

export function useWorkspaceProjectPicker(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly preferredProjectRef: ScopedProjectRef | null;
}) {
  const workspaceProjects = useWorkspaceProjects();
  const materialize = useMaterializeWorkspaceProject();

  const entries = useMemo<ReadonlyArray<WorkspaceProjectPickerEntry>>(() => {
    const checkedOut = buildSidebarProjectPickerEntries({
      groups: input.groups,
      preferredProjectRef: input.preferredProjectRef,
    }).map(
      (entry): WorkspaceProjectPickerEntry => ({
        projectKey: entry.group.projectKey,
        projectKeys: entry.group.memberProjectRefs.map(scopedProjectKey),
        displayName: entry.group.displayName,
        targetProject: entry.targetProject,
        isPreferred: entry.isPreferred,
        needsCheckout: false,
        project: null,
      }),
    );
    const seen = new Set(checkedOut.map((entry) => entry.projectKey));
    const checkoutless = workspaceProjects
      .filter((project) => project.group === null && !seen.has(project.projectKey))
      .map(
        (project): WorkspaceProjectPickerEntry => ({
          projectKey: project.projectKey,
          projectKeys: [],
          displayName: project.displayName,
          targetProject: null,
          isPreferred: false,
          needsCheckout: true,
          project,
        }),
      );
    return [...checkedOut, ...checkoutless];
  }, [input.groups, input.preferredProjectRef, workspaceProjects]);

  /**
   * The scoped ref to start work against, creating a checkout first when there is none.
   *
   * Null means the caller should do nothing: no environment to create in, or the create failed and
   * has already reported itself.
   */
  const resolveProjectRef = useCallback(
    async (entry: WorkspaceProjectPickerEntry): Promise<ScopedProjectRef | null> => {
      if (entry.targetProject !== null) {
        return scopeProjectRef(entry.targetProject.environmentId, entry.targetProject.id);
      }
      if (entry.project === null) return null;
      const result = await materialize(entry.project);
      return result.ok ? scopeProjectRef(result.value.environmentId, result.value.projectId) : null;
    },
    [materialize],
  );

  return { entries, resolveProjectRef };
}
