import { describe, expect, it } from "vite-plus/test";

import {
  RESEND_COOLDOWN_SECONDS,
  canResendCode,
  isVerificationCodeComplete,
  normalizeVerificationCode,
  resendButtonLabel,
  resendCooldownEndsAt,
  resendSecondsRemaining,
  validateRegisterDetails,
} from "./registerForm.logic";

describe("resendCooldownEndsAt", () => {
  it("lands the default cooldown 30 seconds out", () => {
    expect(resendCooldownEndsAt(1_000)).toBe(31_000);
  });

  it("honours an explicit cooldown length", () => {
    expect(resendCooldownEndsAt(1_000, 5)).toBe(6_000);
  });
});

describe("resendSecondsRemaining", () => {
  it("reports zero when no cooldown is running", () => {
    expect(resendSecondsRemaining(null, 5_000)).toBe(0);
  });

  it("rounds up so the label never shows zero while still locked", () => {
    expect(resendSecondsRemaining(10_001, 10_000)).toBe(1);
    expect(resendSecondsRemaining(11_500, 10_000)).toBe(2);
  });

  it("reports the full cooldown at the instant it starts", () => {
    const now = 4_000;
    expect(resendSecondsRemaining(resendCooldownEndsAt(now), now)).toBe(RESEND_COOLDOWN_SECONDS);
  });

  it("clamps to zero once the deadline passes", () => {
    expect(resendSecondsRemaining(10_000, 10_000)).toBe(0);
    expect(resendSecondsRemaining(10_000, 90_000)).toBe(0);
  });
});

describe("canResendCode", () => {
  it("unlocks only once the countdown has drained", () => {
    expect(canResendCode({ isBusy: false, secondsRemaining: 0 })).toBe(true);
    expect(canResendCode({ isBusy: false, secondsRemaining: 1 })).toBe(false);
  });

  it("stays locked while a request is in flight", () => {
    expect(canResendCode({ isBusy: true, secondsRemaining: 0 })).toBe(false);
  });
});

describe("resendButtonLabel", () => {
  it("counts down while locked", () => {
    expect(resendButtonLabel(28)).toBe("Resend in 28s");
    expect(resendButtonLabel(1)).toBe("Resend in 1s");
  });

  it("offers the action once unlocked", () => {
    expect(resendButtonLabel(0)).toBe("Resend code");
  });
});

describe("normalizeVerificationCode", () => {
  it("strips everything that is not a digit", () => {
    expect(normalizeVerificationCode("12 34-56")).toBe("123456");
    expect(normalizeVerificationCode("Your code is 907214")).toBe("907214");
  });

  it("truncates to the code length", () => {
    expect(normalizeVerificationCode("1234567890")).toBe("123456");
  });

  it("returns an empty string when there is nothing to keep", () => {
    expect(normalizeVerificationCode("   ")).toBe("");
  });
});

describe("isVerificationCodeComplete", () => {
  it("requires a full six digits", () => {
    expect(isVerificationCodeComplete("123456")).toBe(true);
    expect(isVerificationCodeComplete("12345")).toBe(false);
  });

  it("ignores separators when measuring completeness", () => {
    expect(isVerificationCodeComplete("123 456")).toBe(true);
  });
});

describe("validateRegisterDetails", () => {
  it("accepts a plausible email and a long enough password", () => {
    expect(validateRegisterDetails({ email: "ada@example.com", password: "correct-horse" })).toBe(
      null,
    );
  });

  it("tolerates surrounding whitespace on the email", () => {
    expect(validateRegisterDetails({ email: "  ada@example.com  ", password: "12345678" })).toBe(
      null,
    );
  });

  it("asks for a missing email first", () => {
    expect(validateRegisterDetails({ email: "  ", password: "" })).toBe(
      "Enter your email address.",
    );
  });

  it("rejects an email without a domain", () => {
    expect(validateRegisterDetails({ email: "ada@example", password: "12345678" })).toBe(
      "Enter a valid email address.",
    );
  });

  it("rejects an email with no local part", () => {
    expect(validateRegisterDetails({ email: "@example.com", password: "12345678" })).toBe(
      "Enter a valid email address.",
    );
  });

  it("asks for a password before judging its length", () => {
    expect(validateRegisterDetails({ email: "ada@example.com", password: "" })).toBe(
      "Choose a password.",
    );
  });

  it("enforces the minimum password length", () => {
    expect(validateRegisterDetails({ email: "ada@example.com", password: "short" })).toBe(
      "Passwords need at least 8 characters.",
    );
  });
});
