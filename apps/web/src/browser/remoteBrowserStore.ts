import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "~/rightPanelStore";
import { remoteBrowserEnabled } from "~/browser/browserPlacement";

export interface RemoteBrowserThreadState {
  /** The remote tab the panel shows; null follows the environment's selected tab. */
  readonly selectedTabId: string | null;
  /** A URL to open in a new remote tab once the panel's browser is connected. */
  readonly pendingUrl: string | null;
}

const EMPTY: RemoteBrowserThreadState = { selectedTabId: null, pendingUrl: null };

interface RemoteBrowserStoreState {
  readonly byThreadKey: Record<string, RemoteBrowserThreadState>;
  readonly select: (ref: ScopedThreadRef, tabId: string | null) => void;
  readonly requestOpen: (ref: ScopedThreadRef, url: string) => void;
  /** Hands the pending URL to exactly one caller. */
  readonly takePendingUrl: (ref: ScopedThreadRef) => string | null;
}

const update = (
  byThreadKey: Record<string, RemoteBrowserThreadState>,
  ref: ScopedThreadRef,
  patch: Partial<RemoteBrowserThreadState>,
) => {
  const threadKey = scopedThreadKey(ref);
  return {
    byThreadKey: {
      ...byThreadKey,
      [threadKey]: { ...(byThreadKey[threadKey] ?? EMPTY), ...patch },
    },
  };
};

export const useRemoteBrowserStore = create<RemoteBrowserStoreState>()((set, get) => ({
  byThreadKey: {},
  select: (ref, tabId) =>
    set((state) =>
      state.byThreadKey[scopedThreadKey(ref)]?.selectedTabId === tabId
        ? state
        : update(state.byThreadKey, ref, { selectedTabId: tabId }),
    ),
  requestOpen: (ref, url) => set((state) => update(state.byThreadKey, ref, { pendingUrl: url })),
  takePendingUrl: (ref) => {
    const pendingUrl = get().byThreadKey[scopedThreadKey(ref)]?.pendingUrl ?? null;
    if (pendingUrl !== null) set((state) => update(state.byThreadKey, ref, { pendingUrl: null }));
    return pendingUrl;
  },
}));

export function useRemoteBrowserSelectedTabId(ref: ScopedThreadRef): string | null {
  return useRemoteBrowserStore(
    (state) => state.byThreadKey[scopedThreadKey(ref)]?.selectedTabId ?? null,
  );
}

/** Shows the thread's remote browser in the right panel, on a given tab or with a URL to open. */
export function openRemoteBrowser(
  ref: ScopedThreadRef,
  target: { readonly tabId?: string; readonly url?: string } = {},
): void {
  if (!remoteBrowserEnabled) return;
  const store = useRemoteBrowserStore.getState();
  if (target.tabId !== undefined) store.select(ref, target.tabId);
  if (target.url !== undefined) store.requestOpen(ref, target.url);
  useRightPanelStore.getState().openRemoteBrowser(ref);
}
