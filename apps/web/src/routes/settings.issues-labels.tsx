import { createFileRoute } from "@tanstack/react-router";

import { LabelsSettingsPanel } from "../components/settings/issues/LabelsSettingsPanel";

export const Route = createFileRoute("/settings/issues-labels")({
  component: LabelsSettingsPanel,
});
