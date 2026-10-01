import {
  DeviceControlError,
  EnvironmentId,
  type DeviceControlState,
  type DeviceServiceState,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { withDeviceControl } from "@spiritdevs/client-runtime/device/hub-access";
import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DeviceAndroidFoldControls } from "./DeviceAndroidFoldControls";
import { DeviceControlBar } from "./DeviceControlBar";
import {
  DEVICE_CONTROL_RENEW_MS,
  useDeviceControlLease,
  type DeviceControlLease,
} from "./useDeviceControlLease";

type Result =
  | { _tag: "Success"; value: DeviceControlState }
  | { _tag: "Failure"; cause: Cause.Cause<unknown> };
const commands = vi.hoisted(() => ({
  acquire: vi.fn<(request: unknown) => Promise<Result>>(),
  renew: vi.fn<(request: unknown) => Promise<Result>>(),
  release: vi.fn<(request: unknown) => Promise<Result>>(),
  refresh: vi.fn(),
  state: { current: null as unknown },
  stateError: { current: null as string | null },
  connection: { current: null as unknown },
}));
vi.mock("~/state/device", () => ({
  deviceEnvironment: {
    acquireControl: "acquire",
    renewControl: "renew",
    releaseControl: "release",
  },
  useDeviceState: () => ({
    state: commands.state.current,
    loaded: true,
    error: commands.stateError.current,
    refresh: commands.refresh,
  }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: commands.connection.current }),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: (props: { render?: ReactNode; children?: ReactNode }) =>
    props.render ?? props.children,
  TooltipPopup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "acquire" | "renew" | "release") => commands[command],
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Request failed" }));
vi.mock("~/lib/utils", async (original) => ({
  ...(await original<typeof import("~/lib/utils")>()),
  randomUUID: () => "viewer-1",
}));

const environmentId = EnvironmentId.make("environment");
const control = (overrides: Partial<DeviceControlState>): DeviceControlState => ({
  hostId: "local",
  deviceId: "phone",
  generation: 3,
  phase: "held",
  owner: { kind: "agent", threadId: "thread-1", runId: "run-1" } as DeviceControlState["owner"],
  expiresAt: 1,
  ...overrides,
});
const mine = (generation: number) =>
  control({ generation, owner: { kind: "viewer", sessionId: "s", viewerId: "viewer-1" } });
const serviceState = (controls: DeviceControlState[], supported = true) =>
  ({
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
    supportsDeviceControl: supported,
    controls,
  }) as unknown as DeviceServiceState;
const connected = (generation: number) => ({ phase: "connected", generation });
const success = (value: DeviceControlState): Result => ({ _tag: "Success", value });
const failure = (code: DeviceControlError["code"]): Result => ({
  _tag: "Failure",
  cause: Cause.fail(
    new DeviceControlError({ hostId: "local", deviceId: "phone", code, message: code }),
  ),
});
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | undefined;
let lease: DeviceControlLease;
const resume = vi.fn();
function Probe({ visible = true, threadId = "thread-1" }) {
  const next = useDeviceControlLease({
    environmentId,
    hostId: "local",
    deviceId: "phone",
    visible,
  });
  useEffect(() => {
    lease = next;
  }, [next]);
  return (
    <DeviceControlBar
      lease={next}
      threadId={threadId}
      onOpenThread={() => {}}
      onResumeAgent={resume}
    />
  );
}
async function mount(props: { visible?: boolean; threadId?: string } = {}) {
  await act(async () => {
    renderer = create(<Probe {...props} />);
  });
}
const rerender = (props: { visible?: boolean } = {}) =>
  act(async () => renderer!.update(<Probe {...props} />));
const text = () =>
  renderer!.root
    .findAll((node) => typeof node.type === "string" && node.type === "p")
    .map((node) => node.children.join(""))
    .join(" | ");
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const button = (label: string): ReactTestInstance =>
  renderer!.root.find((node) => node.type === "button" && textOf(node).includes(label));
const click = (label: string) => act(async () => button(label).props.onClick());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const command of [commands.acquire, commands.renew, commands.release, commands.refresh])
    command.mockReset();
  resume.mockReset();
  commands.release.mockResolvedValue(success(control({ phase: "idle" })));
  commands.state.current = serviceState([control({})]);
  commands.stateError.current = null;
  commands.connection.current = connected(1);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stays watch-only until the environment confirms this viewer's generation", async () => {
  await mount();
  expect(text()).toContain("This thread's agent is in control");
  expect(lease.control).toBeNull();

  const acquired = deferred();
  commands.acquire.mockReturnValueOnce(acquired.promise);
  await click("Take control");
  expect(commands.acquire).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "phone", viewerId: "viewer-1" },
  });
  expect(button("Taking control…").props.disabled).toBe(true);

  // State can lag the acknowledgement; until it names this viewer, input stays off.
  commands.state.current = serviceState([control({ generation: 3, phase: "draining" })]);
  await act(async () => acquired.resolve(success(mine(4))));
  await rerender();
  expect(lease.control).toBeNull();
  expect(button("Taking control…").props.disabled).toBe(true);

  commands.state.current = serviceState([mine(4)]);
  await rerender();
  expect(lease.control).toEqual({ viewerId: "viewer-1", generation: 4 });
  expect(text()).toContain("You're in control.");
});

it("shows a disabled Take control while another controller drains or the state is unknown", async () => {
  commands.state.current = serviceState([control({ phase: "draining" })]);
  await mount();
  expect(text()).toContain("Finishing the previous controller's input");
  expect(button("Take control").props.disabled).toBe(true);

  commands.state.current = serviceState([]);
  commands.stateError.current = "Disconnected";
  await rerender();
  expect(text()).toContain("Control status is unavailable");
  expect(button("Take control").props.disabled).toBe(true);
  expect(lease.control).toBeNull();
});

it("keeps legacy input and no control UI on environments without leases", async () => {
  commands.state.current = serviceState([], false);
  await mount();
  expect(lease.control).toBeUndefined();
  expect(renderer!.toJSON()).toBeNull();
});

it("renews while held and releases on hide before input resumes", async () => {
  vi.useFakeTimers();
  commands.acquire.mockResolvedValueOnce(success(mine(5)));
  await mount();
  await click("Take control");
  commands.state.current = serviceState([mine(5)]);
  await rerender();
  expect(lease.control).not.toBeNull();

  commands.renew.mockResolvedValue(success(mine(5)));
  await act(async () => vi.advanceTimersByTime(DEVICE_CONTROL_RENEW_MS));
  expect(commands.renew).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "phone", viewerId: "viewer-1", generation: 5 },
  });

  commands.release.mockResolvedValueOnce(success(control({ generation: 6, phase: "idle" })));
  await rerender({ visible: false });
  expect(lease.control).toBeNull();
  expect(commands.release).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "phone", viewerId: "viewer-1", generation: 5 },
  });
  await act(async () => vi.advanceTimersByTime(DEVICE_CONTROL_RENEW_MS * 2));
  expect(commands.renew).toHaveBeenCalledOnce();
});

it("releases on unmount and when hidden while still taking control", async () => {
  const acquired = deferred();
  commands.acquire.mockReturnValueOnce(acquired.promise);
  commands.release.mockResolvedValue(success(control({ phase: "idle" })));
  await mount();
  await click("Take control");
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => acquired.resolve(success(mine(7))));
  expect(commands.release).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "phone", viewerId: "viewer-1", generation: 7 },
  });
});

it("resumes the agent only after the release is acknowledged", async () => {
  commands.acquire.mockResolvedValueOnce(success(mine(8)));
  await mount();
  await click("Take control");
  commands.state.current = serviceState([mine(8)]);
  await rerender();

  const released = deferred();
  commands.release.mockReturnValueOnce(released.promise);
  await click("Resume agent");
  expect(lease.control).toBeNull();
  expect(button("Releasing control…").props.disabled).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  await act(async () => released.resolve(success(control({ generation: 9, phase: "idle" }))));
  expect(resume).toHaveBeenCalledOnce();
});

it("does not resume the agent when the release fails", async () => {
  commands.acquire.mockResolvedValueOnce(success(mine(8)));
  await mount();
  await click("Take control");
  commands.state.current = serviceState([mine(8)]);
  await rerender();
  commands.release.mockResolvedValueOnce(failure("input_unconfirmed"));
  await click("Resume agent");
  expect(resume).not.toHaveBeenCalled();
  expect(text()).toContain("couldn't confirm the last input finished");
});

it("re-reads state on a stale generation and reports a takeover by another viewer", async () => {
  commands.acquire.mockResolvedValueOnce(failure("stale_generation"));
  await mount();
  await click("Take control");
  expect(commands.refresh).toHaveBeenCalledOnce();
  expect(text()).toContain("Your control of this device ended");

  commands.acquire.mockResolvedValueOnce(success(mine(10)));
  await click("Take control");
  commands.state.current = serviceState([mine(10)]);
  await rerender();
  expect(lease.control).not.toBeNull();

  commands.state.current = serviceState([
    control({
      generation: 11,
      owner: { kind: "viewer", sessionId: "other", viewerId: "viewer-2" },
    }),
  ]);
  await rerender();
  expect(lease.control).toBeNull();
  expect(text()).toContain("Someone else took control of this device.");
  expect(text()).toContain("Someone else is in control. You're watching.");
});

it("links to another thread whose agent is in control", async () => {
  commands.state.current = serviceState([
    control({ owner: { kind: "agent", threadId: "thread-2", runId: "run-9" } as never }),
  ]);
  await mount();
  expect(text()).toContain("An agent in another thread is in control");
  expect(button("Open thread")).toBeDefined();
});

async function holding(generation: number) {
  commands.acquire.mockResolvedValueOnce(success(mine(generation)));
  await click("Take control");
  commands.state.current = serviceState([mine(generation)]);
  await rerender();
  expect(lease.control?.generation).toBe(generation);
}

it.each(["stale_generation", "control_held", "control_required"] as const)(
  "does not resume the agent when release fails with %s",
  async (code) => {
    await mount();
    await holding(8);
    commands.release.mockResolvedValueOnce(failure(code));
    await click("Resume agent");
    expect(resume).not.toHaveBeenCalled();
    expect(lease.control).toBeNull();
    expect(lease.error).not.toBeNull();
  },
);

it("shares an in-flight release with later callers", async () => {
  await mount();
  await holding(8);
  const released = deferred();
  commands.release.mockReturnValueOnce(released.promise);
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = lease.release();
  });
  await act(async () => {
    second = lease.release();
  });
  await act(async () => released.resolve(failure("stale_generation")));
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(commands.release).toHaveBeenCalledOnce();
});

it("ends control when the environment connection drops or is replaced", async () => {
  await mount();
  await holding(8);
  commands.connection.current = { phase: "backoff", generation: 1 };
  await rerender();
  expect(lease.control).toBeNull();
  expect(text()).toContain("Control status is unavailable");
  expect(text()).toContain("Lost the connection to the environment");
  expect(button("Take control").props.disabled).toBe(true);

  // The same snapshot after reconnecting does not restore the old lease.
  commands.connection.current = connected(2);
  await rerender();
  expect(lease.control).toBeNull();
  expect(button("Take control").props.disabled).toBe(false);
  await holding(9);
});

it("drops control when the connection changes while acquiring", async () => {
  const acquired = deferred();
  commands.acquire.mockReturnValueOnce(acquired.promise);
  await mount();
  await click("Take control");
  commands.connection.current = connected(2);
  commands.state.current = serviceState([mine(7)]);
  await rerender();
  await act(async () => acquired.resolve(success(mine(7))));
  expect(lease.control).toBeNull();
  expect(text()).toContain("Lost the connection to the environment");
});

it("treats a renewal that fails without a control code as lost control", async () => {
  vi.useFakeTimers();
  await mount();
  await holding(8);
  commands.renew.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("gone")) });
  await act(async () => vi.advanceTimersByTimeAsync(DEVICE_CONTROL_RENEW_MS));
  expect(lease.control).toBeNull();
  expect(text()).toContain("Lost the connection to the environment");
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a late renewal failure from a released lease", async () => {
  vi.useFakeTimers();
  await mount();
  await holding(8);
  const oldRenew = deferred();
  commands.renew.mockReturnValueOnce(oldRenew.promise);
  await act(async () => vi.advanceTimersByTime(DEVICE_CONTROL_RENEW_MS));
  await click("Release control");
  commands.state.current = serviceState([control({ generation: 9, phase: "idle", owner: null })]);
  await rerender();
  await holding(10);
  await act(async () => oldRenew.resolve(failure("stale_generation")));
  expect(lease.control?.generation).toBe(10);
  expect(commands.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
});

it("ignores control errors reported for an older generation", async () => {
  await mount();
  await holding(10);
  await act(async () => lease.reportError("stale_generation", 8));
  expect(lease.control?.generation).toBe(10);
  await act(async () => lease.reportError("stale_generation", 10));
  expect(lease.control).toBeNull();
  expect(commands.refresh).toHaveBeenCalledOnce();
});

it("hands back an acquisition hidden and shown again before it returned", async () => {
  const acquired = deferred();
  commands.acquire.mockReturnValueOnce(acquired.promise);
  await mount();
  await click("Take control");
  await rerender({ visible: false });
  await rerender({ visible: true });
  expect(button("Take control").props.disabled).toBe(false);
  commands.state.current = serviceState([mine(7)]);
  await act(async () => acquired.resolve(success(mine(7))));
  expect(lease.control).toBeNull();
  expect(commands.release).toHaveBeenCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "phone", viewerId: "viewer-1", generation: 7 },
  });
});

it("drops control and re-reads state when a fold is refused as stale", async () => {
  vi.stubGlobal("window", globalThis);
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (init.method !== "POST")
      return Response.json({
        ok: true,
        fold: { supported: true, posture: "opened", hingeAngle: 180 },
      });
    posts.push(url);
    return new Response("stale_generation", { status: 409 });
  });
  const access = {
    httpBase: "https://environment.test/api/device-hub",
    wsBase: "wss://environment.test/api/device-hub",
    query: { hostId: "local" },
    credentials: true,
    expiresAt: null,
  };
  function FoldProbe() {
    lease = useDeviceControlLease({
      environmentId,
      hostId: "local",
      deviceId: "phone",
      visible: true,
    });
    const proof = lease.control;
    return (
      <DeviceAndroidFoldControls
        access={withDeviceControl(access, proof ?? null)}
        deviceId="phone"
        visible
        enabled
        canChange={proof !== null}
        onControlError={proof ? (code) => lease.reportError(code, proof.generation) : undefined}
        screenWidth={400}
        screenHeight={800}
        onFoldAngle={() => {}}
      />
    );
  }
  commands.acquire.mockResolvedValueOnce(success(mine(8)));
  commands.state.current = serviceState([mine(8)]);
  await act(async () => {
    renderer = create(<FoldProbe />);
  });
  await act(async () => {
    await lease.take();
  });
  const fold = () =>
    renderer!.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Fold device",
    );
  await act(async () => fold().props.onClick());
  expect(new URL(posts[0]!).searchParams.get("controlGeneration")).toBe("8");
  expect(commands.refresh).toHaveBeenCalledOnce();
  expect(lease.control).toBeNull();
  expect(lease.error).toContain("Your control of this device ended");
  expect(fold().props.disabled).toBe(true);
});
