import { BotIcon } from "lucide-react";

import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarContent, SidebarGroup, SidebarGroupLabel } from "../ui/sidebar";

export function OrchestratorSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Orchestrator" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <BotIcon />
            AI Orchestrator
          </SidebarGroupLabel>
          <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
            Your orchestrator agents and workflows will appear here.
          </p>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
