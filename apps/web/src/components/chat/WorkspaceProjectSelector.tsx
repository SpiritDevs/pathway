import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@spiritdevs/client-runtime/environment";
import { ALL_FOCUS_ID } from "@spiritdevs/client-runtime/state/focuses";
import type { ScopedProjectRef } from "@spiritdevs/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { activeFocusIdAtom, focusAssignmentsAtom, focusListAtom } from "~/cloud/focusReadModel";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { FocusIcon } from "../focus/FocusIcon";
import { useWorkspaceProjectPicker } from "../projects/useWorkspaceProjectPicker";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { groupProjectPickerEntriesByFocus } from "./DraftHeroHeadline.logic";

interface WorkspaceProjectSelectorProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly ariaLabel: string;
  readonly triggerClassName: string;
  readonly renderTrigger?: (displayName: string) => ReactNode;
  readonly menuAlign?: "start" | "center" | "end";
  readonly onSelectProject: (projectRef: ScopedProjectRef) => unknown | Promise<unknown>;
}

export function WorkspaceProjectSelector({
  activeProjectRef,
  activeProjectTitle,
  ariaLabel,
  triggerClassName,
  renderTrigger,
  menuAlign = "center",
  onSelectProject,
}: WorkspaceProjectSelectorProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const focuses = useAtomValue(focusListAtom);
  const focusAssignments = useAtomValue(focusAssignmentsAtom);
  const setActiveFocusId = useAtomSet(activeFocusIdAtom);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const { entries, resolveProjectRef } = useWorkspaceProjectPicker({
    groups: projectGroups,
    preferredProjectRef: activeProjectRef,
  });
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.projectKey, entry] as const)),
    [entries],
  );
  const pickerGroups = useMemo(
    () =>
      groupProjectPickerEntriesByFocus({
        entries,
        focuses,
        assignments: focusAssignments,
      }),
    [entries, focusAssignments, focuses],
  );
  const focusIdByProjectKey = useMemo(
    () =>
      new Map(
        pickerGroups.flatMap((group) =>
          group.entries.map((entry) => [entry.projectKey, group.focusId] as const),
        ),
      ),
    [pickerGroups],
  );
  const showGroups = pickerGroups.some((group) => group.focus !== null);
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const displayName = activeProjectGroup?.displayName ?? activeProjectTitle ?? "Choose a project";

  const selectProject = (value: unknown) => {
    const entry = entryByKey.get(value as string);
    if (!entry || value === activeProjectKey) return;
    void (async () => {
      const projectRef = await resolveProjectRef(entry);
      if (projectRef === null) return;
      setActiveFocusId(focusIdByProjectKey.get(entry.projectKey) ?? ALL_FOCUS_ID);
      await onSelectProject(projectRef);
    })();
  };

  const projectItem = (entry: (typeof entries)[number]) => (
    <MenuRadioItem key={entry.projectKey} value={entry.projectKey} closeOnClick>
      <span className="block min-w-0 truncate" title={entry.displayName}>
        {entry.displayName}
      </span>
    </MenuRadioItem>
  );

  if (entries.length === 0) {
    return (
      <button
        type="button"
        aria-label="Add a project"
        onClick={openAddProject}
        className={triggerClassName}
      >
        {renderTrigger?.(activeProjectTitle ?? "Add a project") ??
          activeProjectTitle ??
          "Add a project"}
      </button>
    );
  }

  return (
    <Menu>
      <MenuTrigger aria-label={ariaLabel} className={triggerClassName} title={displayName}>
        {renderTrigger?.(displayName) ?? displayName}
      </MenuTrigger>
      <MenuPopup align={menuAlign} className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        {showGroups ? (
          pickerGroups.map((group) => (
            <MenuGroup key={group.focusId}>
              <MenuGroupLabel className="flex items-center gap-1.5">
                {group.focus === null ? null : (
                  <FocusIcon
                    iconName={group.focus.iconName}
                    color={group.focus.accentColor}
                    className="size-3 shrink-0"
                  />
                )}
                {group.focus?.name ?? "Other projects"}
              </MenuGroupLabel>
              <MenuRadioGroup value={activeProjectKey} onValueChange={selectProject}>
                {group.entries.map(projectItem)}
              </MenuRadioGroup>
            </MenuGroup>
          ))
        ) : (
          <MenuRadioGroup value={activeProjectKey} onValueChange={selectProject}>
            {entries.map(projectItem)}
          </MenuRadioGroup>
        )}
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
