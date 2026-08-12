import { describe, expect, it } from "vite-plus/test";

import { detectTwoFactorCode } from "./detectTwoFactorCode.ts";

describe("detectTwoFactorCode", () => {
  it.each([
    ["Your verification code is 123456", "123456"],
    ["OTP: A7B9", "A7B9"],
    ["Use ZX81QK to confirm your account", "ZX81QK"],
    ["One-time passcode\n\n98765432", "98765432"],
  ])("detects a 4-8 character code near a keyword", (textBody, expected) => {
    expect(detectTwoFactorCode({ subject: null, textBody, htmlBody: null })).toBe(expected);
  });

  it("does not take an unrelated number", () => {
    expect(
      detectTwoFactorCode({
        subject: "Receipt 123456",
        textBody: "Thanks for your order.",
        htmlBody: null,
      }),
    ).toBeNull();
  });

  it("prefers a valid project override and falls back from an invalid one", () => {
    const input = {
      subject: "Magic token: XY99ZZ",
      textBody: "Your verification code is 123456",
      htmlBody: null,
    };
    expect(detectTwoFactorCode({ ...input, projectRegex: "Magic token: ([A-Z0-9]+)" })).toBe(
      "XY99ZZ",
    );
    expect(detectTwoFactorCode({ ...input, projectRegex: "[" })).toBe("123456");
  });
});
