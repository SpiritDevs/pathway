import { describe, expect, it } from "vite-plus/test";

import { hasDesktopParentExited } from "./DesktopParentMonitor.ts";

describe("desktop parent monitor", () => {
  it("detects when a force-quit reparents the bundled backend", () => {
    expect(hasDesktopParentExited(4242, 4242)).toBe(false);
    expect(hasDesktopParentExited(4242, 1)).toBe(true);
  });
});
