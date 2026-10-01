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
class Session { phase="running"; close(){this.phase="stopped";} async handleHidMessage($,${socket}){} queueHingeControl($){} }
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
export function patch(wrongHash = false, wrongNative = false) {
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
