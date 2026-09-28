/**
 * Keeps a tear-out drag visible outside the window (desktop only). A page can
 * only draw inside its own window, so once the cursor leaves it the desktop
 * shell shows a copy of the drag chip that follows the cursor. Inside the
 * window the page's own chip does the job and the copy hides.
 */
import type { DesktopDragGhost } from "@spiritdevs/contracts";

type Point = { readonly x: number; readonly y: number };

const desktopWindows = typeof window === "undefined" ? undefined : window.desktopBridge?.windows;

/** Room the ghost adds either side of a label that has no chip of its own. */
const LABEL_PADDING = 10;

/**
 * Describes `content` as the shell should draw it: its icon and text, with the
 * colors of `surface` (the chip it sits on). Sizes are in the shell's units, so
 * page zoom is folded in.
 */
export function describeDragGhost(
  content: HTMLElement,
  pointer: Point,
  surface: HTMLElement = content,
  zoom = readPageZoom(),
): DesktopDragGhost {
  const contentRect = content.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const padding = surface === content ? 0 : LABEL_PADDING;
  const width = contentRect.width + padding * 2;
  const height = surfaceRect.height;
  const left = contentRect.left - padding;
  return {
    label: content.textContent?.trim() ?? "",
    iconSvg: content.querySelector("svg")?.outerHTML ?? "",
    width: width * zoom,
    height: height * zoom,
    offsetX: clamp(pointer.x - left, 0, width) * zoom,
    offsetY: clamp(pointer.y - surfaceRect.top, 0, height) * zoom,
    background: style.backgroundColor,
    foreground: style.color,
    border: style.borderTopColor,
    fontFamily: style.fontFamily,
    fontSize: `${Number.parseFloat(style.fontSize) * zoom}px`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** CSS pixels to window pixels: the shell sizes windows in the latter. */
function readPageZoom(): number {
  const zoom = window.outerWidth / window.innerWidth;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

let started = false;
let visible = false;

/** Prepares the ghost for this drag, once, from the chip the page is drawing. */
export function prepareDragGhost(ghost: () => DesktopDragGhost): void {
  if (!desktopWindows || started) return;
  started = true;
  void desktopWindows.startDragGhost(ghost()).catch(() => undefined);
}

/** Shows the ghost while the pointer is outside the window. Only a change is sent. */
export function setDragGhostOutside(outside: boolean): void {
  if (!desktopWindows || !started || visible === outside) return;
  visible = outside;
  void desktopWindows.setDragGhostVisible(outside).catch(() => undefined);
}

export function endDragGhost(): void {
  if (!desktopWindows || !started) return;
  started = false;
  visible = false;
  void desktopWindows.stopDragGhost().catch(() => undefined);
}
