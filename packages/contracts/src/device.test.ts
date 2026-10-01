import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DeviceInputInput,
  DeviceCapabilities,
  DEVICE_TV_KEYBOARD_MAP,
  deviceSimulatorInputPacket,
  DeviceRestartToolsInput,
  deviceToolInstallMessage,
} from "./device.ts";

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});

const decodeRestart = Schema.decodeUnknownSync(DeviceRestartToolsInput);
it("accepts targeted and default helper restarts but rejects empty or unknown tool selections", () => {
  expect(decodeRestart({})).toEqual({});
  expect(decodeRestart({ hostId: "ssh-mac", tools: ["hub"] })).toEqual({
    hostId: "ssh-mac",
    tools: ["hub"],
  });
  expect(() => decodeRestart({ tools: [] })).toThrow();
  expect(() => decodeRestart({ tools: ["xcode"] })).toThrow();
});

const decodeInput = Schema.decodeUnknownSync(DeviceInputInput);
const decodeCapabilities = Schema.decodeUnknownSync(DeviceCapabilities);
it("validates bounded input and a typed unsupported streaming reason", () => {
  for (const delta of [NaN, Infinity, 201, -201])
    expect(() =>
      decodeInput({ deviceId: "watch", input: { kind: "digitalCrown", delta } }),
    ).toThrow();
  for (const x of [-1, 2, NaN])
    expect(() =>
      decodeInput({ deviceId: "watch", input: { kind: "touch", phase: "begin", x, y: 0.5 } }),
    ).toThrow();
  expect(() =>
    decodeInput({ deviceId: "tv", input: { kind: "remoteButton", button: "invented" } }),
  ).toThrow();
  const capabilities = decodeCapabilities({
    streaming: { status: "unsupported", reason: "Native capture unavailable on this host" },
    agentCli: { status: "supported" },
    inputKinds: ["remoteButton"],
    framing: { shape: "tv", orientation: "landscape", aspectRatio: 16 / 9 },
  });
  expect(capabilities.streaming.status).toBe("unsupported");
});

it("maps Siri Remote keyboard controls to button events and Watch crown to rotation", () => {
  for (const button of Object.values(DEVICE_TV_KEYBOARD_MAP))
    expect(deviceSimulatorInputPacket({ kind: "remoteButton", button }).tag).toBe(19);
  expect(DEVICE_TV_KEYBOARD_MAP.Space).toBe("playPause");
  expect(deviceSimulatorInputPacket({ kind: "remoteButton", button: "right" })).toEqual({
    tag: 19,
    payload: { button: "right" },
  });
  expect(deviceSimulatorInputPacket({ kind: "digitalCrown", delta: -10 })).toEqual({
    tag: 10,
    payload: { delta: -10 },
  });
  expect(deviceSimulatorInputPacket({ kind: "watchButton", button: "side" })).toEqual({
    tag: 4,
    payload: { page: 12, usage: 0x95 },
  });
});
