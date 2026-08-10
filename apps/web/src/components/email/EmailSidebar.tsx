import { MailIcon } from "lucide-react";

import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup, SidebarGroupLabel } from "../ui/sidebar";

export function EmailSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Email" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="gap-2">
            <MailIcon />
            Email
          </SidebarGroupLabel>
          <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
            Mailbox navigation will appear here.
          </p>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
