import {
  EnvironmentId,
  ThreadId,
  type ComputerActionEvent,
  type ComputerWindow,
  type ThreadComputerState,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_COMPUTER_CLIENT_STATE,
  applyComputerWindowsChanged,
  clearComputerEnvironment,
  recordComputerAction,
  removeComputerThreadState,
  setComputerInputStopped,
  upsertComputerThreadState,
} from "./computerState.ts";

const ENV = EnvironmentId.make("env-a");
const OTHER_ENV = EnvironmentId.make("env-b");
const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");

const baseState = {
  threadId: THREAD_1,
  version: 2,
  computerId: "desktop",
  capabilities: {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
  },
  windows: [],
  screenSize: { width: 5120, height: 2520 },
  agentActive: false,
  controlledByOtherThread: false,
  availability: { kind: "available" },
  health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
  lastError: null,
} as unknown as ThreadComputerState;

const key = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

describe("computerState", () => {
  it("keeps the newest thread snapshot", () => {
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    const before = state;
    state = upsertComputerThreadState(state, ENV, { ...baseState, version: 1, agentActive: true });
    expect(state).toBe(before);
    expect(state.threadStates[key(ENV, THREAD_1)]).toEqual(baseState);
  });

  it("takes a newer snapshot's degraded health", () => {
    const degraded = {
      ...baseState,
      version: 3,
      availability: { kind: "backend-unavailable", message: "Reconnecting to the desktop." },
      health: {
        status: "reconnecting",
        consecutiveFailures: 1,
        reconnects: 0,
        lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
        captureAvailable: false,
      },
    } as unknown as ThreadComputerState;
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    state = upsertComputerThreadState(state, ENV, degraded);
    expect(state.threadStates[key(ENV, THREAD_1)]?.health).toEqual(degraded.health);
  });

  it("shares one window inventory within an environment and ignores the same object", () => {
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    state = upsertComputerThreadState(state, ENV, { ...baseState, threadId: THREAD_2 });
    state = upsertComputerThreadState(state, OTHER_ENV, baseState);
    const windows = Object.freeze([
      Object.freeze({
        id: "window-1",
        title: "Terminal",
        focused: false,
        minimized: false,
        visible: true,
      }),
    ]) as unknown as readonly ComputerWindow[];

    const updated = applyComputerWindowsChanged(state, ENV, windows);
    expect(updated.threadStates[key(ENV, THREAD_1)]?.windows).toBe(windows);
    expect(updated.threadStates[key(ENV, THREAD_2)]?.windows).toBe(windows);
    expect(updated.threadStates[key(OTHER_ENV, THREAD_1)]?.windows).toEqual([]);
    expect(applyComputerWindowsChanged(updated, ENV, windows)).toBe(updated);
  });

  it("attributes an action to its thread and ignores unattributed pane input", () => {
    const typed = {
      type: "computer.action",
      action: "computer_type_text",
      ok: true,
      threadId: THREAD_1,
    } as unknown as ComputerActionEvent;
    const paneClick = {
      type: "computer.action",
      action: "computer_click",
      ok: true,
    } as unknown as ComputerActionEvent;

    const state = recordComputerAction(EMPTY_COMPUTER_CLIENT_STATE, ENV, typed);
    expect(recordComputerAction(state, ENV, paneClick)).toBe(state);
    expect(state.lastActions).toEqual({ [key(ENV, THREAD_1)]: typed });
  });

  it("stamps the Escape stop onto that environment's thread states only", () => {
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    state = upsertComputerThreadState(state, ENV, { ...baseState, threadId: THREAD_2 });
    state = upsertComputerThreadState(state, OTHER_ENV, baseState);

    const stopped = setComputerInputStopped(state, ENV, true);
    expect(stopped.inputStoppedByEnvironment[ENV]).toBe(true);
    expect(stopped.threadStates[key(ENV, THREAD_1)]?.inputStopped).toBe(true);
    expect(stopped.threadStates[key(ENV, THREAD_2)]?.inputStopped).toBe(true);
    expect(stopped.threadStates[key(OTHER_ENV, THREAD_1)]?.inputStopped).toBeUndefined();

    const rearmed = setComputerInputStopped(stopped, ENV, false);
    expect(rearmed.threadStates[key(ENV, THREAD_1)]?.inputStopped).toBe(false);
    expect(setComputerInputStopped(rearmed, ENV, false)).toBe(rearmed);
  });

  it("forgets a removed thread's action along with its snapshot", () => {
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    state = recordComputerAction(state, ENV, {
      type: "computer.action",
      action: "computer_click",
      ok: true,
      threadId: THREAD_1,
    } as unknown as ComputerActionEvent);

    state = removeComputerThreadState(state, { environmentId: ENV, threadId: THREAD_1 });
    expect(state.threadStates).toEqual({});
    expect(state.lastActions).toEqual({});
    expect(removeComputerThreadState(state, { environmentId: ENV, threadId: THREAD_1 })).toBe(
      state,
    );
  });

  it("clears one environment, including its Escape latch", () => {
    let state = upsertComputerThreadState(EMPTY_COMPUTER_CLIENT_STATE, ENV, baseState);
    state = upsertComputerThreadState(state, OTHER_ENV, baseState);
    state = setComputerInputStopped(state, ENV, true);

    state = clearComputerEnvironment(state, ENV);
    expect(Object.keys(state.threadStates)).toEqual([key(OTHER_ENV, THREAD_1)]);
    expect(state.inputStoppedByEnvironment[ENV]).toBeUndefined();
    expect(clearComputerEnvironment(state, ENV)).toBe(state);
  });
});
