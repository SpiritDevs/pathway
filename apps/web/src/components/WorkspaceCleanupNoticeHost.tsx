import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2WorkspaceCleanupNotice } from "@spiritdevs/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { retryWorkspaceCleanup, workspaceCleanupNotices } from "../state/workspaceCleanup";
import { Button } from "./ui/button";

export function WorkspaceCleanupNotice({
  environmentId,
  environmentLabel,
  connected,
  notice,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  connected: boolean;
  notice: OrchestrationV2WorkspaceCleanupNotice;
}) {
  const retry = useAtomCommand(retryWorkspaceCleanup, { reportFailure: false });
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retryCleanup = async () => {
    if (!connected || retrying) return;
    setRetrying(true);
    setRetryError(null);
    const result = await retry({ environmentId, input: { effectId: notice.effectId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setRetryError(error instanceof Error ? error.message : "Could not retry cleanup.");
    }
    setRetrying(false);
  };

  return (
    <section className="pointer-events-auto rounded-lg border border-warning/40 bg-popover p-3 text-popover-foreground shadow-lg">
      <div className="flex items-start gap-2">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">Workspace cleanup needs attention</p>
          <p className="break-words text-xs font-medium">
            {notice.title} · {environmentLabel}
          </p>
          <p className="break-words text-xs text-muted-foreground">{notice.message}</p>
          <p className="text-xs text-muted-foreground">
            {!connected
              ? "Reconnect this environment to check cleanup and retry."
              : notice.nextAttemptAt === null
                ? "Cleanup is pending. The environment retries automatically."
                : `Next automatic retry: ${new Date(notice.nextAttemptAt).toLocaleTimeString()}.`}
          </p>
          {retryError ? (
            <p role="alert" className="text-xs text-destructive">
              {retryError}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || retrying}
          aria-label={`Retry cleanup for ${notice.title} on ${environmentLabel}`}
          onClick={() => void retryCleanup()}
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </section>
  );
}

export function EnvironmentWorkspaceCleanupNotices({
  environmentId,
  environmentLabel,
  connected,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  connected: boolean;
}) {
  const query = useEnvironmentQuery(
    connected ? workspaceCleanupNotices({ environmentId, input: {} }) : null,
  );
  const [lastNotices, setLastNotices] = useState<readonly OrchestrationV2WorkspaceCleanupNotice[]>(
    [],
  );
  useEffect(() => {
    if (query.data !== null) setLastNotices(query.data);
  }, [query.data]);
  // A disconnect is not evidence that the environment finished deleting its files.
  const notices = query.data ?? lastNotices;
  return notices.map((notice) => (
    <WorkspaceCleanupNotice
      key={notice.effectId}
      environmentId={environmentId}
      environmentLabel={environmentLabel}
      connected={connected}
      notice={notice}
    />
  ));
}

export function WorkspaceCleanupNoticeHost() {
  const { environments } = useEnvironments();
  return (
    <aside
      aria-label="Workspace cleanup"
      aria-live="polite"
      className="pointer-events-none fixed right-3 bottom-3 z-50 max-h-[45vh] w-[min(28rem,calc(100vw-1.5rem))] space-y-2 overflow-y-auto"
    >
      {environments
        .filter((environment) => environment.descriptor?.capabilities.threadConversations === true)
        .map((environment) => (
          <EnvironmentWorkspaceCleanupNotices
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
            connected={environment.connection.phase === "connected"}
          />
        ))}
    </aside>
  );
}
