/**
 * Settings → Projects: the index.
 *
 * Project settings are per-project, so this page is a directory rather than a form — it lists every
 * logical project group (the same grouping the sidebar uses) and links through to
 * `/settings/projects/$projectKey`, which renders the project settings panel on its own.
 *
 * @module components/settings/ProjectsSettingsIndexPanel
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, FolderIcon } from "lucide-react";

import { ProjectFavicon } from "../ProjectFavicon";
import { useProjectGroups } from "../projects/useProjectGroups";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ProjectsSettingsIndexPanel() {
  const groups = useProjectGroups();

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection
        {...searchableSetting("projects")}
        icon={<FolderIcon className="size-3.5" />}
      >
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
            Add a project from the sidebar and it shows up here.
          </p>
        ) : (
          groups.map((group) => (
            <Link
              key={group.projectKey}
              to="/settings/projects/$projectKey"
              params={{ projectKey: group.projectKey }}
              className="flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
            >
              <ProjectFavicon
                environmentId={group.environmentId}
                cwd={group.workspaceRoot}
                faviconPath={group.faviconPath}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                  {group.displayName}
                </span>
                <span className="block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
                  {group.workspaceRoot ?? "No directory attached"}
                </span>
              </span>
              {group.groupedProjectCount > 1 ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {group.groupedProjectCount} checkouts
                </span>
              ) : null}
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
