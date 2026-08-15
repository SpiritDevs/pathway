import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";

export function WorkspaceViewFrame({
  actions,
  children,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel={`${title} breadcrumb`}>
              <WorkspaceBreadcrumbItem current>{title}</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {actions ? (
              <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>
        </header>
        {children}
      </div>
    </SidebarInset>
  );
}
