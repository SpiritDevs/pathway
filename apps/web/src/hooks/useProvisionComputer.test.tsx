// Pins the one "Set up computer control" command both surfaces share: the
// status-store write that repaints them, the ready callback, who gets toasts,
// and the single-flight guard across surfaces. Observed from outside React
// (the store, the toast manager, the RPC), so server rendering is enough;
// each test awaits the settling promise `provision` hands back.

import {
  ComputerId,
  EnvironmentId,
  type ComputerProvisionResult,
  type ComputerStatusResult,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const provisionCommand = vi.hoisted(() => vi.fn());
const refreshCommand = vi.hoisted(() => vi.fn());
const toastAdd = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ isElectron: false, primaryEnvironmentId: null as string | null }));

vi.mock("../env", () => ({
  get isElectron() {
    return host.isElectron;
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => host.primaryEnvironmentId,
}));

vi.mock("../state/computer", () => ({
  computerEnvironment: { provision: "provision", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "provision" ? provisionCommand : refreshCommand,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: toastAdd } }));

import { useComputerStateStore } from "../computerStateStore";
import { useProvisionComputer } from "./useProvisionComputer";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: ComputerId.make("desktop"),
    availability: { kind: "available", backend: "mac" },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function blockedStatus(): ComputerStatusResult {
  return status({
    availability: {
      kind: "permission-required",
      missing: ["accessibility"],
      message: "macOS is asking for Accessibility.",
      buildSignature: "adhoc",
    },
  });
}

const succeed = (value: unknown) => AsyncResult.success(value);
const fail = (error: unknown) => AsyncResult.failure(Cause.fail(error));

/** Mounts the hook once and hands back the result it produced on that render. */
function mountProvisionHook(
  options?: Parameters<typeof useProvisionComputer>[1],
): ReturnType<typeof useProvisionComputer> {
  const captured: { current: ReturnType<typeof useProvisionComputer> | null } = { current: null };
  function Probe() {
    captured.current = useProvisionComputer(ENVIRONMENT_ID, options);
    return <span />;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured.current) throw new Error("useProvisionComputer probe did not render.");
  return captured.current;
}

function storedStatus() {
  return useComputerStateStore.getState().statusByEnvironment[ENVIRONMENT_ID];
}

beforeEach(() => {
  provisionCommand.mockReset();
  refreshCommand.mockReset();
  toastAdd.mockReset();
  useComputerStateStore.getState().clearEnvironment(ENVIRONMENT_ID);
});

afterEach(() => {
  host.isElectron = false;
  host.primaryEnvironmentId = null;
  vi.unstubAllGlobals();
});

/** Runs as the desktop app whose own server is the environment under test. */
function onHostDesktop() {
  host.isElectron = true;
  host.primaryEnvironmentId = ENVIRONMENT_ID;
  vi.stubGlobal("window", { desktopBridge: { computer: {} } });
}

describe("useProvisionComputer", () => {
  it("re-reads status under native setup instead of trusting the RPC's older snapshot", async () => {
    onHostDesktop();
    const newer = status();
    provisionCommand.mockResolvedValue(
      succeed({ summary: "Still missing.", status: blockedStatus() }),
    );
    refreshCommand.mockResolvedValue(succeed(newer));
    await mountProvisionHook({ notify: true }).provision();
    expect(storedStatus()).toBe(newer);
    expect(refreshCommand).toHaveBeenCalledOnce();
    // The native guide carries on; an incomplete RPC result raises no second toast.
    expect(toastAdd).toHaveBeenCalledTimes(1);
  });

  it("keeps a native grant pushed while the chat card's setup was in flight", async () => {
    onHostDesktop();
    let finish!: (value: unknown) => void;
    provisionCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const granted = status();
    refreshCommand.mockResolvedValue(succeed(granted));
    // The chat card's options: it never says whether native setup applies.
    const settled = mountProvisionHook({ notify: true, missing: ["accessibility"] }).provision();
    useComputerStateStore.getState().setStatus(ENVIRONMENT_ID, granted);
    finish(succeed({ summary: "Still missing.", status: blockedStatus() }));
    await settled;
    expect(storedStatus()).toBe(granted);
    expect(refreshCommand).toHaveBeenCalledOnce();
    expect(toastAdd).toHaveBeenCalledTimes(1);
  });

  it("trusts the RPC's status on an environment the desktop does not host", async () => {
    onHostDesktop();
    host.primaryEnvironmentId = "environment-other";
    const result: ComputerProvisionResult = { summary: "Still missing.", status: blockedStatus() };
    provisionCommand.mockResolvedValue(succeed(result));
    await mountProvisionHook({ notify: true }).provision();
    expect(storedStatus()).toBe(result.status);
    expect(refreshCommand).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledTimes(2);
  });

  it("drops the answer when the environment was cleared while setup ran", async () => {
    onHostDesktop();
    let finish!: (value: unknown) => void;
    provisionCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    refreshCommand.mockResolvedValue(succeed(status()));
    const settled = mountProvisionHook().provision();
    useComputerStateStore.getState().clearEnvironment(ENVIRONMENT_ID);
    finish(succeed({ summary: "Granted.", status: status() }));
    await settled;
    expect(storedStatus()).toBeUndefined();
  });

  it("writes the status the call returned straight into the store", async () => {
    const result: ComputerProvisionResult = { summary: "Granted.", status: status() };
    provisionCommand.mockResolvedValue(succeed(result));
    await mountProvisionHook().provision();
    expect(storedStatus()).toBe(result.status);
    expect(provisionCommand).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: {},
    });
    expect(refreshCommand).not.toHaveBeenCalled();
  });

  it("runs onReady when the desktop came back with nothing left to set up", async () => {
    provisionCommand.mockResolvedValue(succeed({ summary: "Granted.", status: status() }));
    const onReady = vi.fn();
    await mountProvisionHook({ onReady }).provision();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("leaves onReady alone when a grant is still missing", async () => {
    const result: ComputerProvisionResult = { summary: "Still missing.", status: blockedStatus() };
    provisionCommand.mockResolvedValue(succeed(result));
    const onReady = vi.fn();
    await mountProvisionHook({ onReady }).provision();
    expect(storedStatus()).toBe(result.status);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("stays silent unless the surface asked to be notified", async () => {
    provisionCommand.mockResolvedValue(succeed({ summary: "Granted.", status: status() }));
    await mountProvisionHook().provision();
    expect(storedStatus()).toBeDefined();
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("raises the opening toast before the call, then one for the outcome", async () => {
    provisionCommand.mockResolvedValue(succeed({ summary: "Granted.", status: status() }));
    const settled = mountProvisionHook({ notify: true, missing: ["accessibility"] }).provision();
    // Synchronously: the call's visible effect is a macOS dialog over Pathway.
    expect(toastAdd).toHaveBeenCalledTimes(1);
    await settled;
    expect(toastAdd).toHaveBeenCalledTimes(2);
    expect(toastAdd.mock.calls[1]?.[0]).toMatchObject({ type: "success" });
  });

  it("reports a failed provision and writes nothing to the store", async () => {
    provisionCommand.mockResolvedValue(fail(new Error("no toolchain")));
    await mountProvisionHook({ notify: true }).provision();
    expect(toastAdd).toHaveBeenCalledTimes(2);
    expect(toastAdd.mock.calls[1]?.[0]).toMatchObject({
      type: "error",
      description: "no toolchain",
    });
    expect(storedStatus()).toBeUndefined();
  });

  it("clears a failed attempt so setup can be retried", async () => {
    provisionCommand.mockResolvedValueOnce(fail(new Error("Helper disconnected")));
    await mountProvisionHook().provision();
    provisionCommand.mockResolvedValueOnce(succeed({ summary: "Ready.", status: status() }));
    await mountProvisionHook().provision();
    expect(provisionCommand).toHaveBeenCalledTimes(2);
    expect(storedStatus()).toBeDefined();
  });

  it("shares pending setup across surfaces before either component rerenders", async () => {
    let finish!: (result: unknown) => void;
    provisionCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const card = mountProvisionHook({ notify: true });
    const settings = mountProvisionHook({ notify: true });
    const settled = card.provision();
    await settings.provision();
    await card.provision();
    expect(provisionCommand).toHaveBeenCalledOnce();
    expect(toastAdd).toHaveBeenCalledOnce();
    finish(succeed({ summary: "Ready.", status: status() }));
    await settled;
    // Once settled, the next press starts a fresh attempt.
    provisionCommand.mockResolvedValue(succeed({ summary: "Ready.", status: status() }));
    await card.provision();
    expect(provisionCommand).toHaveBeenCalledTimes(2);
  });
});
