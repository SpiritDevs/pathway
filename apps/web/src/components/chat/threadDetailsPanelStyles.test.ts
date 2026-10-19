import { describe, expect, it } from "vite-plus/test";

import { THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS } from "./threadDetailsPanelStyles";

describe("thread details panel disclosure rows", () => {
  it("supplies the flex alignment that native buttons do not provide", () => {
    const classes = THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS.split(" ");

    expect(classes).toContain("flex");
    expect(classes).toContain("items-center");
    expect(classes).toContain("text-left");
  });
});
