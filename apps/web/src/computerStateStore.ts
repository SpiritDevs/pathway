import {
  EMPTY_COMPUTER_CLIENT_STATE,
  applyComputerWindowsChanged,
  clearComputerEnvironment,
  rebaseComputerEnvironment,
  recordComputerAction,
  removeComputerThreadState,
  setComputerInputStopped,
  upsertComputerThreadState,
  type ComputerClientState,
} from "@spiritdevs/client-runtime/state/computer-state";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type {
  ComputerActionEvent,
  ComputerStatusResult,
  ComputerWindow,
  EnvironmentId,
  ScopedThreadRef,
  ThreadComputerState,
} from "@spiritdevs/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

interface ComputerStateStore extends ComputerClientState {
  /**
   * The last `computer.getStatus` answer per environment, written by whichever
   * surface fetched it. Reading status can start the desktop helper, so
   * surfaces that only describe the desktop read this instead of asking.
   */
  readonly statusByEnvironment: Readonly<Record<string, ComputerStatusResult>>;
  readonly upsertThreadState: (environmentId: EnvironmentId, state: ThreadComputerState) => void;
  readonly applyWindowsChanged: (
    environmentId: EnvironmentId,
    windows: readonly ComputerWindow[],
  ) => void;
  readonly setInputStopped: (environmentId: EnvironmentId, stopped: boolean) => void;
  readonly recordAction: (environmentId: EnvironmentId, action: ComputerActionEvent) => void;
  readonly removeThreadState: (ref: ScopedThreadRef) => void;
  readonly setStatus: (environmentId: EnvironmentId, status: ComputerStatusResult) => void;
  /** A new connection generation: keep what shows, let snapshots replace it. */
  readonly rebaseEnvironment: (environmentId: EnvironmentId) => void;
  /** The environment left: nothing of it may linger, nor land later. */
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
}

// Bumped when an environment is cleared, so an answer requested before the
// clear cannot repopulate it.
const environmentEpochs = new Map<EnvironmentId, number>();

/**
 * A check that an asynchronous status answer still belongs: false once the
 * environment was cleared after the request went out.
 */
export function computerEnvironmentFence(environmentId: EnvironmentId): () => boolean {
  const epoch = environmentEpochs.get(environmentId) ?? 0;
  return () => (environmentEpochs.get(environmentId) ?? 0) === epoch;
}

export const useComputerStateStore = create<ComputerStateStore>()((set) => ({
  ...EMPTY_COMPUTER_CLIENT_STATE,
  statusByEnvironment: {},
  upsertThreadState: (environmentId, state) =>
    set((current) => upsertComputerThreadState(current, environmentId, state)),
  applyWindowsChanged: (environmentId, windows) =>
    set((current) => applyComputerWindowsChanged(current, environmentId, windows)),
  setInputStopped: (environmentId, stopped) =>
    set((current) => setComputerInputStopped(current, environmentId, stopped)),
  recordAction: (environmentId, action) =>
    set((current) => recordComputerAction(current, environmentId, action)),
  removeThreadState: (ref) => set((current) => removeComputerThreadState(current, ref)),
  setStatus: (environmentId, status) =>
    set((current) =>
      current.statusByEnvironment[environmentId] === status
        ? current
        : { statusByEnvironment: { ...current.statusByEnvironment, [environmentId]: status } },
    ),
  rebaseEnvironment: (environmentId) =>
    set((current) => rebaseComputerEnvironment(current, environmentId)),
  clearEnvironment: (environmentId) =>
    set((current) => {
      environmentEpochs.set(environmentId, (environmentEpochs.get(environmentId) ?? 0) + 1);
      const next = clearComputerEnvironment(current, environmentId);
      if (!Object.hasOwn(current.statusByEnvironment, environmentId)) return next;
      const statusByEnvironment = { ...current.statusByEnvironment };
      delete statusByEnvironment[environmentId];
      return { ...next, statusByEnvironment };
    }),
}));

export function selectThreadComputerState(
  ref: ScopedThreadRef,
): (store: ComputerStateStore) => ThreadComputerState | undefined {
  const key = scopedThreadKey(ref);
  return (store) => store.threadStates[key];
}

export function selectThreadComputerAction(
  ref: ScopedThreadRef,
): (store: ComputerStateStore) => ComputerActionEvent | undefined {
  const key = scopedThreadKey(ref);
  return (store) => store.lastActions[key];
}

export function useThreadComputerState(ref: ScopedThreadRef | null) {
  return useComputerStateStore((state) =>
    ref ? state.threadStates[scopedThreadKey(ref)] : undefined,
  );
}

/** Composer availability does not change with desktop activity or geometry. */
export function useThreadComputerAvailability(ref: ScopedThreadRef | null) {
  return useComputerStateStore(
    useShallow((state) =>
      ref ? state.threadStates[scopedThreadKey(ref)]?.availability : undefined,
    ),
  );
}

/** Observe revocation only, without rerendering the composer for desktop actions. */
export function useThreadComputerControlGeneration(ref: ScopedThreadRef | null) {
  return useComputerStateStore((state) =>
    ref ? state.threadStates[scopedThreadKey(ref)]?.controlGeneration : undefined,
  );
}

/** The environment's host-wide Escape latch. */
export function useComputerInputStopped(environmentId: EnvironmentId | null) {
  return useComputerStateStore((state) =>
    environmentId ? (state.inputStoppedByEnvironment[environmentId] ?? false) : false,
  );
}

/**
 * The desktop backend's status if some surface has already asked, without
 * being the thing that asks.
 */
export function useCachedComputerStatus(environmentId: EnvironmentId | null) {
  return useComputerStateStore((state) =>
    environmentId ? state.statusByEnvironment[environmentId] : undefined,
  );
}
