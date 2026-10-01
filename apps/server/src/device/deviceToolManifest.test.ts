import { expect, it } from "vite-plus/test";
import type { DeviceHostSummary } from "@spiritdevs/contracts";
import {
  checkDeviceRequirements,
  deviceToolDrift,
  DEVICE_TOOL_MANIFEST as manifest,
} from "./deviceToolManifest.ts";

const host: DeviceHostSummary = {
  id: "local",
  kind: "local",
  label: "Mac",
  platforms: [],
  hubInstalled: true,
  agentDeviceInstalled: false,
  tools: {
    hub: {
      requiredVersion: manifest.hub,
      installedVersions: [manifest.hub],
      runningVersion: "0.1.0",
    },
    agent: { requiredVersion: manifest.agent, installedVersions: [], runningVersion: null },
    serveSim: {
      requiredVersion: manifest.serveSim,
      installedVersions: [manifest.serveSim],
      runningVersion: "expo-device-hub@0.1.0",
    },
  },
  sdkInventory: {
    xcode: "25.0",
    sdks: [{ platform: "ios", version: "26.0" }],
    runtimes: [{ platform: "ios", version: "26.0" }],
    inspectionErrors: ["android:runtime"],
  },
};

it("separates missing installs, installed drift, running drift and unknown inspection", () => {
  const drift = Object.fromEntries(deviceToolDrift(host).map((value) => [value.tool, value]));
  expect(drift.hub).toMatchObject({ status: "match", restartRequired: true });
  expect(drift.serveSim).toMatchObject({ status: "match", restartRequired: true });
  expect(drift.agent).toMatchObject({ status: "missing", restartRequired: false });
  expect(drift.xcode).toMatchObject({ status: "different", actual: ["25.0"] });
  expect(drift.iosRuntime).toMatchObject({ status: "match" });
  expect(drift.androidRuntime).toMatchObject({ status: "unknown" });
});

it("reports exact project SDK/runtime requirements and distinguishes unknown from missing", () => {
  const ios = { kind: "sdk", platform: "ios", version: "26.0" } as const;
  const missing = { kind: "runtime", platform: "ios", version: "18.0" } as const;
  const unknown = { kind: "runtime", platform: "android", version: "36" } as const;
  expect(checkDeviceRequirements(host, { requirements: [ios] })).toMatchObject({
    satisfied: true,
    missing: [],
    unknown: [],
  });
  expect(checkDeviceRequirements(host, { requirements: [ios, missing, unknown] })).toEqual({
    hostId: "local",
    satisfied: false,
    missing: [missing],
    unknown: [unknown],
  });
  expect(
    checkDeviceRequirements({ ...host, toolInspectionError: "offline" }, { requirements: [ios] }),
  ).toMatchObject({ satisfied: false, missing: [], unknown: [ios] });
});
