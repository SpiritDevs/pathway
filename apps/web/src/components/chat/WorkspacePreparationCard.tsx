import { memo, useEffect, useRef, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  LoaderCircleIcon,
  GitBranchIcon,
  XCircleIcon,
  LaptopIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import { workspacePreparationPresentation } from "@spiritdevs/client-runtime/state/turn-item-presentation";
import { useAttachedTerminalSession } from "~/state/terminalSessions";
import { cn } from "~/lib/utils";

type PreparationItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

function SetupOutput({
  item,
  environmentId,
}: {
  item: PreparationItem;
  environmentId: EnvironmentId;
}) {
  const session = useAttachedTerminalSession({
    preview: true,
    environmentId,
    terminal: item.workspacePreparation?.terminalId
      ? {
          threadId: item.threadId,
          terminalId: item.workspacePreparation.terminalId,
          restartIfNotRunning: false,
        }
      : null,
  });
  const outputRef = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  // The terminal buffer is already bounded. Limit the inline preview further and remove terminal controls.
  const output = session.buffer
    .slice(-24_000)
    // eslint-disable-next-line no-control-regex -- Strip OSC sequences from terminal output.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex -- Strip ANSI display controls from terminal output.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  useEffect(() => {
    if (following.current && outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);
  return (
    <>
      {session.error ? (
        <p className="text-xs text-destructive">Setup output is unavailable. {session.error}</p>
      ) : null}
      <pre
        ref={outputRef}
        tabIndex={0}
        aria-label="Setup script output"
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
        className="max-h-52 min-h-20 overflow-auto rounded-lg border border-border/60 bg-background p-3 font-mono text-xs leading-5 text-foreground/80"
      >
        {output || "Waiting for setup output…"}
      </pre>
    </>
  );
}

export const WorkspacePreparationCard = memo(function WorkspacePreparationCard({
  item,
  environmentId,
  onControl,
}: {
  item: PreparationItem;
  environmentId: EnvironmentId;
  onControl?: (action: "cancel" | "work_locally") => Promise<void>;
}) {
  const presentation = workspacePreparationPresentation(item);
  const preparation = item.workspacePreparation;
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<"cancel" | "work_locally" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingAction =
    pending ?? (item.status === "running" ? (preparation?.controlAction ?? null) : null);
  const canControl =
    item.status === "running" && preparation?.workspaceKind === "worktree" && onControl;
  async function control(action: "cancel" | "work_locally") {
    if (pending || !onControl) return;
    setPending(action);
    setError(null);
    try {
      await onControl(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change workspace preparation.");
    } finally {
      setPending(null);
    }
  }
  return (
    <section
      aria-label={presentation.title}
      data-workspace-preparation="true"
      className="my-3 min-w-0 text-sm"
    >
      <div className="mb-3 flex items-center gap-2 text-muted-foreground" role="status">
        <GitBranchIcon className="size-4" aria-hidden />
        <span>{presentation.title}</span>
      </div>
      <div
        className={cn(
          "rounded-xl border border-border/70 p-4",
          presentation.failed && "border-destructive/40",
        )}
      >
        <ol className="space-y-3" aria-label="Workspace setup progress">
          {presentation.steps.map((step) => {
            const Icon =
              step.status === "completed"
                ? CheckCircle2Icon
                : step.status === "failed" || step.status === "stopped"
                  ? XCircleIcon
                  : step.status === "running"
                    ? LoaderCircleIcon
                    : CircleIcon;
            return (
              <li
                key={step.label}
                aria-current={step.status === "running" ? "step" : undefined}
                className={cn(
                  "flex items-start gap-2.5",
                  step.status === "completed" || step.status === "running"
                    ? "text-primary"
                    : step.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    step.status === "running" &&
                      "animate-spin [animation-timing-function:steps(12)] motion-reduce:animate-none",
                  )}
                  aria-hidden
                />
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span>{step.label}</span>
                  {step.status === "running" &&
                  preparation?.phase === "worktree" &&
                  !pendingAction ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <div
                        role="progressbar"
                        aria-label="Checking out files"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={preparation.checkoutPercent}
                        className="h-1 w-16 overflow-hidden rounded-full bg-primary/15 sm:w-24"
                      >
                        <div
                          className={cn(
                            "h-full rounded-full bg-primary",
                            preparation.checkoutPercent === undefined && "opacity-60",
                          )}
                          style={{
                            width:
                              preparation.checkoutPercent === undefined
                                ? "33%"
                                : `${Math.min(100, Math.max(0, preparation.checkoutPercent))}%`,
                          }}
                        />
                      </div>
                      {preparation.checkoutPercent !== undefined ? (
                        <span className="w-7 text-right text-[10px] tabular-nums">
                          {preparation.checkoutPercent}%
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <span className="sr-only">{step.status}</span>
              </li>
            );
          })}
        </ol>
        {presentation.failed || presentation.stopped ? (
          <p className="mt-3 text-xs text-destructive" role="status">
            {item.output || "Workspace preparation stopped before it finished."}
          </p>
        ) : null}
        {presentation.completed && preparation?.terminalId ? (
          <p className="mt-3 text-xs text-muted-foreground">
            The setup script runs in its terminal while the agent starts.
          </p>
        ) : null}
        {canControl ? (
          <div className="float-right mt-3 ml-4 flex flex-wrap justify-end gap-4 text-muted-foreground">
            <button
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void control("work_locally")}
              className="flex items-center gap-2 rounded py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <LaptopIcon className="size-4" aria-hidden />
              {pendingAction === "work_locally" ? "Switching to local…" : "Work locally"}
            </button>
            <button
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void control("cancel")}
              className="flex items-center gap-2 rounded py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <XIcon className="size-4" aria-hidden />
              {pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        ) : null}
        {pendingAction ? (
          <p className="clear-both pt-2 text-xs text-muted-foreground" role="status">
            Waiting for the current operation to stop safely and cleaning up the worktree…
          </p>
        ) : null}
        {error ? (
          <p className="clear-both pt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <details className="group mt-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-4 -rotate-90 group-open:rotate-0" aria-hidden />
            {expanded ? "Less details" : "More details"}
          </summary>
          <div className="clear-both pt-3 space-y-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {preparation?.baseRef ? (
                <>
                  <dt className="text-muted-foreground">Base branch</dt>
                  <dd className="break-all">{preparation.baseRef}</dd>
                </>
              ) : null}
              {preparation?.branch ? (
                <>
                  <dt className="text-muted-foreground">Branch at creation</dt>
                  <dd className="break-all">{preparation.branch}</dd>
                </>
              ) : null}
              {preparation?.cwd ? (
                <>
                  <dt className="text-muted-foreground">
                    {preparation.phase === "worktree" ? "Source folder" : "Workspace"}
                  </dt>
                  <dd className="break-all font-mono">{preparation.cwd}</dd>
                </>
              ) : null}
              {preparation?.scriptName ? (
                <>
                  <dt className="text-muted-foreground">Setup script</dt>
                  <dd>{preparation.scriptName}</dd>
                </>
              ) : null}
            </dl>
            {item.output ? (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.output}</p>
            ) : null}
            {expanded && preparation?.terminalId ? (
              <SetupOutput item={item} environmentId={environmentId} />
            ) : null}
            {!item.output && !preparation?.terminalId ? (
              <p className="text-xs text-muted-foreground">{item.title}</p>
            ) : null}
          </div>
        </details>
      </div>
    </section>
  );
});
