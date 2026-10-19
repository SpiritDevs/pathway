import type { StorageSnapshot, StoragePressure } from "@spiritdevs/contracts";
let latest: { storagePressure: StoragePressure; storageSampledAt: number } = {
  storagePressure: "unknown",
  storageSampledAt: 0,
};
export function recordStoragePressure(
  snapshot: Pick<StorageSnapshot, "sampledAt" | "volumes">,
): void {
  const levels = snapshot.volumes.map((volume) => volume.pressure);
  latest = {
    storagePressure: levels.includes("critical")
      ? "critical"
      : levels.includes("warning")
        ? "warning"
        : levels.length > 0 && levels.every((level) => level === "healthy")
          ? "healthy"
          : "unknown",
    storageSampledAt: Date.parse(snapshot.sampledAt),
  };
}
export function readStoragePressure() {
  return latest;
}

let inventoryRevision = 0;
export function invalidateStorageInventory(): void {
  inventoryRevision++;
}
export function storageInventoryRevision(): number {
  return inventoryRevision;
}
