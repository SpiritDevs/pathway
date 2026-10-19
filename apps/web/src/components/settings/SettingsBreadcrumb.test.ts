import { describe, expect, it } from "vite-plus/test";

import {
  settingsEmailEnvironmentIdFromPathname,
  settingsProjectKeyFromPathname,
} from "./SettingsBreadcrumb";

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

describe("settingsEmailEnvironmentIdFromPathname", () => {
  it("decodes the environment id from an email capture detail route", () => {
    expect(settingsEmailEnvironmentIdFromPathname("/settings/email/device%3Alocal")).toBe(
      "device:local",
    );
  });

  it("ignores the email capture index and unrelated settings routes", () => {
    expect(settingsEmailEnvironmentIdFromPathname("/settings/email")).toBeNull();
    expect(settingsEmailEnvironmentIdFromPathname("/settings/environments")).toBeNull();
  });
});
