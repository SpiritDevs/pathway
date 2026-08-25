import type { EnvironmentId } from "@spiritdevs/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { EmailSettingsPanel } from "../components/settings/EmailSettingsPanel";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useEnvironments } from "../state/environments";

function SettingsEmailEnvironmentRoute() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const { environments, isReady } = useEnvironments();
  const environmentId = rawEnvironmentId as EnvironmentId;
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;

  if (environment === null) {
    return (
      <SettingsPageContainer className="max-w-3xl">
        <SettingsSection title="Email capture">
          <SettingsRow
            description={
              isReady
                ? "Return to Capture and choose an available environment."
                : "Reading connected environments."
            }
            title={isReady ? "Environment unavailable" : "Loading environment"}
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <EmailSettingsPanel environmentId={environment.environmentId} />;
}

// Escaped from the index route so the selected environment's settings replace the list.
export const Route = createFileRoute("/settings/email_/$environmentId")({
  component: SettingsEmailEnvironmentRoute,
});
