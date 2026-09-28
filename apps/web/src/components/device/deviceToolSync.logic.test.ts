import type {
  DeviceHostSummary,
  DeviceServiceState,
  DeviceToolDrift,
  DeviceToolManifest,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceToolBanner,
  deviceToolRowKey,
  deviceToolSyncRows,
  deviceToolUpdateTargets,
  hostHelperState,
  hostToolColumns,
  summarizeDeviceToolUpdates,
  type DeviceToolUpdateOutcome,
} from "./deviceToolSync.logic";

const manifest: DeviceToolManifest = {
  revision: "1",
  hub: "0.12.0",
  agent: "0.21.12",
  serveSim: "expo-device-hub@0.12.0",
  recommendedXcode: "26.0",
  recommendedRuntimes: [
    { platform: "ios", version: "26.0" },
    { platform: "android", version: "36" },
  ],
};

const drift = (
  tool: DeviceToolDrift["tool"],
  status: DeviceToolDrift["status"],
  actual: string[] = status === "match" ? ["expected"] : [],
  restartRequired = false,
): DeviceToolDrift => ({ tool, status, expected: "expected", actual, restartRequired });

const matching = () => [
  drift("hub", "match", ["0.12.0"]),
  drift("agent", "match", ["0.21.12"]),
  drift("serveSim", "match", ["expo-device-hub@0.12.0"]),
  drift("xcode", "match", ["26.0"]),
  drift("iosRuntime", "match", ["26.0"]),
  drift("androidRuntime", "missing"),
];

const host = (overrides: Partial<DeviceHostSummary> = {}): DeviceHostSummary => ({
  id: "local",
  kind: "local",
  label: "This Mac",
  platforms: [],
  hubInstalled: true,
  agentDeviceInstalled: true,
  drift: matching(),
  sdkInventory: {
    xcode: "26.0",
    sdks: [],
    runtimes: [
      { platform: "ios", version: "26.0" },
      { platform: "ios", version: "18.4" },
    ],
    inspectionErrors: [],
  },
  ...overrides,
});

const state = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [host()],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 1,
  manifest,
  supportsEnvironmentToolSync: true,
  ...overrides,
});

describe("hostHelperState", () => {
  it("is current when every pinned helper matches", () => {
    expect(hostHelperState(host())).toBe("current");
  });

  it("ignores advisory Xcode and runtime drift", () => {
    expect(
      hostHelperState(
        host({ drift: [...matching().slice(0, 3), drift("xcode", "different", ["16.4"])] }),
      ),
    ).toBe("current");
  });

  it("is behind when a helper is missing or different", () => {
    expect(
      hostHelperState(
        host({ drift: [...matching().slice(1), drift("hub", "different", ["0.11.0"])] }),
      ),
    ).toBe("behind");
    expect(hostHelperState(host({ drift: [drift("agent", "missing")] }))).toBe("behind");
  });

  it("asks for a restart when the pin is installed but an older helper runs", () => {
    expect(hostHelperState(host({ drift: [drift("hub", "match", ["0.12.0"], true)] }))).toBe(
      "restart",
    );
  });

  it("is unknown without drift or with failed probes", () => {
    expect(hostHelperState(host({ drift: undefined }))).toBe("unknown");
    expect(hostHelperState(host({ drift: [drift("hub", "unknown")] }))).toBe("unknown");
  });
});

describe("hostToolColumns", () => {
  it("folds serve-sim into the hub column and labels inventory", () => {
    const columns = hostToolColumns(
      host({
        drift: [
          drift("hub", "match", ["0.12.0"]),
          drift("serveSim", "missing"),
          drift("iosRuntime", "match", ["26.0"]),
          drift("androidRuntime", "missing"),
        ],
      }),
    );
    expect(columns.hub).toMatchObject({ status: "missing", actual: "0.12.0" });
    expect(columns.runtimes).toMatchObject({
      status: "missing",
      actual: "iOS 18.4, iOS 26.0",
      expected: "iOS expected · Android expected",
    });
    expect(columns.xcode.status).toBeNull();
    expect(columns.xcode.actual).toBe("26.0");
  });

  it("separates an unknown probe from a completed check that found nothing", () => {
    const columns = hostToolColumns(
      host({
        drift: [drift("agent", "unknown"), drift("hub", "missing")],
        sdkInventory: undefined,
      }),
    );
    expect(columns.agent.actual).toBe("Unknown");
    expect(columns.hub.actual).toBe("None");
    expect(columns.xcode.actual).toBe("—");
  });
});

describe("deviceToolSyncRows", () => {
  it("flags environments whose release pins older helpers", () => {
    const rows = deviceToolSyncRows([
      { environmentId: "a", label: "Studio", state: state() },
      {
        environmentId: "b",
        label: "Laptop",
        state: state({ manifest: { ...manifest, hub: "0.11.2" } }),
      },
      { environmentId: "c", label: "Old server", state: state({ manifest: undefined }) },
    ]);
    expect(rows.map((row) => [row.environmentLabel, row.olderRelease])).toEqual([
      ["Studio", false],
      ["Laptop", true],
      ["Old server", true],
    ]);
  });

  it("only offers updates for behind hosts on servers that support tool sync", () => {
    const behind = host({
      id: "mini",
      kind: "ssh",
      label: "Mac mini",
      drift: [drift("hub", "missing")],
    });
    const rows = deviceToolSyncRows([
      { environmentId: "a", label: "Studio", state: state({ hosts: [host(), behind] }) },
      {
        environmentId: "b",
        label: "Legacy",
        state: state({ hosts: [behind], supportsEnvironmentToolSync: undefined }),
      },
    ]);
    expect(rows.map((row) => [row.key, row.canUpdate])).toEqual([
      [deviceToolRowKey("a", "local"), false],
      [deviceToolRowKey("a", "mini"), true],
      [deviceToolRowKey("b", "mini"), false],
    ]);
  });

  it("marks cached inventory as stale", () => {
    const [row] = deviceToolSyncRows([
      {
        environmentId: "a",
        label: "Studio",
        state: state({ hosts: [host({ toolInspectionError: "ssh timed out" })] }),
      },
    ]);
    expect(row?.stale).toBe(true);
  });
});

describe("fan-out", () => {
  const rows = deviceToolSyncRows([
    {
      environmentId: "a",
      label: "A",
      state: state({ hosts: [host({ drift: [drift("hub", "missing")] })] }),
    },
    {
      environmentId: "b",
      label: "B",
      state: state({ hosts: [host({ drift: [drift("agent", "different", ["0.20.0"])] })] }),
    },
    { environmentId: "c", label: "C", state: state() },
  ]);

  it("targets behind hosts that are not already updating", () => {
    const outcomes = new Map<string, DeviceToolUpdateOutcome>([
      [deviceToolRowKey("a", "local"), { status: "pending" }],
    ]);
    expect(deviceToolUpdateTargets(rows, outcomes).map((row) => row.environmentId)).toEqual(["b"]);
    expect(deviceToolUpdateTargets(rows, new Map()).map((row) => row.environmentId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("summarizes per-environment progress and failures", () => {
    const summarize = (...values: DeviceToolUpdateOutcome[]) =>
      summarizeDeviceToolUpdates(new Map(values.map((value, index) => [String(index), value])));
    expect(summarize()).toBeNull();
    expect(summarize({ status: "pending" }, { status: "success" })).toBe(
      "Updating 1 host… 1 of 2 finished.",
    );
    expect(summarize({ status: "success" }, { status: "success" })).toBe("Updated 2 hosts.");
    expect(summarize({ status: "failed", message: "offline" })).toBe("Update failed on 1 host.");
    expect(summarize({ status: "success" }, { status: "failed", message: "offline" })).toBe(
      "Updated 1 host; 1 failed.",
    );
  });
});

describe("deviceToolBanner", () => {
  it("is hidden when helpers match their pins", () => {
    expect(deviceToolBanner(state())).toBeNull();
  });

  it("names the pins and behind hosts when several hosts exist", () => {
    const banner = deviceToolBanner(
      state({
        hosts: [host(), host({ id: "mini", label: "Mac mini", drift: [drift("hub", "missing")] })],
      }),
    );
    expect(banner).toEqual({
      kind: "behind",
      hostIds: ["mini"],
      message:
        "Device tools on Mac mini are behind this release. It pins Device Hub 0.12.0 and agent-device 0.21.12.",
      canUpdate: true,
    });
  });

  it("does not offer an update on servers without tool sync", () => {
    const banner = deviceToolBanner(
      state({
        hosts: [host({ drift: [drift("hub", "missing")] })],
        supportsEnvironmentToolSync: undefined,
      }),
    );
    expect(banner).toMatchObject({ kind: "behind", canUpdate: false });
  });

  it("asks for a restart once installed pins are waiting to run", () => {
    expect(
      deviceToolBanner(state({ hosts: [host({ drift: [drift("agent", "match", ["x"], true)] })] })),
    ).toMatchObject({ kind: "restart" });
  });
});
