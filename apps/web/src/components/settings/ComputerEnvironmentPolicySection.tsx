// Who may drive this environment's desktop (ADR 0041) and how much oversight
// Computer tasks get (ADR 0042–0043). Both are server settings on the selected
// environment, and only an admin connection (`access:write`) may change them:
// they grant, or loosen control over, the host's logged-in desktop session.

import type { ComputerAccessPolicy, ComputerAutonomy, EnvironmentId } from "@spiritdevs/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@spiritdevs/contracts/settings";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  COMPUTER_ACCESS_POLICY_OPTIONS,
  COMPUTER_AUTONOMY_OPTIONS,
  computerAutonomyReducesOversight,
  computerPolicyOption,
  type ComputerPolicyOption,
  type ComputerScopeAccess,
} from "./ComputerSettingsPanel.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectComputerSettings = (settings: typeof DEFAULT_UNIFIED_SETTINGS) => settings.computer;

function PolicySelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly ComputerPolicyOption<T>[];
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger aria-label={label} className="w-44">
        <SelectValue>{computerPolicyOption(options, value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ComputerEnvironmentPolicySection({
  environmentId,
  writeAccess,
}: {
  readonly environmentId: EnvironmentId;
  readonly writeAccess: ComputerScopeAccess;
}) {
  const computer = useEnvironmentSettings(environmentId, selectComputerSettings);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const defaults = DEFAULT_UNIFIED_SETTINGS.computer;
  // An older server would decode the patch as empty and report success.
  const serverConfig = useServerConfigs().get(environmentId);
  const serverTooOld =
    serverConfig !== undefined && serverConfig.environment.capabilities.computerPolicy !== true;
  const readOnly = writeAccess !== "granted" || serverConfig === undefined || serverTooOld;
  const accessPolicy = computerPolicyOption(COMPUTER_ACCESS_POLICY_OPTIONS, computer.accessPolicy);
  const autonomy = computerPolicyOption(COMPUTER_AUTONOMY_OPTIONS, computer.autonomy);
  const setAccessPolicy = (accessPolicy: ComputerAccessPolicy) =>
    updateSettings({ computer: { accessPolicy } });
  const setAutonomy = (autonomy: ComputerAutonomy) => updateSettings({ computer: { autonomy } });

  return (
    <SettingsSection title="Access and oversight">
      {serverTooOld ? (
        <p className="@xl/settings:px-4 px-3 text-xs text-muted-foreground">
          Update this environment's Pathway server to change these settings.
        </p>
      ) : writeAccess === "denied" ? (
        <p className="@xl/settings:px-4 px-3 text-xs text-muted-foreground">
          Only an admin connection (access:write) can change these settings.
        </p>
      ) : null}
      <SettingsRow
        {...searchableSetting("computer-access-policy")}
        description={`${accessPolicy?.description ?? ""} Under every policy, anyone who can operate a thread can watch the preview, answer approvals, and press Stop.`}
        resetAction={
          !readOnly && computer.accessPolicy !== defaults.accessPolicy ? (
            <SettingResetButton
              label="computer access"
              onClick={() => setAccessPolicy(defaults.accessPolicy)}
            />
          ) : null
        }
        control={
          <PolicySelect
            label="Who can use this computer"
            value={computer.accessPolicy}
            options={COMPUTER_ACCESS_POLICY_OPTIONS}
            disabled={readOnly}
            onChange={setAccessPolicy}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("computer-autonomy")}
        description={`${autonomy?.description ?? ""} Each chat's mode can be stricter, never looser. The app denylist (password managers, Keychain Access, Passwords, System Settings, SecurityAgent), Stop and physical Escape, and the local action log always apply.`}
        status={
          computerAutonomyReducesOversight(computer.autonomy)
            ? "Reduced oversight: Computer tasks on this environment run without approvals."
            : undefined
        }
        resetAction={
          !readOnly && computer.autonomy !== defaults.autonomy ? (
            <SettingResetButton
              label="computer autonomy"
              onClick={() => setAutonomy(defaults.autonomy)}
            />
          ) : null
        }
        control={
          <PolicySelect
            label="Computer autonomy"
            value={computer.autonomy}
            options={COMPUTER_AUTONOMY_OPTIONS}
            disabled={readOnly}
            onChange={setAutonomy}
          />
        }
      />
    </SettingsSection>
  );
}
