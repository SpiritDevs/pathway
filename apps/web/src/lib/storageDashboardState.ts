import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import { EnvironmentId, type StorageSnapshot } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import { companyScopedStorageSnapshot } from "./storageCompanyScope";
import { readStorageSnapshots, writeStorageSnapshot } from "./storageSnapshotCache";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type EnvironmentPresentation, useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { storageDashboardHasRunningJob, storageDashboardQueryKey } from "./storageDashboardPolling";

export interface StorageEnvironmentEntry {
  readonly environment: EnvironmentPresentation;
  readonly snapshot: StorageSnapshot | null;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const snapshotsAtom = Atom.family((environmentKey: string) => {
  const environmentIds = environmentKey
    .split("\n")
    .filter(Boolean)
    .map((id) => EnvironmentId.make(id));
  return Atom.make((get) =>
    environmentIds.map((environmentId) => {
      const result = get(serverEnvironment.storageSnapshot({ environmentId, input: {} }));
      const failure = result._tag === "Failure" ? Cause.squash(result.cause) : null;
      return {
        environmentId,
        snapshot: Option.getOrNull(AsyncResult.value(result)),
        error:
          failure instanceof Error
            ? failure.message
            : failure
              ? "Storage could not be loaded."
              : null,
        isLoading: result.waiting,
      };
    }),
  );
});

/** One query per connected environment, including environments with no visible projects. */
export function useStorageDashboardState({ refreshIntervalMs = 30_000, polling = true } = {}) {
  const { environments } = useEnvironments();
  const accountId = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;
  const companyId = useAtomValue(activeCompanyIdAtom);
  const replicas = useAtomValue(scopedCompanyRegistryReplicasAtom);
  const allEnvironmentKey = environments
    .map((environment) => environment.environmentId)
    .toSorted()
    .join("\n");
  const environmentKey = storageDashboardQueryKey(environments);
  const results = useAtomValue(snapshotsAtom(environmentKey));
  const [cache, setCache] = useState<{
    accountId: string | null;
    snapshots: ReadonlyMap<EnvironmentId, StorageSnapshot>;
  }>({ accountId, snapshots: new Map() });
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void readStorageSnapshots(
      accountId,
      allEnvironmentKey
        .split("\n")
        .filter(Boolean)
        .map((id) => EnvironmentId.make(id)),
    )
      .then((snapshots) => {
        if (cancelled) return;
        setCache((previous) => ({
          accountId,
          snapshots: new Map([
            ...snapshots,
            ...(previous.accountId === accountId ? previous.snapshots : []),
          ]),
        }));
      })
      .catch(() => {
        /* Live measurements remain available when browser storage is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, allEnvironmentKey]);
  useEffect(() => {
    if (!accountId) return;
    setCache((previous) => {
      const next = new Map(previous.accountId === accountId ? previous.snapshots : []);
      let changed = previous.accountId !== accountId;
      for (const result of results) {
        if (result.snapshot && next.get(result.environmentId) !== result.snapshot) {
          next.set(result.environmentId, result.snapshot);
          changed = true;
        }
      }
      return changed ? { accountId, snapshots: next } : previous;
    });
    for (const result of results) {
      if (result.snapshot)
        void writeStorageSnapshot(accountId, result.environmentId, result.snapshot).catch(() => {});
    }
  }, [accountId, results]);
  const entries: ReadonlyArray<StorageEnvironmentEntry> = useMemo(
    () =>
      environments.map((environment) => {
        const result = results.find((entry) => entry.environmentId === environment.environmentId);
        const unsupported =
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.storageManagement !== true;
        const snapshot = unsupported
          ? null
          : (result?.snapshot ??
            (cache.accountId === accountId
              ? cache.snapshots.get(environment.environmentId)
              : null) ??
            null);
        return {
          environment,
          snapshot: snapshot
            ? companyScopedStorageSnapshot(snapshot, companyId, replicas, environment.environmentId)
            : null,
          error: unsupported
            ? "Update this environment's server to view storage and manage cleanup."
            : (result?.error ?? null),
          isLoading: result?.isLoading ?? false,
        };
      }),
    [environments, results, cache, accountId, companyId, replicas],
  );
  const refresh = useCallback(() => {
    for (const id of environmentKey.split("\n").filter(Boolean)) {
      appAtomRegistry.refresh(
        serverEnvironment.storageSnapshot({ environmentId: EnvironmentId.make(id), input: {} }),
      );
    }
  }, [environmentKey]);
  const hasRunningJob = storageDashboardHasRunningJob(results);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") refresh();
      },
      hasRunningJob ? 2_000 : refreshIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [hasRunningJob, refresh, refreshIntervalMs, polling]);
  return { entries, refresh };
}
