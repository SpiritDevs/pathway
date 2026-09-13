import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  DictationBridge,
  DictationCommand,
  DictationPreferences,
  DictationState,
} from "@spiritdevs/contracts/dictation";

type Snapshot = { state: DictationState | null; error: string | null };
const unavailable: Snapshot = { state: null, error: null };
const noopSubscribe = () => () => {};
const unavailableSnapshot = () => unavailable;

/** One desktop subscription shared by settings and navigation. Late reads cannot replace newer events. */
export function createDictationStore(bridge: DictationBridge) {
  let snapshot: Snapshot = unavailable;
  let revision = 0;
  let generation = 0;
  let operation = 0;
  let unsubscribe: (() => void) | undefined;
  let preferencesQueue = Promise.resolve<DictationState | null>(null);
  const listeners = new Set<() => void>();
  const emit = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) =>
    emit({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
  const run = async (action: () => Promise<DictationState>) => {
    const startedAt = revision;
    const currentGeneration = generation;
    const currentOperation = ++operation;
    try {
      const state = await action();
      if (currentGeneration !== generation || currentOperation !== operation) return state;
      // Native events often precede a command reply. Keep their state while clearing
      // the retry's old error. An older operation cannot clear or report a newer error.
      if (startedAt === revision) {
        revision++;
        emit({ state, error: null });
      } else if (snapshot.error !== null) {
        emit({ ...snapshot, error: null });
      }
      return state;
    } catch (error) {
      if (currentGeneration === generation && currentOperation === operation) fail(error);
      return null;
    }
  };
  const refresh = async () => {
    await run(() => bridge.getState());
  };
  const execute = (command: DictationCommand) => run(() => bridge.execute(command));
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        generation++;
        const currentGeneration = generation;
        unsubscribe = bridge.onState((state) => {
          if (currentGeneration !== generation) return;
          revision++;
          emit({ state, error: snapshot.error });
        });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation++;
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    execute,
    refresh,
    updatePreferences(patch: Partial<DictationPreferences>) {
      // Merge at dispatch so two quick controls never send stale complete preferences.
      preferencesQueue = preferencesQueue.then(async () => {
        if (!snapshot.state) await refresh();
        const state = snapshot.state;
        if (!state) return null;
        return execute({ type: "preferences", preferences: { ...state.preferences, ...patch } });
      });
      return preferencesQueue;
    },
  };
}

const stores = new WeakMap<DictationBridge, ReturnType<typeof createDictationStore>>();
export const DictationBridgeContext = createContext<DictationBridge | undefined>(undefined);

function useStore() {
  const override = useContext(DictationBridgeContext);
  const bridge =
    override ?? (typeof window === "undefined" ? undefined : window.desktopBridge?.dictation);
  if (!bridge) return { bridge, store: undefined };
  let store = stores.get(bridge);
  if (!store) {
    store = createDictationStore(bridge);
    stores.set(bridge, store);
  }
  return { bridge, store };
}

export function useDictation() {
  const { bridge, store } = useStore();
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? unavailableSnapshot,
    unavailableSnapshot,
  );
  return {
    ...snapshot,
    bridge,
    execute: store?.execute,
    updatePreferences: store?.updatePreferences,
    refresh: store?.refresh,
  };
}

/** A primitive snapshot keeps audio level events from repainting the settings sidebar. */
export function useDictationAvailability() {
  const { store } = useStore();
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => {
      const state = store?.getSnapshot().state;
      return !state?.supported
        ? "unavailable"
        : state.preferences.setupComplete
          ? "ready"
          : "setup";
    },
    () => "unavailable",
  );
}
