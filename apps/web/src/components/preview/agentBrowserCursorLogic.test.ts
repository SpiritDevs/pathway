import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserCursorGlidePosition,
  agentBrowserCursorOpacity,
  agentBrowserCursorSurfaceOffset,
} from "./agentBrowserCursorLogic";

describe("agentBrowserCursorOpacity", () => {
  it("keeps active movement fully visible", () => {
    expect(agentBrowserCursorOpacity(true)).toBe(1);
  });

  it("settles to a visible idle state", () => {
    expect(agentBrowserCursorOpacity(false)).toBe(0.35);
  });
});

describe("agentBrowserCursorGlidePosition", () => {
  it("scales guest coordinates by zoom and presentation scale", () => {
    expect(
      agentBrowserCursorGlidePosition({ x: 100, y: 40 }, 2, {
        x: 8,
        y: 16,
        scale: 0.5,
        scrollLeft: 0,
        scrollTop: 0,
      }),
    ).toEqual({ x: 100, y: 40 });
  });

  it("falls back to unscaled coordinates without content presentation", () => {
    expect(agentBrowserCursorGlidePosition({ x: 30, y: 20 }, 1, null)).toEqual({ x: 30, y: 20 });
  });
});

describe("agentBrowserCursorSurfaceOffset", () => {
  it("offsets by viewport position minus wrapper scroll", () => {
    expect(
      agentBrowserCursorSurfaceOffset({ x: 8, y: 32, scale: 1, scrollLeft: 3, scrollTop: 5 }),
    ).toEqual({ x: 5, y: 27 });
  });

  it("is zero without content presentation", () => {
    expect(agentBrowserCursorSurfaceOffset(null)).toEqual({ x: 0, y: 0 });
  });
});
