import type { OrchestrationV2TurnItem } from "@spiritdevs/contracts";

export function BackgroundServiceOutput({ item }: { item: OrchestrationV2TurnItem | undefined }) {
  if (item?.type !== "command_execution") {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Output is no longer available for this service.
      </p>
    );
  }
  return (
    <section
      aria-label="Background service output"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Background service output</h2>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.input}</p>
        <p className="mt-2 text-xs capitalize text-muted-foreground">
          {item.status}
          {item.exitCode === undefined ? "" : ` · Exit ${item.exitCode}`}
        </p>
      </header>
      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        role="region"
        aria-label="Service output"
        tabIndex={0}
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {item.output || "No output has been reported yet."}
        </pre>
      </div>
    </section>
  );
}
