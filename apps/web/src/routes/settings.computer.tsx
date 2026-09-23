import { createFileRoute } from "@tanstack/react-router";

import { ComputerSettingsPanel } from "../components/settings/ComputerSettingsPanel";

function SettingsComputerRoute() {
  return <ComputerSettingsPanel />;
}

export const Route = createFileRoute("/settings/computer")({
  component: SettingsComputerRoute,
});
