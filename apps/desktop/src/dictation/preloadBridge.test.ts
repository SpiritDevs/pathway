import { ipcRenderer } from "electron";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultDictationPreferences, type DictationState } from "@spiritdevs/contracts/dictation";
import * as channels from "./channels.ts";
import { createDictationPreloadBridge } from "./preloadBridge.ts";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", async () => {
  const NodeEvents = await import("node:events");
  return {
    ipcRenderer: Object.assign(new NodeEvents.EventEmitter(), { invoke: mocks.invoke }),
  };
});

function recording(): DictationState {
  return {
    supported: true,
    platform: "darwin",
    authenticated: true,
    accountId: "first-account",
    preferences: { ...defaultDictationPreferences("darwin"), enabled: true, setupComplete: true },
    models: [],
    microphones: [],
    microphonePermission: "granted",
    accessibilityPermission: "granted",
    nativeAvailable: true,
    phase: "recording",
    mode: "locked",
    durationMs: 1000,
    level: 0.2,
    result: null,
    error: null,
    dictionary: [],
    dictionaryConnected: true,
  };
}

beforeEach(() => {
  ipcRenderer.removeAllListeners();
  mocks.invoke.mockReset();
});

describe("dictation preload meter subscriptions", () => {
  it("seeds a listener attached during recording and delivers subsequent meter events", async () => {
    const initial = Promise.withResolvers<DictationState>();
    mocks.invoke.mockReturnValue(initial.promise);
    const listener = vi.fn();
    const unsubscribe = createDictationPreloadBridge().onState(listener);
    expect(mocks.invoke).toHaveBeenCalledWith(channels.DICTATION_GET_STATE);
    const snapshot = recording();
    initial.resolve(snapshot);
    await initial.promise;
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot);

    ipcRenderer.emit(channels.DICTATION_METER, {}, { durationMs: 1500, level: 0.7 });
    expect(listener).toHaveBeenLastCalledWith({ ...snapshot, durationMs: 1500, level: 0.7 });
    expect(snapshot).toMatchObject({ durationMs: 1000, level: 0.2 });
    unsubscribe();
  });

  it("keeps a newer account state and meter when the initial snapshot arrives late", async () => {
    const initial = Promise.withResolvers<DictationState>();
    mocks.invoke.mockReturnValue(initial.promise);
    const listener = vi.fn();
    const unsubscribe = createDictationPreloadBridge().onState(listener);
    const newer = { ...recording(), accountId: "second-account" };
    ipcRenderer.emit(channels.DICTATION_STATE, {}, newer);
    ipcRenderer.emit(channels.DICTATION_METER, {}, { durationMs: 2000, level: 0.5 });
    initial.resolve(recording());
    await initial.promise;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ ...newer, durationMs: 2000, level: 0.5 });
    unsubscribe();
  });

  it("ignores the initial snapshot and all events after unsubscribe", async () => {
    const initial = Promise.withResolvers<DictationState>();
    mocks.invoke.mockReturnValue(initial.promise);
    const listener = vi.fn();
    const unsubscribe = createDictationPreloadBridge().onState(listener);
    unsubscribe();
    initial.resolve(recording());
    await initial.promise;
    ipcRenderer.emit(channels.DICTATION_STATE, {}, recording());
    ipcRenderer.emit(channels.DICTATION_METER, {}, { durationMs: 2000, level: 0.5 });
    expect(listener).not.toHaveBeenCalled();
    expect(ipcRenderer.listenerCount(channels.DICTATION_STATE)).toBe(0);
    expect(ipcRenderer.listenerCount(channels.DICTATION_METER)).toBe(0);
  });
});
