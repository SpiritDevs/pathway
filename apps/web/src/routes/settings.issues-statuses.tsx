import { createFileRoute } from "@tanstack/react-router";

import { StatusesSettingsPanel } from "../components/settings/issues/StatusesSettingsPanel";

export const Route = createFileRoute("/settings/issues-statuses")({
  component: StatusesSettingsPanel,
});
