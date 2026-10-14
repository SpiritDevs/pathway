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
    const first = { closest: () => null } as unknown as Element;
    const second = { closest: () => null } as unknown as Element;
    const visible = vi.fn();
    const other = vi.fn();
    const stop = observeNearViewport(first, visible);
    const stopOther = observeNearViewport(second, other);
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledWith(expect.any(Function), {
      root: null,
      rootMargin: "200px",
    });
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

  it("observes rows in a nested scroll area against that area, one observer per area", () => {
    const observers: Array<{ root: Element | null; observe: ReturnType<typeof vi.fn> }> = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function (_callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        const observer = { root: options.root as Element | null, observe: vi.fn() };
        observers.push(observer);
        return { observe: observer.observe, unobserve: vi.fn(), disconnect };
      }),
    );
    // The sidebar scrolls inside a clipped viewport: rootMargin against the page would not
    // reach past its clip, so rows must observe with the viewport as root.
    const sidebarViewport = {} as Element;
    const otherViewport = {} as Element;
    const inside = (viewport: Element | null) =>
      ({
        closest: (selector: string) =>
          selector === '[data-slot="scroll-area-viewport"]' ? viewport : null,
      }) as unknown as Element;
    const rowA = inside(sidebarViewport);
    const rowB = inside(sidebarViewport);
    const panelRow = inside(otherViewport);
    const stops = [rowA, rowB, panelRow].map((row) => observeNearViewport(row, vi.fn()));
    expect(observers.map((observer) => observer.root)).toEqual([sidebarViewport, otherViewport]);
    expect(observers[0]!.observe.mock.calls).toEqual([[rowA], [rowB]]);
    expect(observers[1]!.observe.mock.calls).toEqual([[panelRow]]);
    for (const stop of stops) stop();
    expect(disconnect).toHaveBeenCalledTimes(2);
    observeNearViewport(rowA, vi.fn())();
    expect(observers).toHaveLength(3);
  });

  it("keeps status available when IntersectionObserver is unsupported", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const visible = vi.fn();
    observeNearViewport({} as Element, visible)();
    expect(visible).toHaveBeenCalledWith(true);
  });
});
