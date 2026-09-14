import type { PendingBackgroundWorkTask } from "@spiritdevs/shared/orchestrationV2PendingBackgroundWork";
import { ChevronDownIcon, SquareIcon } from "lucide-react";
import { useId, useState } from "react";

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
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (tasks.length === 0) return null;

  const label = tasks[0]?.description ?? "Background task";
  const explanation = temporary
    ? "Keep this conversation before stopping and settling its background work."
    : canStop
      ? "Stops all thread work, cancels queued messages, and moves this thread to Settled. Reopen it to continue."
      : "Update the connected environment to stop background work here.";

  return (
    <section aria-label="Background work" className="border-t border-border/65">
      <h3 className="px-3.5 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
        Background work
      </h3>
      <div className="flex min-w-0 items-center gap-1 px-2 pb-2 text-xs">
        <span className="min-w-0 flex-1 truncate pl-1.5" title={label}>
          {label}
        </span>
        {tasks.length > 1 ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">+{tasks.length - 1}</span>
        ) : null}
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          aria-label={stopping ? "Stopping work…" : "Stop work and settle"}
          title={`${stopping ? "Stopping work…" : "Stop work and settle"}. ${explanation}`}
          disabled={!canStop || stopping || temporary}
          onClick={onStop}
        >
          <SquareIcon className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={expanded ? "Hide background work details" : "Show background work details"}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDownIcon
            className={expanded ? "size-3.5 rotate-180" : "size-3.5"}
            aria-hidden="true"
          />
        </button>
      </div>
      <div id={detailsId} hidden={!expanded} className="px-3.5 pb-2.5">
        <ul className="max-h-40 space-y-2 overflow-y-auto text-xs">
          {tasks.map((task) => (
            <li key={task.taskId} className="break-words">
              {task.description ?? "Background task"}
            </li>
          ))}
        </ul>
        <p className="pt-2 text-[11px] text-muted-foreground">{explanation}</p>
      </div>
    </section>
  );
}
