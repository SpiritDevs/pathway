import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { BROWSER_HISTORY_MAX_TITLE_LENGTH, normalizeHistoryUrl } from "./browserHistoryStore";
import { resolveStorage } from "./lib/storage";

/** A page the user keeps on the new-tab page regardless of history. */
export type BrowserPinnedSite = { url: string; title?: string };

export const BROWSER_MAX_PINNED_SITES = 16;

/** The pinned pages, in the order they were pinned. */
export function useBrowserPinnedSites(): ReadonlyArray<BrowserPinnedSite> {
  return useBrowserPinnedSitesStore((state) => state.sites);
}

interface BrowserPinnedSitesState {
  sites: ReadonlyArray<BrowserPinnedSite>;
  /** Adds a page to the end of the pinned list; pinning an already pinned page is a no-op. */
  pin: (site: BrowserPinnedSite) => void;
  unpin: (url: string) => void;
}

export function migratePersistedPinnedSites(persistedState: unknown): {
  sites: ReadonlyArray<BrowserPinnedSite>;
} {
  const raw =
    persistedState && typeof persistedState === "object"
      ? (persistedState as { sites?: unknown }).sites
      : undefined;
  if (!Array.isArray(raw)) return { sites: [] };
  const seen = new Set<string>();
  const sites = raw.flatMap<BrowserPinnedSite>((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const { url, title } = candidate as Record<string, unknown>;
    const normalized = typeof url === "string" ? normalizeHistoryUrl(url) : null;
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [
      {
        url: normalized,
        ...(typeof title === "string" && title.length > 0
          ? { title: title.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) }
          : {}),
      },
    ];
  });
  return { sites: sites.slice(0, BROWSER_MAX_PINNED_SITES) };
}

export const useBrowserPinnedSitesStore = create<BrowserPinnedSitesState>()(
  persist(
    (set) => ({
      sites: [],
      pin: (site) => {
        const url = normalizeHistoryUrl(site.url);
        if (!url) return;
        set((state) =>
          state.sites.some((pinned) => pinned.url === url)
            ? state
            : {
                sites: [
                  ...state.sites,
                  { url, ...(site.title ? { title: site.title } : {}) },
                ].slice(-BROWSER_MAX_PINNED_SITES),
              },
        );
      },
      unpin: (url) => {
        const normalized = normalizeHistoryUrl(url);
        set((state) => ({ sites: state.sites.filter((pinned) => pinned.url !== normalized) }));
      },
    }),
    {
      name: "pathway:browser-pinned-sites:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ sites: state.sites }),
      migrate: migratePersistedPinnedSites,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedPinnedSites(persistedState),
      }),
    },
  ),
);
