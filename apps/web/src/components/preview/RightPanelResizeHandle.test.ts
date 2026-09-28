import { describe, expect, it } from "vite-plus/test";

import { getRightPanelSplitWidth } from "./RightPanelResizeHandle";

describe("getRightPanelSplitWidth", () => {
  it("splits the workspace row evenly around the gutter", () => {
    // 1256 row = 624 main content + 8 gutter + 624 panel.
    expect(getRightPanelSplitWidth(1_256)).toBe(624);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getRightPanelSplitWidth(1_257.6)).toBe(624);
  });
});
