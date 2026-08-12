import { createFileRoute } from "@tanstack/react-router";

import { IntakeSettingsPanel } from "../components/settings/issues/IntakeSettingsPanel";

export const Route = createFileRoute("/settings/issues-intake")({
  component: IntakeSettingsPanel,
});
