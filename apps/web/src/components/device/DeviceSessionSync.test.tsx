import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type DeviceServiceState } from "@spiritdevs/contracts";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { useRightPanelStore, selectThreadRightPanelState } from "~/rightPanelStore";
vi.mock("~/state/device", () => ({ useDeviceState: () => ({ state, loaded: true }) }));
import { useDeviceSessionSync } from "./DeviceSessionSync";
const ref = scopeThreadRef(EnvironmentId.make("test"), ThreadId.make("thread"));
const device = {
  id: "same-device",
  hostId: "local",
  platform: "ios" as const,
  name: "iPhone",
  version: "27",
  booted: true,
  physical: false,
};
let state: DeviceServiceState;
let renderer: ReactTestRenderer;
const panels = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
function Sync() {
  useDeviceSessionSync(ref);
  return null;
}
const render = () =>
  act(async () => {
    if (renderer) renderer.update(<Sync />);
    else renderer = create(<Sync />);
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  state = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [device],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: false,
    hubBasePath: "/api/device-hub",
    revision: 0,
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined!;
  vi.unstubAllGlobals();
});
it("opens new sessions, respects dismissal, and removes remotely closed sessions", async () => {
  await render();
  state = {
    ...state,
    sessions: [
      {
        threadId: ref.threadId,
        hostId: "local",
        deviceId: device.id,
        platform: "ios",
        openedAt: "now",
      },
    ],
  };
  await render();
  expect(panels().surfaces).toHaveLength(1);
  useRightPanelStore.getState().closeSurface(ref, panels().surfaces[0]!.id);
  state = { ...state, devices: [{ ...device, name: "Renamed" }] };
  await render();
  expect(panels().surfaces).toHaveLength(0);
  state = { ...state, sessions: [] };
  await render();
  state = {
    ...state,
    sessions: [
      {
        threadId: ref.threadId,
        hostId: "local",
        deviceId: device.id,
        platform: "ios",
        openedAt: "later",
      },
    ],
  };
  await render();
  expect(panels().surfaces).toHaveLength(1);
  state = { ...state, sessions: [] };
  await render();
  expect(panels().isOpen).toBe(false);
});
it("waits for device metadata and keeps identically named devices on different hosts separate", async () => {
  await render();
  state = {
    ...state,
    sessions: [
      {
        threadId: ref.threadId,
        hostId: "remote",
        deviceId: device.id,
        platform: "ios",
        openedAt: "now",
      },
    ],
  };
  await render();
  expect(panels().surfaces).toHaveLength(0);
  state = { ...state, devices: [device, { ...device, hostId: "remote" }] };
  await render();
  expect(panels().surfaces[0]?.id).toBe("device:remote:same-device");
  useRightPanelStore
    .getState()
    .openDevice(ref, { hostId: "local", deviceId: device.id, platform: "ios", name: device.name });
  expect(panels().surfaces).toHaveLength(2);
});
