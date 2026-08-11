import { ListTodoIcon } from "lucide-react";

import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup, SidebarGroupLabel } from "../ui/sidebar";

export function IssuesSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Issues" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <ListTodoIcon />
            Issue tracker
          </SidebarGroupLabel>
          <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
            Issue filters, projects, and saved views will appear here.
          </p>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
