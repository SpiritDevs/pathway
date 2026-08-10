import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { SidebarHeader } from "../ui/sidebar";

export function ContextualSidebarHeader({ title }: { title: string }) {
  return (
    <SidebarHeader
      className={cn(
        "relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <span className="ml-[var(--workspace-titlebar-content-left)] truncate text-sm font-medium text-sidebar-foreground">
        {title}
      </span>
    </SidebarHeader>
  );
}
