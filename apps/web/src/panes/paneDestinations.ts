import {
  resolvePrimaryNavigationDestination,
  type PrimaryNavigationDestination,
} from "../components/navigation/PrimaryNavigationRail";

/** Rail pages that can open in a pane or window. The orchestrator is an overlay, not a page. */
export type PaneDestination = Exclude<PrimaryNavigationDestination, "orchestrator">;

export const PANE_DESTINATION_LABELS: Record<PrimaryNavigationDestination, string> = {
  dashboard: "Dashboard",
  threads: "Threads",
  projects: "Projects",
  issues: "Tasks",
  "pull-requests": "Source Control",
  calendar: "Calendar",
  email: "Email",
  contacts: "Contacts",
  "time-tracker": "Time Tracker",
  orchestrator: "Orchestrator AI",
  settings: "Settings",
};

/** Where a rail page opens when it starts a new pane or window. */
export function resolvePaneDestinationHref(destination: PaneDestination): string {
  switch (destination) {
    case "dashboard":
      return "/";
    case "pull-requests":
      return "/pull-requests?involvement=all&state=open";
    default:
      return `/${destination}`;
  }
}

/** The rail page a location belongs to, as a label for pane and window chrome. */
export function describePaneLocation(href: string): string {
  const pathname = href.split(/[?#]/, 1)[0] || "/";
  return PANE_DESTINATION_LABELS[resolvePrimaryNavigationDestination(pathname)];
}
