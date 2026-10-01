import type { ReleaseTarget } from "@spiritdevs/contracts/releases";
import { useState } from "react";

import { useAppleAccountsClient, useAppleCloudQuery } from "~/cloud/appleAccounts";
import { appleReleaseFunctions } from "~/cloud/appleReleases";
import { Switch } from "../ui/switch";
import { describeReleaseFailure } from "./Releases.logic";

export const PUBLISHING_DESCRIPTION =
  "Lets Pathway upload builds and submit them to TestFlight and App Review for this app. Each upload or submission still waits for you to confirm it. This sends your app to Apple and can make it available to testers.";

/** Read the app's Cloud publishing setting. Off until a person turns it on. */
export function useReleasePublishing(target: ReleaseTarget | null) {
  const client = useAppleAccountsClient();
  return useAppleCloudQuery(client, appleReleaseFunctions.settings, target);
}

/** The per-app publishing switch. Only a signed-in member who manages the Apple account can flip it. */
export function ReleasePublishingToggle({
  target,
  appName,
}: {
  target: ReleaseTarget;
  appName: string;
}) {
  const client = useAppleAccountsClient();
  const settings = useReleasePublishing(target);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.data?.enabled ?? false;
  const change = async (next: boolean) => {
    if (!client || !settings.data || pending) return;
    setPending(true);
    setError(null);
    try {
      await client.mutation(appleReleaseFunctions.setEnabled, {
        ...target,
        enabled: next,
        expectedRevision: settings.data.revision,
      });
    } catch (cause) {
      setError(describeReleaseFailure(cause, "Publishing was not changed."));
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {enabled ? "Publishing on" : "Publishing off"}
        </span>
        <Switch
          aria-label={`Allow publishing ${appName} to App Store Connect`}
          checked={enabled}
          disabled={!settings.data || pending}
          onCheckedChange={(next) => void change(next)}
        />
      </span>
      {error || settings.error ? (
        <span role="alert" className="text-xs text-destructive">
          {error ??
            describeReleaseFailure(settings.error, "Could not read the publishing setting.")}
        </span>
      ) : null}
    </span>
  );
}
