import type { WorkflowRecordingStatus } from "@spiritdevs/contracts";
import { CheckIcon, CircleIcon, SparklesIcon, XIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";

import type { WorkflowRecordingController } from "~/hooks/useWorkflowRecording";
import { Button } from "../ui/button";

// Failed recordings the user dismissed. Module scope so switching threads and
// back does not resurrect the notice this session.
const dismissedFailures = new Set<string>();

const failureKey = (status: WorkflowRecordingStatus) =>
  status.recordingId ?? `${status.phase}:${status.endedAt ?? ""}`;

const elapsedLabel = (startedAt: string | undefined) => {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

interface StripView {
  readonly message: string;
  readonly actions?: ReactNode;
  readonly icon?: "live" | "done" | "skill";
}

/**
 * One-line strip atop the composer for Record a skill: confirmation pending,
 * live recording with Stop and Cancel, then the hand-off into a skill prompt.
 * Only status crosses the wire; the recorded files stay on the environment.
 */
export const ComposerWorkflowRecordingStrip = memo(function ComposerWorkflowRecordingStrip({
  recording,
  targetName,
  promptAdded,
  onCreateSkill,
  onDiscard,
}: {
  recording: WorkflowRecordingController;
  /** The machine being recorded, never the device showing this UI. */
  targetName: string;
  /** Whether the draft already holds this recording's skill prompt. */
  promptAdded: boolean;
  onCreateSkill: (status: WorkflowRecordingStatus) => void;
  /** Deletes a completed recording and takes its prompt back out of the draft. */
  onDiscard: () => void;
}) {
  const { status, error, pending } = recording;
  const [, rerender] = useState(0);
  const busy = pending !== null;
  // Only the elapsed label changes each second, so only this strip re-renders for it.
  const ticking = status?.phase === "recording" && status.startedAt !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => rerender((value) => value + 1), 1_000);
    return () => clearInterval(interval);
  }, [ticking]);

  const cancelButton = (
    <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={recording.cancel}>
      Cancel
    </Button>
  );

  const view = ((): StripView | null => {
    if (!status) return null;
    switch (status.phase) {
      case "awaiting-confirmation":
        return {
          icon: "live",
          message: `Confirm on ${targetName} to start recording. Nothing is recorded until you do.`,
          actions: cancelButton,
        };
      case "recording": {
        const elapsed = elapsedLabel(status.startedAt);
        const steps = status.eventCount === 1 ? "1 step" : `${status.eventCount} steps`;
        return {
          icon: "live",
          message: `Recording on ${targetName}${elapsed ? ` · ${elapsed}` : ""} · ${steps}`,
          actions: (
            <>
              {cancelButton}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={recording.stop}
              >
                Stop
              </Button>
            </>
          ),
        };
      }
      case "stopping":
        return { icon: "live", message: `Saving the recording on ${targetName}…` };
      case "busy":
        return {
          message: `Another thread is recording on ${targetName}. You can record here once it ends.`,
        };
      case "completed": {
        const discard = (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={onDiscard}
            title={
              promptAdded
                ? "Delete this recording and remove its prompt from your draft"
                : "Delete this recording"
            }
          >
            Discard
          </Button>
        );
        if (promptAdded) {
          return {
            icon: "done",
            message: "Prompt added. Send it to create the skill.",
            actions: discard,
          };
        }
        return {
          icon: "skill",
          message:
            status.endReason === "time-limit"
              ? "Recording reached 30 minutes and was saved. Turn it into a skill?"
              : status.endReason === "size-limit"
                ? "Recording reached its size limit and was saved. Turn it into a skill?"
                : "Recording saved. Turn it into a skill?",
          actions: (
            <>
              {discard}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || !status.skillPrompt}
                onClick={() => onCreateSkill(status)}
              >
                <SparklesIcon />
                Create skill
              </Button>
            </>
          ),
        };
      }
      case "failed":
        if (dismissedFailures.has(failureKey(status))) return null;
        return {
          message: status.message ?? "Recording stopped unexpectedly. Nothing was saved.",
          actions: (
            <IconButton
              label="Dismiss"
              onClick={() => {
                dismissedFailures.add(failureKey(status));
                rerender((value) => value + 1);
              }}
            >
              <XIcon />
            </IconButton>
          ),
        };
      default:
        return null;
    }
  })();

  // A failed read or command keeps the known controls, so Stop stays reachable.
  if (error) {
    return (
      <Strip
        icon={view?.icon}
        tone="error"
        message={error}
        actions={
          <>
            {view?.actions}
            <IconButton label="Dismiss" onClick={recording.clearError}>
              <XIcon />
            </IconButton>
          </>
        }
      />
    );
  }
  if (!view) return null;
  return (
    <Strip
      icon={view.icon}
      tone={status?.phase === "failed" ? "error" : "default"}
      message={view.message}
      actions={view.actions}
    />
  );
});

function Strip({
  message,
  actions,
  icon = "skill",
  tone,
}: {
  message: string;
  actions?: ReactNode;
  icon?: StripView["icon"];
  tone: "default" | "error";
}) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 sm:px-5"
      data-testid="composer-workflow-recording"
      role="status"
    >
      {icon === "live" ? (
        <CircleIcon aria-hidden="true" className="size-2.5 shrink-0 fill-red-500 text-red-500" />
      ) : icon === "done" ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span
        className={
          tone === "error"
            ? "min-w-0 flex-1 truncate text-xs text-destructive"
            : "min-w-0 flex-1 truncate text-xs text-muted-foreground"
        }
        title={message}
      >
        {message}
      </span>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
