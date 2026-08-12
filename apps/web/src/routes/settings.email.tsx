import { createFileRoute } from "@tanstack/react-router";

import { EmailSettingsPanel } from "../components/settings/EmailSettingsPanel";

export const Route = createFileRoute("/settings/email")({
  component: EmailSettingsPanel,
});
