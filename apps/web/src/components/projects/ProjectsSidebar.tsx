import { useLocation, useNavigate } from "@tanstack/react-router";
import { FolderKanbanIcon } from "lucide-react";

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
import { projectKeyFromProjectsPathname } from "./projectsSidebar.logic";
import { useProjectGroups } from "./useProjectGroups";

export function ProjectsSidebar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = useProjectGroups();
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
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
              Projects you add to Pathway will appear here.
            </p>
          ) : (
            <SidebarMenu>
              {groups.map((group) => (
                <SidebarMenuItem key={group.projectKey}>
                  <SidebarMenuButton
                    isActive={activeProjectKey === group.projectKey}
                    className="gap-2"
                    onClick={() => openProject(group.projectKey)}
                  >
                    <ProjectFavicon
                      environmentId={group.environmentId}
                      cwd={group.workspaceRoot}
                      faviconPath={group.faviconPath}
                    />
                    <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                    {group.groupedProjectCount > 1 ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-sidebar-muted-foreground/70">
                        {group.groupedProjectCount}
                      </span>
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
