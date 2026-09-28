import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { DeviceRestartToolsInput, deviceToolInstallMessage } from "./device.ts";

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
