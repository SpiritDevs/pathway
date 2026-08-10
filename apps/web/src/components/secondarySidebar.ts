export type SecondarySidebarKind =
  | "threads"
  | "settings"
  | "email"
  | "calendar"
  | "orchestrator"
  | "issues";

/**
 * The icon rail is global navigation; this wider sidebar belongs only to routes
 * with section-specific navigation. Pull Requests gets its own sidebar later,
 * so it must not temporarily inherit thread controls.
 */
export function resolveSecondarySidebarKind(pathname: string): SecondarySidebarKind | null {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
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
  if (
    pathname === "/" ||
    pathname === "/pull-requests" ||
    pathname.startsWith("/pull-requests/") ||
    pathname === "/usage" ||
    pathname.startsWith("/usage/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/")
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
