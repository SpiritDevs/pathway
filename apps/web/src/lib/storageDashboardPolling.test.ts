import { DEFAULT_STORAGE_POLICY, EnvironmentId, type StorageSnapshot } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import { storageDashboardHasRunningJob, storageDashboardQueryKey } from "./storageDashboardPolling";

const environment = (id: string, phase: string, storageManagement?: boolean) => ({
  environmentId: EnvironmentId.make(id),
  connection: { phase },
  serverConfig: { environment: { capabilities: { storageManagement } } },
});
const snapshot = (sampledAt = new Date().toISOString()): StorageSnapshot => ({
  sampledAt,
  policy: DEFAULT_STORAGE_POLICY,
  volumes: [],
  worktrees: [],
  threads: [],
  scanError: null,
  jobs: [
    {
      id: "cleanup",
      mode: "manual",
      status: "running",
      startedAt: sampledAt,
      finishedAt: null,
      items: [],
    },
  ],
});

describe("storage dashboard polling", () => {
  it("queries only connected servers advertising storage support in a mixed-version setup", () => {
    expect(
      storageDashboardQueryKey([
        environment("old", "connected"),
        environment("disabled", "connected", false),
        environment("offline", "disconnected", true),
        environment("new", "connected", true),
      ]),
    ).toBe("new");
  });
  it("drops a disconnected running environment from the query set", () => {
    expect(storageDashboardQueryKey([environment("running", "disconnected", true)])).toBe("");
    expect(storageDashboardHasRunningJob([])).toBe(false);
  });
  it("accelerates for a fresh running job returned by a supported connected environment", () => {
    expect(storageDashboardHasRunningJob([{ snapshot: snapshot(), error: null }])).toBe(true);
  });
  it("does not accelerate for failed or expired running-job results", () => {
    expect(
      storageDashboardHasRunningJob([{ snapshot: snapshot(), error: "Connection lost" }]),
    ).toBe(false);
    expect(
      storageDashboardHasRunningJob([
        { snapshot: snapshot(new Date(Date.now() - 180_000).toISOString()), error: null },
      ]),
    ).toBe(false);
  });
  it("returns to normal polling when a live cleanup completes", () => {
    const completed = snapshot();
    expect(
      storageDashboardHasRunningJob([
        {
          snapshot: {
            ...completed,
            jobs: completed.jobs.map((job) => ({ ...job, status: "completed" })),
          },
          error: null,
        },
      ]),
    ).toBe(false);
  });
});
