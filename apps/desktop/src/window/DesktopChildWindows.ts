import { DESKTOP_CHILD_WINDOW_QUERY_PARAM, type DesktopScreenPoint } from "@spiritdevs/contracts";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

// Pure helpers for torn-out ("child") windows. The registry and Electron wiring
// live in DesktopWindow.ts; everything here is deterministic so it can be unit
// tested without a BrowserWindow.

/** The renderer enters window mode when this query param is present. */
export const CHILD_WINDOW_QUERY_PARAM = DESKTOP_CHILD_WINDOW_QUERY_PARAM;
/** Opening past this many children still works; the renderer is told to warn. */
export const CHILD_WINDOW_SOFT_CAP = 6;
export const DEFAULT_CHILD_WINDOW_SIZE = { width: 900, height: 700 } as const;
const CHILD_WINDOW_CASCADE_OFFSET = 32;
// Puts the cursor over the new window's title bar rather than its corner.
const CHILD_WINDOW_CURSOR_OFFSET = { x: 80, y: 16 } as const;

type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Renderer paths are hash-history routes; anything else is coerced to one. */
export function normalizeChildWindowPath(path: string): string {
  const trimmed = path.trim().replace(/^#/, "");
  if (trimmed.length === 0) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** `<desktopUrl>?pathwayWindow=<id>#<path>`: the query must precede the hash. */
export function buildChildWindowUrl(
  applicationUrl: string,
  windowId: string,
  path: string,
): string {
  const url = new URL(applicationUrl);
  url.searchParams.set(CHILD_WINDOW_QUERY_PARAM, windowId);
  url.hash = normalizeChildWindowPath(path);
  return url.href;
}

/** Reads the current route from a renderer URL (used on did-navigate-in-page). */
export function childWindowPathFromUrl(rendererUrl: string): string | null {
  try {
    const { hash } = new URL(rendererUrl);
    return hash.length > 1 ? normalizeChildWindowPath(hash) : "/";
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampIntoWorkArea(bounds: Rect, workArea: Rect): Rect {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

/**
 * Where a new child window goes: near the cursor for a drag-out, otherwise
 * cascaded off the main window. `null` lets Electron center it.
 */
export function resolveNewChildWindowBounds(input: {
  readonly screenPoint: DesktopScreenPoint | undefined;
  readonly anchorBounds: Rect | null;
  readonly workArea: Rect | null;
}): Rect | null {
  const size = DEFAULT_CHILD_WINDOW_SIZE;
  const origin =
    input.screenPoint !== undefined
      ? {
          x: input.screenPoint.x - CHILD_WINDOW_CURSOR_OFFSET.x,
          y: input.screenPoint.y - CHILD_WINDOW_CURSOR_OFFSET.y,
        }
      : input.anchorBounds !== null
        ? {
            x: input.anchorBounds.x + CHILD_WINDOW_CASCADE_OFFSET,
            y: input.anchorBounds.y + CHILD_WINDOW_CASCADE_OFFSET,
          }
        : null;
  if (origin === null) return null;
  const bounds = { ...origin, ...size };
  return input.workArea === null ? bounds : clampIntoWorkArea(bounds, input.workArea);
}

/** Restored bounds are only reused when they still fit on a connected display. */
export function resolveRestoredChildWindowBounds(
  bounds: DesktopAppSettings.DesktopChildWindowState["bounds"],
  displays: readonly Rect[],
): Rect | null {
  const fits = displays.some(
    (display) =>
      bounds.x >= display.x &&
      bounds.y >= display.y &&
      bounds.x + bounds.width <= display.x + display.width &&
      bounds.y + bounds.height <= display.y + display.height,
  );
  return fits ? bounds : null;
}
