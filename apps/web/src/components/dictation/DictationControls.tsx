import { useState, type ReactNode } from "react";
import {
  CheckIcon,
  MicIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type {
  DictationCommand,
  DictationPreferences,
  DictationState,
} from "@spiritdevs/contracts/dictation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { dictationReadiness, formatDuration } from "./dictationUi";

export type DictationActions = {
  state: DictationState;
  execute: (command: DictationCommand) => Promise<DictationState | null>;
  updatePreferences: (patch: Partial<DictationPreferences>) => Promise<DictationState | null>;
};

export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
      items={options}
    >
      <SelectTrigger aria-label={label} className="w-full sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-[13px] leading-relaxed ${error ? "border-destructive/25 bg-destructive/5 text-destructive-foreground" : "border-border/70 bg-muted/25 text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}

export function ConfirmDelete({
  label,
  onConfirm,
  disabled,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => {
          onConfirm();
          setConfirming(false);
        }}
      >
        Confirm {label.toLowerCase()}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirming(true)}>
      {label}
    </Button>
  );
}

export function MicrophoneControls({ state, execute, updatePreferences }: DictationActions) {
  const { microphoneId } = state.preferences;
  const microphones = [
    { value: "default", label: "System default" },
    ...state.microphones
      .filter((device) => device.id !== "default")
      .map((device) => ({ value: device.id, label: device.name })),
  ];
  if (!microphones.some((device) => device.value === microphoneId))
    microphones.push({ value: microphoneId, label: "Disconnected microphone" });
  const testing =
    state.mode === "test" && (state.phase === "recording" || state.phase === "starting");
  const busy = ["starting", "recording", "processing"].includes(state.phase);
  const canTest =
    state.supported &&
    state.authenticated &&
    state.nativeAvailable &&
    state.microphonePermission === "granted" &&
    state.models.some(
      (model) => model.id === state.preferences.speechModel && model.status === "installed",
    ) &&
    (microphoneId === "default" || state.microphones.some((device) => device.id === microphoneId));
  return (
    <SettingsSection
      title="Microphone"
      icon={<MicIcon className="size-4" />}
      id="dictation-microphone"
    >
      <SettingsRow
        title="Input device"
        description="Follow your system input or choose a microphone for dictation."
        control={
          <>
            <Choice
              label="Microphone"
              value={microphoneId}
              options={microphones}
              disabled={busy}
              onChange={(value) => void updatePreferences({ microphoneId: value })}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh microphones"
              onClick={() => void execute({ type: "refresh-devices" })}
            >
              <RefreshCwIcon />
            </Button>
          </>
        }
      />
      <SettingsRow
        title="Test your microphone"
        description="Record a short phrase and review it here. A test never inserts text or changes your clipboard."
        control={
          testing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void execute({ type: "cancel" })}>
                <XIcon />
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={state.phase === "starting"}
                onClick={() => void execute({ type: "stop" })}
              >
                <SquareIcon />
                Finish test
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canTest || busy}
              onClick={() => void execute({ type: "start", mode: "test" })}
            >
              <MicIcon />
              {state.mode === "test" && state.phase === "processing"
                ? "Transcribing…"
                : "Test microphone"}
            </Button>
          )
        }
      >
        {testing && (
          <div className="my-3 flex items-center gap-4 rounded-lg bg-muted/40 p-3">
            <span className="size-2 rounded-full bg-red-500" />
            <span className="text-xs tabular-nums">
              {state.phase === "starting"
                ? "Opening microphone…"
                : formatDuration(state.durationMs)}
            </span>
            <meter
              aria-label="Microphone input level"
              value={state.level}
              min={0}
              max={1}
              className="h-2 flex-1"
            />
            <span className="text-xs text-muted-foreground">Listening</span>
          </div>
        )}
        {state.result?.delivery === "test" && state.phase === "result" && (
          <div className="my-3 space-y-2 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Test transcript</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss test transcript"
                onClick={() => void execute({ type: "dismiss" })}
              >
                <XIcon />
              </Button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{state.result.text}</p>
            {state.result.cleanup === "unavailable" && (
              <p className="text-xs text-muted-foreground">
                Cleanup unavailable. This is the recognized text.
              </p>
            )}
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

export function ShortcutControls({ state, updatePreferences }: DictationActions) {
  const options: { value: DictationPreferences["shortcut"]; label: string }[] = [
    ...(state.platform === "darwin" ? [{ value: "fn" as const, label: "Fn / Globe" }] : []),
    { value: "right-control", label: "Right Control" },
    { value: "right-option", label: state.platform === "darwin" ? "Right Option" : "Right Alt" },
    { value: "F8", label: "F8" },
  ];
  if (!options.some((option) => option.value === state.preferences.shortcut))
    options.push({ value: state.preferences.shortcut, label: state.preferences.shortcut });
  return (
    <SettingsSection title="Recording shortcut" id="dictation-shortcut">
      <SettingsRow
        title="Shortcut"
        description="Hold to record and release to finish. Double-tap for locked recording, then tap once to finish. Escape cancels."
        control={
          <Choice
            label="Dictation shortcut"
            value={state.preferences.shortcut}
            options={options}
            onChange={(shortcut) => void updatePreferences({ shortcut })}
          />
        }
      />
    </SettingsSection>
  );
}

export function PermissionControls({ state, execute }: DictationActions) {
  const permissionStatus = (status: string) => (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${status === "granted" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
    >
      {status === "granted" && <CheckIcon className="size-3.5" />}
      {status === "granted"
        ? "Allowed"
        : status === "denied"
          ? "Access denied"
          : "Needs permission"}
    </span>
  );
  return (
    <SettingsSection
      title="Permissions"
      icon={<ShieldCheckIcon className="size-4" />}
      id="dictation-permissions"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void execute({ type: "permissions", action: "refresh" })}
        >
          Check permissions
        </Button>
      }
    >
      <SettingsRow
        title="Microphone access"
        description="Capture your voice only when you record or run a microphone test."
        control={
          state.microphonePermission === "granted" ? (
            permissionStatus(state.microphonePermission)
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void execute({ type: "permissions", action: "microphone" })}
            >
              Allow microphone
            </Button>
          )
        }
      />
      {state.platform === "darwin" && (
        <SettingsRow
          title="Accessibility access"
          description="Listen for your shortcut and insert text into the field you are using."
          control={
            state.accessibilityPermission === "granted" ? (
              permissionStatus(state.accessibilityPermission)
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void execute({ type: "permissions", action: "accessibility" })}
              >
                Allow accessibility
              </Button>
            )
          }
        />
      )}
      {(state.microphonePermission === "denied" || state.accessibilityPermission === "denied") && (
        <div className="px-4">
          <Notice>
            Allow Pathway in{" "}
            {state.platform === "darwin"
              ? "System Settings → Privacy & Security"
              : "Windows Settings → Privacy & security"}
            , then check permissions again.
          </Notice>
        </div>
      )}
    </SettingsSection>
  );
}

export function ReadinessNotice({ state }: { state: DictationState }) {
  const reasons = dictationReadiness(state);
  if (!reasons.length) return null;
  return (
    <Notice>
      <p className="mb-1 font-medium text-foreground">Before you record</p>
      <ul className="list-disc space-y-1 pl-4">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </Notice>
  );
}
