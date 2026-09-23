import { describe, expect, it } from "vite-plus/test";

import { PATHWAY_CUA_DESKTOP_IDENTITY, resolvePackagedDesktopFlavor } from "./desktopFlavor.ts";

describe("resolvePackagedDesktopFlavor", () => {
  it("treats a missing flavor as production", () => {
    expect(resolvePackagedDesktopFlavor(undefined)).toBe("production");
  });

  it.each(["production", "cua"] as const)("accepts the packaged %s flavor", (flavor) => {
    expect(resolvePackagedDesktopFlavor(flavor)).toBe(flavor);
  });

  it.each(["canary", "development", "CUA", 1, null])("rejects %s", (value) => {
    expect(() => resolvePackagedDesktopFlavor(value)).toThrow("Rebuild the application");
  });
});

describe("PATHWAY_CUA_DESKTOP_IDENTITY", () => {
  it("never overlaps the production identity", () => {
    expect(PATHWAY_CUA_DESKTOP_IDENTITY.bundleId).not.toBe("com.spiritdevs.pathway");
    expect(PATHWAY_CUA_DESKTOP_IDENTITY.scheme).not.toMatch(/^pathway(-dev)?$/);
    expect(PATHWAY_CUA_DESKTOP_IDENTITY.homeDirName).not.toBe(".pathway");
    expect(PATHWAY_CUA_DESKTOP_IDENTITY.userDataDirName).not.toMatch(/^pathway(-dev)?$/);
  });
});
