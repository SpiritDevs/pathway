import { describe, expect, it } from "vite-plus/test";

import { DIALOG_POPUP_CLASS } from "./dialog-styles";

describe("dialog styles", () => {
  it("keeps dialog popups interactive over Electron drag regions", () => {
    expect(DIALOG_POPUP_CLASS).toContain("[-webkit-app-region:no-drag]");
  });
});
