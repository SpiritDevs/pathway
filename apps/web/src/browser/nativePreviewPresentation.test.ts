import { describe, expect, it } from "vite-plus/test";

import { overlapsNativePreview } from "./nativePreviewPresentation";

describe("native preview overlays", () => {
  const bounds = { x: 600, y: 80, width: 400, height: 600, scale: 0.5 };

  it("hides the native page for an overlapping menu or full-window modal backdrop", () => {
    expect(overlapsNativePreview(bounds, { x: 550, y: 50, width: 200, height: 200 })).toBe(true);
    expect(overlapsNativePreview(bounds, { x: 0, y: 0, width: 1200, height: 900 })).toBe(true);
  });

  it("leaves the native page visible for other panels, toolbar-only popups, and hidden overlays", () => {
    expect(overlapsNativePreview(bounds, { x: 0, y: 100, width: 500, height: 400 })).toBe(false);
    expect(overlapsNativePreview(bounds, { x: 600, y: 0, width: 400, height: 80 })).toBe(false);
    expect(overlapsNativePreview(bounds, { x: 650, y: 100, width: 0, height: 0 })).toBe(false);
  });
});
