import { EnvironmentId, type DeviceServiceState } from "@spiritdevs/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ command: vi.fn(() => Promise.resolve({ _tag: "Success" })) }));
vi.mock("~/state/device", () => ({ deviceEnvironment: { installPlatform: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => harness.command }));
vi.mock("./DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));

const { AndroidInstallAction } = await import("./DeviceSetup");

const environmentId = EnvironmentId.make("environment-1");
const state = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      platforms: [
        { platform: "ios", available: true },
        {
          platform: "android",
          available: false,
          reason: "Android SDK Command-line Tools (latest) are missing.",
          installable: true,
        },
      ],
      hubInstalled: true,
      agentDeviceInstalled: false,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 1,
  ...overrides,
});

const render = (value: DeviceServiceState) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AndroidInstallAction environmentId={environmentId} state={value} />);
  });
  return renderer;
};
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

it("starts the install on the host that supports it", async () => {
  const renderer = render(state());
  const button = renderer.root.findByType("button");
  expect(text(renderer)).toContain("Set up Android");
  await act(async () => button.props.onClick());
  expect(harness.command).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", platform: "android" },
  });
});

it("shows the environment's progress instead of the button while installing", () => {
  const renderer = render(
    state({
      platformInstalls: [
        {
          hostId: "local",
          platform: "android",
          status: "installing",
          detail: "Downloading the Android Emulator and a system image…",
        },
      ],
    }),
  );
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  expect(text(renderer)).toContain("Downloading the Android Emulator and a system image…");
});

it("explains a failed install and offers a retry", () => {
  const renderer = render(
    state({
      platformInstalls: [
        { hostId: "local", platform: "android", status: "failed", detail: "Couldn't download." },
      ],
    }),
  );
  expect(text(renderer)).toContain("Couldn't download.");
  expect(text(renderer)).toContain("Try again");
});

it("offers nothing when no host can install Android", () => {
  const value = state();
  const renderer = render({
    ...value,
    hosts: value.hosts.map((host) => ({
      ...host,
      platforms: host.platforms.map(({ installable: _, ...platform }) => platform),
    })),
  });
  expect(renderer.toJSON()).toBeNull();
});
