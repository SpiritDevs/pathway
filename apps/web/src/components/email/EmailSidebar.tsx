import { useState } from "react";

import { cn } from "../../lib/utils";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type EmailSource = "local-smtp" | "gmail";

export function EmailSourceToggle() {
  const [source, setSource] = useState<EmailSource>("local-smtp");

  return (
    <ToggleGroup
      aria-label="Email source"
      className="relative grid w-full grid-cols-2 gap-0 rounded-full border border-sidebar-foreground/15 bg-sidebar-foreground/10 p-0.5"
      size="sm"
      value={[source]}
      variant="default"
      onValueChange={(value) => {
        const nextSource = value[0];
        if (nextSource === "local-smtp" || nextSource === "gmail") {
          setSource(nextSource);
        }
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-white shadow-sm/10 transition-transform duration-200 ease-out motion-reduce:transition-none",
          source === "gmail" && "translate-x-full",
        )}
      />
      <Toggle
        className="relative z-10 h-6 min-w-0 w-full rounded-full px-2 text-xs text-sidebar-muted-foreground shadow-none before:hidden transition-colors hover:bg-transparent hover:text-sidebar-foreground data-pressed:bg-transparent data-pressed:text-zinc-950"
        value="local-smtp"
      >
        Local SMTP
      </Toggle>
      <Toggle
        className="relative z-10 h-6 min-w-0 w-full rounded-full px-2 text-xs text-sidebar-muted-foreground shadow-none before:hidden transition-colors hover:bg-transparent hover:text-sidebar-foreground data-pressed:bg-transparent data-pressed:text-zinc-950"
        value="gmail"
      >
        Gmail
      </Toggle>
    </ToggleGroup>
  );
}

export function EmailSidebar() {
  return (
    <>
      <ContextualSidebarHeader title="Email" />
      <SidebarContent>
        <SidebarGroup className="p-[var(--sidebar-content-inset)]">
          <EmailSourceToggle />
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
