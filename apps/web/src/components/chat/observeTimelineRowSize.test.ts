import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { observeTimelineRowSize } from "./observeTimelineRowSize";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let callback: ResizeObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(onResize: ResizeObserverCallback) {
        callback = onResize;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const element = {} as HTMLElement;
  const syncLayout = vi.fn();
  const cleanup = observeTimelineRowSize(element, syncLayout);
  const resize = (width: number, height: number) => {
    callback(
      [
        {
          target: element,
          contentRect: {
            width,
            height,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            toJSON: () => ({ width, height }),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  };
  return { cleanup, disconnect, element, observe, resize, syncLayout };
}

describe("timeline content measurement", () => {
  it("remeasures when an image loads and when message content expands or collapses", () => {
    const { resize, syncLayout } = setup();
    resize(700, 100);
    syncLayout.mockClear();
    resize(700, 280);
    resize(700, 440);
    resize(700, 280);
    expect(syncLayout).toHaveBeenCalledTimes(3);
  });

  it("resyncs after a lane resize even if the outer list viewport did not change", () => {
    const { resize, syncLayout } = setup();
    resize(700, 280);
    syncLayout.mockClear();
    resize(500, 340);
    expect(syncLayout).toHaveBeenCalledOnce();
  });

  it("ignores repeated sizes so list remeasurement cannot feed back indefinitely", () => {
    const { resize, syncLayout } = setup();
    resize(700, 280);
    resize(700, 280);
    expect(syncLayout).toHaveBeenCalledOnce();
  });

  it("disconnects and ignores queued notifications after a row unmounts", () => {
    const { cleanup, disconnect, element, observe, resize, syncLayout } = setup();
    expect(observe).toHaveBeenCalledWith(element);
    cleanup();
    resize(700, 280);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(syncLayout).not.toHaveBeenCalled();
  });
});
