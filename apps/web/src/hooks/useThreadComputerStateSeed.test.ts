import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const { readComputerControlGenerationForSend, useThreadComputerStateSeed } =
  await import("./useThreadComputerStateSeed");
const { resolveComputerControlForSend } = await import("./useComputerControlModeChange.logic");

const ENV = EnvironmentId.make("environment-1");
const THREAD = ThreadId.make("reconnect-thread");
const REF = { environmentId: ENV, threadId: THREAD };

function render(ref: typeof REF | null = REF) {
  harness.beginRender();
  useThreadComputerStateSeed(ref);
}

/** The seed chained its `.then` on this answer first, so it has run once this resumes. */
async function seedAnswered(): Promise<void> {
  await harness.runAtomCommand.mock.results.at(-1)?.value;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
  await seedAnswered();
  expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeDefined();

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
  await seedAnswered();
  expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeUndefined();
});

it("keeps the cache on a failed seed and asks nothing without a thread", async () => {
  harness.runAtomCommand.mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
  harness.generation = 1;
  render();
  await seedAnswered();
  expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeUndefined();

  harness.reset();
  render(null);
  expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);
});

describe("readComputerControlGenerationForSend", () => {
  // A stopped thread sits at generation 1 and refuses intent pinned to 0.
  const stopped = threadComputerState({ threadId: THREAD, controlGeneration: 1 });
  const computerSend = {
    ref: REF,
    messageText: "/computer-use open Calculator",
    computerControlEnabled: false,
    draftGeneration: undefined,
  };
  const read = (input: Partial<Parameters<typeof readComputerControlGenerationForSend>[1]> = {}) =>
    readComputerControlGenerationForSend(harness.registry as never, {
      ...computerSend,
      ...input,
    });

  it("asks the server for an unseeded thread's generation before a Computer send", async () => {
    harness.runAtomCommand.mockResolvedValue(AsyncResult.success(stopped));
    const generation = await read();
    expect(generation).toBe(1);
    expect(
      resolveComputerControlForSend({
        messageText: "/computer-use open Calculator",
        computerControlEnabled: false,
        generation,
      }).fields,
    ).toEqual({ computerControlGeneration: 1 });
    expect(
      useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]?.controlGeneration,
    ).toBe(1);
  });

  it("asks nothing when this connection confirmed the generation, the send has no intent, or the thread is new", async () => {
    useComputerStateStore
      .getState()
      .upsertThreadState(ENV, threadComputerState({ threadId: THREAD, controlGeneration: 2 }));
    expect(await read()).toBe(2);
    expect(await read({ messageText: "summarise the README" })).toBeUndefined();
    expect(await read({ ref: null, draftGeneration: 3 })).toBe(3);
    expect(harness.runAtomCommand).not.toHaveBeenCalled();
  });

  it("asks the server when the only generation was carried across a reconnect", async () => {
    // Another device's Stop advanced the thread to 2 while this one was away.
    useComputerStateStore
      .getState()
      .upsertThreadState(
        ENV,
        threadComputerState({ threadId: THREAD, version: 9, controlGeneration: 1 }),
      );
    useComputerStateStore.getState().rebaseEnvironment(ENV);
    harness.runAtomCommand.mockResolvedValue(
      AsyncResult.success(threadComputerState({ threadId: THREAD, controlGeneration: 2 })),
    );
    expect(await read({ messageText: "open Notes", computerControlEnabled: true })).toBe(2);
    expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);
  });

  it("asks the server rather than trust a server thread's drafted generation", async () => {
    harness.runAtomCommand.mockResolvedValue(
      AsyncResult.success(threadComputerState({ threadId: THREAD, controlGeneration: 2 })),
    );
    expect(await read({ draftGeneration: 1 })).toBe(2);
    expect(harness.runAtomCommand).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["removed", () => useComputerStateStore.getState().clearEnvironment(ENV)],
    ["disconnected", () => useComputerStateStore.getState().rebaseEnvironment(ENV)],
  ])("stores nothing when the environment was %s while the read was pending", async (_, leave) => {
    const answer = deferred<unknown>();
    harness.runAtomCommand.mockReturnValue(answer.promise);
    const generation = read();
    leave();
    answer.resolve(
      AsyncResult.success(
        threadComputerState({ threadId: THREAD, version: 9, controlGeneration: 1 }),
      ),
    );
    expect(await generation).toBeUndefined();
    expect(useComputerStateStore.getState().threadStates[scopedThreadKey(REF)]).toBeUndefined();
  });

  it("leaves the generation unknown when the server cannot answer", async () => {
    harness.runAtomCommand.mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
    expect(
      await read({ messageText: "open Calculator", computerControlEnabled: true }),
    ).toBeUndefined();
  });
});
