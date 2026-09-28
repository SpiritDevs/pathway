/**
 * Pane and window actions shared by every entry point: the rail's context menu
 * and drag, the focused pane's pill, the command palette, and keybindings.
 */
import { openPageWindow } from "./pageWindows";
import { resolvePaneDestinationHref, type PaneDestination } from "./paneDestinations";
import { isSplit, PRIMARY_PANE_ID, splitEdge, type PaneEdge } from "./paneLayout";
import { getPaneRouter, navigatePrimaryPane } from "./paneRouters";
import { usePaneStore } from "./paneStore";

/** Opens a rail page as a new pane at one edge of the main window. */
export function openDestinationInPane(destination: PaneDestination, edge: PaneEdge): void {
  usePaneStore.getState().openPane(resolvePaneDestinationHref(destination), edge);
}

export function openDestinationInWindow(
  destination: PaneDestination,
  options?: { readonly screenPoint?: { readonly x: number; readonly y: number } },
): Promise<boolean> {
  return openPageWindow(resolvePaneDestinationHref(destination), options);
}

/** Closes a pane. When it was the primary pane, the neighbour that replaces it takes over the URL. */
export function closePaneById(paneId: string): void {
  const promotedHref = usePaneStore.getState().closePane(paneId);
  if (promotedHref !== null) navigatePrimaryPane(promotedHref);
}

export function closeAllSidePanes(): void {
  usePaneStore.getState().closeSidePanes();
}

/** The location a pane is showing right now. */
export function readPaneHref(paneId: string): string | null {
  if (paneId === PRIMARY_PANE_ID)
    return getPaneRouter(PRIMARY_PANE_ID)?.state.location.href ?? null;
  return usePaneStore.getState().layout.panes.find((entry) => entry.id === paneId)?.href ?? null;
}

/** Opens the focused pane's page again as a new pane beside the row. */
export function splitFocusedPane(): void {
  const { layout, openPane } = usePaneStore.getState();
  const href = readPaneHref(layout.focusedPaneId);
  if (href !== null) openPane(href, splitEdge(layout));
}

/** Closes the focused pane. Does nothing unless the window is split. */
export function closeFocusedPane(): void {
  const { layout } = usePaneStore.getState();
  if (isSplit(layout)) closePaneById(layout.focusedPaneId);
}

/** Moves a pane into its own window, then closes the pane. A window that fails to open keeps the pane. */
export async function popOutPane(
  paneId: string,
  options?: { readonly screenPoint?: { readonly x: number; readonly y: number } },
): Promise<void> {
  const href = readPaneHref(paneId);
  if (href === null) return;
  if (await openPageWindow(href, options)) closePaneById(paneId);
}
