import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/integrations/IntegrationsSettingsPanel";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettingsPanel,
});
