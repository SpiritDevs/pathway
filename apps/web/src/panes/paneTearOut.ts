/**
 * Tearing a page out by dragging it past the window's edge (desktop only). A
 * pane's pill label is the handle; the rail's own drag reports here too.
 */
import type { PointerEvent as ReactPointerEvent } from "react";

import { canTearOutByDrag } from "./pageWindows";
import { popOutPane } from "./paneActions";

type Point = { readonly x: number; readonly y: number };

/** Whether a pointer at `point` (viewport coordinates) is past the window's edge. */
export function isOutsideViewport(
  point: Point,
  viewport: { readonly width: number; readonly height: number },
): boolean {
  return point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height;
}

/**
 * Where the cursor is on screen, in the units the desktop shell places windows
 * in. The bridge is authoritative; `fallback` covers a failed call.
 */
export async function readCursorScreenPoint(fallback: Point): Promise<Point> {
  const windows = window.desktopBridge?.windows;
  if (!windows) return fallback;
  return windows.getCursorScreenPoint().catch(() => fallback);
}

/**
 * Pointer-down on a pane pill's label. Releasing past the window's edge opens the
 * pane in its own window there; releasing inside does nothing. Inert where
 * drag-out is unsupported.
 */
export function startPaneTearOut(event: ReactPointerEvent<HTMLElement>, paneId: string): void {
  if (!canTearOutByDrag || event.button !== 0) return;
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  document.body.style.setProperty("cursor", "grabbing");

  const onEnd = (endEvent: PointerEvent) => {
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    document.body.style.removeProperty("cursor");
    if (endEvent.type !== "pointerup") return;
    const released = { x: endEvent.clientX, y: endEvent.clientY };
    if (!isOutsideViewport(released, { width: window.innerWidth, height: window.innerHeight })) {
      return;
    }
    void readCursorScreenPoint({ x: endEvent.screenX, y: endEvent.screenY }).then((screenPoint) =>
      popOutPane(paneId, { screenPoint }),
    );
  };
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
}
