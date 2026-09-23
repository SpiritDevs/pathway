import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { shallow } from "zustand/shallow";

import { threadComputerState } from "~/components/computer/computerTestFixtures";
import { useComputerStateStore } from "../computerStateStore";

const ENV = EnvironmentId.make("environment-1");
const ref = { environmentId: ENV, threadId: ThreadId.make("availability-test") };

afterEach(() => useComputerStateStore.getState().clearEnvironment(ENV));

// `useThreadComputerAvailability` subscribes through `useShallow`, so its
// component re-renders exactly when the shallow comparison below fails. There
// is no DOM renderer in this suite; the render count is derived the same way.
it("does not render the composer subscription for activity and geometry updates", () => {
  const initial = threadComputerState({ threadId: ref.threadId });
  const select = () =>
    useComputerStateStore.getState().threadStates[scopedThreadKey(ref)]?.availability;
  useComputerStateStore.getState().upsertThreadState(ENV, initial);
  let rendered = select();
  let renders = 0;
  const stop = useComputerStateStore.subscribe(() => {
    const next = select();
    if (shallow(rendered, next)) return;
    rendered = next;
    renders += 1;
  });
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
    expect(renders).toBe(0);

    useComputerStateStore.getState().upsertThreadState(ENV, {
      ...initial,
      version: 10,
      availability: { kind: "backend-unavailable", message: "Disconnected" },
    });
    expect(renders).toBe(1);
    expect(rendered).toEqual({ kind: "backend-unavailable", message: "Disconnected" });
  } finally {
    stop();
  }
});
