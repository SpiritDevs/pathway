/**
 * Torn-out windows: a rail page opened in its own window, in window mode.
 *
 * Desktop opens real BrowserWindows through the desktop bridge. Web opens
 * popups with `window.open` and can only see the ones this tab opened; each
 * popup announces its page and title, and its closing, on a BroadcastChannel.
 * The same page may be open in several windows at once.
 */
import type { DesktopWindowInfo } from "@spiritdevs/contracts";
import { useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { describePaneLocation } from "./paneDestinations";
import { isChildWindow, WEB_CHILD_WINDOW_NAME_PREFIX } from "./windowMode";

export interface PageWindow {
  readonly id: string;
  /** The page the window is showing, as a router href such as `/email`. */
  readonly href: string;
  readonly title: string;
}

type ScreenPoint = { readonly x: number; readonly y: number };

const desktopWindows = typeof window === "undefined" ? undefined : window.desktopBridge?.windows;

/** Touch-first browsers (phones) get no popups; a laptop or iPad with a trackpad does. */
const hasFinePointer =
  typeof window !== "undefined" && window.matchMedia("(any-pointer: fine)").matches;

/** Whether this client can open page windows at all. Never from a torn-out window itself. */
export const canOpenPageWindows =
  !isChildWindow && (desktopWindows !== undefined || hasFinePointer);

/** Whether a drag past the window edge can tear a page out. Desktop only. */
export const canTearOutByDrag = canOpenPageWindows && desktopWindows !== undefined;

// ── Store ────────────────────────────────────────────────────────────

let pageWindows: readonly PageWindow[] = [];
const listeners = new Set<() => void>();

/** Keeps `current` when `next` says the same thing, so subscribers see a stable array. */
export function reconcilePageWindows(
  current: readonly PageWindow[],
  next: readonly PageWindow[],
): readonly PageWindow[] {
  const same =
    current.length === next.length &&
    current.every((entry, index) => {
      const other = next[index]!;
      return entry.id === other.id && entry.href === other.href && entry.title === other.title;
    });
  return same ? current : next;
}

function setPageWindows(next: readonly PageWindow[]): void {
  const reconciled = reconcilePageWindows(pageWindows, next);
  if (reconciled === pageWindows) return;
  pageWindows = reconciled;
  for (const listener of listeners) listener();
}

/** A desktop window's hash route is already a router href. */
export function toPageWindow(info: DesktopWindowInfo): PageWindow {
  const href = info.path.startsWith("/") ? info.path : `/${info.path}`;
  return { id: info.id, href, title: info.title || describePaneLocation(href) };
}

let desktopSyncStarted = false;

/** Seeds from `list()` and follows `onChanged` for the rest of the session. */
function startDesktopSync(): void {
  if (desktopSyncStarted || !desktopWindows) return;
  desktopSyncStarted = true;
  let changed = false;
  desktopWindows.onChanged((windows) => {
    changed = true;
    setPageWindows(windows.map(toPageWindow));
  });
  void desktopWindows.list().then((windows) => {
    // A change that landed first is newer than this snapshot.
    if (!changed) setPageWindows(windows.map(toPageWindow));
  });
}

function subscribe(listener: () => void): () => void {
  startDesktopSync();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => pageWindows;
const EMPTY: readonly PageWindow[] = [];
const subscribeNothing = () => () => {};
const getEmpty = () => EMPTY;

/** Every open page window, kept current. Empty in a torn-out window's own view of itself. */
export function usePageWindows(): readonly PageWindow[] {
  return useSyncExternalStore(
    isChildWindow ? subscribeNothing : subscribe,
    isChildWindow ? getEmpty : getSnapshot,
    getEmpty,
  );
}

// ── Web popups ───────────────────────────────────────────────────────

export const PAGE_WINDOWS_CHANNEL = "pathway-page-windows";

/** What a popup in window mode tells the tab that opened it. */
export type PageWindowMessage =
  | { readonly type: "state"; readonly id: string; readonly href: string; readonly title: string }
  | { readonly type: "closed"; readonly id: string };

/** Popups this tab opened. Kept past a "closed" message, since a reload also sends one. */
const popupHandles = new Map<string, Window>();
let channel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(PAGE_WINDOWS_CHANNEL);
  return channel;
}

/** Applies a popup's message to the list; messages for popups this tab did not open are ignored. */
export function applyPageWindowMessage(
  windows: readonly PageWindow[],
  message: PageWindowMessage,
  isOwnPopup: (id: string) => boolean,
): readonly PageWindow[] {
  if (!isOwnPopup(message.id)) return windows;
  if (message.type === "closed") return windows.filter((entry) => entry.id !== message.id);
  const next = { id: message.id, href: message.href, title: message.title };
  return windows.some((entry) => entry.id === message.id)
    ? windows.map((entry) => (entry.id === message.id ? next : entry))
    : [...windows, next];
}

let openerListening = false;

function listenAsOpener(): void {
  if (openerListening) return;
  openerListening = true;
  openChannel()?.addEventListener("message", (event: MessageEvent<PageWindowMessage>) => {
    setPageWindows(
      applyPageWindowMessage(pageWindows, event.data, (id) => {
        const handle = popupHandles.get(id);
        return handle !== undefined && !(event.data.type === "state" && handle.closed);
      }),
    );
  });
  // Backstop for a popup that closed without saying so: focus usually returns here.
  window.addEventListener("focus", prunePopups);
}

function prunePopups(): void {
  for (const [id, handle] of popupHandles) {
    if (handle.closed) popupHandles.delete(id);
  }
  setPageWindows(pageWindows.filter((entry) => popupHandles.has(entry.id)));
}

/** Posts a popup's current page or its closing. A no-op outside a web popup. */
export function announcePageWindow(message: PageWindowMessage): void {
  if (desktopWindows) return;
  openChannel()?.postMessage(message);
}

function makeWindowId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Actions ──────────────────────────────────────────────────────────

/**
 * Opens `href` in a new window and resolves whether it opened. `screenPoint`
 * places it near the cursor on desktop, as when a drag ends outside the main
 * window. On web the popup opens synchronously, inside the caller's click.
 */
export async function openPageWindow(
  href: string,
  options?: { readonly screenPoint?: ScreenPoint },
): Promise<boolean> {
  if (!canOpenPageWindows) return false;
  if (desktopWindows) {
    try {
      const result = await desktopWindows.open({
        path: href,
        ...(options?.screenPoint ? { screenPoint: options.screenPoint } : {}),
      });
      if (result.overSoftCap) {
        toastManager.add({
          type: "info",
          title: "That's a lot of windows",
          description: "Panels might be easier to juggle.",
        });
      }
      return true;
    } catch {
      toastManager.add({ type: "error", title: "Couldn't open a new window" });
      return false;
    }
  }

  prunePopups();
  const id = makeWindowId();
  const handle = window.open(
    href,
    `${WEB_CHILD_WINDOW_NAME_PREFIX}${id}`,
    "popup,width=900,height=700",
  );
  if (!handle) {
    toastManager.add({
      type: "warning",
      title: "Your browser blocked the window",
      description: "Allow pop-ups for this site to open pages in their own window.",
    });
    return false;
  }
  listenAsOpener();
  popupHandles.set(id, handle);
  setPageWindows([...pageWindows, { id, href, title: describePaneLocation(href) }]);
  return true;
}

export function closePageWindow(id: string): void {
  if (desktopWindows) {
    void desktopWindows.close(id);
    return;
  }
  popupHandles.get(id)?.close();
  popupHandles.delete(id);
  setPageWindows(pageWindows.filter((entry) => entry.id !== id));
}

export function closeAllPageWindows(): void {
  if (desktopWindows) {
    void desktopWindows.closeAll();
    return;
  }
  for (const handle of popupHandles.values()) handle.close();
  popupHandles.clear();
  setPageWindows([]);
}
