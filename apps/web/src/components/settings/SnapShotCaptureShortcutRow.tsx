import { useAtomValue } from "@effect/atom-react";
import type {
  ClientSettings,
  ClientSettingsPatch,
  DesktopSnapShotShortcutAvailability,
  DesktopSnapShotState,
  SnapShotShortcut,
} from "@spiritdevs/contracts";
import { useEffect, useRef, useState } from "react";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  snapShotCaptureShortcutConflict,
  snapShotCaptureUnavailableMessage,
} from "../../lib/snapShotCapture";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { commandLabel } from "./KeybindingsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

export function SnapShotCaptureShortcutRow({
  type,
  settings,
  state,
  disabled,
  onSave,
}: {
  type: "screen" | "region";
  settings: ClientSettings;
  state: DesktopSnapShotState | null;
  disabled: boolean;
  onSave: (patch: ClientSettingsPatch) => Promise<DesktopSnapShotState | undefined>;
}) {
  const bridge = getDesktopSnapShotBridge();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const saved =
    type === "screen" ? settings.snapShotScreenShortcut : settings.snapShotRegionShortcut;
  const [candidate, setCandidate] = useState<SnapShotShortcut | null>(saved);
  const [availability, setAvailability] = useState<DesktopSnapShotShortcutAvailability | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const checkId = useRef(0);
  const unavailable = snapShotCaptureUnavailableMessage(state, type);
  const changed = candidate !== null && (saved === null || !sameSnapShotShortcut(candidate, saved));
  const keybindingConflict = changed ? snapShotKeybindingConflict(candidate, keybindings) : null;
  const captureConflict = changed
    ? snapShotCaptureShortcutConflict(candidate, settings, type)
    : null;
  const conflict =
    captureConflict ?? (keybindingConflict ? commandLabel(keybindingConflict) : null);

  useEffect(() => {
    checkId.current++;
    setCandidate(saved);
    setAvailability(null);
    setChecking(false);
  }, [saved]);

  const reset = () => {
    checkId.current++;
    setCandidate(saved);
    setAvailability(null);
    setChecking(false);
  };
  const check = async (shortcut: SnapShotShortcut) => {
    const requestId = ++checkId.current;
    setCandidate(shortcut);
    setAvailability(null);
    setChecking(false);
    if (
      !bridge ||
      snapShotKeybindingConflict(shortcut, keybindings) ||
      snapShotCaptureShortcutConflict(shortcut, settings, type)
    )
      return;
    setChecking(true);
    try {
      const result = await bridge.checkSnapShotShortcut(shortcut);
      if (requestId === checkId.current) setAvailability(result);
    } catch (error) {
      if (requestId === checkId.current) {
        setAvailability({
          available: false,
          message: error instanceof Error ? error.message : "Could not check this shortcut.",
        });
      }
    } finally {
      if (requestId === checkId.current) setChecking(false);
    }
  };
  const recorder = useSnapShotShortcutRecorder({
    shortcut: candidate,
    label: type === "screen" ? "current screen capture" : "region capture",
    disabled: disabled || saving || Boolean(unavailable),
    allowModifierPairs: state?.mode !== "portal",
    onStart: () => {
      checkId.current++;
      setAvailability(null);
      setChecking(false);
    },
    onRecord: (shortcut) => void check(shortcut),
    onError: (message) => setAvailability({ available: false, message }),
  });
  const canSave = changed && !conflict && !checking && availability?.available === true;
  const save = async (shortcut: SnapShotShortcut | null) => {
    if (saving || disabled || (unavailable && shortcut !== null)) return;
    recorder.stopRecording();
    setSaving(true);
    try {
      await onSave(
        type === "screen"
          ? { snapShotScreenShortcut: shortcut }
          : { snapShotRegionShortcut: shortcut },
      );
    } finally {
      setSaving(false);
    }
  };
  const registered = state?.captureShortcuts?.[type];
  const status =
    unavailable ??
    (recorder.recording
      ? "Press your shortcut. Esc cancels."
      : conflict
        ? `Pathway already uses this for "${conflict}".`
        : checking
          ? "Checking shortcut…"
          : availability
            ? availability.available
              ? "Ready to save."
              : availability.message
            : saved === null
              ? "No shortcut assigned."
              : registered?.registered
                ? "Shortcut saved."
                : registered?.message);

  return (
    <SettingsRow
      {...searchableSetting(
        type === "screen" ? "snap-shot-screen-shortcut" : "snap-shot-region-shortcut",
      )}
      description={
        type === "screen"
          ? "Capture the entire display containing your pointer, then open the editor."
          : "Drag to capture part of the screen, then open the editor."
      }
      status={status}
      control={
        <>
          {recorder.input}
          {changed ? (
            <>
              <Button
                size="xs"
                disabled={!canSave || saving || disabled}
                onClick={() => void save(candidate)}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving || disabled}
                onClick={() => {
                  recorder.stopRecording();
                  reset();
                }}
              >
                Cancel
              </Button>
            </>
          ) : saved !== null ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={saving || disabled}
              onClick={() => void save(null)}
            >
              Clear
            </Button>
          ) : null}
        </>
      }
    />
  );
}
