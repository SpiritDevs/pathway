import type { EnvironmentId } from "@spiritdevs/contracts";

import {
  useComputerEnvironmentEvents,
  useComputerEventBridge,
} from "~/hooks/useComputerEventBridge";
import { useComputerEventsServed } from "~/hooks/useComputerSupport";
import { useEnvironments } from "~/state/environments";

function ComputerEnvironmentEventBridge({ environmentId }: { environmentId: EnvironmentId }) {
  useComputerEnvironmentEvents(environmentId);
  return null;
}

/** Subscribes only once the environment's server is known to serve Computer events. */
function ComputerEnvironmentEventGate({ environmentId }: { environmentId: EnvironmentId }) {
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
