import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { deviceToolBanner } from "./deviceToolSync.logic";

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banner = deviceToolBanner(state);
  if (!banner) return null;
  const run = async (command: typeof updateTools, hostIds: ReadonlyArray<string>) => {
    setPending(true);
    setError(null);
    try {
      const results = await Promise.all(
        hostIds.map((hostId) => command({ environmentId, input: { hostId } })),
      );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure?._tag === "Failure") setError(formatEnvironmentQueryError(failure.cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div role="status" className="flex items-start gap-3 border-b px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{banner.message}</p>
        {error ? (
          <p role="alert" className="mt-1 text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {banner.kind === "behind" && banner.canUpdate ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => void run(updateTools, banner.hostIds)}
        >
          {pending ? "Updating…" : error ? "Retry" : "Update"}
        </Button>
      ) : null}
      {banner.kind === "restart" && banner.canRestart ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => void run(restartTools, banner.hostIds)}
        >
          {pending ? "Restarting…" : error ? "Retry" : "Restart"}
        </Button>
      ) : null}
    </div>
  );
}
