import { GitPullRequestIcon } from "lucide-react";

import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarContent, SidebarGroup, SidebarGroupLabel } from "../ui/sidebar";

export function SourceControlSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Source Control" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <GitPullRequestIcon />
            Pull Requests
          </SidebarGroupLabel>
          <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
            Repository navigation and source control filters will appear here.
          </p>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
