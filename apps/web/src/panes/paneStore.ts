/**
 * The main window's split-pane layout, saved per device.
 *
 * Only the main window splits: a torn-out window never reads or writes this
 * store, even though it shares the same localStorage.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { randomUUID } from "../lib/utils";
import {
  closePane,
  closeSidePanes,
  equalizePanes,
  flipPane,
  focusAdjacentPane,
  focusPane,
  normalizePaneLayout,
  openPane,
  resizeAtDivider,
  setPaneHref,
  SINGLE_PANE_LAYOUT,
  type PaneEdge,
  type PaneLayout,
} from "./paneLayout";

export const PANE_LAYOUT_STORAGE_KEY = "pathway:pane-layout:v1";

interface PaneStoreState {
  readonly layout: PaneLayout;
  /** The pane opened most recently, until its enter animation has played. Not saved. */
  readonly enteringPaneId: string | null;
  readonly clearEnteringPane: () => void;
  /** Opens a page beside the others and returns the new pane's id. */
  readonly openPane: (href: string, edge: PaneEdge) => string;
  /**
   * Closes a pane. Returns the location the app router must show when the
   * primary pane closed and a neighbour took its place.
   */
  readonly closePane: (paneId: string) => string | null;
  readonly closeSidePanes: () => void;
  readonly flipPane: (paneId: string) => void;
  readonly focusPane: (paneId: string) => void;
  readonly focusAdjacentPane: (direction: PaneEdge) => void;
  readonly setPaneHref: (paneId: string, href: string) => void;
  readonly resizeAtDivider: (leftIndex: number, leftFraction: number, minFraction: number) => void;
  readonly equalizePanes: () => void;
}

export const usePaneStore = create<PaneStoreState>()(
  persist(
    (set, get) => ({
      layout: SINGLE_PANE_LAYOUT,
      enteringPaneId: null,
      clearEnteringPane: () => set({ enteringPaneId: null }),
      openPane: (href, edge) => {
        const id = randomUUID();
        set((state) => ({
          layout: openPane(state.layout, { id, href, edge }),
          enteringPaneId: id,
        }));
        return id;
      },
      closePane: (paneId) => {
        const result = closePane(get().layout, paneId);
        set({ layout: result.layout });
        return result.promotedHref;
      },
      closeSidePanes: () => set((state) => ({ layout: closeSidePanes(state.layout) })),
      flipPane: (paneId) => set((state) => ({ layout: flipPane(state.layout, paneId) })),
      // Runs on every pointerdown and focus in any pane: skip the write, and the
      // persist middleware's localStorage save, when nothing changes.
      focusPane: (paneId) => {
        const layout = focusPane(get().layout, paneId);
        if (layout !== get().layout) set({ layout });
      },
      focusAdjacentPane: (direction) =>
        set((state) => ({ layout: focusAdjacentPane(state.layout, direction) })),
      setPaneHref: (paneId, href) => {
        const layout = setPaneHref(get().layout, paneId, href);
        if (layout !== get().layout) set({ layout });
      },
      resizeAtDivider: (leftIndex, leftFraction, minFraction) =>
        set((state) => ({
          layout: resizeAtDivider(state.layout, leftIndex, leftFraction, minFraction),
        })),
      equalizePanes: () => set((state) => ({ layout: equalizePanes(state.layout) })),
    }),
    {
      name: PANE_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => ({
        ...current,
        layout: normalizePaneLayout((persisted as { layout?: PaneLayout } | undefined)?.layout),
      }),
    },
  ),
);
