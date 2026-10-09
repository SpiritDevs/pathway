import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { PreviewAutomationHistoryResult, ScopedThreadRef } from "@spiritdevs/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { normalizePreviewUrl } from "@spiritdevs/shared/preview";
import { readPreparedConnection } from "~/state/session";

import { isLocalLoopbackHost, normalizeHostname } from "./browser/browserTargetResolver";
import { resolveStorage } from "./lib/storage";

export type BrowserHistoryEntry = {
  url: string;
  lastVisitedAt: number;
  title?: string;
  /** How many times the page was visited; entries saved before counting began read as one. */
  visits?: number;
  /** Set when an agent made the latest visit. */
  source?: "agent";
};

/** One page in the browser-wide history list, with the project it was recorded under. */
export type BrowserHistoryListEntry = BrowserHistoryEntry & { readonly projectKey: string };

export const BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT = 50;
/** Pages imported from another browser live under their own key with a larger cap. */
export const BROWSER_HISTORY_IMPORTED_KEY = "imported";
export const BROWSER_HISTORY_MAX_IMPORTED_ENTRIES = 500;
/** A committed navigation this soon after a recorded visit to the same page is that visit. */
const SAME_VISIT_WINDOW_MS = 5_000;
export const BROWSER_HISTORY_MAX_PROJECTS = 20;
export const BROWSER_HISTORY_MAX_URL_LENGTH = 2048;
export const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

export function isValidHistoryTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS
  );
}

export function normalizeHistoryUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(raw));
  } catch {
    return null;
  }
  parsed.username = parsed.password = "";
  return parsed.href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : parsed.href;
}

export function titleLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(visitLookupKey(normalized, environmentHostname));
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/"))
    parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.href;
}

function visitLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(normalized);
  const host = normalizeHostname(parsed.hostname);
  const environmentHost = environmentHostname && normalizeHostname(environmentHostname);
  if (isLocalLoopbackHost(host) || host === "0.0.0.0" || host === environmentHost)
    parsed.hostname = "local";
  return parsed.href;
}

function isStableLocalUrl(normalized: string): boolean {
  const host = normalizeHostname(new URL(normalized).hostname);
  return isLocalLoopbackHost(host) || host === "0.0.0.0";
}

export function upsertHistoryEntry(
  entries: ReadonlyArray<BrowserHistoryEntry>,
  url: string,
  at: number,
  options?: {
    insertOrdered?: boolean;
    environmentHostname?: string | null;
    source?: "agent";
  },
): BrowserHistoryEntry[] {
  const key = visitLookupKey(url, options?.environmentHostname);
  const existing = entries.find(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) === key,
  );
  const rest = entries.filter(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) !== key,
  );
  const visitedAt =
    options?.insertOrdered && existing && existing.lastVisitedAt > at ? existing.lastVisitedAt : at;
  const storedUrl =
    existing && (isStableLocalUrl(existing.url) || !isStableLocalUrl(url)) ? existing.url : url;
  // The latest visit decides the source, so a user revisit clears an agent's mark.
  const { source: _previousSource, ...previous } = existing ?? { url, lastVisitedAt: visitedAt };
  const entry: BrowserHistoryEntry = {
    ...previous,
    url: storedUrl,
    lastVisitedAt: visitedAt,
    ...(existing ? { visits: historyEntryVisits(existing) + 1 } : {}),
    ...(options?.source ? { source: options.source } : {}),
  };
  if (!options?.insertOrdered)
    return [entry, ...rest].slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
  const index = rest.findIndex((candidate) => candidate.lastVisitedAt < entry.lastVisitedAt);
  const next = index === -1 ? [...rest, entry] : rest.toSpliced(index, 0, entry);
  return next.slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
}

function historyCapFor(projectKey: string): number {
  return projectKey === BROWSER_HISTORY_IMPORTED_KEY
    ? BROWSER_HISTORY_MAX_IMPORTED_ENTRIES
    : BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT;
}

export function historyEntryVisits(entry: BrowserHistoryEntry): number {
  return entry.visits ?? 1;
}

export function evictExcessProjects(
  byProjectKey: Record<string, BrowserHistoryEntry[]>,
): Record<string, BrowserHistoryEntry[]> {
  const keys = Object.keys(byProjectKey).filter((key) => key !== BROWSER_HISTORY_IMPORTED_KEY);
  if (keys.length <= BROWSER_HISTORY_MAX_PROJECTS) return byProjectKey;
  const imported = byProjectKey[BROWSER_HISTORY_IMPORTED_KEY];
  const kept = keys
    .toSorted(
      (a, b) =>
        (byProjectKey[b]?.[0]?.lastVisitedAt ?? 0) - (byProjectKey[a]?.[0]?.lastVisitedAt ?? 0),
    )
    .slice(0, BROWSER_HISTORY_MAX_PROJECTS);
  return Object.fromEntries([
    ...kept.map((key) => [key, byProjectKey[key] ?? []] as const),
    ...(imported ? [[BROWSER_HISTORY_IMPORTED_KEY, imported] as const] : []),
  ]);
}

export function migratePersistedBrowserHistoryState(persistedState: unknown): {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byProjectKey: {} };
  const raw = (persistedState as { byProjectKey?: unknown }).byProjectKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byProjectKey: {} };
  const byProjectKey: Record<string, BrowserHistoryEntry[]> = {};
  for (const [projectKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const seenUrls = new Set<string>();
    const entries = value
      .flatMap<BrowserHistoryEntry>((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const { url, lastVisitedAt, title, visits, source } = candidate as Record<string, unknown>;
        if (typeof url !== "string") return [];
        const normalizedUrl = normalizeHistoryUrl(url);
        if (!normalizedUrl) return [];
        if (!isValidHistoryTimestamp(lastVisitedAt)) return [];
        return [
          {
            url: normalizedUrl,
            lastVisitedAt,
            ...(typeof title === "string" && title.length > 0
              ? { title: title.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) }
              : {}),
            ...(typeof visits === "number" && Number.isSafeInteger(visits) && visits > 1
              ? { visits }
              : {}),
            ...(source === "agent" ? { source } : {}),
          },
        ];
      })
      .toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .filter((entry) => {
        const key = visitLookupKey(entry.url);
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      })
      .slice(0, historyCapFor(projectKey));
    if (entries.length > 0) byProjectKey[projectKey] = entries;
  }
  return { byProjectKey: evictExcessProjects(byProjectKey) };
}

const BROWSER_HISTORY_STORAGE_KEY = "pathway:browser-history:v1";

const PENDING_MAX_PER_THREAD = 10;
const PENDING_MAX_THREADS = 20;

type PendingVisit = { url: string; at: number; environmentHostname: string | null };
type PendingTitle = { url: string; title: string; environmentHostname: string | null | undefined };

interface BrowserHistoryStoreState {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
  projectKeyByThreadKey: Record<string, string>;
  pendingVisitsByThreadKey: Record<string, PendingVisit[]>;
  pendingTitlesByThreadKey: Record<string, PendingTitle[]>;
  recordVisit: (
    projectKey: string,
    url: string,
    at: number,
    options?: {
      insertOrdered?: boolean;
      environmentHostname?: string | null;
      source?: "agent";
    },
  ) => void;
  setTitleForUrl: (
    projectKey: string,
    url: string,
    title: string,
    environmentHostname?: string | null,
  ) => void;
  removeUrl: (projectKey: string, url: string) => void;
  /** Removes pages from every project's history. */
  removeEverywhere: (urls: ReadonlyArray<string>) => void;
  clearAll: () => void;
  /** Adds pages imported from another browser, keeping the newest. */
  importEntries: (entries: ReadonlyArray<BrowserHistoryEntry>) => void;
  registerThreadProject: (ref: ScopedThreadRef, projectKey: string) => void;
}

function addPendingByThread<T>(
  pendingByThreadKey: Record<string, T[]>,
  threadKey: string,
  item: T,
): Record<string, T[]> {
  const existing = pendingByThreadKey[threadKey] ?? [];
  const next = { ...pendingByThreadKey };
  next[threadKey] = [...existing, item].slice(-PENDING_MAX_PER_THREAD);
  const keys = Object.keys(next);
  if (keys.length > PENDING_MAX_THREADS) {
    const oldestKey = keys[0];
    if (oldestKey !== undefined && oldestKey !== threadKey) delete next[oldestKey];
  }
  return next;
}

export const useBrowserHistoryStore = create<BrowserHistoryStoreState>()(
  persist(
    (set, get) => ({
      byProjectKey: {},
      projectKeyByThreadKey: {},
      pendingVisitsByThreadKey: {},
      pendingTitlesByThreadKey: {},
      recordVisit: (projectKey, url, at, options) => {
        const normalized = normalizeHistoryUrl(url);
        if (!normalized) return;
        set((state) => {
          return {
            byProjectKey: evictExcessProjects({
              ...state.byProjectKey,
              [projectKey]: upsertHistoryEntry(
                state.byProjectKey[projectKey] ?? [],
                normalized,
                at,
                options,
              ),
            }),
          };
        });
      },
      setTitleForUrl: (projectKey, url, title, environmentHostname) => {
        const normalized = normalizeHistoryUrl(url);
        const state = get();
        const entries = state.byProjectKey[projectKey];
        const trimmed = title.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
        if (!normalized || !entries || trimmed.length === 0) return;
        const key = titleLookupKey(normalized, environmentHostname);
        const index = entries.findIndex(
          (candidate) => titleLookupKey(candidate.url, environmentHostname) === key,
        );
        if (index === -1 || entries[index]?.title === trimmed) return;
        set({
          byProjectKey: {
            ...state.byProjectKey,
            [projectKey]: entries.map((candidate, candidateIndex) =>
              candidateIndex === index ? { ...candidate, title: trimmed } : candidate,
            ),
          },
        });
      },
      removeUrl: (projectKey, url) => {
        const normalized = normalizeHistoryUrl(url);
        const state = get();
        const entries = state.byProjectKey[projectKey];
        if (!normalized || !entries) return;
        const next = entries.filter((candidate) => candidate.url !== normalized);
        if (next.length === entries.length) return;
        if (next.length === 0) {
          const { [projectKey]: _removed, ...rest } = state.byProjectKey;
          set({ byProjectKey: rest });
          return;
        }
        set({ byProjectKey: { ...state.byProjectKey, [projectKey]: next } });
      },
      removeEverywhere: (urls) => {
        const removed = new Set(urls);
        const state = get();
        const byProjectKey: Record<string, BrowserHistoryEntry[]> = {};
        for (const [projectKey, entries] of Object.entries(state.byProjectKey)) {
          const kept = entries.filter((entry) => !removed.has(entry.url));
          if (kept.length > 0) byProjectKey[projectKey] = kept;
        }
        set({ byProjectKey });
      },
      clearAll: () => set({ byProjectKey: {} }),
      importEntries: (imported) => {
        const state = get();
        const seen = new Set<string>();
        const entries = [...imported, ...(state.byProjectKey[BROWSER_HISTORY_IMPORTED_KEY] ?? [])]
          .flatMap((entry) => {
            const url = normalizeHistoryUrl(entry.url);
            if (!url || !isValidHistoryTimestamp(entry.lastVisitedAt) || seen.has(url)) return [];
            seen.add(url);
            return [{ ...entry, url }];
          })
          .toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt)
          .slice(0, BROWSER_HISTORY_MAX_IMPORTED_ENTRIES);
        set({
          byProjectKey: { ...state.byProjectKey, [BROWSER_HISTORY_IMPORTED_KEY]: entries },
        });
      },
      registerThreadProject: (ref, projectKey) => {
        const threadKey = scopedThreadKey(ref);
        const state = get();
        const pendingVisits = state.pendingVisitsByThreadKey[threadKey];
        const pendingTitles = state.pendingTitlesByThreadKey[threadKey];
        if (
          state.projectKeyByThreadKey[threadKey] === projectKey &&
          !pendingVisits &&
          !pendingTitles
        ) {
          return;
        }
        const nextPendingVisits = { ...state.pendingVisitsByThreadKey };
        const nextPendingTitles = { ...state.pendingTitlesByThreadKey };
        delete nextPendingVisits[threadKey];
        delete nextPendingTitles[threadKey];
        set({
          projectKeyByThreadKey: { ...state.projectKeyByThreadKey, [threadKey]: projectKey },
          pendingVisitsByThreadKey: nextPendingVisits,
          pendingTitlesByThreadKey: nextPendingTitles,
        });
        for (const visit of pendingVisits ?? [])
          get().recordVisit(projectKey, visit.url, visit.at, {
            insertOrdered: true,
            environmentHostname: visit.environmentHostname,
          });
        for (const pendingTitle of pendingTitles ?? [])
          get().setTitleForUrl(
            projectKey,
            pendingTitle.url,
            pendingTitle.title,
            pendingTitle.environmentHostname,
          );
      },
    }),
    {
      name: BROWSER_HISTORY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byProjectKey: state.byProjectKey,
        projectKeyByThreadKey: state.projectKeyByThreadKey,
      }),
      migrate: migratePersistedBrowserHistoryState,
      merge: mergeBrowserHistoryState,
    },
  ),
);

export function mergeBrowserHistoryState(
  persistedState: unknown,
  currentState: BrowserHistoryStoreState,
): BrowserHistoryStoreState {
  const migrated = migratePersistedBrowserHistoryState(persistedState);
  return {
    ...currentState,
    ...migrated,
    projectKeyByThreadKey: migratePersistedThreadProjectKeys(persistedState, migrated.byProjectKey),
    pendingVisitsByThreadKey: {},
    pendingTitlesByThreadKey: {},
  };
}

function migratePersistedThreadProjectKeys(
  persistedState: unknown,
  byProjectKey: Record<string, BrowserHistoryEntry[]>,
): Record<string, string> {
  if (!persistedState || typeof persistedState !== "object") return {};
  const raw = (persistedState as { projectKeyByThreadKey?: unknown }).projectKeyByThreadKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1] in byProjectKey,
      )
      .slice(-100),
  );
}

export function recordVisitForThread(
  ref: ScopedThreadRef,
  url: string,
  at?: number,
  source?: "agent",
): void {
  const threadKey = scopedThreadKey(ref);
  const state = useBrowserHistoryStore.getState();
  const projectKey = state.projectKeyByThreadKey[threadKey];
  const visitAt = at ?? Date.now();
  const connection = readPreparedConnection(ref.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : null;
  if (!projectKey) {
    useBrowserHistoryStore.setState({
      pendingVisitsByThreadKey: addPendingByThread(state.pendingVisitsByThreadKey, threadKey, {
        url,
        at: visitAt,
        environmentHostname,
      }),
    });
    return;
  }
  state.recordVisit(projectKey, url, visitAt, {
    environmentHostname,
    ...(source ? { source } : {}),
  });
}

/**
 * Records a page the tab finished loading. It merges into a visit recorded
 * moments earlier for the same page (the address bar records before the page
 * commits), so one navigation counts once.
 */
export function recordNavigationForThread(
  ref: ScopedThreadRef,
  url: string,
  title: string,
  source: "user" | "agent",
): void {
  const state = useBrowserHistoryStore.getState();
  const projectKey = state.projectKeyByThreadKey[scopedThreadKey(ref)];
  const normalized = normalizeHistoryUrl(url);
  if (!normalized) return;
  const now = Date.now();
  const latest = projectKey ? state.byProjectKey[projectKey]?.[0] : undefined;
  if (
    !projectKey ||
    !latest ||
    latest.url !== normalized ||
    now - latest.lastVisitedAt > SAME_VISIT_WINDOW_MS
  ) {
    recordVisitForThread(ref, normalized, now, source === "agent" ? source : undefined);
  } else if ((latest.source === "agent") !== (source === "agent")) {
    const { source: _previous, ...rest } = latest;
    const entries = state.byProjectKey[projectKey] ?? [];
    useBrowserHistoryStore.setState({
      byProjectKey: {
        ...state.byProjectKey,
        [projectKey]: [source === "agent" ? { ...rest, source } : rest, ...entries.slice(1)],
      },
    });
  }
  if (title.trim() !== "") setTitleForThreadUrl(ref, normalized, title);
}

/** Every recorded page across projects, newest first, one row per address. */
export function listBrowserHistory(
  byProjectKey: Readonly<Record<string, ReadonlyArray<BrowserHistoryEntry>>>,
): ReadonlyArray<BrowserHistoryListEntry> {
  const newest = new Map<string, BrowserHistoryListEntry>();
  for (const [projectKey, entries] of Object.entries(byProjectKey)) {
    for (const entry of entries) {
      const current = newest.get(entry.url);
      const next: BrowserHistoryListEntry =
        current && current.lastVisitedAt >= entry.lastVisitedAt
          ? current
          : { ...entry, projectKey };
      const title = next.title ?? current?.title ?? entry.title;
      newest.set(entry.url, {
        ...next,
        ...(current ? { visits: historyEntryVisits(current) + historyEntryVisits(entry) } : {}),
        ...(title ? { title } : {}),
      });
    }
  }
  return [...newest.values()].toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt);
}

export function setTitleForThreadUrl(
  ref: ScopedThreadRef,
  url: string,
  title: string,
  environmentHostname?: string | null,
): void {
  const threadKey = scopedThreadKey(ref);
  const state = useBrowserHistoryStore.getState();
  const projectKey = state.projectKeyByThreadKey[threadKey];
  if (!projectKey) {
    useBrowserHistoryStore.setState({
      pendingTitlesByThreadKey: addPendingByThread(state.pendingTitlesByThreadKey, threadKey, {
        url,
        title,
        environmentHostname,
      }),
    });
    return;
  }
  state.setTitleForUrl(projectKey, url, title, environmentHostname);
}

/** Every page across projects, newest first, as the new-tab page offers them. */
export function useBrowserWideHistory(): ReadonlyArray<BrowserHistoryListEntry> {
  const byProjectKey = useBrowserHistoryStore((state) => state.byProjectKey);
  return useMemo(() => listBrowserHistory(byProjectKey), [byProjectKey]);
}

const EMPTY_HISTORY: ReadonlyArray<BrowserHistoryEntry> = [];

export function useThreadRecentHistory(
  ref: ScopedThreadRef,
  limit: number,
): ReadonlyArray<BrowserHistoryEntry> {
  return useBrowserHistoryStore(
    useShallow((state) => {
      const projectKey = state.projectKeyByThreadKey[scopedThreadKey(ref)];
      const entries = projectKey ? state.byProjectKey[projectKey] : undefined;
      return entries && entries.length > 0 ? entries.slice(0, limit) : EMPTY_HISTORY;
    }),
  );
}

export function resetBrowserHistoryForTests(): void {
  useBrowserHistoryStore.setState({
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
    pendingTitlesByThreadKey: {},
  });
  useBrowserHistoryStore.persist.clearStorage();
}

/** History as agents read it: newest first, filtered by a case-insensitive query. */
export function browserHistoryForAgent(
  byProjectKey: Readonly<Record<string, ReadonlyArray<BrowserHistoryEntry>>>,
  input: { readonly query?: string | undefined; readonly limit?: number | undefined },
): PreviewAutomationHistoryResult {
  const query = input.query?.trim().toLowerCase() ?? "";
  const entries = listBrowserHistory(byProjectKey)
    .filter(
      (entry) =>
        query === "" ||
        entry.url.toLowerCase().includes(query) ||
        (entry.title?.toLowerCase().includes(query) ?? false),
    )
    .slice(0, input.limit ?? 50)
    .map((entry) => ({
      url: entry.url,
      title: entry.title ?? null,
      lastVisitedAt: new Date(entry.lastVisitedAt).toISOString(),
      visits: historyEntryVisits(entry),
      source: entry.source ?? ("user" as const),
    }));
  return { entries };
}
