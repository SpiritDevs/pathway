// One environment's Computer event pipe across its connection lifecycle: a
// reconnect keeps what the user sees, leaving the catalog clears everything,
// and a status answer requested before a clear never lands after it. The hook
// runs for real under a slot-tracked React harness; the connection state and
// the RPC command are stubbed.

import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
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
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));

const { useComputerPreviewStore } = await import("../computerPreviewStore");
const { useComputerStateStore } = await import("../computerStateStore");
const { refreshComputerStatus, subscribeComputerPreviewSessions, useComputerEnvironmentEvents } =
  await import("./useComputerEventBridge");

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

afterEach(() => {
  harness.unmount();
  harness.connection = { phase: "connected", generation: 1 };
  harness.runAtomCommand.mockReset();
  useComputerStateStore.getState().clearEnvironment(ENV);
  useComputerPreviewStore.getState().clear();
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
});
