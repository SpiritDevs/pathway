export type SecondarySidebarKind =
  | "threads"
  | "projects"
  | "settings"
  | "email"
  | "calendar"
  | "orchestrator"
  | "issues"
  | "source-control";

/**
 * The icon rail is global navigation; this wider sidebar belongs only to routes
 * with section-specific navigation. Routes without one must not temporarily
 * inherit thread controls.
 */
export function resolveSecondarySidebarKind(pathname: string): SecondarySidebarKind | null {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  if (pathname === "/projects" || pathname.startsWith("/projects/")) {
    return "projects";
  }
  if (pathname === "/email" || pathname.startsWith("/email/")) {
    return "email";
  }
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) {
    return "calendar";
  }
  if (pathname === "/orchestrator" || pathname.startsWith("/orchestrator/")) {
    return "orchestrator";
  }
  if (pathname === "/issues" || pathname.startsWith("/issues/")) {
    return "issues";
  }
  if (pathname === "/pull-requests" || pathname.startsWith("/pull-requests/")) {
    return "source-control";
  }
  if (
    pathname === "/" ||
    pathname === "/usage" ||
    pathname.startsWith("/usage/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/contacts" ||
    pathname.startsWith("/contacts/") ||
    pathname === "/time-tracker" ||
    pathname.startsWith("/time-tracker/")
  ) {
    return null;
  }
  return "threads";
}

export function shouldRenderSecondarySidebar(
  isMobile: boolean,
  sidebarKind: SecondarySidebarKind | null,
): boolean {
  return isMobile || sidebarKind !== null;
}
