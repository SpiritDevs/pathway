import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  useLocation,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppRouter } from "../router";
import { getSidePaneRouter, pruneSidePaneRouters, registerPrimaryRouter } from "./paneRouters";
import { SidePaneContext, useSidePaneId } from "./paneScope";
import { useFocusedPaneRouter } from "./usePaneFocus";

// A freshly dropped pane, or one restored at launch, has focus before its router
// loads. Server rendering reads a store's initial state, so the split starts there.
vi.mock("./paneStore", async () => {
  const { create } = await import("zustand");
  return {
    usePaneStore: create(() => ({
      layout: {
        panes: [
          { id: "primary", href: "/", weight: 1 },
          { id: "side", href: "/email", weight: 1 },
        ],
        focusedPaneId: "side",
      },
      setPaneHref: () => {},
    })),
  };
});

/**
 * The split-pane model rests on two router behaviours: routers can share one
 * route tree, and a router nested inside another renders its own matches. Chrome
 * wrapped in a pane's router context reads that pane's location.
 */
describe("pane routers", () => {
  it("render their own page inside another router and drive the chrome around them", async () => {
    let sideRouter: ReturnType<typeof makeRouter> | null = null;

    const rootRoute = createRootRoute({
      component: function Root() {
        const sidePaneId = useSidePaneId();
        if (sidePaneId !== null) return <Outlet />;
        return (
          <div>
            <RouterContextProvider router={sideRouter!}>
              <Chrome />
            </RouterContextProvider>
            <main data-pane="primary">
              <Outlet />
            </main>
            <SidePaneContext.Provider value="side">
              <aside data-pane="side">
                <RouterProvider router={sideRouter!} />
              </aside>
            </SidePaneContext.Provider>
          </div>
        );
      },
    });
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>home</p> }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/email",
        component: () => <p>email</p>,
      }),
    ]);
    function makeRouter(href: string) {
      return createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [href] }),
      });
    }
    function Chrome() {
      return <nav>{useLocation({ select: (location) => location.pathname })}</nav>;
    }

    const primaryRouter = makeRouter("/");
    sideRouter = makeRouter("/email");
    await Promise.all([primaryRouter.load(), sideRouter.load()]);

    // Suspense boundary markers are noise here.
    const html = renderToString(<RouterProvider router={primaryRouter} />).replaceAll(
      /<!--.*?-->/g,
      "",
    );

    expect(html).toMatch(/<nav>\/email<\/nav>/);
    expect(html).toMatch(/<main data-pane="primary"><p>home<\/p><\/main>/);
    expect(html).toMatch(/<aside data-pane="side"><p>email<\/p><\/aside>/);
  });

  it("keep the chrome on the app router until the focused side pane has loaded", async () => {
    const rootRoute = createRootRoute({
      component: function Root() {
        const focusedRouter = useFocusedPaneRouter(useRouter() as unknown as AppRouter);
        return (
          <RouterContextProvider router={focusedRouter}>
            <Chrome />
          </RouterContextProvider>
        );
      },
    });
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/email" }),
    ]);
    // Match hooks throw when the router in context has no match for the chrome.
    function Chrome() {
      useParams({ strict: false });
      return <nav>{useLocation({ select: (location) => location.pathname })}</nav>;
    }

    const primaryRouter = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await primaryRouter.load();
    registerPrimaryRouter(primaryRouter as unknown as AppRouter);
    const render = () =>
      renderToString(<RouterProvider router={primaryRouter} />).replaceAll(/<!--.*?-->/g, "");

    try {
      expect(render()).toMatch(/<nav>\/<\/nav>/);
      await getSidePaneRouter("side", "/email").load();
      expect(render()).toMatch(/<nav>\/email<\/nav>/);
    } finally {
      pruneSidePaneRouters(new Set());
    }
  });
});
