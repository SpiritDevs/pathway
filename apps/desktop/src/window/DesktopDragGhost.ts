/**
 * The drag ghost: what a tear-out drag looks like once the cursor leaves every
 * Pathway window. A page can only draw inside its own window, so the shell
 * draws a copy of the renderer's drag chip in a small click-through window and
 * moves it with the cursor until the drag ends.
 *
 * One ghost at a time; a new drag replaces the last.
 */
import type { DesktopDragGhost } from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Electron from "electron";

/** Room around the chip for its shadow. */
export const DRAG_GHOST_MARGIN = 12;
/** About one frame at 60 Hz: the ghost trails the cursor by no more than that. */
const FOLLOW_INTERVAL = Duration.millis(16);

interface ActiveGhost {
  readonly window: Electron.BrowserWindow;
  readonly spec: DesktopDragGhost;
  readonly follow: Fiber.Fiber<unknown>;
}

let active: ActiveGhost | null = null;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A CSS value from the renderer, kept only if it cannot close the declaration it sits in. */
function cssValue(value: string, fallback: string): string {
  return /^[^;{}<>]*$/.test(value) && value.trim().length > 0 ? value : fallback;
}

/**
 * The ghost's page: the chip alone on a transparent background. The window runs
 * no script, so the icon markup can only draw.
 */
export function buildDragGhostHtml(ghost: DesktopDragGhost): string {
  const icon = ghost.iconSvg.trimStart().startsWith("<svg") ? ghost.iconSvg : "";
  const chipStyle = [
    `width:${Math.max(0, ghost.width)}px`,
    `height:${Math.max(0, ghost.height)}px`,
    `background:${cssValue(ghost.background, "#ffffff")}`,
    `color:${cssValue(ghost.foreground, "#111111")}`,
    `border:1px solid ${cssValue(ghost.border, "rgba(0,0,0,0.12)")}`,
    `font-family:${cssValue(ghost.fontFamily, "system-ui, sans-serif")}`,
    `font-size:${cssValue(ghost.fontSize, "14px")}`,
  ].join(";");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:grabbing}
.chip{box-sizing:border-box;margin:${DRAG_GHOST_MARGIN}px;display:inline-flex;align-items:center;gap:8px;padding:0 10px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.18);white-space:nowrap;overflow:hidden}
.chip svg{width:16px;height:16px;flex:none}
</style></head><body><div class="chip" style="${escapeHtml(chipStyle)}">${icon}<span>${escapeHtml(ghost.label)}</span></div></body></html>`;
}

/** Where the ghost window goes so the chip keeps its grip on the cursor. */
export function dragGhostPosition(
  cursor: { readonly x: number; readonly y: number },
  ghost: Pick<DesktopDragGhost, "offsetX" | "offsetY">,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(cursor.x - ghost.offsetX - DRAG_GHOST_MARGIN),
    y: Math.round(cursor.y - ghost.offsetY - DRAG_GHOST_MARGIN),
  };
}

function moveToCursor(ghost: ActiveGhost): void {
  if (ghost.window.isDestroyed() || !ghost.window.isVisible()) return;
  const position = dragGhostPosition(Electron.screen.getCursorScreenPoint(), ghost.spec);
  ghost.window.setPosition(position.x, position.y, false);
}

export function startDragGhost(spec: DesktopDragGhost, platform: NodeJS.Platform): void {
  stopDragGhost();
  const window = new Electron.BrowserWindow({
    width: Math.ceil(spec.width) + DRAG_GHOST_MARGIN * 2,
    height: Math.ceil(spec.height) + DRAG_GHOST_MARGIN * 2,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Above other apps' windows, and never in the way of the drop underneath.
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.setIgnoreMouseEvents(true);
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildDragGhostHtml(spec))}`,
  );
  let ghost: ActiveGhost | null = null;
  const follow = Effect.runFork(
    Effect.sync(() => {
      if (ghost !== null && active === ghost) moveToCursor(ghost);
    }).pipe(Effect.repeat(Schedule.spaced(FOLLOW_INTERVAL))),
  );
  ghost = { window, spec, follow };
  active = ghost;
}

export function setDragGhostVisible(visible: boolean): void {
  const ghost = active;
  if (!ghost || ghost.window.isDestroyed()) return;
  if (visible) {
    const position = dragGhostPosition(Electron.screen.getCursorScreenPoint(), ghost.spec);
    ghost.window.setPosition(position.x, position.y, false);
    ghost.window.showInactive();
  } else {
    ghost.window.hide();
  }
}

export function stopDragGhost(): void {
  const ghost = active;
  active = null;
  if (!ghost) return;
  Effect.runFork(Fiber.interrupt(ghost.follow));
  if (!ghost.window.isDestroyed()) ghost.window.destroy();
}
