import { useState } from "react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceHostsSettings } from "./DeviceHostsSettings";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";
import { DeviceSetup } from "../device/DeviceSetup";

export function DeviceSettings() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary;
  const environment = environments.find((value) => value.environmentId === environmentId);
  const available =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.deviceWorkspace === true;
  return (
    <SettingsSection title="Devices">
      <label className="mb-4 flex items-center gap-3 text-sm">
        Environment
        <select
          className="rounded-md border bg-background px-2 py-1.5"
          value={environmentId ?? ""}
          onChange={(event) =>
            setSelected(
              environments.find((value) => value.environmentId === event.target.value)
                ?.environmentId ?? null,
            )
          }
        >
          {!environmentId ? <option value="">Choose an environment</option> : null}
          {environments.map((value) => (
            <option key={value.environmentId} value={value.environmentId}>
              {value.label}
            </option>
          ))}
        </select>
      </label>
      {available && environmentId ? (
        <ConnectedDeviceSettings key={environmentId} environmentId={environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect an environment running a version of Pathway that supports devices.
        </p>
      )}
    </SettingsSection>
  );
}

function ConnectedDeviceSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { state, loaded, error, refresh } = useDeviceState(environmentId);
  const configure = useAtomCommand(deviceEnvironment.configure);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = async (input: { enabled?: boolean; agentAccessEnabled?: boolean }) => {
    setBusy(true);
    try {
      await configure({ environmentId, input });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button onClick={refresh} size="sm" variant="outline">
            Retry
          </Button>
        </p>
      ) : null}
      <SettingsRow
        id="device-support"
        title="Device support"
        description="Install and run device tools only when enabled. Disabling stops Pathway’s device helpers."
        control={
          <Switch
            aria-label="Device support"
            checked={state.hostStatus !== "disabled"}
            disabled={!loaded || busy}
            onCheckedChange={(enabled) =>
              void update({ enabled, ...(!enabled ? { agentAccessEnabled: false } : {}) })
            }
          />
        }
      />
      <SettingsRow
        id="agent-device-access"
        title="Agent device access"
        description="Allow agents to open and control devices. Turning this off revokes access for current sessions too."
        control={
          <Switch
            aria-label="Agent device access"
            checked={state.agentAccessEnabled}
            disabled={!loaded || busy || state.hostStatus === "disabled"}
            onCheckedChange={(agentAccessEnabled) => void update({ agentAccessEnabled })}
          />
        }
      />
      {state.hostStatusDetail ? (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          {state.hostStatusDetail}
        </p>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => setSetup(true)}>
        Device setup
      </Button>
      <DeviceHostsSettings environmentId={environmentId} />
      <Dialog open={setup} onOpenChange={setSetup}>
        <WizardPopup>
          <DeviceSetup
            environmentId={environmentId}
            state={state}
            onComplete={() => setSetup(false)}
          />
        </WizardPopup>
      </Dialog>
    </>
  );
}
