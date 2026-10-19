import type { EnvironmentId, StorageSnapshot } from "@spiritdevs/contracts";
import { storageMeasurementIsFresh } from "./storagePresentation";

interface StorageEnvironmentAvailability {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly serverConfig?: {
    readonly environment: {
      readonly capabilities: { readonly storageManagement?: boolean | undefined };
    };
  } | null;
}

/** Older servers remain visible without receiving RPC methods they do not support. */
export function storageDashboardQueryKey(
  environments: ReadonlyArray<StorageEnvironmentAvailability>,
) {
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.storageManagement === true,
    )
    .map((environment) => environment.environmentId)
    .toSorted()
    .join("\n");
}

/** Only successful, current query results may accelerate polling; offline cache is presentation-only. */
export function storageDashboardHasRunningJob(
  results: ReadonlyArray<{
    readonly snapshot: StorageSnapshot | null;
    readonly error: string | null;
  }>,
) {
  return results.some(
    ({ snapshot, error }) =>
      error === null &&
      storageMeasurementIsFresh(snapshot?.sampledAt) &&
      snapshot?.jobs.some((job) => job.status === "running"),
  );
}
