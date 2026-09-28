import { describe, expect, it } from "vite-plus/test";

import { openPane, PRIMARY_PANE_ID, SINGLE_PANE_LAYOUT } from "./paneLayout";
import { paneOwnsInput, resolveInlineRightPanelHostSelector } from "./usePaneFocus";

describe("paneOwnsInput", () => {
  it("gives an unsplit window's only pane every input", () => {
    expect(paneOwnsInput(SINGLE_PANE_LAYOUT, PRIMARY_PANE_ID)).toBe(true);
  });

  it("gives a split window's input to the focused pane alone", () => {
    const split = openPane(SINGLE_PANE_LAYOUT, { id: "side", href: "/email", edge: "right" });
    expect(paneOwnsInput(split, "side")).toBe(true);
    expect(paneOwnsInput(split, PRIMARY_PANE_ID)).toBe(false);
  });
});

describe("resolveInlineRightPanelHostSelector", () => {
  it("keeps the shell's host while the window is unsplit", () => {
    expect(resolveInlineRightPanelHostSelector(PRIMARY_PANE_ID, false)).toBe(
      "[data-inline-right-panel-host]",
    );
  });

  it("uses each pane's own host once split", () => {
    expect(resolveInlineRightPanelHostSelector(PRIMARY_PANE_ID, true)).toBe(
      '[data-pane-right-panel-host="primary"]',
    );
    expect(resolveInlineRightPanelHostSelector("side", true)).toBe(
      '[data-pane-right-panel-host="side"]',
    );
  });
});
