import { describe, expect, it, vi } from "vite-plus/test";
import type {
  DictationBridge,
  DictationCommand,
  DictationState,
} from "@spiritdevs/contracts/dictation";
import { createDictationStore } from "../../dictation/useDictation";
import { makeDictationFixture } from "./fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeBridge(initial = makeDictationFixture()) {
  let state = initial;
  let listener: ((value: DictationState) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge: DictationBridge = {
    getState: vi.fn(async () => state),
    listHistory: async () => [],
    onState: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
    execute: vi.fn(async (command: DictationCommand) => {
      if (command.type === "preferences") state = { ...state, preferences: command.preferences };
      return state;
    }),
  };
  return { bridge, unsubscribe, emit: (value: DictationState) => listener?.(value) };
}

describe("desktop dictation subscription", () => {
  it("shares a subscription and ignores the initial read after a newer event", async () => {
    const test = makeBridge();
    const initial = deferred<DictationState>();
    vi.mocked(test.bridge.getState).mockReturnValue(initial.promise);
    const store = createDictationStore(test.bridge);
    const first = store.subscribe(vi.fn());
    const second = store.subscribe(vi.fn());
    const recording = makeDictationFixture("recording-locked");
    test.emit(recording);
    initial.resolve(makeDictationFixture());
    await initial.promise;
    expect(store.getSnapshot().state).toBe(recording);
    expect(test.bridge.onState).toHaveBeenCalledTimes(1);
    first();
    expect(test.unsubscribe).not.toHaveBeenCalled();
    second();
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("ignores completion and queued events after the final subscriber leaves", async () => {
    const test = makeBridge();
    const initial = deferred<DictationState>();
    vi.mocked(test.bridge.getState).mockReturnValue(initial.promise);
    const store = createDictationStore(test.bridge);
    const listener = vi.fn();
    store.subscribe(listener)();
    initial.resolve(makeDictationFixture());
    await initial.promise;
    test.emit(makeDictationFixture("recording-hold"));
    expect(listener).not.toHaveBeenCalled();
  });
  it("merges quick preference edits into complete current preferences", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    await Promise.all([
      store.updatePreferences({ language: "fr" }),
      store.updatePreferences({ microphoneId: "usb" }),
    ]);
    expect(test.bridge.execute).toHaveBeenLastCalledWith({
      type: "preferences",
      preferences: { ...makeDictationFixture().preferences, language: "fr", microphoneId: "usb" },
    });
    cleanup();
  });
  it("keeps the usable state and reports failed commands without an unhandled rejection", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    vi.mocked(test.bridge.execute).mockRejectedValueOnce(new Error("Microphone is unavailable"));
    expect(await store.execute({ type: "start", mode: "test" })).toBeNull();
    expect(store.getSnapshot().error).toBe("Microphone is unavailable");
    expect(store.getSnapshot().state?.supported).toBe(true);
    cleanup();
  });
  it("clears a failed permission error after a successful retry while retaining newer native state", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    vi.mocked(test.bridge.execute).mockRejectedValueOnce(new Error("Permission check failed"));
    await store.execute({ type: "permissions", action: "microphone" });
    const retry = deferred<DictationState>();
    vi.mocked(test.bridge.execute).mockReturnValueOnce(retry.promise);
    const pending = store.execute({ type: "permissions", action: "microphone" });
    const published = {
      ...makeDictationFixture(),
      microphones: [{ id: "new-input", name: "New microphone", isDefault: true }],
    };
    test.emit(published);
    expect(store.getSnapshot().error).toBe("Permission check failed");
    retry.resolve(makeDictationFixture());
    await pending;
    expect(store.getSnapshot()).toEqual({ state: published, error: null });
    expect(store.getSnapshot().state).toBe(published);
    cleanup();
  });
  it("does not let an older successful command clear a newer failure without a native event", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    const older = deferred<DictationState>();
    vi.mocked(test.bridge.execute).mockReturnValueOnce(older.promise);
    const pending = store.execute({ type: "permissions", action: "refresh" });
    vi.mocked(test.bridge.execute).mockRejectedValueOnce(new Error("New microphone failure"));
    await store.execute({ type: "permissions", action: "microphone" });
    const snapshot = store.getSnapshot();
    older.resolve(makeDictationFixture("recording-locked"));
    await pending;
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.getSnapshot().error).toBe("New microphone failure");
    cleanup();
  });
  it("ignores an older failure after the latest command succeeds", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    const older = deferred<DictationState>();
    vi.mocked(test.bridge.execute).mockReturnValueOnce(older.promise);
    const pending = store.execute({ type: "permissions", action: "microphone" });
    await store.execute({ type: "permissions", action: "refresh" });
    older.reject(new Error("Stale microphone failure"));
    await pending;
    expect(store.getSnapshot().error).toBeNull();
    cleanup();
  });
  it("does not let an older state refresh clear a later command failure", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const cleanup = store.subscribe(vi.fn());
    await store.refresh();
    const older = deferred<DictationState>();
    vi.mocked(test.bridge.getState).mockReturnValueOnce(older.promise);
    const pending = store.refresh();
    vi.mocked(test.bridge.execute).mockRejectedValueOnce(new Error("Accessibility failed"));
    await store.execute({ type: "permissions", action: "accessibility" });
    older.resolve(makeDictationFixture());
    await pending;
    expect(store.getSnapshot().error).toBe("Accessibility failed");
    cleanup();
  });
  it("ignores a command reply from the previous subscription generation", async () => {
    const test = makeBridge();
    const store = createDictationStore(test.bridge);
    const first = store.subscribe(vi.fn());
    await store.refresh();
    const older = deferred<DictationState>();
    vi.mocked(test.bridge.execute).mockReturnValueOnce(older.promise);
    const pending = store.execute({ type: "permissions", action: "microphone" });
    first();
    const second = store.subscribe(vi.fn());
    await store.refresh();
    vi.mocked(test.bridge.execute).mockRejectedValueOnce(new Error("Current subscription failure"));
    await store.execute({ type: "permissions", action: "accessibility" });
    older.resolve(makeDictationFixture());
    await pending;
    expect(store.getSnapshot().error).toBe("Current subscription failure");
    second();
  });
});
