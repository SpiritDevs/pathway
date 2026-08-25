import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
  });

  // #region DEBUG
  history.subscribe(({ action, location }) => {
    const stack = new Error().stack
      ?.split("\n")
      .slice(1, 9)
      .map((line) => line.trim())
      .join(" <- ");
    void fetch("/api/__debug/cloud-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hypothesis: "H5",
        event: "router-history-notified",
        fields: {
          action: action.type,
          hashPresent: location.hash.length > 0,
          pathname: location.pathname,
          searchPresent: location.search.length > 0,
          stack: stack ?? null,
        },
      }),
    }).catch(() => undefined);
  });
  // #endregion DEBUG

  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
