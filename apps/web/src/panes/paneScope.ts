import { createContext, useContext } from "react";

/**
 * Set inside a side pane to that pane's id. The root route reads it to render
 * only the matched page, without the app shell or the global hosts the primary
 * pane already mounts. Kept apart from the pane routers so the root route can
 * import it without a cycle through the route tree.
 */
export const SidePaneContext = createContext<string | null>(null);

export function useSidePaneId(): string | null {
  return useContext(SidePaneContext);
}
