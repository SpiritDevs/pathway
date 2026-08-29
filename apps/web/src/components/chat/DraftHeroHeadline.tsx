import type { ScopedProjectRef } from "@spiritdevs/contracts";
import { scopedProjectKey } from "@spiritdevs/client-runtime/environment";
import { ALL_FOCUS_ID } from "@spiritdevs/client-runtime/state/focuses";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { activeFocusIdAtom, focusAssignmentsAtom, focusListAtom } from "~/cloud/focusReadModel";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useWorkspaceProjectPicker } from "../projects/useWorkspaceProjectPicker";
import { FocusIcon } from "../focus/FocusIcon";
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

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
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
  const { entries: projectPickerEntries, resolveProjectRef } = useWorkspaceProjectPicker({
    groups: projectGroups,
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const projectPickerGroups = useMemo(
    () =>
      groupProjectPickerEntriesByFocus({
        entries: projectPickerEntries,
        focuses,
        assignments: focusAssignments,
      }),
    [focusAssignments, focuses, projectPickerEntries],
  );
  const focusIdByProjectKey = useMemo(
    () =>
      new Map(
        projectPickerGroups.flatMap((group) =>
          group.entries.map((entry) => [entry.projectKey, group.focusId] as const),
        ),
      ),
    [projectPickerGroups],
  );
  const showProjectGroups = projectPickerGroups.some((group) => group.focus !== null);
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const selectProject = (value: unknown) => {
    const entry = projectEntryByKey.get(value as string);
    if (!entry || value === activeProjectKey) return;
    void (async () => {
      // A project with no checkout gets one made on the way through, so picking it starts
      // a thread rather than dead-ending on a directory it does not have yet.
      const projectRef = await resolveProjectRef(entry);
      if (projectRef === null) return;
      setActiveFocusId(focusIdByProjectKey.get(entry.projectKey) ?? ALL_FOCUS_ID);
      await handleNewThread(projectRef, { replace: true });
    })();
  };

  const projectItem = (entry: (typeof projectPickerEntries)[number]) => (
    <MenuRadioItem key={entry.projectKey} value={entry.projectKey} closeOnClick>
      <span className="block min-w-0 truncate" title={entry.displayName}>
        {entry.displayName}
      </span>
    </MenuRadioItem>
  );

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <MenuTrigger
        aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        title={activeProjectDisplayName ?? undefined}
      >
        {activeProjectDisplayName ?? "Choose a project"}
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        {showProjectGroups ? (
          projectPickerGroups.map((group) => (
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
            {projectPickerEntries.map(projectItem)}
          </MenuRadioGroup>
        )}
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
