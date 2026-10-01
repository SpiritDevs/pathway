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
) => `const runtimePattern=/SimRuntime\\.(iOS|watchOS|visionOS|xrOS)-/;
class Session { phase="running"; close(){this.phase="stopped";} async handleHidMessage($,${socket}){} }
globalThis.Session=Session;`;
const files = {
  "/hub/dist/server/index.mjs": index,
  "/hub/vendor/serve-sim/dist/middleware.js": source("v"),
  "/hub/vendor/serve-sim/dist/serve-sim.js": source("U"),
};
const hashes = [
  "1cdba1c07d8d6e66c97aef700f4372d8bcae34ba0160b1059f62b20d123e1266",
  "2c82e875e1cf33b0ec98dd2d6e25271e487d9bc6e162b1c4d86e647bc82dcd9c",
  "d30d6f03320a98682d988df5231aaedd177e44d7867fe8b856ea4a7af34de24e",
];
function patch(wrongHash = false, compileFails = false) {
  const writes = new Map<string, string>();
  let hash = 0;
  const context = NodeVM.createContext({
    process: { platform: "darwin" },
    require: (name: string) => {
      if (name === "node:child_process")
        return {
          execFileSync: () => {
            if (compileFails) throw new Error("compiler unavailable");
          },
        };
      if (name === "node:path") return { join: (...parts: string[]) => parts.join("/") };
      if (name === "node:crypto")
        return {
          createHash: () => ({
            update: () => ({ digest: () => (wrongHash ? "changed" : hashes[hash++]) }),
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
  expect(fixture.writes.size).toBe(5);
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
    expect(code).toContain("await h.digitalCrown(p.delta)");
    expect(code).toContain("await h.buttonHid(p.page,p.usage");
  }
});

it("acknowledges native completion and returns native errors through the helper socket", async () => {
  const fixture = patch();
  fixture.run();
  for (const file of ["middleware.js", "serve-sim.js"]) {
    const context = NodeVM.createContext({ Buffer });
    NodeVM.runInContext(
      fixture.writes.get(`/hub/vendor/serve-sim/dist/${file}`)!.replace(/^import.*\n/, ""),
      context,
    );
    const session = NodeVM.runInContext("new Session()", context) as {
      hid: { handle: { digitalCrown: (delta: number) => Promise<void> } };
      waitForCapture: () => Promise<void>;
      handleHidMessage: (data: Buffer, ws: { send: (data: Buffer) => void }) => Promise<void>;
    };
    let complete!: () => void;
    const delivered = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const deltas: number[] = [];
    session.waitForCapture = async () => {};
    session.hid = {
      handle: {
        digitalCrown: (delta) => {
          deltas.push(delta);
          return delivered;
        },
      },
    };
    const responses: Buffer[] = [];
    const packet = Buffer.concat([
      Buffer.from([18]),
      Buffer.from(JSON.stringify({ id: "one", tag: 10, payload: { delta: -2 } })),
    ]);
    const running = session.handleHidMessage(packet, {
      send: (data) => {
        responses.push(data);
      },
    });
    await Promise.resolve();
    expect(responses).toHaveLength(0);
    complete();
    await running;
    expect(deltas).toEqual([-2]);
    expect(JSON.parse(responses[0]!.subarray(1).toString())).toEqual({ id: "one", ok: true });
    session.hid.handle.digitalCrown = async () => {
      throw new Error("native unavailable");
    };
    await session.handleHidMessage(packet, {
      send: (data) => {
        responses.push(data);
      },
    });
    expect(JSON.parse(responses[1]!.subarray(1).toString())).toMatchObject({
      ok: false,
      error: "Error: native unavailable",
    });
  }
});

it("does not publish patched entry points when native compilation fails", () => {
  const fixture = patch(false, true);
  expect(() => fixture.run()).toThrow("compiler unavailable");
  expect(fixture.writes.has("/hub/dist/server/index.mjs")).toBe(false);
});

it("routes TV through its separate native process and closes it with the capture session", async () => {
  const fixture = patch();
  fixture.run();
  for (const file of ["middleware.js", "serve-sim.js"]) {
    const calls: string[] = [];
    const context = NodeVM.createContext({
      Buffer,
      createPathwayTvInput: (udid: string) => {
        calls.push(udid);
        return {
          send: async (button: string) => {
            calls.push(button);
          },
          close: () => {
            calls.push("closed");
          },
        };
      },
    });
    NodeVM.runInContext(
      fixture.writes.get(`/hub/vendor/serve-sim/dist/${file}`)!.replace(/^import.*\n/, ""),
      context,
    );
    const session = NodeVM.runInContext("new Session()", context) as {
      udid: string;
      hid: { handle: object };
      waitForCapture: () => Promise<void>;
      handleHidMessage: (data: Buffer, ws: { send: (data: Buffer) => void }) => Promise<void>;
      close: () => void;
    };
    session.udid = "tv-udid";
    session.hid = { handle: {} }; // No digitizer API is available on this target.
    session.waitForCapture = async () => {};
    const responses: Buffer[] = [];
    const packet = Buffer.concat([
      Buffer.from([18]),
      Buffer.from(JSON.stringify({ id: "tv", tag: 19, payload: { button: "select" } })),
    ]);
    await session.handleHidMessage(packet, {
      send: (data) => {
        responses.push(data);
      },
    });
    expect(JSON.parse(responses[0]!.subarray(1).toString())).toEqual({ id: "tv", ok: true });
    let captured!: () => void;
    session.waitForCapture = () =>
      new Promise<void>((resolve) => {
        captured = resolve;
      });
    const late = session.handleHidMessage(packet, {
      send: (data) => {
        responses.push(data);
      },
    });
    session.close();
    captured();
    await late;
    expect(JSON.parse(responses[1]!.subarray(1).toString())).toMatchObject({
      ok: false,
      error: "Error: Simulator session is closed",
    });
    expect(calls).toEqual(["tv-udid", "select", "closed"]);
  }
});
