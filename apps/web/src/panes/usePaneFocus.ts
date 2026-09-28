/**
 * Which pane a page renders in, and whether that pane is the one the user is
 * working in. Pages use this to keep window-wide input (keyboard shortcuts,
 * window event buses) from reaching every copy of themselves when the window is
 * split.
 *
 * Listeners should check `isPaneFocused(paneId)` when the event arrives rather
 * than subscribe, so moving focus between panes never re-renders a page.
 */
import { useRouterState } from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";

import type { AppRouter } from "../router";
import { isSplit, PRIMARY_PANE_ID, type PaneLayout } from "./paneLayout";
import { getSidePaneRouter } from "./paneRouters";
import { useSidePaneId } from "./paneScope";
import { usePaneStore } from "./paneStore";
import { isChildWindow } from "./windowMode";

/** Below this width a split pane shows its right panel as a sheet instead of inline. */
export const NARROW_PANE_MAX_WIDTH = 720;

/** True when the pane owns window-wide input: it has focus, or it is the only pane. */
export function paneOwnsInput(layout: PaneLayout, paneId: string): boolean {
  return !isSplit(layout) || layout.focusedPaneId === paneId;
}

/**
 * Selector for the element a pane's inline right panel portals into. Unsplit,
 * that is the shell's host beside the content frame, exactly as before panes
 * existed; split, each pane hosts its own.
 */
export function resolveInlineRightPanelHostSelector(paneId: string, split: boolean): string {
  return split ? `[data-pane-right-panel-host="${paneId}"]` : "[data-inline-right-panel-host]";
}

/** The pane this component renders in. */
export function usePaneId(): string {
  return useSidePaneId() ?? PRIMARY_PANE_ID;
}

/** Read at event time. A torn-out window never splits, whatever the shared store says. */
export function isPaneFocused(paneId: string): boolean {
  return isChildWindow || paneOwnsInput(usePaneStore.getState().layout, paneId);
}

export function useIsFocusedPane(): boolean {
  const paneId = usePaneId();
  return usePaneStore((state) => isChildWindow || paneOwnsInput(state.layout, paneId));
}

/**
 * The router of the focused pane, for window-level UI mounted outside the app
 * shell (such as the command palette) that should act on whichever pane has focus.
 */
export function useFocusedPaneRouter(appRouter: AppRouter): AppRouter {
  // Selects the id alone, so a side pane navigating never re-renders the caller.
  const focusedSidePaneId = usePaneStore((state) =>
    isChildWindow || state.layout.focusedPaneId === PRIMARY_PANE_ID
      ? null
      : state.layout.focusedPaneId,
  );
  // The href only seeds a router the pane row has not created yet.
  const sideRouter =
    focusedSidePaneId === null
      ? null
      : getSidePaneRouter(
          focusedSidePaneId,
          usePaneStore.getState().layout.panes.find((entry) => entry.id === focusedSidePaneId)
            ?.href ?? "",
        );
  // A side router has no matches until its first load commits, and match hooks
  // in the chrome throw against an empty router. Until then the chrome stays on
  // the app router, which is always loaded by the time the shell renders.
  const sideRouterLoaded = useRouterState({
    router: sideRouter ?? appRouter,
    select: (state) => state.matches.length > 0,
  });
  return sideRouter !== null && sideRouterLoaded ? sideRouter : appRouter;
}

export function useIsSplitWindow(): boolean {
  return usePaneStore((state) => !isChildWindow && isSplit(state.layout));
}

/**
 * True when the window is split and this pane is narrower than
 * `NARROW_PANE_MAX_WIDTH`. Re-renders only when the answer flips.
 */
export function useIsNarrowPane(): boolean {
  const paneId = usePaneId();
  const split = useIsSplitWindow();
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    if (!split) return;
    const frame = document.querySelector<HTMLElement>(`[data-pane-frame="${paneId}"]`);
    if (!frame) return;
    const update = (width: number) => setNarrow(width < NARROW_PANE_MAX_WIDTH);
    update(frame.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [paneId, split]);

  return split && narrow;
}
