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

  // Warm only route code during idle time; preloading data here would create
  // a thread subscription before navigation. This benefits every chat entry.
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(() => {
      for (const routeId of [
        "/_chat/threads_/$environmentId/$threadId",
        "/_chat/threads_/draft/$draftId",
      ]) {
        const route = router.looseRoutesById[routeId];
        if (route) void router.loadRouteChunk(route)?.catch(() => undefined);
      }
    });
  }

  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
