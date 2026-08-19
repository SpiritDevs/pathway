import { describe, expect, it } from "vite-plus/test";

import { settingsProjectKeyFromPathname } from "./SettingsBreadcrumb";

describe("settingsProjectKeyFromPathname", () => {
  it("decodes the project key from a project settings detail route", () => {
    expect(
      settingsProjectKeyFromPathname("/settings/projects/github.com%2Fcoreybain%2Fpersonal-site"),
    ).toBe("github.com/coreybain/personal-site");
  });

  it("ignores the projects index and unrelated settings routes", () => {
    expect(settingsProjectKeyFromPathname("/settings/projects")).toBeNull();
    expect(settingsProjectKeyFromPathname("/settings/general")).toBeNull();
  });
});
