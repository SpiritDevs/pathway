import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { DeviceControlLease } from "./useDeviceControlLease";

/** Who controls the device, and the way in or out of control for this viewer. */
export function DeviceControlBar(props: {
  readonly lease: DeviceControlLease;
  readonly threadId: string;
  readonly onOpenThread: (threadId: string) => void;
  /** Called only after the environment acknowledges the release. */
  readonly onResumeAgent?: (() => void) | undefined;
}) {
  const { lease } = props;
  const { view } = lease;
  if (view.kind === "unsupported") return null;
  const status =
    view.kind === "you"
      ? "You're in control."
      : view.kind === "agent"
        ? view.threadId === props.threadId
          ? "This thread's agent is in control. You're watching."
          : "An agent in another thread is in control. You're watching."
        : view.kind === "viewer"
          ? "Someone else is in control. You're watching."
          : view.kind === "draining"
            ? "Finishing the previous controller's input. You're watching."
            : view.kind === "unknown"
              ? "Control status is unavailable. You're watching."
              : "Nobody is in control. You're watching.";
  return (
    <div className="border-b text-xs">
      <div role="status" className="flex items-center gap-2 px-3 py-1.5">
        <p className="min-w-0 flex-1 text-muted-foreground">{status}</p>
        {view.kind === "agent" && view.threadId !== props.threadId ? (
          <Button size="xs" variant="ghost" onClick={() => props.onOpenThread(view.threadId)}>
            Open thread
          </Button>
        ) : null}
        {view.kind === "you" ? (
          <>
            {props.onResumeAgent ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const resume = props.onResumeAgent;
                  // The continuation's device_open needs the lease released and drained first.
                  void lease.release().then((released) => {
                    if (released) resume?.();
                  });
                }}
              >
                Resume agent
              </Button>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => void lease.release()}>
              Release control
            </Button>
          </>
        ) : lease.releasing ? (
          <Button size="xs" variant="outline" disabled>
            Releasing control…
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            // Allowed while draining: acquisition waits for the drain, or reports why it can't.
            disabled={lease.acquiring || view.kind === "unknown"}
            onClick={() => void lease.take()}
          >
            {lease.acquiring ? "Taking control…" : "Take control"}
          </Button>
        )}
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
