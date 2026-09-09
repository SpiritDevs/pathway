import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type StoragePressure } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hostStoragePressure } from "../lib/storagePresentation";

const measurementsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get) =>
    environmentKey
      .split("\n")
      .filter(Boolean)
      .map((id) => {
        const environmentId = EnvironmentId.make(id);
        return {
          environmentId,
          result: get(serverEnvironment.hostResources({ environmentId, input: {} })),
        };
      }),
  ),
);

interface Reading {
  pressure: StoragePressure;
  sampledAt: number;
}
const readingKey = (account: string, environmentId: string) =>
  `pathway:storage-reading:${account}:${environmentId}`;
function readCachedReading(account: string | null, environmentId: string): Reading | null {
  if (!account) return null;
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(readingKey(account, environmentId)) ?? "null",
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "pressure" in value &&
      "sampledAt" in value &&
      (value.pressure === "healthy" ||
        value.pressure === "warning" ||
        value.pressure === "critical") &&
      typeof value.sampledAt === "number" &&
      Number.isFinite(value.sampledAt)
    )
      return { pressure: value.pressure, sampledAt: value.sampledAt };
  } catch {
    /* Unavailable cached measurements are unknown. */
  }
  return null;
}

/** The global indicator reads only pressure; full inventories belong to storage and the selected conversation. */
export function useStoragePressure(account: string | null) {
  const { environments } = useEnvironments();
  const environmentKey = environments
    .filter(
      (environment) =>
        account !== null &&
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.storageManagement === true,
    )
    .map((environment) => environment.environmentId)
    .toSorted()
    .join("\n");
  const results = useAtomValue(measurementsAtom(environmentKey));
  const [previous, setPrevious] = useState<{
    account: string | null;
    readings: ReadonlyMap<EnvironmentId, Reading>;
  }>({ account, readings: new Map() });
  useEffect(() => {
    setPrevious((before) => {
      const readings = new Map(before.account === account ? before.readings : []);
      let changed = before.account !== account;
      for (const { environmentId, result } of results) {
        if (
          result._tag !== "Success" ||
          result.value.storageSampledAt === undefined ||
          !result.value.storagePressure ||
          result.value.storagePressure === "unknown"
        )
          continue;
        const reading = {
          pressure: result.value.storagePressure,
          sampledAt: result.value.storageSampledAt,
        };
        if (
          readings.get(environmentId)?.sampledAt === reading.sampledAt &&
          readings.get(environmentId)?.pressure === reading.pressure
        )
          continue;
        readings.set(environmentId, reading);
        changed = true;
        if (account)
          try {
            localStorage.setItem(readingKey(account, environmentId), JSON.stringify(reading));
          } catch {
            /* Retain the session's last reading. */
          }
      }
      return changed ? { account, readings } : before;
    });
  }, [account, results]);
  useEffect(() => {
    if (!environmentKey) return;
    const refresh = () => {
      for (const id of environmentKey.split("\n"))
        appAtomRegistry.refresh(
          serverEnvironment.hostResources({ environmentId: EnvironmentId.make(id), input: {} }),
        );
    };
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [environmentKey]);
  return useMemo(
    () =>
      environments.map((environment) => {
        const result = results.find(
          (entry) => entry.environmentId === environment.environmentId,
        )?.result;
        const pressure =
          result?._tag === "Success"
            ? hostStoragePressure(result.value, result.timestamp)
            : "unknown";
        const last =
          (previous.account === account
            ? previous.readings.get(environment.environmentId)
            : null) ?? readCachedReading(account, environment.environmentId);
        return { environment, pressure, last };
      }),
    [account, environments, previous, results],
  );
}
