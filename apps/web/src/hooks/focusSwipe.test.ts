import { describe, expect, it, vi } from "vite-plus/test";

import { createFocusSwipeHandler } from "./focusSwipe";

function wheel(timeStamp: number, deltaX: number, deltaY = 0, extra: Partial<WheelEvent> = {}) {
  return {
    timeStamp,
    deltaX,
    deltaY,
    deltaMode: 0,
    preventDefault: vi.fn(),
    ...extra,
  } as unknown as WheelEvent;
}

describe("focus trackpad swipes", () => {
  it("accumulates a deliberate horizontal swipe and consumes its entire momentum tail", () => {
    const select = vi.fn();
    const handle = createFocusSwipeHandler(select);
    const start = wheel(0, 20, 2);
    handle(start);
    expect(start.preventDefault).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    handle(wheel(16, 45, 3));
    for (let time = 32; time <= 1000; time += 16) handle(wheel(time, 30));
    expect(select.mock.calls).toEqual([[1]]);
    const tail = wheel(1016, 1);
    handle(tail);
    expect(tail.preventDefault).toHaveBeenCalledOnce();
  });

  it("releases the lock for a new swipe in either direction", () => {
    const select = vi.fn();
    const handle = createFocusSwipeHandler(select);
    handle(wheel(0, 80));
    handle(wheel(250, -80));
    handle(wheel(500, -80));
    expect(select.mock.calls).toEqual([[1], [-1], [-1]]);
  });

  it("keeps a vertical gesture vertical even when its tail drifts horizontally", () => {
    const select = vi.fn();
    const handle = createFocusSwipeHandler(select);
    const events = [wheel(0, 3, 20), wheel(16, 80, 1), wheel(32, 80, 0)];
    events.forEach(handle);
    expect(select).not.toHaveBeenCalled();
    events.forEach((event) => expect(event.preventDefault).not.toHaveBeenCalled());
  });

  it("ignores diagonal scrolling and horizontal jitter below the threshold", () => {
    const select = vi.fn();
    const handle = createFocusSwipeHandler(select);
    const diagonal = wheel(0, 65, 50);
    handle(diagonal);
    handle(wheel(250, 20));
    handle(wheel(266, -15));
    expect(select).not.toHaveBeenCalled();
    expect(diagonal.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { deltaMode: 1 },
    { deltaMode: 2 },
    { defaultPrevented: true },
  ])("leaves zoom, modified wheels and claimed events alone: %j", (extra) => {
    const select = vi.fn();
    const event = wheel(0, 100, 0, extra);
    createFocusSwipeHandler(select)(event);
    expect(select).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
