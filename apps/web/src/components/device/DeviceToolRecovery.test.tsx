import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DeviceToolSyncSettings } from "~/components/settings/DeviceToolSyncSettings";
import { DeviceToolDriftBanner } from "~/components/device/DeviceToolDriftBanner";
import {
  DeviceControlError,
  type DeviceServiceState,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  state: null as DeviceServiceState | null,
  restart: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  environments: [
    {
      environmentId: "review",
      label: "Review",
      connection: { phase: "connected" },
      serverConfig: { deviceWorkspace: true },
    },
  ],
}));
vi.mock("~/state/device", () => ({
  deviceEnvironment: { restartTools: "restart", updateTools: "update", list: "list" },
  useDeviceState: () => ({ state: mocks.state, loaded: true }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "restart" | "update" | "list") => mocks[command],
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("~/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => <span /> }));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsRow: ({
    status,
    children,
    control,
  }: {
    status: string;
    children: React.ReactNode;
    control: React.ReactNode;
  }) => (
    <section>
      <output>{status}</output>
      {control}
      {children}
    </section>
  ),
}));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const state = (
  status: "match" | "different",
  restartRequired: boolean,
  supportsToolRestart = true,
): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      label: "Local",
      kind: "local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
      drift: [{ tool: "hub", status, expected: "2.0.0", actual: ["2.0.0"], restartRequired }],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
  supportsEnvironmentToolSync: true,
  supportsToolRestart,
});
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.resetAllMocks();
});
const texts = () => JSON.stringify(renderer.toJSON());
const button = (label: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.join("") === label)!;

type Operation = "update" | "restart";
type Result = { _tag: "Success" } | { _tag: "Failure"; cause: unknown };
const hold = (operation: Operation) => {
  let finish!: (result: Result) => void;
  mocks[operation].mockImplementation(
    () =>
      new Promise<Result>((resolve) => {
        finish = resolve;
      }),
  );
  return async (result: Result) => {
    await act(async () => finish(result));
  };
};
const summary = () => renderer.root.findByType("output").children.join("");
const mount = async (component: "Settings" | "banner", next: DeviceServiceState) => {
  mocks.state = next;
  await act(async () => {
    renderer = create(
      component === "Settings" ? (
        <DeviceToolSyncSettings />
      ) : (
        <DeviceToolDriftBanner state={next} environmentId={"review" as EnvironmentId} />
      ),
    );
  });
};
const push = async (component: "Settings" | "banner", next: DeviceServiceState) => {
  mocks.state = next;
  await act(async () =>
    renderer.update(
      component === "Settings" ? (
        <DeviceToolSyncSettings />
      ) : (
        <DeviceToolDriftBanner state={next} environmentId={"review" as EnvironmentId} />
      ),
    ),
  );
};
const click = async (name: string) => {
  await act(async () => button(name).props.onClick());
};

// Restart recovered phone-a, but the environment still can't confirm phone-b's input finished.
const stalled = {
  hostId: "local",
  deviceId: "phone-b",
  generation: 12,
  phase: "draining" as const,
  owner: null,
  expiresAt: null,
};
const recovered = { ...stalled, deviceId: "phone-a", generation: 11, phase: "idle" as const };
const partial = (
  restartRequired: boolean,
  controls: DeviceServiceState["controls"] = [recovered, stalled],
): DeviceServiceState => ({
  ...state("match", restartRequired),
  supportsDeviceControl: true,
  controls,
});
const refusal = (deviceId = "phone-b") => ({
  _tag: "Failure" as const,
  cause: Cause.fail(
    new DeviceControlError({
      hostId: "local",
      deviceId,
      code: "input_unconfirmed",
      message:
        "Device input completion could not be confirmed. Restart device tools before taking control.",
    }),
  ),
});
const UNCONFIRMED = "Device input completion could not be confirmed";

/** Restarts while drift remains, then the versions turn current before the refusal lands. */
const failWithCurrentVersions = async (component: "Settings" | "banner", deviceId?: string) => {
  const finish = hold("restart");
  await mount(component, partial(true));
  await click("Restart");
  await push(component, partial(false));
  await finish(refusal(deviceId));
};

describe.each(["Settings", "banner"] as const)(
  "%s after a partial control recovery",
  (component) => {
    it("shows the failure while version drift remains", async () => {
      mocks.restart.mockResolvedValue(refusal());
      await mount(component, partial(true));
      await click("Restart");
      expect(texts()).toContain(UNCONFIRMED);
      expect(button("Retry")).toBeDefined();
      if (component === "Settings") expect(summary()).toBe("Restart failed on 1 host.");
    });

    it("keeps the failure retryable once versions are current, while the device is fenced", async () => {
      await failWithCurrentVersions(component);
      expect(texts()).toContain(UNCONFIRMED);
      mocks.restart.mockResolvedValue({ _tag: "Success" });
      await click("Retry");
      expect(mocks.restart).toHaveBeenLastCalledWith({
        environmentId: "review",
        input: { hostId: "local" },
      });
    });

    it("retires the failure once the fenced device recovers", async () => {
      await failWithCurrentVersions(component);
      await push(component, partial(false, [recovered, { ...stalled, phase: "idle" }]));
      expect(texts()).not.toContain(UNCONFIRMED);
      expect(button("Retry")).toBeUndefined();
      if (component === "banner") expect(renderer.toJSON()).toBeNull();
    });

    it("retires a recovered device's failure while another device on the host stays fenced", async () => {
      await failWithCurrentVersions(component, "phone-a");
      expect(texts()).not.toContain(UNCONFIRMED);
      expect(button("Retry")).toBeUndefined();
    });

    it("dismisses the failure", async () => {
      await failWithCurrentVersions(component);
      await click("Dismiss");
      expect(texts()).not.toContain(UNCONFIRMED);
      expect(button("Retry")).toBeUndefined();
      if (component === "banner") expect(renderer.toJSON()).toBeNull();
    });
  },
);
