import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type DeviceControlState,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@spiritdevs/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, Profiler, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  stateAtom: null as unknown,
  connectionAtom: null as unknown,
  credentialsAtom: null as unknown,
  command: vi.fn(),
  controls: { error: null },
  navigate: () => {},
  start: vi.fn(),
  stop: vi.fn(),
  streamCommits: vi.fn(),
}));
vi.mock("@spiritdevs/client-runtime/state/device", async (original) => ({
  ...(await original<object>()),
  createDeviceEnvironmentAtoms: () => ({ state: () => harness.stateAtom }),
}));
vi.mock("~/connection/runtime", () => ({
  connectionAtomRuntime: { atom: () => harness.credentialsAtom },
}));
vi.mock("~/state/session", () => ({ environmentSession: {} }));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => harness.connectionAtom },
}));
vi.mock("~/state/presentation", () => ({}));
vi.mock("~/state/primaryEnvironment", () => ({}));
vi.mock("~/state/relay", () => ({}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => harness.command }));
vi.mock("@spiritdevs/client-runtime/device/stream", () => ({
  createDeviceStreamClient: () => ({
    start: harness.start,
    stop: harness.stop,
    sendTouch() {},
    sendRawTouch() {},
    sendKey() {},
    pressButton() {},
    rotate() {},
    setOrientation() {},
    controlDuo() {},
    setMjpegImage() {},
  }),
}));
vi.mock("./DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("./DeviceToolDriftBanner", () => ({ DeviceToolDriftBanner: () => null }));
vi.mock("./DeviceSetup", () => ({ DeviceSetup: () => null }));
vi.mock("./DeviceControlsRail", () => ({ DeviceControlsRail: () => null }));
vi.mock("./DeviceToolsPanel", () => ({ DeviceToolsPanel: () => null }));
vi.mock("./SimBuildBar", () => ({ SimBuildBar: () => null }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../xcode/XcodeSetup", () => ({
  useXcodeHost: () => ({ label: "Test Mac", mac: null, support: "unknown", connected: true }),
  XcodeSetupFlow: () => null,
}));
vi.mock("./useDeviceControls", () => ({ useDeviceControls: () => harness.controls }));
vi.mock("../preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({}) } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("./DeviceStreamView", async (original) => {
  const actual = await original<typeof import("./DeviceStreamView")>();
  return {
    ...actual,
    DeviceStreamView: (props: ComponentProps<typeof actual.DeviceStreamView>) => (
      <Profiler id="stream" onRender={harness.streamCommits}>
        <actual.DeviceStreamView {...props} />
      </Profiler>
    ),
  };
});
import { DevicePanel } from "./DevicePanel";

const environmentId = EnvironmentId.make("environment");
const held: DeviceControlState = {
  hostId: "local",
  deviceId: "phone",
  generation: 8,
  phase: "held",
  owner: { kind: "agent", threadId: "thread-1", runId: "run-1" } as DeviceControlState["owner"],
  expiresAt: 30_000,
};
const published = (controls: DeviceControlState[], revision: number) =>
  AsyncResult.success({
    hosts: [{ id: "local", label: "Local", kind: "local", platforms: [] }],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [
      {
        id: "phone",
        hostId: "local",
        platform: "ios",
        name: "iPhone",
        version: "26",
        booted: true,
      },
    ],
    sessions: [{ hostId: "local", deviceId: "phone", threadId: "thread-1" }],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision,
    supportsDeviceControl: true,
    controls,
  } as unknown as DeviceServiceState);

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const visibility = new EventTarget();
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: visibility.addEventListener.bind(visibility),
    removeEventListener: visibility.removeEventListener.bind(visibility),
  });
  registry = AtomRegistry.make();
  harness.stateAtom = Atom.make(published([held], 1));
  harness.connectionAtom = Atom.make(AsyncResult.success({ phase: "connected", generation: 1 }));
  harness.credentialsAtom = Atom.make(
    AsyncResult.success({
      httpBaseUrl: "http://example.test",
      query: {},
      credentials: true,
      expiresAt: null,
    }),
  );
  harness.command.mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

it("does not re-commit the stream when a publication only renews control", async () => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <DevicePanel
          mode={"docked" as ComponentProps<typeof DevicePanel>["mode"]}
          threadRef={{ environmentId, threadId: "thread-1" } as unknown as ScopedThreadRef}
          surface={
            {
              id: "device-surface",
              kind: "device",
              target: { hostId: "local", deviceId: "phone", platform: "ios", name: "iPhone" },
            } as unknown as ComponentProps<typeof DevicePanel>["surface"]
          }
          visible
          onDismissSetup={() => {}}
        />
      </RegistryContext.Provider>,
      {
        createNodeMock: () => ({
          style: { setProperty() {} },
          getBoundingClientRect: () => ({ width: 400, height: 800 }),
        }),
      },
    );
  });
  const commits = harness.streamCommits.mock.calls.length;
  expect(commits).toBeGreaterThan(0);

  await act(async () =>
    registry.set(
      harness.stateAtom as Atom.Writable<unknown>,
      published([{ ...held, expiresAt: 40_000 }], 2),
    ),
  );
  expect(harness.streamCommits).toHaveBeenCalledTimes(commits);
  expect(harness.start).toHaveBeenCalledOnce();
  expect(harness.stop).not.toHaveBeenCalled();

  // A real change still reaches the stream.
  await act(async () =>
    registry.set(
      harness.stateAtom as Atom.Writable<unknown>,
      published([{ ...held, generation: 9, phase: "draining", owner: null }], 3),
    ),
  );
  expect(harness.streamCommits.mock.calls.length).toBeGreaterThan(commits);
});
