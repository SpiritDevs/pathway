import { expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";
import { patch } from "./deviceHubPatch.testkit.ts";

it("fails before publishing any files if the upstream checksum changes", () => {
  const fixture = patch(true);
  expect(() => fixture.run()).toThrow("checksum mismatch");
  expect(fixture.writes.size).toBe(0);
});

it("patches both helper entry points and includes never-used Watch and TV devices", async () => {
  const fixture = patch();
  fixture.run();
  expect(fixture.writes.size).toBe(8);
  const changed = fixture.writes.get("/hub/dist/server/index.mjs")!;
  expect(changed).toContain('["iOS", "watchOS", "tvOS"].includes');
  expect(changed).not.toContain("lastUsedAt !== undefined");
  expect(changed).toContain("device.deviceTypeIdentifier");
  const devices = [
    { udid: "watch", name: "Renamed", platform: "watchOS", isAvailable: true },
    { udid: "tv", name: "Renamed", platform: "tvOS", isAvailable: true },
    {
      udid: "pad",
      name: "Renamed",
      platform: "iOS",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro",
      isAvailable: true,
    },
    {
      udid: "phone",
      name: "Renamed",
      platform: "iOS",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      isAvailable: true,
    },
    { udid: "missing", platform: "watchOS", isAvailable: false },
    { udid: "vision", platform: "xrOS", isAvailable: true },
  ];
  const context = NodeVM.createContext({ listDevices2: async () => ({ value: devices }) });
  const result = (await NodeVM.runInContext(changed + "\nlistIosSimulators()", context)) as {
    devices: { family: string }[];
  };
  expect(Array.from(result.devices, (device) => device.family)).toEqual([
    "watch",
    "tv",
    "pad",
    "phone",
  ]);
  for (const file of ["middleware.js", "serve-sim.js"]) {
    const code = fixture.writes.get(`/hub/vendor/serve-sim/dist/${file}`)!;
    expect(code).toContain("watchOS|tvOS");
    expect(() => new NodeVM.Script(code.replace(/^import.*\n/gm, ""))).not.toThrow();
    if (file === "serve-sim.js") expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(code).toContain("createPathwaySimulatorInput(this)");
    expect(code).toContain("pathwayLegacyHidMessage");
  }
});

it("rejects a changed native addon before publishing any patch files", () => {
  const fixture = patch(false, true);
  expect(() => fixture.run()).toThrow("checksum mismatch: native addon");
  expect(fixture.writes.size).toBe(0);
});
it("installs shared hub sources on an Android-only Mac without invoking a compiler", () => {
  const fixture = patch();
  fixture.run();
  expect(fixture.writes.get("/hub/vendor/serve-sim/dist/native/pathway-tv-input.json")).toBe(
    '{"status":"notBuilt"}',
  );
  expect(fixture.writes.get("/hub/vendor/serve-sim/dist/pathway-tv-build.mjs")).toContain(
    "ensurePathwayTvInput",
  );
});
