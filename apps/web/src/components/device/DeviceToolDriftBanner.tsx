import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  deviceToolBanner,
  deviceToolOperationSupported,
  unresolvedDeviceToolHosts,
  deviceToolProgressLabel,
  type DeviceToolOperation,
} from "./deviceToolSync.logic";

/** Compact notice when this environment's helpers are behind its release's pins or await a restart. */
export function DeviceToolDriftBanner({
  state,
  environmentId,
}: {
  state: DeviceServiceState;
  environmentId: EnvironmentId;
}) {
  const updateTools = useAtomCommand(deviceEnvironment.updateTools, { reportFailure: false });
  const restartTools = useAtomCommand(deviceEnvironment.restartTools, { reportFailure: false });
  // The request in flight or last failed. It keeps its own operation and hosts, since a new
  // snapshot can switch the banner between update and restart while it runs.
  const [request, setRequest] = useState<{
    operation: DeviceToolOperation;
    hostIds: ReadonlyArray<string>;
    error: string | null;
  } | null>(null);
  const banner = deviceToolBanner(state);
  // A failure stays retryable while one of its own hosts still needs work and the environment
  // supports it. Once they are all current, other hosts' drift gets the banner's fresh action.
  if (
    request?.error != null &&
    (!banner ||
      unresolvedDeviceToolHosts(state, request.hostIds).length === 0 ||
      !deviceToolOperationSupported(state, request.operation))
  ) {
    setRequest(null);
  }
  if (!banner) return null;
  const run = async (operation: DeviceToolOperation, hostIds: ReadonlyArray<string>) => {
    const command = operation === "restart" ? restartTools : updateTools;
    setRequest({ operation, hostIds, error: null });
    const results = await Promise.all(
      hostIds.map((hostId) => command({ environmentId, input: { hostId } })),
    );
    const failure = results.find((result) => result._tag === "Failure");
    setRequest(
      failure?._tag === "Failure"
        ? { operation, hostIds, error: formatEnvironmentQueryError(failure.cause) }
        : null,
    );
  };
  const action =
    banner.kind === "behind" && banner.canUpdate
      ? { operation: "update" as const, label: "Update" }
      : banner.kind === "restart" && banner.canRestart
        ? { operation: "restart" as const, label: "Restart" }
        : null;
  return (
    <div role="status" className="flex items-start gap-3 border-b px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{banner.message}</p>
        {request?.error ? (
          <p role="alert" className="mt-1 text-destructive">
            {request.error}
          </p>
        ) : null}
      </div>
      {request && request.error === null ? (
        <Button size="xs" variant="outline" disabled>
          {deviceToolProgressLabel(request.operation)}
        </Button>
      ) : request ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => void run(request.operation, request.hostIds)}
        >
          Retry
        </Button>
      ) : action ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => void run(action.operation, banner.hostIds)}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
