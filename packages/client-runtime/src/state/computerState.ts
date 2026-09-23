import type {
  ComputerActionEvent,
  ComputerWindow,
  EnvironmentId,
  ScopedThreadRef,
  ThreadComputerState,
} from "@spiritdevs/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";

/**
 * Live Computer state a client keeps from `computer.subscribeEvents`, across
 * every connected environment. Thread entries are keyed by `scopedThreadKey`.
 * Every transition returns the same object when nothing changed, so store
 * subscribers are not notified for no-ops.
 */
export interface ComputerClientState {
  readonly threadStates: Readonly<Record<string, ThreadComputerState>>;
  /** Newest desktop action per thread, so one thread never reads another's. */
  readonly lastActions: Readonly<Record<string, ComputerActionEvent>>;
  /**
   * The host-wide physical-Escape kill latch per environment, true after a
   * `computer.input-stopped` push until the server clears it. Kept beside the
   * thread states because the press belongs to no thread: a conversation with
   * no pane state still has to see input is stopped.
   */
  readonly inputStoppedByEnvironment: Readonly<Record<string, boolean>>;
}

export const EMPTY_COMPUTER_CLIENT_STATE: ComputerClientState = {
  threadStates: {},
  lastActions: {},
  inputStoppedByEnvironment: {},
};

const belongsTo = (key: string, environmentId: EnvironmentId) =>
  key.startsWith(`${environmentId}:`);

/** Keeps the newest snapshot; an older or equal version is ignored. */
export function upsertComputerThreadState(
  current: ComputerClientState,
  environmentId: EnvironmentId,
  state: ThreadComputerState,
): ComputerClientState {
  const key = scopedThreadKey({ environmentId, threadId: state.threadId });
  const previous = current.threadStates[key];
  if (previous && previous.version >= state.version) return current;
  return { ...current, threadStates: { ...current.threadStates, [key]: state } };
}

/** The window inventory is host-wide, so it lands on every thread of that environment. */
export function applyComputerWindowsChanged(
  current: ComputerClientState,
  environmentId: EnvironmentId,
  windows: readonly ComputerWindow[],
): ComputerClientState {
  let next: Record<string, ThreadComputerState> | null = null;
  for (const [key, state] of Object.entries(current.threadStates)) {
    if (!belongsTo(key, environmentId) || state.windows === windows) continue;
    next ??= { ...current.threadStates };
    next[key] = { ...state, windows };
  }
  return next ? { ...current, threadStates: next } : current;
}

/**
 * Sets the environment's Escape latch and stamps it onto that environment's
 * cached thread states, so a pane reading only `ThreadComputerState.inputStopped`
 * sees the transition without waiting for the server's republish.
 */
export function setComputerInputStopped(
  current: ComputerClientState,
  environmentId: EnvironmentId,
  stopped: boolean,
): ComputerClientState {
  if ((current.inputStoppedByEnvironment[environmentId] ?? false) === stopped) return current;
  const threadStates: Record<string, ThreadComputerState> = { ...current.threadStates };
  for (const [key, state] of Object.entries(current.threadStates)) {
    if (belongsTo(key, environmentId)) threadStates[key] = { ...state, inputStopped: stopped };
  }
  return {
    ...current,
    threadStates,
    inputStoppedByEnvironment: { ...current.inputStoppedByEnvironment, [environmentId]: stopped },
  };
}

/**
 * Records an agent action against its thread. Unattributed pane input belongs
 * to no thread and nothing reads a cross-thread "newest action", so it is a
 * no-op.
 */
export function recordComputerAction(
  current: ComputerClientState,
  environmentId: EnvironmentId,
  action: ComputerActionEvent,
): ComputerClientState {
  if (!action.threadId) return current;
  const key = scopedThreadKey({ environmentId, threadId: action.threadId });
  return { ...current, lastActions: { ...current.lastActions, [key]: action } };
}

export function removeComputerThreadState(
  current: ComputerClientState,
  ref: ScopedThreadRef,
): ComputerClientState {
  const key = scopedThreadKey(ref);
  const hasState = Object.hasOwn(current.threadStates, key);
  const hasAction = Object.hasOwn(current.lastActions, key);
  if (!hasState && !hasAction) return current;
  const threadStates = { ...current.threadStates };
  delete threadStates[key];
  const lastActions = { ...current.lastActions };
  delete lastActions[key];
  return { ...current, threadStates, lastActions };
}

/**
 * Forgets one environment wholesale, e.g. after its server restarted. The old
 * latch is dropped too: the new server's own `computer.input-stopped` is the truth.
 */
export function clearComputerEnvironment(
  current: ComputerClientState,
  environmentId: EnvironmentId,
): ComputerClientState {
  const keep = <T>(record: Readonly<Record<string, T>>) => {
    let changed = false;
    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(record)) {
      if (belongsTo(key, environmentId)) changed = true;
      else next[key] = value;
    }
    return changed ? next : record;
  };
  const threadStates = keep(current.threadStates);
  const lastActions = keep(current.lastActions);
  const hasLatch = Object.hasOwn(current.inputStoppedByEnvironment, environmentId);
  if (threadStates === current.threadStates && lastActions === current.lastActions && !hasLatch) {
    return current;
  }
  const inputStoppedByEnvironment = { ...current.inputStoppedByEnvironment };
  delete inputStoppedByEnvironment[environmentId];
  return { threadStates, lastActions, inputStoppedByEnvironment };
}
