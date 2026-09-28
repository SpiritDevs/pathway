import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { useEnvironments } from "~/state/environments";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  deviceToolSyncRows,
  carryPendingDeviceToolUpdates,
  deviceToolUpdateTargets,
  summarizeDeviceToolUpdates,
  type DeviceToolCell,
  type DeviceToolSyncRow,
  type DeviceToolUpdateOutcome,
} from "../device/deviceToolSync.logic";
import { SettingsRow } from "./settingsLayout";

/** Subscribes to one environment's device state and reports each snapshot to the table. */
function DeviceStateSource({
  environmentId,
  onState,
}: {
  environmentId: EnvironmentId;
  onState: (environmentId: EnvironmentId, state: DeviceServiceState | null) => void;
}) {
  const { state, loaded } = useDeviceState(environmentId);
  useEffect(() => {
    onState(environmentId, loaded ? state : null);
  }, [environmentId, loaded, onState, state]);
  useEffect(() => () => onState(environmentId, null), [environmentId, onState]);
  return null;
}

/** Tool versions for every connected environment side by side, with per-host and bulk updates. */
export function DeviceToolSyncSettings() {
  const { environments } = useEnvironments();
  const supported = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.deviceWorkspace === true,
      ),
    [environments],
  );
  const [states, setStates] = useState<ReadonlyMap<EnvironmentId, DeviceServiceState>>(
    () => new Map(),
  );
  const onState = useCallback((environmentId: EnvironmentId, state: DeviceServiceState | null) => {
    setStates((previous) => {
      if (previous.get(environmentId) === (state ?? undefined)) return previous;
      const next = new Map(previous);
      if (state) next.set(environmentId, state);
      else next.delete(environmentId);
      return next;
    });
  }, []);
  const rows = useMemo(
    () =>
      deviceToolSyncRows(
        supported.flatMap((environment) => {
          const state = states.get(environment.environmentId);
          return state
            ? [{ environmentId: environment.environmentId, label: environment.label, state }]
            : [];
        }),
      ),
    [states, supported],
  );

  const updateTools = useAtomCommand(deviceEnvironment.updateTools, { reportFailure: false });
  const restartTools = useAtomCommand(deviceEnvironment.restartTools, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, DeviceToolUpdateOutcome>>(
    () => new Map(),
  );
  const [checking, setChecking] = useState(false);
  const setOutcome = (key: string, outcome: DeviceToolUpdateOutcome) =>
    setOutcomes((previous) => new Map(previous).set(key, outcome));

  const update = async (
    row: DeviceToolSyncRow<EnvironmentId>,
    command: typeof updateTools = updateTools,
  ) => {
    setOutcome(row.key, { status: "pending" });
    const result = await command({
      environmentId: row.environmentId,
      input: { hostId: row.hostId },
    });
    setOutcome(
      row.key,
      result._tag === "Success"
        ? { status: "success" }
        : { status: "failed", message: formatEnvironmentQueryError(result.cause) },
    );
  };
  const targets = deviceToolUpdateTargets(rows, outcomes);
  const updateAll = () => {
    // A new round reports only its own hosts, but requests still in flight stay pending.
    setOutcomes(carryPendingDeviceToolUpdates);
    void Promise.all(targets.map((row) => update(row)));
  };
  const checkAll = () => {
    setChecking(true);
    void Promise.all(
      supported
        .filter((environment) => states.get(environment.environmentId)?.supportsToolInspection)
        .map((environment) =>
          list({ environmentId: environment.environmentId, input: { inspectOnly: true } }),
        ),
    ).finally(() => setChecking(false));
  };
  const summary = summarizeDeviceToolUpdates(outcomes);
  const multipleReleases = rows.some((row) => row.olderRelease);

  return (
    <SettingsRow
      id="device-tool-sync"
      title="Tool versions across environments"
      description="Each Pathway release pins its Device Hub and agent-device versions and recommends an Xcode and runtimes. Environments sharing devices should match."
      status={summary}
      control={
        <>
          <Button size="sm" variant="outline" disabled={checking} onClick={checkAll}>
            {checking ? "Checking…" : "Check all"}
          </Button>
          <Button size="sm" disabled={targets.length === 0} onClick={updateAll}>
            Update all
          </Button>
        </>
      }
    >
      {supported.map((environment) => (
        <DeviceStateSource
          key={environment.environmentId}
          environmentId={environment.environmentId}
          onState={onState}
        />
      ))}
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          Connect an environment running a version of Pathway that supports devices.
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto py-3">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-1 py-2 font-medium">Environment</th>
                <th className="px-1 py-2 font-medium">Xcode</th>
                <th className="px-1 py-2 font-medium">Runtimes</th>
                <th className="px-1 py-2 font-medium">Device Hub</th>
                <th className="px-1 py-2 font-medium">Agent</th>
                <th className="px-1 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => (
                <DeviceToolSyncTableRow
                  key={row.key}
                  row={row}
                  outcome={outcomes.get(row.key)}
                  onUpdate={() => void update(row)}
                  onRestart={() => void update(row, restartTools)}
                />
              ))}
            </tbody>
          </table>
          {multipleReleases ? (
            <p className="px-1 pt-3 text-xs text-muted-foreground">
              Environments marked “Older release” pin older tools. Update Pathway on those
              environments to match; updating tools there installs that release’s pins.
            </p>
          ) : null}
        </div>
      )}
    </SettingsRow>
  );
}

const HELPER_BADGE = {
  current: { label: "Current", variant: "success" },
  behind: { label: "Update available", variant: "warning" },
  restart: { label: "Restart to apply", variant: "info" },
  unknown: { label: "Not checked", variant: "outline" },
} as const;

function DeviceToolSyncTableRow({
  row,
  outcome,
  onUpdate,
  onRestart,
}: {
  row: DeviceToolSyncRow;
  outcome: DeviceToolUpdateOutcome | undefined;
  onUpdate: () => void;
  onRestart: () => void;
}) {
  const badge = HELPER_BADGE[row.helperState];
  return (
    <tr className="align-top">
      <td className="px-1 py-2">
        <div className="font-medium text-foreground">{row.environmentLabel}</div>
        {row.hostKind === "ssh" ? (
          <div className="text-muted-foreground">{row.hostLabel}</div>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge size="sm" variant={badge.variant}>
            {badge.label}
          </Badge>
          {row.olderRelease ? (
            <Badge size="sm" variant="warning">
              Older release
            </Badge>
          ) : null}
          {row.stale ? (
            <Badge size="sm" variant="outline">
              Cached
            </Badge>
          ) : null}
        </div>
      </td>
      <ToolCell cell={row.columns.xcode} expectedLabel="Recommended" />
      <ToolCell cell={row.columns.runtimes} expectedLabel="Recommended" />
      <ToolCell cell={row.columns.hub} expectedLabel="Pinned" />
      <ToolCell cell={row.columns.agent} expectedLabel="Pinned" />
      <td className="px-1 py-2 text-right">
        {outcome?.status === "pending" ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Spinner className="size-3" />
            {row.canRestart ? "Restarting…" : "Updating…"}
          </span>
        ) : outcome?.status === "success" && !row.canUpdate && !row.canRestart ? (
          <CheckIcon aria-label="Done" className="ml-auto size-4 text-success" />
        ) : row.canUpdate ? (
          <Button size="xs" variant={outcome ? "outline" : "default"} onClick={onUpdate}>
            {outcome?.status === "failed" ? "Retry" : "Update"}
          </Button>
        ) : row.canRestart ? (
          <Button size="xs" variant="outline" onClick={onRestart}>
            {outcome?.status === "failed" ? "Retry" : "Restart"}
          </Button>
        ) : null}
        {outcome?.status === "failed" ? (
          <p role="alert" className="mt-1 max-w-48 text-left text-destructive">
            {outcome.message}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

/** Version text; advisory Xcode and runtime drift reads as a warning, never an error. */
function ToolCell({
  cell,
  expectedLabel,
}: {
  cell: DeviceToolCell;
  expectedLabel: "Pinned" | "Recommended";
}) {
  const drifted = cell.status === "missing" || cell.status === "different";
  return (
    <td className="px-1 py-2">
      <div className={cn("font-mono", drifted ? "text-warning" : "text-foreground")}>
        {cell.actual}
      </div>
      {cell.expected && cell.status !== "match" ? (
        <div className="text-muted-foreground">
          {cell.status === "unknown" ? "Could not check" : `${expectedLabel} ${cell.expected}`}
        </div>
      ) : null}
      {cell.restartRequired ? <div className="text-muted-foreground">Restart to apply</div> : null}
    </td>
  );
}
