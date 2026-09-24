import { EnvironmentId, ThreadId, type ComputerStatusResult } from "@spiritdevs/contracts";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { threadComputerState } from "./components/computer/computerTestFixtures";
import { computerEnvironmentFence, useComputerStateStore } from "./computerStateStore";

const ENV = EnvironmentId.make("environment-1");
const OTHER_ENV = EnvironmentId.make("environment-2");
const THREAD = ThreadId.make("thread-1");

function status(): ComputerStatusResult {
  const { computerId, availability, capabilities, health } = threadComputerState();
  return { computerId, availability, capabilities, health };
}

afterEach(() => {
  useComputerStateStore.getState().clearEnvironment(ENV);
  useComputerStateStore.getState().clearEnvironment(OTHER_ENV);
});

describe("computerStateStore", () => {
  it("stamps the Escape latch onto the environment's cached thread states", () => {
    const store = useComputerStateStore.getState();
    store.upsertThreadState(ENV, threadComputerState({ threadId: THREAD }));
    store.upsertThreadState(OTHER_ENV, threadComputerState({ threadId: THREAD }));

    store.setInputStopped(ENV, true);
    const stopped = useComputerStateStore.getState();
    expect(stopped.inputStoppedByEnvironment[ENV]).toBe(true);
    expect(
      stopped.threadStates[scopedThreadKey({ environmentId: ENV, threadId: THREAD })],
    ).toMatchObject({ inputStopped: true });
    expect(
      stopped.threadStates[scopedThreadKey({ environmentId: OTHER_ENV, threadId: THREAD })]
        ?.inputStopped,
    ).toBeUndefined();

    // Repeating the same flag is a no-op that preserves store identity.
    store.setInputStopped(ENV, true);
    expect(useComputerStateStore.getState()).toBe(stopped);
  });

  it("keeps store identity when a refresh answers the same status", () => {
    const store = useComputerStateStore.getState();
    store.setStatus(ENV, status());
    const before = useComputerStateStore.getState();
    store.setStatus(ENV, status());
    expect(useComputerStateStore.getState()).toBe(before);

    store.setStatus(ENV, {
      ...status(),
      availability: { kind: "backend-unavailable", message: "Off" },
    });
    expect(useComputerStateStore.getState().statusByEnvironment[ENV]?.availability.kind).toBe(
      "backend-unavailable",
    );
  });

  it("drops the Escape latch, the status and late answers when the environment is reset", () => {
    const store = useComputerStateStore.getState();
    store.upsertThreadState(ENV, threadComputerState({ threadId: THREAD }));
    store.setInputStopped(ENV, true);
    store.setStatus(ENV, status());
    store.setStatus(OTHER_ENV, status());
    const isCurrent = computerEnvironmentFence(ENV);

    store.clearEnvironment(ENV);
    const reset = useComputerStateStore.getState();
    expect(reset.inputStoppedByEnvironment[ENV]).toBeUndefined();
    expect(reset.threadStates).toEqual({});
    expect(reset.statusByEnvironment[ENV]).toBeUndefined();
    expect(reset.statusByEnvironment[OTHER_ENV]).toBeDefined();
    // A status requested before the reset must not repopulate it.
    expect(isCurrent()).toBe(false);
    expect(computerEnvironmentFence(ENV)()).toBe(true);
  });
});
