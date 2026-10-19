import type { EnvironmentId } from "@spiritdevs/contracts";

import {
  useComputerEnvironmentEvents,
  useComputerEnvironmentLifetime,
  useComputerEventBridge,
} from "~/hooks/useComputerEventBridge";
import { useComputerEventsServed } from "~/hooks/useComputerSupport";
import { useEnvironments } from "~/state/environments";

function ComputerEnvironmentEventBridge({ environmentId }: { environmentId: EnvironmentId }) {
  useComputerEnvironmentEvents(environmentId);
  return null;
}

/**
 * Subscribes only once the environment's server is known to serve Computer
 * events. Mounted per catalog environment, so it owns the environment's
 * Computer state: closing the pipe keeps the status that closed it.
 */
function ComputerEnvironmentEventGate({ environmentId }: { environmentId: EnvironmentId }) {
  useComputerEnvironmentLifetime(environmentId);
  return useComputerEventsServed(environmentId) ? (
    <ComputerEnvironmentEventBridge environmentId={environmentId} />
  ) : null;
}

/** Mounted once at the app root: one computer event pipe per capable catalog environment. */
export function ComputerEventBridges() {
  useComputerEventBridge();
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <ComputerEnvironmentEventGate
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}
