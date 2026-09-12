import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@spiritdevs/contracts";
import { expect, it } from "vite-plus/test";
import {
  snapShotCaptureShortcutConflict,
  snapShotCaptureUnavailableMessage,
} from "./snapShotCapture";

const state: DesktopSnapShotState = {
  mode: "direct",
  shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
  shortcutRegistered: true,
  shortcutMessage: null,
  message: null,
};

it("keeps older bridges window-only and respects advertised capture modes", () => {
  expect(snapShotCaptureUnavailableMessage(state, "window")).toBeUndefined();
  expect(snapShotCaptureUnavailableMessage(state, "screen")).toContain("Update");
  expect(snapShotCaptureUnavailableMessage({ ...state, mode: "portal" }, "region")).toContain(
    "aren't available",
  );
  expect(
    snapShotCaptureUnavailableMessage(
      { ...state, captureTypes: ["window", "screen", "region"] },
      "region",
    ),
  ).toBeUndefined();
  expect(
    snapShotCaptureUnavailableMessage(
      { ...state, mode: "unavailable", message: "Wayland is required." },
      "window",
    ),
  ).toBe("Wayland is required.");
});

it("rejects another capture's modifier pair while allowing its own binding", () => {
  const shortcut = { kind: "modifier-pair", modifier: "shift" } as const;
  expect(
    snapShotCaptureShortcutConflict(shortcut, DEFAULT_CLIENT_SETTINGS, "screen", "MacIntel"),
  ).toBe("Capture active window");
  expect(
    snapShotCaptureShortcutConflict(shortcut, DEFAULT_CLIENT_SETTINGS, "window", "MacIntel"),
  ).toBeNull();
});

it("matches platform-equivalent chords across capture actions and ignores cleared bindings", () => {
  const chord = {
    key: "r",
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
  };
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotRegionShortcut: chord };
  expect(
    snapShotCaptureShortcutConflict(
      { ...chord, modKey: false, metaKey: true },
      settings,
      "screen",
      "MacIntel",
    ),
  ).toBe("Capture region");
  expect(
    snapShotCaptureShortcutConflict(
      chord,
      { ...settings, snapShotRegionShortcut: null },
      "screen",
      "MacIntel",
    ),
  ).toBeNull();
});
