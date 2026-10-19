import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentConnectionSettings } from "../components/settings/ConnectionsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function AppEnvironmentsPanel() {
  return (
    <SettingsPageContainer>
      <EnvironmentConnectionSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/environments")({
  component: AppEnvironmentsPanel,
});
