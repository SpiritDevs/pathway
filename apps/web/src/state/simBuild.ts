import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { createSimBuildEnvironmentAtoms } from "@spiritdevs/client-runtime/state/simBuild";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

export const simBuildEnvironment = createSimBuildEnvironmentAtoms(connectionAtomRuntime);

/**
 * "Run on simulator" from the command palette opens the thread's Devices panel; the panel takes the
 * request once an iOS simulator is showing and opens its run form.
 */
export const useSimBuildRequestStore = create<{
  readonly requestedThreadKeys: ReadonlySet<string>;
  readonly request: (threadKey: string) => void;
  readonly take: (threadKey: string) => boolean;
}>((set, get) => ({
  requestedThreadKeys: new Set(),
  request: (threadKey) =>
    set((state) => ({ requestedThreadKeys: new Set(state.requestedThreadKeys).add(threadKey) })),
  take: (threadKey) => {
    const keys = get().requestedThreadKeys;
    if (!keys.has(threadKey)) return false;
    const next = new Set(keys);
    next.delete(threadKey);
    set({ requestedThreadKeys: next });
    return true;
  },
}));

/** Shows the thread's iOS simulator, or the device picker, and asks it to open the run form. */
export function requestSimulatorRun(ref: ScopedThreadRef): void {
  useSimBuildRequestStore.getState().request(scopedThreadKey(ref));
  const panels = useRightPanelStore.getState();
  const simulator = selectThreadRightPanelState(panels.byThreadKey, ref).surfaces.find(
    (surface) => surface.kind === "device" && surface.target?.platform === "ios",
  );
  if (simulator?.kind === "device" && simulator.target) panels.openDevice(ref, simulator.target);
  else panels.open(ref, "device");
}
