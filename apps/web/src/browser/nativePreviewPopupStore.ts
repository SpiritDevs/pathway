import { create } from "zustand";

interface NativePreviewPopupState {
  readonly tabIds: ReadonlySet<string>;
  readonly reserve: (tabId: string) => void;
  readonly release: (tabId: string) => void;
}

export const useNativePreviewPopupStore = create<NativePreviewPopupState>((set) => ({
  tabIds: new Set(),
  reserve: (tabId) =>
    set((state) =>
      state.tabIds.has(tabId) ? state : { tabIds: new Set([...state.tabIds, tabId]) },
    ),
  release: (tabId) =>
    set((state) => {
      if (!state.tabIds.has(tabId)) return state;
      const tabIds = new Set(state.tabIds);
      tabIds.delete(tabId);
      return { tabIds };
    }),
}));

export const reserveNativePreviewPopup = (tabId: string): void =>
  useNativePreviewPopupStore.getState().reserve(tabId);

export const releaseNativePreviewPopup = (tabId: string): void =>
  useNativePreviewPopupStore.getState().release(tabId);
