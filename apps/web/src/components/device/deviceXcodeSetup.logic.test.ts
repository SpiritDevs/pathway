import type { DeviceServiceState } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldOfferXcodeSetup } from "./deviceXcodeSetup.logic";

type Host = DeviceServiceState["hosts"][number];
type Device = DeviceServiceState["devices"][number];

const host = (id: string, kind: Host["kind"], iosAvailable: boolean) =>
  ({
    id,
    kind,
    label: id,
    platforms: [{ platform: "ios", available: iosAvailable }],
    hubInstalled: true,
    agentDeviceInstalled: true,
  }) as unknown as Host;

const iosDevice = (hostId: string) => ({ hostId, id: "sim", platform: "ios" }) as unknown as Device;

describe("shouldOfferXcodeSetup", () => {
  it("offers setup on a Mac whose local host cannot run iOS or has no simulator", () => {
    expect(
      shouldOfferXcodeSetup({ hosts: [host("local", "local", false)], devices: [] }, "mac"),
    ).toBe(true);
    expect(
      shouldOfferXcodeSetup({ hosts: [host("local", "local", true)], devices: [] }, "mac"),
    ).toBe(true);
    // A remote SSH Mac's simulators do not mean this environment has Xcode.
    expect(
      shouldOfferXcodeSetup(
        {
          hosts: [host("local", "local", true), host("ssh", "ssh", true)],
          devices: [iosDevice("ssh")],
        },
        "mac",
      ),
    ).toBe(true);
  });

  it("stays out of the way once iOS simulators exist or the host is not a Mac", () => {
    expect(
      shouldOfferXcodeSetup(
        { hosts: [host("local", "local", true)], devices: [iosDevice("local")] },
        "mac",
      ),
    ).toBe(false);
    expect(
      shouldOfferXcodeSetup({ hosts: [host("local", "local", false)], devices: [] }, "not-mac"),
    ).toBe(false);
    expect(
      shouldOfferXcodeSetup({ hosts: [host("local", "local", false)], devices: [] }, "unknown"),
    ).toBe(false);
    expect(shouldOfferXcodeSetup({ hosts: [], devices: [] }, "mac")).toBe(false);
  });
});
