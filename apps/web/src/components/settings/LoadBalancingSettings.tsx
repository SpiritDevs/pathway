import type { EnvironmentId } from "@spiritdevs/contracts";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const preferences = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

export function LoadBalancingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const settings = useClientSettings();
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const needsAnotherMachine = environments.length < 2;

  return (
    <SettingsSection id="load-balancing" title="Load balancing">
      {needsAnotherMachine ? (
        <p className="text-sm text-muted-foreground">
          Connect another machine with the same project to balance new threads.
        </p>
      ) : null}
      {!needsAnotherMachine || settings.loadBalancingEnabled ? (
        <SettingsRow
          title="Auto balance new threads"
          description="Choose a connected machine with available CPU and memory. Uses a matching provider and model on that machine. Preferences apply to this client."
          control={
            <Switch
              aria-label="Auto balance new threads"
              checked={settings.loadBalancingEnabled}
              disabled={!hydrated}
              onCheckedChange={(checked) => updateSettings({ loadBalancingEnabled: checked })}
            />
          }
        />
      ) : null}
      {!needsAnotherMachine && settings.loadBalancingEnabled
        ? environments.map((environment) => (
            <SettingsRow
              key={environment.environmentId}
              title={environment.label}
              control={
                <Select
                  value={settings.loadBalancingWeights[environment.environmentId] ?? 50}
                  disabled={!hydrated}
                  onValueChange={(value) => {
                    if (
                      value === null ||
                      !preferences.some((preference) => preference.value === value)
                    )
                      return;
                    updateSettings({
                      loadBalancingWeights: {
                        ...settings.loadBalancingWeights,
                        [environment.environmentId]: value,
                      },
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={`Load balancing preference for ${environment.label}`}
                    className="w-36"
                  >
                    <SelectValue>
                      {preferences.find(
                        (preference) =>
                          preference.value ===
                          (settings.loadBalancingWeights[environment.environmentId] ?? 50),
                      )?.label ?? "Custom"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {preferences.map((preference) => (
                      <SelectItem key={preference.value} value={preference.value}>
                        {preference.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ))
        : null}
    </SettingsSection>
  );
}
