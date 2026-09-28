import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DeviceToolSyncSettings } from "../settings/DeviceToolSyncSettings";
import { DeviceToolDriftBanner } from "./DeviceToolDriftBanner";
import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";

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
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "failed" }));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("~/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => <span /> }));
vi.mock("../settings/settingsLayout", () => ({
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
type Result = { _tag: "Success" } | { _tag: "Failure"; cause: string };
const label = (operation: Operation) => (operation === "update" ? "Update" : "Restart");
const progress = (operation: Operation) => (operation === "update" ? "Updating" : "Restarting");
const other = (operation: Operation): Operation => (operation === "update" ? "restart" : "update");
const snapshot = (operation: Operation) =>
  operation === "update" ? state("different", false) : state("match", true);
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

it.each<Operation>(["update", "restart"])(
  "Settings preserves %s progress and success summary across opposite snapshots",
  async (operation) => {
    const finish = hold(operation);
    await mount("Settings", snapshot(operation));
    await click(label(operation));
    expect(summary()).toBe(`${progress(operation)} 1 host… 0 of 1 finished.`);
    expect(texts()).toContain(`${progress(operation)}…`);
    await push("Settings", snapshot(other(operation)));
    expect.soft(summary()).toBe(`${progress(operation)} 1 host… 0 of 1 finished.`);
    expect.soft(texts()).toContain(`${progress(operation)}…`);
    expect.soft(Boolean(button(label(other(operation))))).toBe(false);
    expect.soft(button("Update all").props.disabled).toBe(true);
    expect.soft(mocks[other(operation)]).not.toHaveBeenCalled();
    await finish({ _tag: "Success" });
    expect(summary()).toBe(`${operation === "update" ? "Updated" : "Restarted"} 1 host.`);
  },
);

it.each<Operation>(["update", "restart"])(
  "Settings Retry repeats failed %s after opposite snapshot",
  async (operation) => {
    const finish = hold(operation);
    await mount("Settings", snapshot(operation));
    await click(label(operation));
    await push("Settings", snapshot(other(operation)));
    await finish({ _tag: "Failure", cause: "failed" });
    expect(summary()).toBe(`${label(operation)} failed on 1 host.`);
    expect(button("Retry")).toBeDefined();
    mocks[other(operation)].mockResolvedValue({ _tag: "Success" });
    await click("Retry");
    expect.soft(mocks[operation]).toHaveBeenCalledTimes(2);
    expect.soft(mocks[other(operation)]).not.toHaveBeenCalled();
    if (mocks[operation].mock.calls.length === 2) await finish({ _tag: "Success" });
  },
);

it.each<Operation>(["update", "restart"])(
  "banner preserves pending %s progress across opposite snapshots",
  async (operation) => {
    const finish = hold(operation);
    await mount("banner", snapshot(operation));
    await click(label(operation));
    expect(button(`${progress(operation)}…`)?.props.disabled).toBe(true);
    await push("banner", snapshot(other(operation)));
    expect.soft(button(`${progress(operation)}…`)?.props.disabled).toBe(true);
    expect.soft(Boolean(button(label(other(operation))))).toBe(false);
    expect.soft(mocks[other(operation)]).not.toHaveBeenCalled();
    await finish({ _tag: "Success" });
  },
);

it.each<Operation>(["update", "restart"])(
  "banner Retry preserves failed %s after opposite snapshot",
  async (operation) => {
    const finish = hold(operation);
    await mount("banner", snapshot(operation));
    await click(label(operation));
    await push("banner", snapshot(other(operation)));
    await finish({ _tag: "Failure", cause: "failed" });
    expect.soft(texts()).toContain("failed");
    expect.soft(button("Retry")).toBeDefined();
    if (button("Retry")) {
      mocks[other(operation)].mockResolvedValue({ _tag: "Success" });
      await click("Retry");
      expect.soft(mocks[operation]).toHaveBeenCalledTimes(2);
      expect.soft(mocks[other(operation)]).not.toHaveBeenCalled();
      await finish({ _tag: "Success" });
    }
  },
);

it.each(["Settings", "banner"] as const)(
  "%s retains same-kind pending controls and Retry",
  async (component) => {
    const finish = hold("restart");
    await mount(component, snapshot("restart"));
    await click("Restart");
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(texts()).toContain("Restarting…");
    if (component === "banner") expect(button("Restarting…").props.disabled).toBe(true);
    else expect(button("Restart")).toBeUndefined();
    await finish({ _tag: "Failure", cause: "failed" });
    expect(texts()).toContain("failed");
    expect(button("Retry").props.disabled).not.toBe(true);
    await click("Retry");
    expect(mocks.restart).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
    await finish({ _tag: "Success" });
  },
);

it.each([false, undefined])(
  "supportsToolRestart=%s hides Settings restart and preserves older-server banner guidance",
  async (capability) => {
    const next = { ...snapshot("restart"), supportsToolRestart: capability };
    await mount("Settings", next);
    expect(button("Restart")).toBeUndefined();
    expect(button("Update all").props.disabled).toBe(true);
    await act(async () => renderer.unmount());
    await mount("banner", next);
    expect(button("Restart")).toBeUndefined();
    expect(texts()).toContain(
      "Turn device support off and on in Settings after finishing active work",
    );
    expect(mocks.restart).not.toHaveBeenCalled();
  },
);

const healthy = () => state("match", false);
const multi = (entries: ReadonlyArray<readonly [string, Operation | "current"]>) => ({
  ...healthy(),
  hosts: entries.map(([id, op]) => ({
    ...(op === "current" ? healthy() : snapshot(op)).hosts[0]!,
    id,
    label: id,
    kind: "ssh" as const,
  })),
});
const targetIds = (operation: Operation) =>
  mocks[operation].mock.calls.map(([call]) => call.input.hostId);

it("banner: after resolved drift, a new host's drift must not retry the old host", async () => {
  mocks.update.mockResolvedValue({ _tag: "Failure", cause: "failed" });
  await mount(
    "banner",
    multi([
      ["a", "update"],
      ["b", "current"],
    ]),
  );
  await click("Update");
  await push(
    "banner",
    multi([
      ["a", "current"],
      ["b", "current"],
    ]),
  );
  expect(renderer.toJSON()).toBeNull();
  await push(
    "banner",
    multi([
      ["a", "current"],
      ["b", "update"],
    ]),
  );
  mocks.update.mockResolvedValue({ _tag: "Success" });
  await click(button("Update") ? "Update" : "Retry");
  expect(targetIds("update")).toEqual(["a", "b"]);
});

it.each(["Settings", "banner"] as const)(
  "%s: failed update must not supersede a fresh restart after an all-current snapshot",
  async (component) => {
    mocks.update.mockResolvedValue({ _tag: "Failure", cause: "failed" });
    mocks.restart.mockResolvedValue({ _tag: "Success" });
    await mount(component, snapshot("update"));
    await click("Update");
    await push(component, state("match", false));
    expect(button("Retry")).toBeUndefined();
    await push(component, snapshot("restart"));
    mocks.update.mockResolvedValue({ _tag: "Success" });
    await click(button("Restart") ? "Restart" : "Retry");
    expect.soft(mocks.restart).toHaveBeenCalledTimes(1);
    expect.soft(mocks.update).toHaveBeenCalledTimes(1);
  },
);

it("banner: failure received while hidden must not attach its targets to new drift", async () => {
  const finish = hold("restart");
  await mount(
    "banner",
    multi([
      ["a", "restart"],
      ["b", "current"],
    ]),
  );
  await click("Restart");
  await push(
    "banner",
    multi([
      ["a", "current"],
      ["b", "current"],
    ]),
  );
  await finish({ _tag: "Failure", cause: "failed" });
  expect(renderer.toJSON()).toBeNull();
  await push(
    "banner",
    multi([
      ["a", "current"],
      ["b", "restart"],
    ]),
  );
  mocks.restart.mockResolvedValue({ _tag: "Success" });
  await click(button("Restart") ? "Restart" : "Retry");
  expect(targetIds("restart")).toEqual(["a", "b"]);
});

it.each([false, undefined])(
  "banner: capability %s must prevent Retry from issuing an unsupported restart",
  async (capability) => {
    mocks.restart.mockResolvedValue({ _tag: "Failure", cause: "failed" });
    await mount("banner", snapshot("restart"));
    await click("Restart");
    await push("banner", { ...snapshot("restart"), supportsToolRestart: capability });
    expect(texts()).toContain(
      "Turn device support off and on in Settings after finishing active work",
    );
    expect.soft(Boolean(button("Retry"))).toBe(false);
    if (button("Retry")) await click("Retry");
    expect(mocks.restart).toHaveBeenCalledTimes(1);
  },
);

it.each([false, undefined])(
  "Settings: capability %s must prevent Retry from issuing an unsupported restart after drift flips",
  async (capability) => {
    mocks.restart.mockResolvedValue({ _tag: "Failure", cause: "failed" });
    mocks.update.mockResolvedValue({ _tag: "Success" });
    await mount("Settings", snapshot("restart"));
    await click("Restart");
    await push("Settings", { ...snapshot("update"), supportsToolRestart: capability });
    await click(button("Update") ? "Update" : "Retry");
    expect(mocks.restart).toHaveBeenCalledTimes(1);
  },
);

it.each<Operation>(["update", "restart"])(
  "banner: resolved original %s hosts must not be retried because a different host still drifts",
  async (operation) => {
    mocks[operation].mockResolvedValue({ _tag: "Failure", cause: "failed" });
    await mount(
      "banner",
      multi([
        ["a", operation],
        ["b", "current"],
      ]),
    );
    await click(label(operation));
    await push(
      "banner",
      multi([
        ["a", "current"],
        ["b", operation],
      ]),
    );
    expect(renderer.toJSON()).not.toBeNull();
    mocks[operation].mockResolvedValue({ _tag: "Success" });
    await click(button(label(operation)) ? label(operation) : "Retry");
    expect(targetIds(operation)).toEqual(["a", "b"]);
  },
);

it("banner: an old failure arriving after its target resolves must not attach to unrelated remaining drift", async () => {
  const finish = hold("restart");
  await mount(
    "banner",
    multi([
      ["a", "restart"],
      ["b", "current"],
    ]),
  );
  await click("Restart");
  await push(
    "banner",
    multi([
      ["a", "current"],
      ["b", "update"],
    ]),
  );
  expect(button("Restarting…").props.disabled).toBe(true);
  await finish({ _tag: "Failure", cause: "failed" });
  mocks.restart.mockResolvedValue({ _tag: "Success" });
  mocks.update.mockResolvedValue({ _tag: "Success" });
  await click(button("Update") ? "Update" : "Retry");
  expect.soft(targetIds("restart")).toEqual(["a"]);
  expect.soft(targetIds("update")).toEqual(["b"]);
});
