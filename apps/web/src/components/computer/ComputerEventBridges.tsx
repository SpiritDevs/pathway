import type { EnvironmentId } from "@spiritdevs/contracts";

import {
  useComputerEnvironmentEvents,
  useComputerEventBridge,
} from "~/hooks/useComputerEventBridge";
import { useEnvironments } from "~/state/environments";

function ComputerEnvironmentEventBridge({ environmentId }: { environmentId: EnvironmentId }) {
  useComputerEnvironmentEvents(environmentId);
  return null;
}

/** Mounted once at the app root: one computer event pipe per catalog environment. */
export function ComputerEventBridges() {
  useComputerEventBridge();
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <ComputerEnvironmentEventBridge
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}
