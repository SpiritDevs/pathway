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
import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ProjectFavicon } from "../ProjectFavicon";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import {
  buildProjectConnectionCatalog,
  deriveProjectConnectionMetadata,
  projectConnectionPlatformLabel,
} from "../projects/projectConnectionMetadata";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useCompanySettings } from "./company/useCompanySettings";

export function ProjectsSettingsIndexPanel() {
  const projects = useWorkspaceProjects();
  const companySettings = useCompanySettings();
  const connectionCatalog = useMemo(
    () => buildProjectConnectionCatalog(companySettings.replica?.view.values() ?? []),
    [companySettings.replica],
  );

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection
        {...searchableSetting("projects")}
        icon={<FolderIcon className="size-3.5" />}
        headerAction={
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon aria-hidden className="size-4" />
            Add project
          </Button>
        }
      >
        {projects.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
            Add a project to configure it here.
          </p>
        ) : (
          projects.map((project) => {
            const group = project.group;
            const connections = deriveProjectConnectionMetadata({
              members: group?.memberProjects ?? [],
              catalog: connectionCatalog,
            });
            return (
              <Link
                key={project.projectKey}
                to="/settings/projects/$projectKey"
                params={{ projectKey: project.projectKey }}
                className="flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
              >
                {group === null ? (
                  <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ProjectFavicon
                    environmentId={group.environmentId}
                    cwd={group.workspaceRoot}
                    faviconPath={group.faviconPath}
                    className="size-4 shrink-0"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                    {project.displayName}
                  </span>
                  <span className="block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
                    {group?.workspaceRoot ?? "No directory attached"}
                  </span>
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="shrink-0 rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground" />
                    }
                  >
                    {connections.length} {connections.length === 1 ? "connection" : "connections"}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-96">
                    <div className="space-y-2 py-1 text-left">
                      {connections.map((connection) => (
                        <div key={`${connection.environmentId}:${connection.localProjectId}`}>
                          <div className="font-medium text-foreground">
                            {connection.environmentLabel}
                            {connection.isPreferred ? " · Default" : ""}
                          </div>
                          <div className="max-w-80 truncate text-muted-foreground">
                            {connection.directory ?? "No directory attached"}
                          </div>
                          <div className="text-[11px] text-muted-foreground/80">
                            {[
                              projectConnectionPlatformLabel(connection.platform),
                              connection.serverVersion
                                ? `Pathway ${connection.serverVersion}`
                                : null,
                              connection.bindingStatus,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  </TooltipPopup>
                </Tooltip>
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
