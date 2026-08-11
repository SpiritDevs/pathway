import {
  BotIcon,
  CalendarDaysIcon,
  GitPullRequestIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MailIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { SidebarProviderUpdatePill } from "../sidebar/SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const PRIMARY_NAVIGATION_COMPACT_WIDTH = "3.5rem";
export const PRIMARY_NAVIGATION_EXPANDED_WIDTH = "13rem";
export const PRIMARY_NAVIGATION_EXPANDED_STORAGE_KEY = "pathway:primary-navigation-expanded";
const PRIMARY_NAVIGATION_WORKSPACE_ITEM_COUNT = 6;

export function resolvePrimaryNavigationRailWidth(expanded: boolean): string {
  return expanded ? PRIMARY_NAVIGATION_EXPANDED_WIDTH : PRIMARY_NAVIGATION_COMPACT_WIDTH;
}

export type PrimaryNavigationDestination =
  | "dashboard"
  | "threads"
  | "issues"
  | "pull-requests"
  | "calendar"
  | "email"
  | "orchestrator"
  | "settings";

export function resolvePrimaryNavigationDestination(
  pathname: string,
): PrimaryNavigationDestination {
  if (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return "dashboard";
  }
  if (pathname === "/pull-requests" || pathname.startsWith("/pull-requests/")) {
    return "pull-requests";
  }
  if (pathname === "/issues" || pathname.startsWith("/issues/")) {
    return "issues";
  }
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) {
    return "calendar";
  }
  if (pathname === "/email" || pathname.startsWith("/email/")) {
    return "email";
  }
  if (pathname === "/orchestrator" || pathname.startsWith("/orchestrator/")) {
    return "orchestrator";
  }
  if (
    pathname === "/usage" ||
    pathname.startsWith("/usage/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  ) {
    return "settings";
  }
  return "threads";
}

type NavigationRailButtonProps = {
  active?: boolean;
  expanded: boolean;
  icon: LucideIcon;
  label: string;
  onClick?: ComponentProps<typeof Button>["onClick"];
};

type MobileNavigationItem = {
  destination: PrimaryNavigationDestination;
  icon: LucideIcon;
  label: string;
  onNavigate: () => void;
};

type MobileNavigationExpansionMode = "closed" | "hover" | "engaged";

function NavigationRailButton({
  active = false,
  expanded,
  icon: Icon,
  label,
  onClick,
}: NavigationRailButtonProps) {
  return (
    <Tooltip disabled={expanded}>
      <TooltipTrigger
        render={
          <Button
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={cn(
              "relative h-9! overflow-hidden [-webkit-app-region:no-drag] [--control-icon-color:var(--sidebar-muted-foreground)]",
              "hover:[--control-icon-color:var(--sidebar-foreground)]",
              expanded ? "w-full justify-start gap-2 px-2.5" : "w-9 gap-0 px-0",
              active &&
                "bg-sidebar-accent text-sidebar-accent-foreground [--control-icon-color:var(--sidebar-accent-foreground)]",
            )}
            onClick={onClick}
            size="icon-lg"
            style={{ width: expanded ? "100%" : "2.25rem" }}
            variant="ghost"
          >
            <Icon className="size-5" />
            {expanded ? (
              <span className="min-w-0 flex-1 truncate text-left text-sm">{label}</span>
            ) : null}
          </Button>
        }
      />
      <TooltipPopup side="right" sideOffset={8}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

export function MobileNavigationToolbar({
  activeDestination,
  items,
}: {
  activeDestination: PrimaryNavigationDestination;
  items: readonly MobileNavigationItem[];
}) {
  const [expansionMode, setExpansionMode] = useState<MobileNavigationExpansionMode>("closed");
  const expanded = expansionMode !== "closed";
  const toolbarRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const collapse = useCallback((restoreFocus = false) => {
    setExpansionMode("closed");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const toolbar = toolbarRef.current;
    const activeItem = toolbar?.querySelector<HTMLElement>('[aria-current="page"]');
    const firstItem = toolbar?.querySelector<HTMLElement>("[data-mobile-navigation-item]");
    const focusFrame =
      expansionMode === "engaged"
        ? window.requestAnimationFrame(() => (activeItem ?? firstItem)?.focus())
        : undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      collapse();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapse(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [collapse, expanded, expansionMode]);

  return (
    <div
      className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+0.25rem)] left-1/2 z-70 flex -translate-x-1/2 justify-center md:hidden"
      data-mobile-primary-navigation=""
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open primary navigation"
        aria-expanded={expanded}
        aria-controls="mobile-primary-navigation-toolbar"
        className={cn(
          "group pointer-events-auto flex h-11 w-16 cursor-pointer appearance-none items-start justify-center border-0 bg-transparent pt-2 outline-none transition-[opacity,transform] duration-100 ease-out motion-reduce:transition-none",
          expanded ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100",
        )}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
          event.preventDefault();
          setExpansionMode("engaged");
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          setExpansionMode("engaged");
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          setExpansionMode((mode) => (mode === "closed" ? "hover" : mode));
        }}
        tabIndex={expanded ? -1 : 0}
      >
        <span
          aria-hidden="true"
          className="h-5 w-14 rounded-full border border-border/55 bg-background/35 shadow-sm/5 backdrop-blur-xl backdrop-saturate-150 transition-[background-color,box-shadow] duration-150 ease-out group-hover:bg-background/95 group-focus-visible:bg-background/95 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 dark:bg-background/30 dark:group-hover:bg-background/95 motion-reduce:transition-none"
        />
      </button>

      <nav
        ref={toolbarRef}
        id="mobile-primary-navigation-toolbar"
        aria-label="Primary navigation"
        aria-hidden={!expanded}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse" || expansionMode !== "hover") return;
          collapse();
        }}
        className={cn(
          "pointer-events-auto absolute top-0 left-1/2 flex h-14 w-max max-w-[calc(100vw-1rem)] origin-top -translate-x-1/2 items-center rounded-[1.75rem] border border-border/70 bg-background/48 p-1.5 shadow-lg/8 backdrop-blur-2xl backdrop-saturate-150",
          "transition-[visibility,opacity,transform,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-background/95 pointer-coarse:bg-background/88 dark:bg-background/42 dark:hover:bg-background/95 dark:pointer-coarse:bg-background/88 motion-reduce:delay-0 motion-reduce:transition-none",
          expanded
            ? "visible translate-y-0 scale-x-100 scale-y-100 opacity-100 delay-0"
            : "invisible pointer-events-none translate-y-2 scale-x-[0.14] scale-y-[0.36] opacity-0 delay-150",
        )}
      >
        <div className="flex min-w-0 max-w-full items-center justify-[safe_center] gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map(({ destination, icon: Icon, label, onNavigate }, index) => (
            <div key={destination} className="contents">
              {index === PRIMARY_NAVIGATION_WORKSPACE_ITEM_COUNT ? (
                <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border/80" />
              ) : null}
              <Button
                type="button"
                aria-current={activeDestination === destination ? "page" : undefined}
                aria-label={label}
                title={label}
                data-mobile-navigation-item=""
                className={cn(
                  "size-11! shrink-0 rounded-full [-webkit-app-region:no-drag] [--control-icon-color:var(--muted-foreground)] hover:[--control-icon-color:var(--foreground)]",
                  activeDestination === destination &&
                    "bg-accent text-accent-foreground [--control-icon-color:var(--accent-foreground)]",
                )}
                onClick={() => {
                  collapse();
                  onNavigate();
                }}
                size="icon-lg"
                tabIndex={expanded ? 0 : -1}
                variant="ghost"
              >
                <Icon className="size-5" />
              </Button>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}

export const PrimaryNavigationRail = memo(function PrimaryNavigationRail({
  expanded,
  onExpandedChange,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeDestination = resolvePrimaryNavigationDestination(pathname);

  const navigateToDashboard = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);
  const navigateToThreads = useCallback(() => {
    void navigate({ to: "/threads" });
  }, [navigate]);
  const navigateToIssues = useCallback(() => {
    void navigate({ to: "/issues" });
  }, [navigate]);
  const navigateToPullRequests = useCallback(() => {
    void navigate({
      to: "/pull-requests",
      search: { involvement: "all", state: "open" },
    });
  }, [navigate]);
  const navigateToCalendar = useCallback(() => {
    void navigate({ to: "/calendar" });
  }, [navigate]);
  const navigateToEmail = useCallback(() => {
    void navigate({ to: "/email" });
  }, [navigate]);
  const navigateToOrchestrator = useCallback(() => {
    void navigate({ to: "/orchestrator" });
  }, [navigate]);
  const navigateToSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);
  const navigationItems = [
    {
      destination: "dashboard",
      icon: LayoutDashboardIcon,
      label: "Dashboard",
      onNavigate: navigateToDashboard,
    },
    {
      destination: "threads",
      icon: MessagesSquareIcon,
      label: "Threads",
      onNavigate: navigateToThreads,
    },
    {
      destination: "issues",
      icon: ListTodoIcon,
      label: "Issues",
      onNavigate: navigateToIssues,
    },
    {
      destination: "pull-requests",
      icon: GitPullRequestIcon,
      label: "Source Control",
      onNavigate: navigateToPullRequests,
    },
    {
      destination: "calendar",
      icon: CalendarDaysIcon,
      label: "Calendar",
      onNavigate: navigateToCalendar,
    },
    {
      destination: "email",
      icon: MailIcon,
      label: "Email",
      onNavigate: navigateToEmail,
    },
    {
      destination: "orchestrator",
      icon: BotIcon,
      label: "Orchestrator AI",
      onNavigate: navigateToOrchestrator,
    },
    {
      destination: "settings",
      icon: SettingsIcon,
      label: "Settings",
      onNavigate: navigateToSettings,
    },
  ] as const satisfies readonly MobileNavigationItem[];

  return (
    <>
      <aside
        aria-label="Primary navigation"
        className="relative z-20 hidden h-dvh w-(--primary-navigation-rail-width) shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear motion-reduce:transition-none md:flex"
        data-expanded={expanded}
        data-primary-navigation-rail=""
      >
        <div className="h-11 shrink-0" aria-hidden="true" />
        <nav
          aria-label="Workspace"
          className={cn(
            "flex w-full flex-col gap-1 px-2 pb-2",
            expanded ? "items-stretch" : "items-center",
          )}
        >
          {navigationItems
            .slice(0, PRIMARY_NAVIGATION_WORKSPACE_ITEM_COUNT)
            .map(({ destination, icon, label, onNavigate }) => (
              <NavigationRailButton
                key={destination}
                active={activeDestination === destination}
                expanded={expanded}
                icon={icon}
                label={label}
                onClick={onNavigate}
              />
            ))}
        </nav>
        <nav
          aria-label="Account and application"
          className={cn(
            "mt-auto flex w-full flex-col gap-1 px-2 pb-3",
            expanded ? "items-stretch" : "items-center",
          )}
        >
          <SidebarProviderUpdatePill expanded={expanded} />
          <SidebarUpdatePill expanded={expanded} />
          {navigationItems
            .slice(PRIMARY_NAVIGATION_WORKSPACE_ITEM_COUNT)
            .map(({ destination, icon, label, onNavigate }) => (
              <NavigationRailButton
                key={destination}
                active={activeDestination === destination}
                expanded={expanded}
                icon={icon}
                label={label}
                onClick={onNavigate}
              />
            ))}
          <div className="mt-1 flex w-full flex-col items-center border-t border-sidebar-border pt-2">
            <NavigationRailButton
              expanded={expanded}
              icon={expanded ? PanelLeftCloseIcon : PanelLeftIcon}
              label={expanded ? "Collapse navigation" : "Expand navigation"}
              onClick={() => onExpandedChange(!expanded)}
            />
          </div>
        </nav>
      </aside>
      <MobileNavigationToolbar activeDestination={activeDestination} items={navigationItems} />
    </>
  );
});
