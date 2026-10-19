import { describe, expect, it } from "vite-plus/test";

import { detectTwoFactorCode } from "./detectTwoFactorCode.ts";

describe("detectTwoFactorCode", () => {
  it.each([
    ["Your verification code is 123456", "123456"],
    ["OTP: A7B9", "A7B9"],
    ["Your verification code is JRSVLS", "JRSVLS"],
    ["Your verification code is abcdef", "abcdef"],
    ["Enter ABCD-EFGH to confirm your account", "ABCD-EFGH"],
    ["Passcode: abc-123-xyz", "abc-123-xyz"],
    ["Use ZX81QK to confirm your account", "ZX81QK"],
    ["One-time passcode\n\n98765432", "98765432"],
  ])("detects a supported code shape near a keyword", (textBody, expected) => {
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

  it("uses a verification keyword in the subject to identify a code in the body", () => {
    expect(
      detectTwoFactorCode({
        subject: "Your verification code",
        textBody: "Use 482913 to sign in.",
        htmlBody: null,
      }),
    ).toBe("482913");
  });

  it("does not mistake HTML styles near code copy for the code", () => {
    expect(
      detectTwoFactorCode({
        subject: "QuoteCloud Magic Link Request",
        textBody: "Your QuoteCloud login code is JRSVLS. This code expires in 1 hour.",
        htmlBody:
          '<p>Your login code is <strong>JRSVLS</strong>.</p><p style="font-size:12px">Do not read this code out loud.</p>',
      }),
    ).toBe("JRSVLS");
  });

  it("ignores CSS and ordinary words when an email has no code", () => {
    expect(
      detectTwoFactorCode({
        subject: "Security notice",
        textBody: "This code expires soon, but the value is no longer available.",
        htmlBody: "<style>.copy { font-size: 12px; }</style><p>This code expires soon.</p>",
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

  it("allows a project override to capture letter-only and dashed codes", () => {
    const input = {
      subject: "Magic token: ABCD-EFGH",
      textBody: null,
      htmlBody: null,
    };
    expect(detectTwoFactorCode({ ...input, projectRegex: "Magic token: ([A-Z-]+)" })).toBe(
      "ABCD-EFGH",
    );
  });
});
