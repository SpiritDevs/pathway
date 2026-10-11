import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { DeviceControlLease } from "./useDeviceControlLease";
import type { DeviceControlModeState } from "./useDeviceControlMode";

/** Who controls the device: the viewer or this thread's agent, with a switch between them. */
export function DeviceControlBar(props: {
  readonly lease: DeviceControlLease;
  readonly control: DeviceControlModeState;
  readonly threadId: string;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { lease, control } = props;
  const { view } = lease;
  if (view.kind === "unsupported") return null;
  const status =
    view.kind === "you"
      ? control.agentTurn
        ? "You're in control. The agent waits until you hand it back."
        : "You're in control. Agent idle."
      : view.kind === "agent"
        ? view.threadId === props.threadId
          ? "Agent in control."
          : "An agent in another thread is in control."
        : view.kind === "viewer"
          ? "Someone else is in control."
          : view.kind === "draining"
            ? "Finishing the previous controller's input."
            : view.kind === "unknown"
              ? "Control status is unavailable."
              : control.agentTurn
                ? "Agent working."
                : "Taking control…";
  const switching = lease.acquiring || lease.releasing;
  return (
    <div className="border-b text-xs">
      <div role="status" className="flex items-center gap-2 px-3 py-1.5">
        <p className="min-w-0 flex-1 text-muted-foreground">{status}</p>
        {view.kind === "agent" && view.threadId !== props.threadId ? (
          <Button size="xs" variant="ghost" onClick={() => props.onOpenThread(view.threadId)}>
            Open thread
          </Button>
        ) : null}
        <div
          role="group"
          aria-label="Device control"
          className="inline-flex shrink-0 rounded-md border p-0.5"
        >
          <Button
            size="xs"
            variant={control.mode === "you" ? "secondary" : "ghost"}
            aria-pressed={control.mode === "you"}
            // Allowed while draining: acquisition waits for the drain, or reports why it can't.
            disabled={switching || view.kind === "unknown"}
            onClick={() => {
              if (control.mode !== "you") control.chooseYou();
            }}
          >
            You
          </Button>
          <Button
            size="xs"
            variant={control.mode === "agent" ? "secondary" : "ghost"}
            aria-pressed={control.mode === "agent"}
            disabled={switching || control.mode !== "you" || !control.canChooseAgent}
            onClick={() => void control.chooseAgent()}
          >
            Agent
          </Button>
        </div>
      </div>
      {lease.error ? (
        <div role="alert" className="flex items-start gap-2 px-3 pb-1.5 text-destructive">
          <p className="min-w-0 flex-1">{lease.error}</p>
          {lease.canRecover ? (
            <Button
              size="xs"
              variant="outline"
              disabled={lease.recovering}
              onClick={() => void lease.recover()}
            >
              {lease.recovering ? "Restarting device tools…" : "Restart device tools"}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss device control error"
            onClick={lease.dismissError}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
