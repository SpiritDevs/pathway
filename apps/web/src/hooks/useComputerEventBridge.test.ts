import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import {
  ComputerId,
  EnvironmentId,
  ThreadId,
  type ComputerEvent,
  type DesktopComputerHelperState,
} from "@spiritdevs/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { threadComputerState } from "~/components/computer/computerTestFixtures";
import {
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "../computerPreviewStore";
import { useComputerStateStore } from "../computerStateStore";
import {
  applyComputerEvent,
  subscribeComputerEnvironmentEvents,
  subscribeComputerPermissionStatus,
  subscribeComputerPreviewSessions,
} from "./useComputerEventBridge";

const ENV = EnvironmentId.make("environment-1");
const OTHER_ENV = EnvironmentId.make("environment-2");
const THREAD = ThreadId.make("thread-1");
const REF = { environmentId: ENV, threadId: THREAD };

function grantState(
  overrides: Partial<DesktopComputerHelperState> = {},
): DesktopComputerHelperState {
  return {
    supported: true,
    status: "ready",
    message: null,
    appDisplayName: "Pathway",
    accessibilityPermission: "granted",
    inputMonitoringPermission: "granted",
    screenRecordingPermission: "granted",
    ...overrides,
  };
}

function bridgeFixture(refresh: () => void) {
  let onState!: (state: DesktopComputerHelperState) => void;
  const unsubscribe = vi.fn();
  const stop = subscribeComputerPermissionStatus(refresh, {
    onState: (listener) => {
      onState = listener;
      return unsubscribe;
    },
  });
  return { onState, stop, unsubscribe };
}

function previewSession(ref = REF) {
  return selectThreadComputerPreviewSession(ref)(useComputerPreviewStore.getState());
}

afterEach(() => {
  useComputerStateStore.getState().clearEnvironment(ENV);
  useComputerStateStore.getState().clearEnvironment(OTHER_ENV);
  useComputerPreviewStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("native Computer permission status bridge", () => {
  it("refreshes on a grant change and coalesces unchanged snapshots", () => {
    const refresh = vi.fn();
    const bridge = bridgeFixture(refresh);
    bridge.onState(grantState());
    expect(refresh).toHaveBeenCalledTimes(1);
    bridge.onState(grantState({ status: "ready", message: "still ready" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    bridge.onState(grantState({ accessibilityPermission: "denied" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    bridge.stop();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores snapshots that never asked about Accessibility", () => {
    const refresh = vi.fn();
    const bridge = bridgeFixture(refresh);
    const { accessibilityPermission: _accessibility, ...withoutAccessibility } = grantState({
      screenRecordingPermission: "denied",
    });
    bridge.onState(withoutAccessibility);
    bridge.onState(grantState({ supported: false }));
    expect(refresh).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("is inert in a browser without the desktop Computer bridge", () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    const refresh = vi.fn();
    const stop = subscribeComputerPermissionStatus(refresh);
    stop();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("applyComputerEvent", () => {
  it("scopes pushed thread state and the Escape latch to the environment", () => {
    const refresh = vi.fn();
    applyComputerEvent(
      ENV,
      { type: "computer.thread-state", state: threadComputerState({ threadId: THREAD }) },
      refresh,
    );
    applyComputerEvent(ENV, { type: "computer.input-stopped", stopped: true }, refresh);

    const store = useComputerStateStore.getState();
    expect(store.threadStates[scopedThreadKey(REF)]?.threadId).toBe(THREAD);
    expect(
      store.threadStates[scopedThreadKey({ ...REF, environmentId: OTHER_ENV })],
    ).toBeUndefined();
    expect(store.inputStoppedByEnvironment[ENV]).toBe(true);
    expect(store.inputStoppedByEnvironment[OTHER_ENV]).toBeUndefined();
    expect(refresh).toHaveBeenCalledWith(ENV);
  });

  it("arms the owning thread's preview on a pane request", () => {
    applyComputerEvent(ENV, { type: "computer.open-pane-requested", threadId: THREAD }, vi.fn());
    expect(previewSession()?.phase).toBe("armed");
    expect(previewSession({ ...REF, environmentId: OTHER_ENV })).toBeUndefined();
  });

  it("ignores frames on the RPC channel", () => {
    const before = useComputerStateStore.getState();
    applyComputerEvent(
      ENV,
      {
        type: "computer.frame",
        computerId: ComputerId.make("desktop"),
      } as unknown as ComputerEvent,
      vi.fn(),
    );
    expect(useComputerStateStore.getState()).toBe(before);
  });
});

describe("subscribeComputerPreviewSessions", () => {
  it("feeds seeded and pushed states into edge detection and ends removed sessions", () => {
    const stop = subscribeComputerPreviewSessions();
    try {
      useComputerStateStore
        .getState()
        .upsertThreadState(ENV, threadComputerState({ threadId: THREAD, agentActive: true }));
      expect(previewSession()?.phase).toBe("armed");

      useComputerStateStore
        .getState()
        .upsertThreadState(
          ENV,
          threadComputerState({ threadId: THREAD, version: 2, agentActive: false }),
        );
      expect(previewSession()?.phase).toBe("ended");

      useComputerStateStore.getState().clearEnvironment(ENV);
      expect(previewSession()).toBeUndefined();
    } finally {
      stop();
    }
  });
});

describe("subscribeComputerEnvironmentEvents", () => {
  it("delivers each pushed event once, even when its result is re-announced", () => {
    const registry = AtomRegistry.make();
    const events = Atom.make<AsyncResult.AsyncResult<ComputerEvent, never>>(
      AsyncResult.initial(false),
    );
    const received: ComputerEvent[] = [];
    const stop = subscribeComputerEnvironmentEvents(registry, events, (event) =>
      received.push(event),
    );
    const first: ComputerEvent = { type: "computer.input-stopped", stopped: true };
    const second: ComputerEvent = { type: "computer.input-stopped", stopped: false };
    registry.set(events, AsyncResult.success(first));
    registry.set(events, AsyncResult.success(first, { waiting: true }));
    registry.set(events, AsyncResult.success(second));
    stop();
    registry.set(events, AsyncResult.success(first));
    expect(received).toEqual([first, second]);
  });
});
