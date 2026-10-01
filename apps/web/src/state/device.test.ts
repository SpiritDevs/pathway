import type { DeviceControlState, DeviceServiceState } from "@spiritdevs/contracts";
import * as Equal from "effect/Equal";
import { AsyncResult } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";
import { selectDeviceControl } from "./device";

const control = (overrides: Partial<DeviceControlState> = {}): DeviceControlState => ({
  hostId: "local",
  deviceId: "phone",
  generation: 3,
  phase: "held",
  owner: { kind: "viewer", sessionId: "s", viewerId: "viewer-1" },
  expiresAt: 1_000,
  ...overrides,
});
const published = (controls: DeviceControlState[]) =>
  AsyncResult.success({
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
    supportsDeviceControl: true,
    controls,
  } satisfies DeviceServiceState);
const select = (controls: DeviceControlState[]) =>
  selectDeviceControl(published(controls), "local", "phone");

it("ignores renewals and other devices, but not a change of control", () => {
  const before = select([control()]);
  expect(Equal.equals(before, select([control({ expiresAt: 11_000 })]))).toBe(true);
  expect(
    Equal.equals(before, select([control(), control({ deviceId: "tablet", phase: "draining" })])),
  ).toBe(true);
  expect(Equal.equals(before, select([control({ generation: 4 })]))).toBe(false);
  expect(Equal.equals(before, select([control({ phase: "draining" })]))).toBe(false);
});
