/**
 * Whether this renderer is a torn-out window: one page on its own, with no rail
 * and no split panes.
 *
 * The desktop shell marks one with a `pathwayWindow` query parameter ahead of the
 * hash route. A web popup carries its id in `window.name`, which survives the
 * popup's own navigations. Read once: a window never changes kind.
 */
import { DESKTOP_CHILD_WINDOW_QUERY_PARAM } from "@spiritdevs/contracts";

export const CHILD_WINDOW_QUERY_PARAM = DESKTOP_CHILD_WINDOW_QUERY_PARAM;
export const WEB_CHILD_WINDOW_NAME_PREFIX = "pathway-window:";

export function readChildWindowId(location: {
  readonly search: string;
  readonly name: string;
}): string | null {
  const fromQuery = new URLSearchParams(location.search).get(CHILD_WINDOW_QUERY_PARAM);
  if (fromQuery) return fromQuery;
  return location.name.startsWith(WEB_CHILD_WINDOW_NAME_PREFIX)
    ? location.name.slice(WEB_CHILD_WINDOW_NAME_PREFIX.length) || null
    : null;
}

export const childWindowId: string | null =
  typeof window === "undefined"
    ? null
    : readChildWindowId({ search: window.location.search, name: window.name });

export const isChildWindow = childWindowId !== null;
