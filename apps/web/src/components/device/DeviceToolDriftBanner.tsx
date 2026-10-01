import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { deviceControlFence, deviceStillFenced, type DeviceControlFence } from "./deviceControl";
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
    fence: DeviceControlFence | null;
  } | null>(null);
  const banner = deviceToolBanner(state);
  // A failure that fenced a device stays retryable until that device recovers, whatever the drift.
  const fenced =
    request?.fence != null &&
    deviceStillFenced(state, request.fence) &&
    deviceToolOperationSupported(state, "restart");
  // Other failures stay retryable while one of their own hosts still needs work and the
  // environment supports it. Once they are all current, other drift gets the banner's action.
  if (
    request?.error != null &&
    !fenced &&
    (!banner ||
      unresolvedDeviceToolHosts(state, request.hostIds).length === 0 ||
      !deviceToolOperationSupported(state, request.operation))
  ) {
    setRequest(null);
  }
  if (!banner && !request) return null;
  const run = async (operation: DeviceToolOperation, hostIds: ReadonlyArray<string>) => {
    const command = operation === "restart" ? restartTools : updateTools;
    setRequest({ operation, hostIds, error: null, fence: null });
    const results = await Promise.all(
      hostIds.map((hostId) => command({ environmentId, input: { hostId } })),
    );
    const failure = results.find((result) => result._tag === "Failure");
    setRequest(
      failure?._tag === "Failure"
        ? {
            operation,
            hostIds,
            error: formatEnvironmentQueryError(failure.cause),
            fence: deviceControlFence(failure.cause),
          }
        : null,
    );
  };
  const action = !banner
    ? null
    : banner.kind === "behind" && banner.canUpdate
      ? { operation: "update" as const, label: "Update", hostIds: banner.hostIds }
      : banner.kind === "restart" && banner.canRestart
        ? { operation: "restart" as const, label: "Restart", hostIds: banner.hostIds }
        : null;
  return (
    <div role="status" className="flex items-start gap-3 border-b px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        {banner ? <p className="text-muted-foreground">{banner.message}</p> : null}
        {request?.error ? (
          <p role="alert" className={banner ? "mt-1 text-destructive" : "text-destructive"}>
            {request.error}
          </p>
        ) : null}
      </div>
      {request && request.error === null ? (
        <Button size="xs" variant="outline" disabled>
          {deviceToolProgressLabel(request.operation)}
        </Button>
      ) : request ? (
        <>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void run(request.operation, request.hostIds)}
          >
            Retry
          </Button>
          {request.fence ? (
            // A fenced device's failure outlives the drift, so it needs its own way out.
            <Button size="xs" variant="ghost" onClick={() => setRequest(null)}>
              Dismiss
            </Button>
          ) : null}
        </>
      ) : action ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => void run(action.operation, action.hostIds)}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
