import { useLocation, useNavigate } from "@tanstack/react-router";
import { CloudOffIcon, FolderKanbanIcon } from "lucide-react";

import { ProjectFavicon } from "../ProjectFavicon";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { projectKeyFromProjectsPathname } from "./projectsSidebar.logic";
import { useWorkspaceProjects } from "./useWorkspaceProjects";

export function ProjectsSidebar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const projects = useWorkspaceProjects();
  const activeProjectKey = projectKeyFromProjectsPathname(pathname);

  const openProject = (projectKey: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey },
    });
  };

  return (
    <>
      <ContextualSidebarHeader title="Projects" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <FolderKanbanIcon />
            All projects
          </SidebarGroupLabel>
          {projects.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
              Projects you add to Pathway will appear here.
            </p>
          ) : (
            <SidebarMenu>
              {projects.map((project) => (
                <SidebarMenuItem key={project.projectKey}>
                  <SidebarMenuButton
                    isActive={activeProjectKey === project.projectKey}
                    className="gap-2"
                    onClick={() => openProject(project.projectKey)}
                  >
                    {project.group === null ? (
                      <FolderKanbanIcon className="size-4 text-sidebar-muted-foreground/70" />
                    ) : (
                      <ProjectFavicon
                        environmentId={project.group.environmentId}
                        cwd={project.group.workspaceRoot}
                        faviconPath={project.group.faviconPath}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
                    {project.checkoutCount === 0 ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <CloudOffIcon
                              aria-label="No checkout on any machine"
                              className="size-3.5 shrink-0 text-sidebar-muted-foreground/70"
                            />
                          }
                        />
                        <TooltipPopup side="right">
                          No checkout yet. You can plan and file issues here; attach a directory to
                          run agents.
                        </TooltipPopup>
                      </Tooltip>
                    ) : project.checkoutCount > 1 ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="shrink-0 text-[11px] tabular-nums text-sidebar-muted-foreground/70">
                              {project.checkoutCount}
                            </span>
                          }
                        />
                        <TooltipPopup side="right">
                          {project.group?.memberProjects.length === 0
                            ? `${project.checkoutCount} checkouts`
                            : project.group?.memberProjects
                                .map(
                                  (member) =>
                                    `${member.environmentLabel ?? "This machine"} · ${member.workspaceRoot ?? "No directory"}`,
                                )
                                .join("\n")}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
