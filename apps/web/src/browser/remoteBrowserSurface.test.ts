import { describe, expect, it } from "vite-plus/test";

import {
  cdpModifiers,
  sameSurfaceViewport,
  surfaceIndicator,
  surfaceViewportFor,
  wheelPixels,
} from "./remoteBrowserSurface";

describe("surfaceViewportFor", () => {
  it("asks for the panel at the display's density, capped at 2x", () => {
    expect(surfaceViewportFor({ width: 800.4, height: 600.6 }, 2)).toEqual({
      width: 800,
      height: 601,
      deviceScale: 2,
    });
    expect(surfaceViewportFor({ width: 800, height: 600 }, 3)?.deviceScale).toBe(2);
    expect(surfaceViewportFor({ width: 800, height: 600 }, 0)?.deviceScale).toBe(1);
  });

  it("waits for a laid-out panel", () => {
    expect(surfaceViewportFor({ width: 0, height: 600 }, 2)).toBeNull();
  });

  it("treats equal sizes as unchanged so a resize storm does not reconnect", () => {
    const a = surfaceViewportFor({ width: 800, height: 600 }, 2);
    const b = surfaceViewportFor({ width: 800.2, height: 599.8 }, 2);
    expect(sameSurfaceViewport(a, b)).toBe(true);
    expect(sameSurfaceViewport(a, surfaceViewportFor({ width: 801, height: 600 }, 2))).toBe(false);
  });
});

describe("input mapping", () => {
  it("encodes CDP modifier bits", () => {
    expect(cdpModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13);
  });

  it("converts line and page wheel deltas to pixels", () => {
    expect(wheelPixels({ deltaX: 0.5, deltaY: 3, deltaMode: 0 }, 900)).toEqual({
      deltaX: 0.5,
      deltaY: 3,
    });
    expect(wheelPixels({ deltaX: 0, deltaY: 2, deltaMode: 1 }, 900).deltaY).toBe(32);
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 900).deltaY).toBe(900);
  });
});

describe("surfaceIndicator", () => {
  it("reports frame rate and rounded latency while live", () => {
    expect(surfaceIndicator("live", { fps: 24, latencyMs: 83 })).toEqual({
      tone: "live",
      label: "24 fps · 80 ms",
    });
  });

  it("calls a still page live instead of 0 fps", () => {
    expect(surfaceIndicator("live", { fps: 0, latencyMs: 9_000 })).toEqual({
      tone: "live",
      label: "Live",
    });
  });

  it("flags a slow stream and a lost one", () => {
    expect(surfaceIndicator("live", { fps: 8, latencyMs: 650 }).tone).toBe("degraded");
    expect(surfaceIndicator("stale", null)).toEqual({ tone: "degraded", label: "Reconnecting…" });
    expect(surfaceIndicator("failed", null).tone).toBe("offline");
  });
});
