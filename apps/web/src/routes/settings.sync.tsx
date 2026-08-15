import { createFileRoute } from "@tanstack/react-router";

import { SyncSettingsPanel } from "../components/settings/company/SyncSettingsPanel";

export const Route = createFileRoute("/settings/sync")({
  component: SyncSettingsPanel,
});
