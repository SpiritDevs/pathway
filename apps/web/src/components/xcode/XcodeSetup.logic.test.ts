import { describe, expect, it } from "vite-plus/test";

import {
  appleIdPasswordFormKey,
  appleIdSignInStage,
  describeMac,
  describeXcodeFailure,
  pickXcodeAccountId,
  xcodeHostSupport,
} from "./XcodeSetup.logic";

describe("xcodeHostSupport", () => {
  it("only offers Xcode on macOS hosts", () => {
    expect(xcodeHostSupport({ platform: { os: "darwin", arch: "arm64" } })).toBe("mac");
    expect(xcodeHostSupport({ platform: { os: "linux", arch: "x64" } })).toBe("not-mac");
    expect(xcodeHostSupport({ platform: { os: "unknown", arch: "other" } })).toBe("unknown");
    expect(xcodeHostSupport(null)).toBe("unknown");
  });
});

describe("describeMac", () => {
  it("combines model and hostname when both are reported", () => {
    expect(
      describeMac({ device: { kind: "laptop", model: "MacBook Pro", hostname: "studio.local" } }),
    ).toBe("MacBook Pro (studio.local)");
    expect(describeMac({ device: { kind: "desktop", hostname: "studio.local" } })).toBe(
      "studio.local",
    );
    expect(describeMac({})).toBeNull();
  });
});

describe("pickXcodeAccountId", () => {
  it("keeps a remembered account that still exists", () => {
    const accounts = [{ id: "a" }, { id: "b" }];
    expect(pickXcodeAccountId(accounts, "b")).toBe("b");
    expect(pickXcodeAccountId(accounts, "gone")).toBe("a");
    expect(pickXcodeAccountId([], "b")).toBeNull();
  });
});

describe("describeXcodeFailure", () => {
  it("shows environment error messages and falls back for anything else", () => {
    expect(
      describeXcodeFailure({ _tag: "XcodeError", code: "busy", message: "Finish first." }, "x"),
    ).toBe("Finish first.");
    expect(
      describeXcodeFailure(
        { _tag: "AppleError", code: "rate-limited", message: "", retryAfterSeconds: 29.2 },
        "x",
      ),
    ).toBe("Apple is rate limiting sign-in. Try again in 30 seconds.");
    expect(describeXcodeFailure(new Error("socket closed"), "Could not cancel.")).toBe(
      "Could not cancel.",
    );
  });
});

describe("appleIdSignInStage", () => {
  const view = (state: string | null, error: string | null = null) => ({
    data: state === null ? null : { state },
    error,
  });

  it("shows a stream error instead of checking forever", () => {
    expect(appleIdSignInStage(view(null, "Connection lost"))).toBe("unavailable");
    expect(appleIdSignInStage(view("authenticated", "Connection lost"))).toBe("unavailable");
    expect(appleIdSignInStage(view(null))).toBe("checking");
  });

  it("asks for a password when signed out, failed, expired or signing in again", () => {
    expect(appleIdSignInStage(view("signed-out"))).toBe("password");
    expect(appleIdSignInStage(view("failed"))).toBe("password");
    expect(appleIdSignInStage(view("expired"))).toBe("password");
    expect(appleIdSignInStage(view("authenticated"))).toBe("authenticated");
    expect(appleIdSignInStage(view("authenticated"), true)).toBe("password");
    expect(appleIdSignInStage(view("challenge"), true)).toBe("challenge");
  });
});

describe("appleIdPasswordFormKey", () => {
  it("differs per environment, company and account", () => {
    const key = appleIdPasswordFormKey("env", { companyId: "c", accountId: "a" });
    expect(appleIdPasswordFormKey("env", { companyId: "c", accountId: "b" })).not.toBe(key);
    expect(appleIdPasswordFormKey("env", { companyId: "d", accountId: "a" })).not.toBe(key);
    expect(appleIdPasswordFormKey("env2", { companyId: "c", accountId: "a" })).not.toBe(key);
    expect(appleIdPasswordFormKey("env", { companyId: "c", accountId: "a" })).toBe(key);
  });
});
