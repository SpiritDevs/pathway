import { createFileRoute } from "@tanstack/react-router";

import { EmailSettingsEnvironmentList } from "../components/settings/EmailSettingsEnvironmentList";
import { EmailSettingsPanel } from "../components/settings/EmailSettingsPanel";
import { useEnvironments } from "../state/environments";

function SettingsEmailRoute() {
  const { environments } = useEnvironments();
  const environment = environments[0] ?? null;

  if (environments.length > 1 || environment === null) {
    return <EmailSettingsEnvironmentList />;
  }

  return <EmailSettingsPanel environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/email")({
  component: SettingsEmailRoute,
});
