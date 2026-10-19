// The composer's availability subscription through the real hook and the real
// zustand binding. zustand calls React from outside the module graph, so React's
// own hook dispatcher is pointed at a slot-tracked harness that re-renders the
// way React does: when the store changes and the snapshot is a new value.

import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import React from "react";
import { afterEach, expect, it } from "vite-plus/test";

import { threadComputerState } from "~/components/computer/computerTestFixtures";
import { useComputerStateStore, useThreadComputerAvailability } from "../computerStateStore";

const ENV = EnvironmentId.make("environment-1");
const ref = { environmentId: ENV, threadId: ThreadId.make("availability-test") };

const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** Mounts `hook` and re-renders it whenever its store snapshot changes identity. */
function mount<T>(hook: () => T) {
  const slots: Array<{ current: unknown }> = [];
  let cursor = 0;
  let getSnapshot: () => unknown = () => undefined;
  let rendered: unknown;
  let unsubscribe: (() => void) | undefined;
  const result = { renders: 0, value: undefined as T, unmount: () => unsubscribe?.() };
  const dispatcher = {
    useRef: (initial: unknown) => (slots[cursor++] ??= { current: initial }),
    useCallback: <F>(callback: F) => callback,
    useDebugValue: () => undefined,
    useSyncExternalStore: (subscribe: (onChange: () => void) => () => void, get: () => unknown) => {
      getSnapshot = get;
      rendered = get();
      unsubscribe ??= subscribe(() => {
        if (!Object.is(getSnapshot(), rendered)) render();
      });
      return rendered;
    },
  };
  const render = () => {
    cursor = 0;
    result.renders += 1;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      result.value = hook();
    } finally {
      internals.H = previous;
    }
  };
  render();
  return result;
}

afterEach(() => useComputerStateStore.getState().clearEnvironment(ENV));

it("does not render the composer subscription for activity and geometry updates", () => {
  const initial = threadComputerState({ threadId: ref.threadId });
  useComputerStateStore.getState().upsertThreadState(ENV, initial);
  const probe = mount(() => useThreadComputerAvailability(ref));
  try {
    for (let version = 2; version < 10; version++) {
      useComputerStateStore.getState().upsertThreadState(ENV, {
        ...initial,
        version,
        availability: { kind: "available" },
        agentActive: true,
        cursor: { x: version, y: version },
      });
    }
    expect(probe.renders).toBe(1);

    useComputerStateStore.getState().upsertThreadState(ENV, {
      ...initial,
      version: 10,
      availability: { kind: "backend-unavailable", message: "Disconnected" },
    });
    expect(probe.renders).toBe(2);
    expect(probe.value).toEqual({ kind: "backend-unavailable", message: "Disconnected" });
  } finally {
    probe.unmount();
  }
});
