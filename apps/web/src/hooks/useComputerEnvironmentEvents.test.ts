// One environment's Computer event pipe across its connection lifecycle: a
// reconnect keeps what the user sees, leaving the catalog clears everything,
// and a status answer requested before a clear never lands after it. The root
// bridge applies the desktop's local grant pushes to its own primary only. The
// hooks run for real under a slot-tracked React harness; the connection state,
// the primary environment and the RPC command are stubbed.

import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { isComputerThreadStateCurrent } from "@spiritdevs/client-runtime/state/computer-state";
import {
  EnvironmentId,
  ThreadId,
  type ComputerStatusResult,
  type DesktopComputerHelperState,
} from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { threadComputerState } from "~/components/computer/computerTestFixtures";

const harness = vi.hoisted(() => {
  let slots: Array<{
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    ref?: { current: unknown };
  }> = [];
  let cursor = 0;
  return {
    connection: { phase: "connected", generation: 1 } as { phase: string; generation: number },
    primary: null as string | null,
    registry: { subscribe: () => () => undefined },
    runAtomCommand: vi.fn(),
    beginRender() {
      cursor = 0;
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useRef<T>(value: T) {
      const slot = (slots[cursor++] ??= {});
      return (slot.ref ??= { current: value }) as { current: T };
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (
        slot.deps?.length === deps.length &&
        slot.deps.every((dep, index) => Object.is(dep, deps[index]))
      ) {
        return;
      }
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useContext: () => harness.registry,
  useEffect: harness.useEffect,
  useRef: harness.useRef,
}));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: {},
  useAtomValue: () => AsyncResult.success(harness.connection),
}));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: harness.runAtomCommand,
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { stateAtom: () => ({}) } }));
vi.mock("~/state/computer", () => ({
  computerEnvironment: { events: () => ({}), refreshStatus: {} },
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => harness.primary }));

const { useComputerPreviewStore } = await import("../computerPreviewStore");
const { useComputerStateStore } = await import("../computerStateStore");
const {
  refreshComputerStatus,
  subscribeComputerPreviewSessions,
  useComputerEnvironmentEvents,
  useComputerEventBridge,
} = await import("./useComputerEventBridge");

const ENV = EnvironmentId.make("environment-1");
const THREAD = ThreadId.make("thread-1");
const REF = { environmentId: ENV, threadId: THREAD };
const KEY = scopedThreadKey(REF);

function render() {
  harness.beginRender();
  useComputerEnvironmentEvents(ENV);
}

function driving(version: number, agentActive = true) {
  return threadComputerState({
    threadId: THREAD,
    version,
    agentActive,
    ...(agentActive ? { controlOwnerThreadId: THREAD } : {}),
  });
}

const REMOTE_ENV = EnvironmentId.make("environment-remote");

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  harness.unmount();
  harness.connection = { phase: "connected", generation: 1 };
  harness.primary = null;
  harness.runAtomCommand.mockReset();
  useComputerStateStore.getState().clearEnvironment(ENV);
  useComputerStateStore.getState().clearEnvironment(REMOTE_ENV);
  useComputerPreviewStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("useComputerEnvironmentEvents", () => {
  it("keeps a live preview, its float and layout across a reconnect", () => {
    const stop = subscribeComputerPreviewSessions();
    try {
      render();
      useComputerStateStore.getState().upsertThreadState(ENV, driving(7));
      const preview = useComputerPreviewStore.getState();
      preview.requestPreviewSurface(REF);
      preview.markPreviewLive(REF);
      preview.setPreviewFloating(REF, { x: 40, y: 60 });
      preview.notePreviewLayout(REF, { hasFrame: true, width: 320 });
      useComputerStateStore.getState().setInputStopped(ENV, true);

      harness.connection = { phase: "disconnected", generation: 1 };
      render();
      harness.connection = { phase: "connected", generation: 2 };
      render();

      const after = useComputerPreviewStore.getState();
      expect(after.sessionsByThreadKey[KEY]?.phase).toBe("live");
      expect(after.floatingByThreadKey[KEY]).toEqual({ x: 40, y: 60 });
      expect(after.previewLayoutByThreadKey[KEY]).toEqual({ hasFrame: true, width: 320 });
      expect(useComputerStateStore.getState().threadStates[KEY]).toBeDefined();
      expect(useComputerStateStore.getState().inputStoppedByEnvironment[ENV]).toBeUndefined();

      // A restarted server numbers from scratch; its snapshot still replaces
      // the kept state, and a finished task ends the preview.
      useComputerStateStore.getState().upsertThreadState(ENV, driving(0, false));
      expect(useComputerStateStore.getState().threadStates[KEY]?.version).toBe(0);
      expect(useComputerPreviewStore.getState().sessionsByThreadKey[KEY]?.phase).toBe("ended");
    } finally {
      stop();
    }
  });

  it("stops trusting a thread's generation as soon as the connection drops", () => {
    render();
    useComputerStateStore.getState().upsertThreadState(ENV, driving(7));
    harness.connection = { phase: "disconnected", generation: 1 };
    render();
    const kept = useComputerStateStore.getState().threadStates[KEY];
    expect(kept).toBeDefined();
    expect(isComputerThreadStateCurrent(kept!)).toBe(false);
  });

  it("clears everything of the environment when it leaves the catalog", () => {
    render();
    useComputerStateStore.getState().upsertThreadState(ENV, driving(1));
    useComputerPreviewStore.getState().requestPreviewSurface(REF);
    harness.unmount();
    expect(useComputerStateStore.getState().threadStates[KEY]).toBeUndefined();
    expect(useComputerPreviewStore.getState().sessionsByThreadKey[KEY]).toBeUndefined();
  });
});

describe("refreshComputerStatus", () => {
  it("drops a status answer that lands after the environment was cleared", async () => {
    let answer!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    harness.runAtomCommand.mockReturnValue(pending);
    refreshComputerStatus(harness.registry as never, ENV);
    useComputerStateStore.getState().clearEnvironment(ENV);
    answer(AsyncResult.success({ availability: { kind: "ready" } }));
    // The bridge's `.then` was queued first, so it has run once this resumes.
    await pending;
    expect(useComputerStateStore.getState().statusByEnvironment[ENV]).toBeUndefined();
  });

  it("drops a status answer the previous connection owed", async () => {
    const answer = deferred<unknown>();
    harness.runAtomCommand.mockReturnValue(answer.promise);
    render();
    refreshComputerStatus(harness.registry as never, ENV);
    harness.connection = { phase: "disconnected", generation: 1 };
    render();
    harness.connection = { phase: "connected", generation: 2 };
    render();
    const fresh = { availability: { kind: "available" } } as ComputerStatusResult;
    useComputerStateStore.getState().setStatus(ENV, fresh);
    answer.resolve(
      AsyncResult.success({ availability: { kind: "backend-unavailable", message: "old host" } }),
    );
    await answer.promise;
    expect(useComputerStateStore.getState().statusByEnvironment[ENV]).toBe(fresh);
  });
});

describe("useComputerEventBridge", () => {
  function status(): ComputerStatusResult {
    const { computerId, availability, capabilities, health } = driving(1);
    return { computerId, availability, capabilities, health };
  }

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

  /** Mounts the root bridge in a desktop app whose primary is `primary`. */
  function mountBridge(primary: EnvironmentId | null) {
    harness.primary = primary;
    const onState = vi.fn<(listener: (state: DesktopComputerHelperState) => void) => () => void>(
      () => () => undefined,
    );
    vi.stubGlobal("window", {
      desktopBridge: { computer: { onState, onError: () => () => undefined } },
    });
    harness.beginRender();
    useComputerEventBridge();
    return {
      onState,
      push: (state: DesktopComputerHelperState) => onState.mock.calls[0]?.[0](state),
    };
  }

  it("does not apply local grant pushes to a remote Computer host", () => {
    harness.runAtomCommand.mockReturnValue(new Promise(() => undefined));
    useComputerStateStore.getState().setStatus(REMOTE_ENV, status());
    const bridge = mountBridge(ENV);

    // The primary has no status yet, so nothing is asked; the remote host's
    // grants are not this Mac's and are never refreshed from its pushes.
    bridge.push(grantState({ accessibilityPermission: "denied" }));
    expect(harness.runAtomCommand).not.toHaveBeenCalled();

    useComputerStateStore.getState().setStatus(ENV, status());
    bridge.push(grantState());
    expect(harness.runAtomCommand).toHaveBeenCalledExactlyOnceWith(
      harness.registry,
      expect.anything(),
      { environmentId: ENV, input: {} },
      { reportFailure: false },
    );
  });

  it("does not listen for local grants without a primary environment", () => {
    const bridge = mountBridge(null);
    expect(bridge.onState).not.toHaveBeenCalled();
  });
});
