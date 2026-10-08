import { EnvironmentId, ThreadId, type DesktopBridge } from "@spiritdevs/contracts";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  subscribeSnapShotComposerFocus,
} from "./desktopSnapShot";

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("getDesktopSnapShotBridge", () => {
  it("rejects an older desktop bridge without window capture methods", () => {
    window.desktopBridge = {} as DesktopBridge;

    expect(getDesktopSnapShotBridge()).toBeUndefined();
  });

  it("returns a bridge with the complete window capture capability", () => {
    const bridge = {
      setSnapShotAccount: vi.fn(async () => undefined),
      requestSnapShotPermissions: vi.fn(),
      getSnapShotState: vi.fn(),
      checkSnapShotShortcut: vi.fn(),
      setSnapShotShortcutSuppressed: vi.fn(),
      listPendingSnapShots: vi.fn(),
      readSnapShot: vi.fn(),
      acknowledgeSnapShot: vi.fn(),
      onSnapShotEvent: vi.fn(),
    } as unknown as DesktopBridge;
    window.desktopBridge = bridge;

    expect(getDesktopSnapShotBridge()).toBe(bridge);
  });
});

describe("window capture composer focus", () => {
  it("includes the destination so unrelated panes stay collapsed", () => {
    const target = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("child"));
    const listener = vi.fn();
    const unsubscribe = subscribeSnapShotComposerFocus(listener);
    dispatchSnapShotComposerFocus(target);
    expect(listener).toHaveBeenCalledExactlyOnceWith(target);
    unsubscribe();
  });
  it("notifies active subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSnapShotComposerFocus(listener);

    dispatchSnapShotComposerFocus();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    dispatchSnapShotComposerFocus();
    expect(listener).toHaveBeenCalledOnce();
  });
});
