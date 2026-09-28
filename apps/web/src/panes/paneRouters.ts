/**
 * One router per pane. The primary pane uses the app router; each side pane gets
 * its own router over the same route tree with in-memory history, so routed pages
 * render there unchanged. Chrome outside the panes (rail, secondary sidebar, top
 * bar) is rendered inside the focused pane's router context, which is how rail
 * clicks land in the focused pane.
 */
import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import type { AppRouter } from "../router";
import { PRIMARY_PANE_ID } from "./paneLayout";
import { usePaneStore } from "./paneStore";

interface SidePaneRouter {
  readonly router: AppRouter;
  readonly unsubscribe: () => void;
}

const sidePaneRouters = new Map<string, SidePaneRouter>();
let primaryRouter: AppRouter | null = null;

/** The app router. Registered once at boot so code outside React can navigate the primary pane. */
export function registerPrimaryRouter(router: AppRouter): void {
  primaryRouter = router;
}

/**
 * The router for a side pane, created on first use at `initialHref`. It lives
 * as long as the pane does, so a pane that collapses and comes back keeps its
 * history.
 */
export function getSidePaneRouter(paneId: string, initialHref: string): AppRouter {
  const existing = sidePaneRouters.get(paneId);
  if (existing) return existing.router;
  if (!primaryRouter) throw new Error("Side panes render after the app router is registered.");

  const history = createMemoryHistory({ initialEntries: [initialHref || "/"] });
  const router: AppRouter = createRouter({
    // Reusing the app router's tree, rather than importing the generated one,
    // keeps this module out of the route tree's import cycle.
    routeTree: primaryRouter.routeTree,
    history,
    context: {},
  });
  const unsubscribe = history.subscribe(() => {
    usePaneStore.getState().setPaneHref(paneId, history.location.href);
  });
  sidePaneRouters.set(paneId, { router, unsubscribe });
  return router;
}

/** The router behind a pane, or null for a side pane that has not rendered yet. */
export function getPaneRouter(paneId: string): AppRouter | null {
  if (paneId === PRIMARY_PANE_ID) return primaryRouter;
  return sidePaneRouters.get(paneId)?.router ?? null;
}

/** Drops routers whose panes are gone. */
export function pruneSidePaneRouters(livePaneIds: ReadonlySet<string>): void {
  for (const [paneId, entry] of sidePaneRouters) {
    if (livePaneIds.has(paneId)) continue;
    entry.unsubscribe();
    sidePaneRouters.delete(paneId);
  }
}

/** Navigates the primary pane to a location, as when a side pane is promoted into it. */
export function navigatePrimaryPane(href: string): void {
  void primaryRouter?.navigate({ href });
}
