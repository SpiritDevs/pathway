import type { DeviceSummary, EnvironmentId } from "@spiritdevs/contracts";
import { useEffect, useMemo, useState } from "react";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { createDeviceInputQueue } from "./deviceInputQueue";

/**
 * Watch Crown/buttons and TV remote presses through `device.input` on the
 * selected environment. Disabling (hidden panel, lost input socket) drops
 * anything unsent rather than replaying it later. Mount keyed by device.
 */
export function useDeviceInput(options: {
  environmentId: EnvironmentId;
  device: Pick<DeviceSummary, "hostId" | "id">;
  enabled: boolean;
}) {
  const { environmentId, enabled } = options;
  const { hostId, id: deviceId } = options.device;
  const send = useAtomCommand(deviceEnvironment.input, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const queue = useMemo(
    () =>
      createDeviceInputQueue({
        send: (input) =>
          send({ environmentId, input: { hostId, deviceId, input } }).then((result) => {
            setError(result._tag === "Success" ? null : formatEnvironmentQueryError(result.cause));
            return result._tag === "Success";
          }),
        requestFrame: (callback) => {
          const frame = requestAnimationFrame(callback);
          return () => cancelAnimationFrame(frame);
        },
      }),
    [deviceId, environmentId, hostId, send],
  );
  useEffect(() => {
    if (!enabled) queue.cancel();
    return queue.cancel;
  }, [enabled, queue]);
  return { queue, enabled, error, clearError: () => setError(null) };
}

export type DeviceInputControls = ReturnType<typeof useDeviceInput>;
