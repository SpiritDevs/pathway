import type { PendingBackgroundWorkTask } from "@spiritdevs/shared/orchestrationV2PendingBackgroundWork";
import { SquareIcon } from "lucide-react";

export function BackgroundWorkSection({
  tasks,
  canStop,
  stopping,
  temporary = false,
  onStop,
}: {
  tasks: readonly PendingBackgroundWorkTask[];
  canStop: boolean;
  stopping: boolean;
  temporary?: boolean;
  onStop: () => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <section aria-label="Background work" className="border-t border-border/65">
      <h3 className="px-3.5 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
        Background work
      </h3>
      <ul className="max-h-40 space-y-2 overflow-y-auto px-3.5 py-2 text-xs">
        {tasks.map((task) => {
          const label = task.description ?? "Background task";
          return (
            <li key={task.taskId} className="break-words" title={label}>
              {label}
            </li>
          );
        })}
      </ul>
      <div className="px-2 pb-2.5">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          disabled={!canStop || stopping || temporary}
          onClick={onStop}
        >
          <SquareIcon className="size-4 shrink-0" aria-hidden="true" />
          {stopping ? "Stopping work…" : "Stop work and settle"}
        </button>
        <p className="px-1.5 pt-1 text-[11px] text-muted-foreground">
          {temporary
            ? "Keep this conversation before stopping and settling its background work."
            : canStop
              ? "Stops all thread work, cancels queued messages, and moves this thread to Settled. Reopen it to continue."
              : "Update the connected environment to stop background work here."}
        </p>
      </div>
    </section>
  );
}
