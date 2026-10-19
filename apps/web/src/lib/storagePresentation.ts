import type {
  HostResourcesSnapshot,
  StoragePressure,
  StorageSnapshot,
} from "@spiritdevs/contracts";

export const STORAGE_MEASUREMENT_MAX_AGE_MS = 120_000;

export function formatStorageBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Not measured";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1_000 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[exponent - 1]}`;
}

export function storageMeasurementIsFresh(
  sampledAt: string | number | null | undefined,
  now = Date.now(),
): boolean {
  const timestamp = typeof sampledAt === "string" ? Date.parse(sampledAt) : sampledAt;
  return (
    timestamp != null &&
    Number.isFinite(timestamp) &&
    timestamp <= now + 5_000 &&
    now - timestamp <= STORAGE_MEASUREMENT_MAX_AGE_MS
  );
}

export function hostStoragePressure(
  resources: HostResourcesSnapshot,
  receivedAt: number,
  now = Date.now(),
): StoragePressure {
  if (resources.storageSampledAt === undefined) return "unknown";
  const sampledAtOnClient = receivedAt + resources.storageSampledAt - resources.sampledAt;
  return storageMeasurementIsFresh(sampledAtOnClient, now)
    ? (resources.storagePressure ?? "unknown")
    : "unknown";
}

export function storagePressure(
  snapshot: StorageSnapshot | null,
  now = Date.now(),
): StoragePressure {
  if (!snapshot || !storageMeasurementIsFresh(snapshot.sampledAt, now)) return "unknown";
  const measured = snapshot.volumes.filter((volume) =>
    storageMeasurementIsFresh(volume.sampledAt, now),
  );
  if (measured.some((volume) => volume.pressure === "critical")) return "critical";
  if (measured.some((volume) => volume.pressure === "warning")) return "warning";
  if (
    snapshot.scanError ||
    measured.length !== snapshot.volumes.length ||
    measured.length === 0 ||
    measured.some((volume) => volume.pressure === "unknown")
  )
    return "unknown";
  return "healthy";
}

/** An unknown reading is not evidence that storage recovered. */
export function storagePressureTransition(
  previous: StoragePressure | undefined,
  next: StoragePressure,
): "low" | "recovered" | null {
  if (next === "unknown" || previous === next) return null;
  if (next === "critical" || next === "warning") return "low";
  return previous === "warning" || previous === "critical" ? "recovered" : null;
}
