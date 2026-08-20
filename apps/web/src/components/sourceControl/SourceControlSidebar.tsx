import type { ProjectId } from "@spiritdevs/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CloudOffIcon, FolderGit2Icon, GitPullRequestIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import {
  pullRequestProjectSearch,
  sourceControlProjectEntries,
} from "./sourceControlSidebar.logic";

export function SourceControlSidebar() {
  const navigate = useNavigate();
  const rawSearch = useLocation({ select: (location) => location.search }) as Record<
    string,
    unknown
  >;
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const projects = sourceControlProjectEntries(useWorkspaceProjects(), environmentId);
  const selectedProjectId =
    typeof rawSearch.projectId === "string" ? rawSearch.projectId : undefined;

  const selectProject = (projectId: ProjectId | undefined) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/pull-requests",
      replace: true,
      search: pullRequestProjectSearch(rawSearch, projectId),
    });
  };

  return (
    <>
      <ContextualSidebarHeader title="Source Control" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={selectedProjectId === undefined}
                onClick={() => selectProject(undefined)}
              >
                <GitPullRequestIcon />
                <span>Pull Requests</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">
              Projects from this workspace will appear here.
            </p>
          ) : (
            <SidebarMenu>
              {projects.map(({ project, projectId, targetProject, targetProjects }) => {
                const unavailable = targetProject === null;
                return (
                  <SidebarMenuItem key={project.projectKey}>
                    <SidebarMenuButton
                      disabled={unavailable}
                      isActive={selectedProjectId === String(projectId)}
                      onClick={() => {
                        if (targetProject !== null) selectProject(projectId);
                      }}
                      title={
                        unavailable
                          ? "No checkout for this project is available in any environment."
                          : targetProjects.length > 1
                            ? `Available in ${targetProjects.length} environments`
                            : undefined
                      }
                    >
                      {targetProject === null || targetProject.workspaceRoot === null ? (
                        <FolderGit2Icon />
                      ) : (
                        <ProjectFavicon
                          environmentId={targetProject.environmentId}
                          cwd={targetProject.workspaceRoot}
                          faviconPath={targetProject.faviconPath}
                          fallbackIcon={FolderGit2Icon}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
                      {unavailable ? (
                        <CloudOffIcon
                          aria-label="No checkout in any environment"
                          className="size-3.5 shrink-0 text-sidebar-muted-foreground/70"
                        />
                      ) : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
