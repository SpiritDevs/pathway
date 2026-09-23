import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { threadComputerState } from "~/components/computer/computerTestFixtures";

const harness = vi.hoisted(() => {
  let effects: Array<{ deps: readonly unknown[]; cleanup: (() => void) | void }> = [];
  let cursor = 0;
  return {
    generation: null as number | null,
    registry: {},
    runAtomCommand: vi.fn(),
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      effects = [];
      cursor = 0;
    },
    useEffect(effect: () => (() => void) | void, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = effects[index];
      if (previous && previous.deps.every((dep, i) => Object.is(dep, deps[i]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: effect() };
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useContext: () => harness.registry,
  useEffect: harness.useEffect,
}));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: harness.runAtomCommand,
}));
vi.mock("./useComputerEventBridge", () => ({
  useConnectedGeneration: () => harness.generation,
}));

const { useComputerStateStore } = await import("../computerStateStore");
const { useThreadComputerStateSeed } = await import("./useThreadComputerStateSeed");

const ENV = EnvironmentId.make("environment-1");
const THREAD = ThreadId.make("reconnect-thread");
const REF = { environmentId: ENV, threadId: THREAD };

function render(ref: typeof REF | null = REF) {
  harness.beginRender();
  useThreadComputerStateSeed(ref);
}

beforeEach(() => {
  harness.reset();
  harness.generation = null;
  harness.runAtomCommand.mockReset();
  harness.runAtomCommand.mockResolvedValue(
    AsyncResult.success(threadComputerState({ threadId: THREAD })),
  );
});

afterEach(() => {
  harness.reset();
  useComputerStateStore.getState().clearEnvironment(ENV);
});

it("restores thread state and server event interests after reconnect", async () => {
  harness.generation = 1;
  render();
  render();
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);
  expect(harness.runAtomCommand.mock.calls[0]?.[2]).toEqual({
    environmentId: ENV,
    input: { threadId: THREAD },
  });
  await vi.waitFor(() =>
    expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeDefined(),
  );

  harness.generation = null;
  render();
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);

  harness.generation = 2;
  render();
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(2);
  expect(harness.runAtomCommand).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    { environmentId: ENV, input: { threadId: THREAD } },
    { reportFailure: false },
  );

  harness.reset();
  harness.generation = 3;
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(2);
});

it("drops an answer that lands after the surface unmounted", async () => {
  let resolve!: (value: unknown) => void;
  harness.runAtomCommand.mockReturnValue(new Promise((next) => (resolve = next)));
  harness.generation = 1;
  render();
  harness.reset();
  resolve(AsyncResult.success(threadComputerState({ threadId: THREAD })));
  await Promise.resolve();
  await Promise.resolve();
  expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeUndefined();
});

it("keeps the cache on a failed seed and asks nothing without a thread", async () => {
  harness.runAtomCommand.mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
  harness.generation = 1;
  render();
  await Promise.resolve();
  expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeUndefined();

  harness.reset();
  render(null);
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);
});
