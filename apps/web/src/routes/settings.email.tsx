import { ConnectedMailSettings } from "../components/email/ConnectedMailSettings";
import { Button } from "../components/ui/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { EmailSettingsEnvironmentList } from "../components/settings/EmailSettingsEnvironmentList";
import { EmailSettingsPanel } from "../components/settings/EmailSettingsPanel";
import { useEnvironments } from "../state/environments";

function SettingsEmailRoute() {
  const { environments } = useEnvironments();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const source = search.source ?? "mail";
  const setSource = (next: "mail" | "capture") => {
    void navigate({ replace: true, search: { source: next } });
  };
  const environment = environments[0] ?? null;
  return (
    <>
      <div className="flex gap-2 px-5 pt-4">
        <Button
          size="sm"
          variant={source === "mail" ? "secondary" : "ghost"}
          onClick={() => setSource("mail")}
        >
          Connected mail
        </Button>
        <Button
          size="sm"
          variant={source === "capture" ? "secondary" : "ghost"}
          onClick={() => setSource("capture")}
        >
          SMTP capture
        </Button>
      </div>
      {source === "mail" ? (
        <ConnectedMailSettings />
      ) : environments.length > 1 || environment === null ? (
        <EmailSettingsEnvironmentList />
      ) : (
        <EmailSettingsPanel environmentId={environment.environmentId} />
      )}
    </>
  );
}

export const Route = createFileRoute("/settings/email")({
  validateSearch: (raw: Record<string, unknown>): { source?: "mail" | "capture" | undefined } => ({
    source: raw.source === "capture" ? "capture" : raw.source === "mail" ? "mail" : undefined,
  }),
  component: SettingsEmailRoute,
});
