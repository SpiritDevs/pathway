import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";
import { AlertQuietHours, alertProjectScopeKey, resolveAlertPolicy } from "./threadAlerts.ts";
const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeQuietHours = Schema.decodeUnknownSync(AlertQuietHours);

describe("thread alert contracts", () => {
  it("keeps existing users silent until they subscribe", () => {
    expect(resolveAlertPolicy()).toEqual({
      completion: false,
      permission: false,
      input: false,
      failure: false,
    });
    const settings = decodeSettings({});
    expect(settings.threadAlerts.soundEnabled).toBe(true);
    expect(settings.threadAlerts.osNotificationsEnabled).toBe(false);
    expect(decodePatch({ threadAlerts: settings.threadAlerts }).threadAlerts).toEqual(
      settings.threadAlerts,
    );
  });
  it("resolves each event independently, preserving explicit false", () => {
    expect(
      resolveAlertPolicy(
        { completion: true, input: true },
        { completion: false, permission: true },
        { input: false, failure: true },
      ),
    ).toEqual({ completion: false, permission: true, input: false, failure: true });
  });
  it("shares repository policy across checkouts but scopes other projects", () => {
    expect(alertProjectScopeKey("a", "p", "github.com/team/repo")).toBe(
      alertProjectScopeKey("b", "q", "github.com/team/repo"),
    );
    expect(alertProjectScopeKey("a", "p")).not.toBe(alertProjectScopeKey("b", "p"));
  });
  it("rejects invalid quiet-hours clock values and weekdays", () => {
    expect(() =>
      decodeQuietHours({ enabled: true, weekdays: [7], start: "22:00", end: "08:00" }),
    ).toThrow();
    expect(() =>
      decodeQuietHours({ enabled: true, weekdays: [1], start: "25:00", end: "08:00" }),
    ).toThrow();
  });
});
