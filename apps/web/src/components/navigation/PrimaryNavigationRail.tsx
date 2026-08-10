import {
  BotIcon,
  CalendarDaysIcon,
  CircleDotIcon,
  GitPullRequestIcon,
  LayoutDashboardIcon,
  MailIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, type ComponentProps } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const PRIMARY_NAVIGATION_COMPACT_WIDTH = "3.5rem";
export const PRIMARY_NAVIGATION_EXPANDED_WIDTH = "13rem";
export const PRIMARY_NAVIGATION_EXPANDED_STORAGE_KEY = "pathway:primary-navigation-expanded";

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

  return (
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
        <NavigationRailButton
          active={activeDestination === "dashboard"}
          expanded={expanded}
          icon={LayoutDashboardIcon}
          label="Dashboard"
          onClick={navigateToDashboard}
        />
        <NavigationRailButton
          active={activeDestination === "threads"}
          expanded={expanded}
          icon={MessagesSquareIcon}
          label="Threads"
          onClick={navigateToThreads}
        />
        <NavigationRailButton
          active={activeDestination === "issues"}
          expanded={expanded}
          icon={CircleDotIcon}
          label="Issues"
          onClick={navigateToIssues}
        />
        <NavigationRailButton
          active={activeDestination === "pull-requests"}
          expanded={expanded}
          icon={GitPullRequestIcon}
          label="Pull Requests"
          onClick={navigateToPullRequests}
        />
        <NavigationRailButton
          active={activeDestination === "calendar"}
          expanded={expanded}
          icon={CalendarDaysIcon}
          label="Calendar"
          onClick={navigateToCalendar}
        />
        <NavigationRailButton
          active={activeDestination === "email"}
          expanded={expanded}
          icon={MailIcon}
          label="Email"
          onClick={navigateToEmail}
        />
      </nav>
      <nav
        aria-label="Account and application"
        className={cn(
          "mt-auto flex w-full flex-col gap-1 px-2 pb-3",
          expanded ? "items-stretch" : "items-center",
        )}
      >
        <NavigationRailButton
          active={activeDestination === "orchestrator"}
          expanded={expanded}
          icon={BotIcon}
          label="Orchestrator AI"
          onClick={navigateToOrchestrator}
        />
        <NavigationRailButton
          active={activeDestination === "settings"}
          expanded={expanded}
          icon={SettingsIcon}
          label="Settings"
          onClick={navigateToSettings}
        />
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
  );
});
