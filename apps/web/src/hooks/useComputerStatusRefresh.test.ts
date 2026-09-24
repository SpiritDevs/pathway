// Settings → Computer and the chat setup card refresh the server status on an
// interval, and the native grant snapshot only when the user returns to the
// window. The hook runs for real under a slot-tracked React harness with fake
// timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  let slots: Array<{
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    ref?: { current: unknown };
  }> = [];
  let cursor = 0;
  return {
    beginRender() {
      cursor = 0;
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useRef<T>(value: T) {
      const slot = (slots[cursor++] ??= {});
      return (slot.ref ??= { current: value }) as { current: T };
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (
        slot.deps?.length === deps.length &&
        slot.deps.every((dep, index) => Object.is(dep, deps[index]))
      ) {
        return;
      }
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: harness.useEffect,
  useRef: harness.useRef,
}));

const { COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS, useComputerStatusRefresh } =
  await import("./useComputerStatusRefresh");

const refreshStatus = vi.fn();
const refreshNativeState = vi.fn();
const view = Object.assign(new EventTarget(), { visibilityState: "visible" });

function render(paused = false) {
  harness.beginRender();
  useComputerStatusRefresh({ refreshStatus, refreshNativeState, paused });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", view);
});

afterEach(() => {
  harness.unmount();
  view.visibilityState = "visible";
  refreshStatus.mockReset();
  refreshNativeState.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useComputerStatusRefresh", () => {
  it("polls only the server status on the interval", () => {
    render();
    vi.advanceTimersByTime(COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS * 3);
    expect(refreshStatus).toHaveBeenCalledTimes(3);
    expect(refreshNativeState).not.toHaveBeenCalled();

    view.visibilityState = "hidden";
    vi.advanceTimersByTime(COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(3);
  });

  it("re-reads the native grants when the user returns to the window", () => {
    render();
    window.dispatchEvent(new Event("focus"));
    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(refreshNativeState).toHaveBeenCalledOnce();
  });

  it("refreshes only the status on return for a view without a native snapshot", () => {
    harness.beginRender();
    useComputerStatusRefresh({ refreshStatus, paused: false });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
  });

  it("pauses the interval while the status read fails, and resumes after it recovers", () => {
    render(true);
    vi.advanceTimersByTime(COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS * 3);
    expect(refreshStatus).not.toHaveBeenCalled();

    render(false);
    vi.advanceTimersByTime(COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS);
    expect(refreshStatus).toHaveBeenCalledOnce();
  });
});
