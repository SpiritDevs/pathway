import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
  });

  // Route chunks otherwise wait for every `beforeLoad`, and the root's is a
  // server round trip for the auth gate. Fetching the landing route's code now
  // overlaps the two, so a cold start does not pay for them one after another.
  for (const match of router.matchRoutes(router.state.location)) {
    const route = router.looseRoutesById[match.routeId];
    if (route) void router.loadRouteChunk(route)?.catch(() => undefined);
  }

  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
