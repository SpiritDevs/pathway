import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  coordinateNativePreviewPopup,
  popupActivation,
  popupServerSeedUrl,
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
        isDisposed: () => false,
      }),
    ).rejects.toThrow("adoption failed");
    expect(discardPopup).toHaveBeenCalledWith(request.popupId);
    expect(closeTab).toHaveBeenCalledWith("runtime-child");
    expect(closeSession).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(request.popupId);
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
        isDisposed: () => true,
      }),
    ).rejects.toThrow("owner was closed");
    expect(discardPopup).toHaveBeenCalledWith(request.popupId);
    expect(closeSession).toHaveBeenCalledOnce();
  });
});
