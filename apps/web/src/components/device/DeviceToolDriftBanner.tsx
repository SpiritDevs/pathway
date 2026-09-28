import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  deviceToolBanner,
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
  // Remembers which request is in flight or failed, since a new snapshot can switch the banner kind.
  const [pending, setPending] = useState<DeviceToolOperation | null>(null);
  const [error, setError] = useState<{ operation: DeviceToolOperation; message: string } | null>(
    null,
  );
  const banner = deviceToolBanner(state);
  if (!banner) return null;
  const run = async (operation: DeviceToolOperation, hostIds: ReadonlyArray<string>) => {
    const command = operation === "restart" ? restartTools : updateTools;
    setPending(operation);
    setError(null);
    try {
      const results = await Promise.all(
        hostIds.map((hostId) => command({ environmentId, input: { hostId } })),
      );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure?._tag === "Failure")
        setError({ operation, message: formatEnvironmentQueryError(failure.cause) });
    } finally {
      setPending(null);
    }
  };
  return (
    <div role="status" className="flex items-start gap-3 border-b px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{banner.message}</p>
        {error ? (
          <p role="alert" className="mt-1 text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>
      {banner.kind === "behind" && banner.canUpdate ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void run("update", banner.hostIds)}
        >
          {pending === "update"
            ? deviceToolProgressLabel(pending)
            : error?.operation === "update"
              ? "Retry"
              : "Update"}
        </Button>
      ) : null}
      {banner.kind === "restart" && banner.canRestart ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void run("restart", banner.hostIds)}
        >
          {pending === "restart"
            ? deviceToolProgressLabel(pending)
            : error?.operation === "restart"
              ? "Retry"
              : "Restart"}
        </Button>
      ) : null}
    </div>
  );
}
