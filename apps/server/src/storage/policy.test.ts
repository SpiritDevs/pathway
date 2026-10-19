import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_STORAGE_POLICY } from "@spiritdevs/contracts";
import { storagePressure, eligibilityBlockers, validateStoragePolicy } from "./policy.ts";
import {
  leaseStorageWorkspace,
  useStorageWorkspace,
  markStorageWorkspaceRemoved,
  workspaceStorageBlocker,
} from "./workspaceLease.ts";

describe("storage pressure", () => {
  it("uses either capacity threshold and only recovers above both", () => {
    expect(storagePressure(25e9, 1e12, DEFAULT_STORAGE_POLICY)).toBe("critical");
    expect(storagePressure(10e9, 50e9, DEFAULT_STORAGE_POLICY)).toBe("critical");
    expect(storagePressure(20e9, 50e9, DEFAULT_STORAGE_POLICY)).toBe("warning");
    expect(storagePressure(21e9, 100e9, DEFAULT_STORAGE_POLICY)).toBe("healthy");
    expect(storagePressure(0, 0, DEFAULT_STORAGE_POLICY)).toBe("unknown");
  });
  it("rejects inverted thresholds", () => {
    expect(() =>
      validateStoragePolicy({ ...DEFAULT_STORAGE_POLICY, criticalBytes: 30e9 }),
    ).toThrow();
  });
});

const eligible = {
  active: false,
  snoozed: false,
  temporary: false,
  pinned: false,
  keep: false,
  terminal: false,
  projectRoot: false,
  sharedActive: false,
  dirty: false,
  unpublished: false,
  mode: "manual" as const,
  eligibleSince: null,
  afterDays: 30,
  now: 31 * 86_400_000,
};
describe("cleanup eligibility", () => {
  it("never lets emergency cleanup bypass protection", () => {
    for (const flag of [
      "active",
      "snoozed",
      "temporary",
      "pinned",
      "keep",
      "terminal",
      "projectRoot",
      "sharedActive",
      "dirty",
      "unpublished",
    ] as const)
      expect(
        eligibilityBlockers({ ...eligible, mode: "emergency", [flag]: true }).length,
      ).toBeGreaterThan(0);
  });
  it("requires a continuous age for scheduled cleanup but not explicit cleanup", () => {
    expect(eligibilityBlockers(eligible)).toEqual([]);
    expect(eligibilityBlockers({ ...eligible, mode: "scheduled" })).toContain(
      "Retention period has not elapsed",
    );
    expect(
      eligibilityBlockers({
        ...eligible,
        mode: "scheduled",
        eligibleSince: "1970-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });
});
describe("workspace leases", () => {
  it("blocks cleanup while a dispatch or nested terminal is starting", () => {
    const release = useStorageWorkspace("/fixture/repo/worktree/nested");
    expect(() => leaseStorageWorkspace("/fixture/repo/worktree")).toThrow();
    release();
    const cleanup = leaseStorageWorkspace("/fixture/repo/worktree");
    expect(() => useStorageWorkspace("/fixture/repo/worktree/nested")).toThrow();
    cleanup();
    expect(workspaceStorageBlocker("/fixture/repo/worktree")).toBeNull();
  });
  it("keeps removed workspaces blocked until recreation", () => {
    markStorageWorkspaceRemoved("/fixture/reclaimed", true);
    expect(() => useStorageWorkspace("/fixture/reclaimed")).toThrow(/Recreate/);
    markStorageWorkspaceRemoved("/fixture/reclaimed", false);
    const release = useStorageWorkspace("/fixture/reclaimed");
    release();
  });
});
