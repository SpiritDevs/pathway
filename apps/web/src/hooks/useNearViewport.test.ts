import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { observeNearViewport } from "./useNearViewport";

afterEach(() => vi.unstubAllGlobals());

describe("near viewport observer", () => {
  it("shares one observer and releases every row subscription", () => {
    let receive: IntersectionObserverCallback = () => undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    const constructor = vi.fn(function (callback: IntersectionObserverCallback) {
      receive = callback;
      return { observe, unobserve, disconnect };
    });
    vi.stubGlobal("IntersectionObserver", constructor);
    const first = {} as Element;
    const second = {} as Element;
    const visible = vi.fn();
    const other = vi.fn();
    const stop = observeNearViewport(first, visible);
    const stopOther = observeNearViewport(second, other);
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledWith(expect.any(Function), { rootMargin: "200px" });
    expect(visible).not.toHaveBeenCalled();
    receive(
      [{ target: first, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(visible).toHaveBeenLastCalledWith(true);
    expect(other).not.toHaveBeenCalled();
    receive(
      [{ target: first, isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(visible).toHaveBeenLastCalledWith(false);
    stop();
    expect(unobserve).toHaveBeenCalledWith(first);
    expect(disconnect).not.toHaveBeenCalled();
    stopOther();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps status available when IntersectionObserver is unsupported", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const visible = vi.fn();
    observeNearViewport({} as Element, visible)();
    expect(visible).toHaveBeenCalledWith(true);
  });
});
