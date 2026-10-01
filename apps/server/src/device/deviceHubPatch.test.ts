import { expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";
import { deviceHubPatchScript } from "./deviceHubPatch.ts";

const index = `async function listIosSimulators() {
 const listed=await listDevices2();
 return { devices: listed.value.filter((device) => device.platform === "iOS" && device.isAvailable).map((device)=>{
  return { id:device.udid, name: device.name || "Simulator", version:device.platform, platform:"ios" };
 }).filter((device) => device.lastUsedAt !== undefined), error:null };
}`;
// The fixtures contain only the pinned anchors. Filesystem and hashing are the mocked install boundary.
const source = (
  socket: string,
) => `${socket === "U" ? "#!/usr/bin/env node\n" : ""}const runtimePattern=/SimRuntime\\.(iOS|watchOS|visionOS|xrOS)-/;
class Session { phase="running"; close(){this.phase="stopped";} async handleHidMessage($,${socket}){} }
globalThis.Session=Session;`;
const files = {
  "/hub/vendor/serve-sim/dist/native/serve-sim-native.node": "native",
  "/hub/dist/server/index.mjs": index,
  "/hub/vendor/serve-sim/dist/middleware.js": source("v"),
  "/hub/vendor/serve-sim/dist/serve-sim.js": source("U"),
};
const hashes = [
  "1cdba1c07d8d6e66c97aef700f4372d8bcae34ba0160b1059f62b20d123e1266",
  "2c82e875e1cf33b0ec98dd2d6e25271e487d9bc6e162b1c4d86e647bc82dcd9c",
  "d30d6f03320a98682d988df5231aaedd177e44d7867fe8b856ea4a7af34de24e",
  "27732f7fbc01c1fdd97f1b850d072cb4b57991e3177fde084a1e6e6c0b061628",
];
function patch(wrongHash = false, wrongNative = false) {
  const writes = new Map<string, string>();
  let hash = 0;
  const context = NodeVM.createContext({
    process: { platform: "darwin" },
    require: (name: string) => {
      if (name === "node:path") return { join: (...parts: string[]) => parts.join("/") };
      if (name === "node:crypto")
        return {
          createHash: () => ({
            update: () => ({
              digest: () => (wrongHash || (wrongNative && hash === 3) ? "changed" : hashes[hash++]),
            }),
          }),
        };
      if (name === "node:fs")
        return {
          readFileSync: (file: keyof typeof files) => Buffer.from(files[file]),
          writeFileSync: (file: string, text: string) => writes.set(file, text),
        };
      throw new Error(name);
    },
  });
  return {
    run: () => NodeVM.runInContext(deviceHubPatchScript + '\npatchDeviceHub("/hub")', context),
    writes,
  };
}

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
