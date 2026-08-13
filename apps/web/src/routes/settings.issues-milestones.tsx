import { createFileRoute } from "@tanstack/react-router";

import { MilestonesSettingsPanel } from "../components/settings/issues/MilestonesSettingsPanel";

export const Route = createFileRoute("/settings/issues-milestones")({
  component: MilestonesSettingsPanel,
});
