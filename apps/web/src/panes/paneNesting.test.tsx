import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidePaneContext, useSidePaneId } from "./paneScope";

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
});
