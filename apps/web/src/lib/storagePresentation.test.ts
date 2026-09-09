import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_STORAGE_POLICY, type StorageSnapshot } from "@spiritdevs/contracts";
import {
  formatStorageBytes,
  hostStoragePressure,
  storageMeasurementIsFresh,
  storagePressure,
  storagePressureTransition,
} from "./storagePresentation";

describe("storage measurements", () => {
  it("uses resource receipt time for storage warnings when remote clocks differ", () => {
    const resources = {
      sampledAt: 9_000_000,
      storageSampledAt: 8_999_000,
      storagePressure: "critical" as const,
      cpuUtilization: null,
      cpuCount: 8,
      availableMemoryBytes: 500,
      totalMemoryBytes: 1000,
    };
    expect(hostStoragePressure(resources, 20_000, 20_001)).toBe("critical");
    expect(hostStoragePressure(resources, 20_000, 150_000)).toBe("unknown");
    expect(
      hostStoragePressure({ ...resources, storageSampledAt: 10_000_000 }, 20_000, 20_001),
    ).toBe("unknown");
  });
  it("does not present missing sizes or stale measurements as current zeroes", () => {
    expect(formatStorageBytes(null)).toBe("Not measured");
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(10_000_000_000)).toBe("10 GB");
    expect(storageMeasurementIsFresh(0, 120_001)).toBe(false);
    expect(storageMeasurementIsFresh("invalid", 0)).toBe(false);
  });
  it("reports pressure on any volume and never reports unknown coverage as healthy", () => {
    const snapshot: StorageSnapshot = {
      sampledAt: new Date(10_000).toISOString(),
      policy: DEFAULT_STORAGE_POLICY,
      jobs: [],
      threads: [],
      worktrees: [],
      scanError: null,
      volumes: [
        {
          id: "system",
          path: "/",
          availableBytes: 100,
          totalBytes: 1000,
          pressure: "healthy",
          sampledAt: new Date(10_000).toISOString(),
        },
        {
          id: "external",
          path: "/disk",
          availableBytes: 1,
          totalBytes: 1000,
          pressure: "critical",
          sampledAt: new Date(10_000).toISOString(),
        },
      ],
    };
    expect(storagePressure(snapshot, 10_000)).toBe("critical");
    expect(storagePressure({ ...snapshot, volumes: [] }, 10_000)).toBe("unknown");
    expect(storagePressure(snapshot, 150_000)).toBe("unknown");
  });
  it("alerts on threshold crossings and recovery without treating disconnects as recovery", () => {
    expect(storagePressureTransition(undefined, "critical")).toBe("low");
    expect(storagePressureTransition("critical", "critical")).toBeNull();
    expect(storagePressureTransition("warning", "critical")).toBe("low");
    expect(storagePressureTransition("critical", "unknown")).toBeNull();
    expect(storagePressureTransition("critical", "healthy")).toBe("recovered");
  });
});
