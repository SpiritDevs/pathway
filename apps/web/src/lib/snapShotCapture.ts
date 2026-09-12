import type { ClientSettings, DesktopSnapShotState, SnapShotShortcut } from "@spiritdevs/contracts";
import { sameSnapShotShortcut } from "./snapShotShortcut";

export const SNAP_SHOT_CAPTURE_ACTIONS = [
  { type: "window", title: "Capture active window", setting: "snapShotShortcut" },
  { type: "screen", title: "Capture current screen", setting: "snapShotScreenShortcut" },
  { type: "region", title: "Capture region", setting: "snapShotRegionShortcut" },
] as const;

export type SnapShotCaptureMode = (typeof SNAP_SHOT_CAPTURE_ACTIONS)[number]["type"];

/** Older desktop bridges only know how to capture a window. */
export function snapShotCaptureUnavailableMessage(
  state: DesktopSnapShotState | null,
  type: SnapShotCaptureMode,
): string | undefined {
  if (!state) return "Checking capture support…";
  if (state.mode === "unavailable")
    return state.message ?? "Capture is unavailable on this desktop.";
  if ((state.captureTypes ?? ["window"]).includes(type)) return undefined;
  return state.mode === "portal"
    ? "Screen and region capture aren't available on this desktop yet."
    : "Update the desktop app to use screen and region capture.";
}

export function snapShotCaptureShortcutConflict(
  shortcut: SnapShotShortcut,
  settings: Pick<
    ClientSettings,
    "snapShotShortcut" | "snapShotScreenShortcut" | "snapShotRegionShortcut"
  >,
  except: SnapShotCaptureMode,
  platform = navigator.platform,
): string | null {
  const conflict = SNAP_SHOT_CAPTURE_ACTIONS.find((action) => {
    const saved = settings[action.setting];
    return (
      action.type !== except && saved !== null && sameSnapShotShortcut(shortcut, saved, platform)
    );
  });
  return conflict?.title ?? null;
}
