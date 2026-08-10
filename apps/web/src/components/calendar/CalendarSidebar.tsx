import { CalendarDaysIcon } from "lucide-react";

import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup, SidebarGroupLabel } from "../ui/sidebar";

export function CalendarSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Calendar" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <CalendarDaysIcon />
            Calendar
          </SidebarGroupLabel>
          <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
            Calendar filters and upcoming schedules will appear here.
          </p>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
