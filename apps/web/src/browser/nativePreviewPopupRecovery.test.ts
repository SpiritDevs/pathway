import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const storageKey = "pathway.native-preview-popup-recovery.v1";
const recovery = {
  tabId: "popup-reload",
  environmentId: "env-test",
  threadId: "thread-test",
  serverEpoch: "epoch-1",
  runtimeTabId: "runtime-popup-reload",
};

const makeSessionStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
};

describe("native popup reload recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("sessionStorage", makeSessionStorage());
    sessionStorage.setItem(storageKey, JSON.stringify([recovery]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates the native reservation synchronously and clears it after logical cleanup", async () => {
    const store = await import("./nativePreviewPopupStore");
    expect(store.useNativePreviewPopupStore.getState().tabIds.has(recovery.tabId)).toBe(true);

    const { recoverNativePreviewPopup } = await import("./ElectronBrowserHost");
    await expect(
      recoverNativePreviewPopup({
        recovery: {
          tabId: recovery.tabId,
          threadRef: {
            environmentId: EnvironmentId.make(recovery.environmentId),
            threadId: ThreadId.make(recovery.threadId),
          },
          serverEpoch: recovery.serverEpoch,
          runtimeTabId: recovery.runtimeTabId,
        },
        desktop: {
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        currentServerEpoch: recovery.serverEpoch,
        logicalSessionObserved: true,
        closeSession: vi.fn(async () => undefined),
        forget: store.forgetNativePreviewPopup,
      }),
    ).resolves.toBe(true);

    expect(store.useNativePreviewPopupStore.getState().tabIds.has(recovery.tabId)).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "null")).toEqual([]);
  });

  it("retains the persisted reservation when logical cleanup fails", async () => {
    const store = await import("./nativePreviewPopupStore");
    const { recoverNativePreviewPopup } = await import("./ElectronBrowserHost");

    await expect(
      recoverNativePreviewPopup({
        recovery: {
          tabId: recovery.tabId,
          threadRef: {
            environmentId: EnvironmentId.make(recovery.environmentId),
            threadId: ThreadId.make(recovery.threadId),
          },
          serverEpoch: recovery.serverEpoch,
          runtimeTabId: recovery.runtimeTabId,
        },
        desktop: {
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        currentServerEpoch: recovery.serverEpoch,
        logicalSessionObserved: true,
        closeSession: async () => {
          throw new Error("disconnected");
        },
        forget: store.forgetNativePreviewPopup,
      }),
    ).rejects.toThrow("disconnected");

    expect(store.useNativePreviewPopupStore.getState().tabIds.has(recovery.tabId)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "null")).toEqual([recovery]);
  });

  it("persists observation so a retry can clear a locally suppressed session", async () => {
    const store = await import("./nativePreviewPopupStore");
    store.markNativePreviewPopupSessionObserved(recovery.tabId);

    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "null")).toEqual([
      { ...recovery, logicalSessionObserved: true },
    ]);

    store.markNativePreviewPopupSessionObserved(recovery.tabId);
    expect(store.useNativePreviewPopupStore.getState().recoveryRevision).toBe(1);
  });
});
