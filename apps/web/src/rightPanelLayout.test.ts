import { describe, expect, it } from "vite-plus/test";

import { resolveThreadPanelPresentation } from "./rightPanelLayout";

describe("resolveThreadPanelPresentation", () => {
  it("uses the stable workspace width minus the real right panel width", () => {
    expect(resolveThreadPanelPresentation(null, 0)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_104, 0)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_103, 0)).toBe("popover");

    expect(resolveThreadPanelPresentation(1_400, 0)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_400, 540)).toBe("popover");
    expect(resolveThreadPanelPresentation(1_644, 540)).toBe("inline");
  });
});
