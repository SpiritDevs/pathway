import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@spiritdevs/client-runtime/connection";
import { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "~/connection/desktopLocal";

import { isThisMachineTarget } from "./browserPlacement";

const environmentId = EnvironmentId.make("environment-1");

describe("isThisMachineTarget", () => {
  it("treats the desktop's own backends as this machine", () => {
    expect(
      isThisMachineTarget(
        new PrimaryConnectionTarget({
          environmentId,
          label: "This device",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      ),
    ).toBe(true);
    expect(
      isThisMachineTarget(
        new BearerConnectionTarget({
          environmentId,
          label: "WSL (Ubuntu)",
          connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
        }),
      ),
    ).toBe(true);
  });

  it("treats saved, SSH and Pathway Connect environments as another machine", () => {
    expect(
      isThisMachineTarget(
        new BearerConnectionTarget({ environmentId, label: "Studio Mac", connectionId: "saved-1" }),
      ),
    ).toBe(false);
    expect(
      isThisMachineTarget(
        new SshConnectionTarget({ environmentId, label: "Build box", connectionId: "ssh-1" }),
      ),
    ).toBe(false);
    expect(
      isThisMachineTarget(new RelayConnectionTarget({ environmentId, label: "Studio Mac" })),
    ).toBe(false);
    expect(isThisMachineTarget(undefined)).toBe(false);
  });
});
