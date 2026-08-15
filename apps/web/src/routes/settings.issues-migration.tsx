import { createFileRoute } from "@tanstack/react-router";

import { MigrationSettingsPanel } from "../components/settings/issues/MigrationSettingsPanel";

export const Route = createFileRoute("/settings/issues-migration")({
  component: MigrationSettingsPanel,
});
