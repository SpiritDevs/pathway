import { describe, expect, it } from "vite-plus/test";

import { resolveRightPanelSheetMaxWidth } from "./RightPanelSheet";
import { shouldMountRightPanelSheet } from "../rightPanelLayout";

describe("right panel presentation", () => {
  it("keeps a sheet mounted while closed so its ending transition can finish", () => {
    expect(shouldMountRightPanelSheet({ usesSheet: true, hasContent: true })).toBe(true);
  });

  it("does not mount a sheet when the layout is inline or has no content", () => {
    expect(shouldMountRightPanelSheet({ usesSheet: false, hasContent: true })).toBe(false);
    expect(shouldMountRightPanelSheet({ usesSheet: true, hasContent: false })).toBe(false);
  });
});

describe("resolveRightPanelSheetMaxWidth", () => {
  it("lets the sheet reach the collapsed navigation rail", () => {
    expect(resolveRightPanelSheetMaxWidth({ viewportWidth: 980, navigationRailRight: 56 })).toBe(
      916,
    );
  });

  it("tracks an expanded navigation rail", () => {
    expect(resolveRightPanelSheetMaxWidth({ viewportWidth: 980, navigationRailRight: 224 })).toBe(
      748,
    );
  });

  it("retains the panel minimum on constrained viewports", () => {
    expect(resolveRightPanelSheetMaxWidth({ viewportWidth: 380, navigationRailRight: 56 })).toBe(
      360,
    );
  });
});
