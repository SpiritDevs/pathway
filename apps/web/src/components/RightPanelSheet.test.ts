import { describe, expect, it } from "vite-plus/test";

import { resolveRightPanelSheetMaxWidth } from "./RightPanelSheet";
import { shouldPresentRightPanelAsSheet } from "../rightPanelLayout";

describe("right panel presentation", () => {
  it("uses the floating sheet when a desktop panel is popped out", () => {
    expect(shouldPresentRightPanelAsSheet({ viewportRequiresSheet: false, poppedOut: true })).toBe(
      true,
    );
  });

  it("keeps the responsive sheet without an explicit pop out", () => {
    expect(shouldPresentRightPanelAsSheet({ viewportRequiresSheet: true, poppedOut: false })).toBe(
      true,
    );
  });

  it("keeps the panel inline by default on desktop", () => {
    expect(shouldPresentRightPanelAsSheet({ viewportRequiresSheet: false, poppedOut: false })).toBe(
      false,
    );
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
