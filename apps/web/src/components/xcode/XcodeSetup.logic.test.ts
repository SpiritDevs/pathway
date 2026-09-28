import { describe, expect, it } from "vite-plus/test";

import {
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
