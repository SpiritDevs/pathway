import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2TurnItem,
  RunId,
} from "@spiritdevs/contracts";
import { useId, useState } from "react";
import { ChevronDownIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface ThreadBackgroundServicesProps {
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  enabled: boolean;
  onOpenOutput: (taskId: string) => void;
  onStop: (runId: RunId, taskId: string) => Promise<void>;
}

/** Provider commands use their captured output; interactive terminals live in Terminals. */
export function ThreadBackgroundServices({
  tasks,
  turnItems,
  enabled,
  onStop,
  onOpenOutput,
}: ThreadBackgroundServicesProps) {
  const disclosureId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  if (tasks.length === 0) return null;

  const stop = async (runId: RunId, taskId: string) => {
    setStopping((current) => new Set(current).add(taskId));
    setErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await onStop(runId, taskId);
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [taskId]: cause instanceof Error ? cause.message : "Failed to stop background service.",
      }));
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  };

  return (
    <section aria-label="Background services" className="border-t border-border/65 px-3.5 py-3">
      <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">
        Background services · {tasks.length}
      </h3>
      <div className="space-y-0.5">
        {tasks.map((task, index) => {
          const item = turnItems.find(
            (candidate) => (candidate.nativeItemRef?.nativeId ?? candidate.id) === task.taskId,
          );
          const command = item?.type === "command_execution" ? item : undefined;
          const runId = command?.runId;
          const canStop = runId != null && command?.nativeItemRef?.driver === "codex";
          const label = task.description ?? task.taskType ?? "Background task";
          const stopResult =
            item === undefined
              ? undefined
              : turnItems.find(
                  (candidate) =>
                    candidate.type === "run_interrupt_result" && candidate.parentItemId === item.id,
                );
          const isStopping = stopping.has(task.taskId) || stopResult?.status === "running";
          const isExpanded = expanded.has(task.taskId);
          const failureMessage =
            errors[task.taskId] ??
            (stopResult?.type === "run_interrupt_result" && stopResult.status === "failed"
              ? stopResult.message
              : null);
          const failed = failureMessage !== null;
          const status = isStopping
            ? "Stopping…"
            : failed
              ? "Stop failed"
              : item?.status === "pending"
                ? "Pending"
                : "Running";
          const controlsId = `${disclosureId}-${index}`;
          return (
            <div key={task.taskId} className="min-w-0 text-xs">
              <div className={cn("flex gap-1", isExpanded ? "items-start" : "items-center")}>
                <span
                  role="status"
                  aria-label={status}
                  title={status}
                  className={cn(
                    "mt-2 size-1.5 shrink-0 rounded-full",
                    !isExpanded && "mt-0",
                    failed ? "bg-destructive" : isStopping ? "bg-warning" : "bg-success",
                  )}
                />
                <p
                  className={cn("min-w-0 flex-1 py-1", isExpanded ? "break-all" : "truncate")}
                  title={label}
                >
                  {label}
                </p>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!enabled || !canStop || isStopping}
                  data-keep-action-card-open
                  aria-label={`Stop ${label}`}
                  title={
                    canStop
                      ? "Stop this background command"
                      : "This provider does not support stopping this task individually"
                  }
                  onClick={() => {
                    if (runId != null) void stop(runId, task.taskId);
                  }}
                >
                  Stop
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-keep-action-card-open
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
                  aria-expanded={isExpanded}
                  aria-controls={controlsId}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(task.taskId)) next.delete(task.taskId);
                      else next.add(task.taskId);
                      return next;
                    })
                  }
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn("size-3.5", isExpanded && "rotate-180")}
                  />
                </Button>
              </div>
              {isExpanded ? (
                <div id={controlsId} className="pb-2 pl-2.5">
                  <p className="text-[11px] text-muted-foreground">{status}</p>
                  {failed ? (
                    <p role="alert" className="mt-1 text-destructive">
                      {failureMessage}
                    </p>
                  ) : null}
                  {command ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="mt-1 -ml-2"
                      data-keep-action-card-open
                      onClick={() => onOpenOutput(task.taskId)}
                    >
                      <PanelRightOpenIcon aria-hidden="true" /> Open output
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
