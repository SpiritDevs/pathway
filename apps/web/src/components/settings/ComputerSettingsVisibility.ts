import { useComputerStateStore } from "../../computerStateStore";
import { useEnvironments } from "../../state/environments";
import { environmentSupportsComputer } from "./ComputerSettingsPanel.logic";

/**
 * Whether any connected environment could ever drive a desktop, so Settings
 * offers the Computer section. The same answer as `useComputerSupport`, taken
 * across environments: server platform, plus a status only if one was fetched.
 */
export function useComputerSettingsVisible(): boolean {
  const { environments } = useEnvironments();
  const statusByEnvironment = useComputerStateStore((state) => state.statusByEnvironment);
  return environments.some((environment) =>
    environmentSupportsComputer(
      environment.descriptor?.platform.os,
      statusByEnvironment[environment.environmentId],
    ),
  );
}
