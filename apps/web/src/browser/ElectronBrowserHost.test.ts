import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import {
  coordinateNativePreviewPopup,
  popupActivation,
  popupServerSeedUrl,
  previewServerRevisionChanged,
  recoverNativePreviewPopup,
  supportsNativePreviewPopupAdoption,
} from "./ElectronBrowserHost";

const threadRef = {
  environmentId: EnvironmentId.make("env-test"),
  threadId: ThreadId.make("thread-test"),
};
const snapshot = {
  tabId: "popup-test",
  threadId: threadRef.threadId,
  navStatus: { _tag: "Loading", url: "https://example.com", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
} satisfies PreviewSessionSnapshot;

const request = {
  sourceRuntimeTabId: "runtime-source",
  popupId: snapshot.tabId,
  url: "https://example.com",
  disposition: "foreground-tab",
  frameName: "child",
} as const;

describe("desktop popup coordination", () => {
  beforeEach(resetPreviewStateForTests);
  it("keeps Chromium background-tab disposition in the background", () => {
    expect(popupActivation({ disposition: "background-tab" })).toBe("background");
    expect(popupActivation({ disposition: "foreground-tab" })).toBe("foreground");
    expect(popupActivation({ disposition: "new-window" })).toBe("foreground");
  });

  it("only seeds reconnectable HTTP destinations into the server snapshot", () => {
    expect(popupServerSeedUrl("https://example.com/result")).toBe("https://example.com/result");
    expect(popupServerSeedUrl("about:blank")).toBeUndefined();
    expect(popupServerSeedUrl("blob:https://example.com/id")).toBeUndefined();
    expect(popupServerSeedUrl("data:text/html,hello")).toBeUndefined();
  });

  it("only adopts native popups when the server supports requested preview tab ids", () => {
    expect(supportsNativePreviewPopupAdoption(undefined)).toBe(false);
    expect(supportsNativePreviewPopupAdoption({})).toBe(false);
    expect(supportsNativePreviewPopupAdoption({ previewRequestedTabId: false })).toBe(false);
    expect(supportsNativePreviewPopupAdoption({ previewRequestedTabId: true })).toBe(true);
  });

  it("reserves, adopts, reconciles, and activates a foreground popup in order", async () => {
    const order: Array<string> = [];
    await coordinateNativePreviewPopup({
      request,
      threadRef,
      desktop: {
        adoptPopup: async () => {
          order.push("adopt");
        },
        closeTab: vi.fn(async () => undefined),
        discardPopup: vi.fn(async () => undefined),
      },
      openSession: async () => {
        order.push("open");
        return snapshot;
      },
      closeSession: vi.fn(async () => undefined),
      runtimeTabId: () => "runtime-child",
      reconcile: (_snapshot, activation) => order.push(`reconcile:${activation}`),
      openSurface: (_tabId, activate) => order.push(`surface:${String(activate)}`),
      reserve: () => order.push("reserve"),
      release: () => order.push("release"),
      forget: () => order.push("forget"),
      isDisposed: () => false,
    });
    expect(order).toEqual(["reserve", "open", "adopt", "reconcile:foreground", "surface:true"]);
  });

  it("keeps background popups inactive", async () => {
    const reconcile = vi.fn();
    const openSurface = vi.fn();
    await coordinateNativePreviewPopup({
      request: { ...request, disposition: "background-tab" },
      threadRef,
      desktop: {
        adoptPopup: vi.fn(async () => undefined),
        closeTab: vi.fn(async () => undefined),
        discardPopup: vi.fn(async () => undefined),
      },
      openSession: async () => snapshot,
      closeSession: vi.fn(async () => undefined),
      runtimeTabId: () => "runtime-child",
      reconcile,
      openSurface,
      reserve: vi.fn(),
      release: vi.fn(),
      forget: vi.fn(),
      isDisposed: () => false,
    });
    expect(reconcile).toHaveBeenCalledWith(snapshot, "background");
    expect(openSurface).toHaveBeenCalledWith(snapshot.tabId, false);
  });

  it("discards both sides when adoption fails", async () => {
    const discardPopup = vi.fn(async () => undefined);
    const closeTab = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    const release = vi.fn();
    await expect(
      coordinateNativePreviewPopup({
        request,
        threadRef,
        desktop: {
          adoptPopup: vi.fn(async () => {
            throw new Error("adoption failed");
          }),
          closeTab,
          discardPopup,
        },
        openSession: async () => snapshot,
        closeSession,
        runtimeTabId: () => "runtime-child",
        reconcile: vi.fn(),
        openSurface: vi.fn(),
        reserve: vi.fn(),
        release,
        forget: vi.fn(),
        isDisposed: () => false,
      }),
    ).rejects.toThrow("adoption failed");
    expect(discardPopup).toHaveBeenCalledWith(request.popupId);
    expect(closeTab).toHaveBeenCalledWith("runtime-child");
    expect(closeSession).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(request.popupId);
  });

  it("suppresses failed popup sessions before releasing their native reservation", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const release = vi.fn(() => {
      const state = readThreadPreviewState(threadRef);
      expect(state.sessions[snapshot.tabId]).toBeUndefined();
      expect(state.suppressedTabIds.has(snapshot.tabId)).toBe(true);
    });
    await expect(
      coordinateNativePreviewPopup({
        request,
        threadRef,
        desktop: {
          adoptPopup: async () => {
            throw new Error("adoption failed");
          },
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        openSession: async () => snapshot,
        closeSession: async () => {
          throw new Error("disconnected");
        },
        runtimeTabId: () => "runtime-child",
        reconcile: vi.fn(),
        openSurface: vi.fn(),
        reserve: vi.fn(),
        release,
        forget: vi.fn(),
        isDisposed: () => false,
      }),
    ).rejects.toThrow("could not be cleaned up");
    expect(release).not.toHaveBeenCalled();
    applyPreviewServerSnapshot(threadRef, snapshot);
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toBeUndefined();
  });

  it("does not reopen a tab closed while native adoption is in flight", async () => {
    const reconcile = vi.fn();
    const openSurface = vi.fn();
    const closeSession = vi.fn(async () => undefined);
    await expect(
      coordinateNativePreviewPopup({
        request,
        threadRef,
        desktop: {
          adoptPopup: async () => {
            beginPreviewSessionClose(threadRef, snapshot.tabId);
            await Promise.resolve();
          },
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        openSession: async () => {
          applyPreviewServerSnapshot(threadRef, snapshot);
          return snapshot;
        },
        closeSession,
        runtimeTabId: () => "runtime-child",
        reconcile,
        openSurface,
        reserve: vi.fn(),
        release: vi.fn(),
        forget: vi.fn(),
        isDisposed: () => false,
      }),
    ).rejects.toThrow("closed during adoption");
    expect(reconcile).not.toHaveBeenCalled();
    expect(openSurface).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("discards a pending child if the renderer is gone after the server opens", async () => {
    const discardPopup = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    await expect(
      coordinateNativePreviewPopup({
        request,
        threadRef,
        desktop: {
          adoptPopup: vi.fn(async () => undefined),
          closeTab: vi.fn(async () => undefined),
          discardPopup,
        },
        openSession: async () => snapshot,
        closeSession,
        runtimeTabId: () => "runtime-child",
        reconcile: vi.fn(),
        openSurface: vi.fn(),
        reserve: vi.fn(),
        release: vi.fn(),
        forget: vi.fn(),
        isDisposed: () => true,
      }),
    ).rejects.toThrow("owner was closed");
    expect(discardPopup).toHaveBeenCalledWith(request.popupId);
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("keeps a pre-open recovery fenced until the late server session is observed", async () => {
    const desktop = {
      closeTab: vi.fn(async () => undefined),
      discardPopup: vi.fn(async () => undefined),
    };
    const closeSession = vi.fn(async () => undefined);
    const forget = vi.fn();
    const recovery = {
      tabId: snapshot.tabId,
      threadRef,
      serverEpoch: "epoch-1",
    } as const;

    expect(
      await recoverNativePreviewPopup({
        recovery,
        desktop,
        currentServerEpoch: "epoch-1",
        logicalSessionObserved: false,
        closeSession,
        forget,
      }),
    ).toBe(false);
    expect(forget).not.toHaveBeenCalled();

    expect(
      await recoverNativePreviewPopup({
        recovery,
        desktop,
        currentServerEpoch: "epoch-1",
        logicalSessionObserved: true,
        closeSession,
        forget,
      }),
    ).toBe(true);
    expect(forget).toHaveBeenCalledWith(snapshot.tabId);
  });

  it("retains an adopted popup recovery when logical cleanup fails", async () => {
    const forget = vi.fn();
    await expect(
      recoverNativePreviewPopup({
        recovery: {
          tabId: snapshot.tabId,
          threadRef,
          serverEpoch: "epoch-1",
          runtimeTabId: "runtime-child",
        },
        desktop: {
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        currentServerEpoch: "epoch-1",
        logicalSessionObserved: true,
        closeSession: async () => {
          throw new Error("disconnected");
        },
        forget,
      }),
    ).rejects.toThrow("disconnected");
    expect(forget).not.toHaveBeenCalled();
  });

  it("clears a previously observed pre-open recovery after a successful retry", async () => {
    const forget = vi.fn();
    await expect(
      recoverNativePreviewPopup({
        recovery: {
          tabId: snapshot.tabId,
          threadRef,
          serverEpoch: "epoch-1",
          logicalSessionObserved: true,
        },
        desktop: {
          closeTab: vi.fn(async () => undefined),
          discardPopup: vi.fn(async () => undefined),
        },
        currentServerEpoch: "epoch-1",
        logicalSessionObserved: true,
        closeSession: vi.fn(async () => undefined),
        forget,
      }),
    ).resolves.toBe(true);
    expect(forget).toHaveBeenCalledWith(snapshot.tabId);
  });

  it("reschedules recovery only when server progress landed during cleanup", () => {
    const initial = { serverEpoch: "epoch-1", serverRevision: 4 };
    expect(previewServerRevisionChanged(initial, initial)).toBe(false);
    expect(
      previewServerRevisionChanged(initial, { serverEpoch: "epoch-1", serverRevision: 5 }),
    ).toBe(true);
    expect(
      previewServerRevisionChanged(initial, { serverEpoch: "epoch-2", serverRevision: 0 }),
    ).toBe(true);
  });
});
