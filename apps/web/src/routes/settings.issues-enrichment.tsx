import { createFileRoute } from "@tanstack/react-router";

import { EnrichmentSettingsPanel } from "../components/settings/issues/EnrichmentSettingsPanel";

export const Route = createFileRoute("/settings/issues-enrichment")({
  component: EnrichmentSettingsPanel,
});
